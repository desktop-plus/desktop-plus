import { IDataStore, ISecureStore } from './stores'
import { getKeyForAccount } from '../auth'
import {
  Account,
  AccountAPIType,
  getAccountKey,
  IAccountIdentity,
  isDotComAccount,
  UnknownLogin,
} from '../../models/account'
import {
  fetchUser,
  EmailVisibility,
  getEnterpriseAPIURL,
  BitbucketCloudAPIEndpoint,
  CodebergCloudAPIEndpoint,
  GitLabCloudAPIEndpoint,
  GiteaCloudAPIEndpoint,
  deriveApiType,
} from '../api'
import { assertNever, fatalError } from '../fatal-error'
import { TypedBaseStore } from './base-store'
import { isGHE } from '../endpoint-capabilities'
import { compare, compareDescending } from '../compare'
import { caseInsensitiveEquals } from '../compare'
import {
  isRegisteredApiType,
  registerEndpointApiType,
  RegisteredApiType,
  tryGetHost,
  unregisterHost,
} from '../endpoint-api-type-registry'
import { Disposable } from 'event-kit'
import {
  renewAccountToken,
  revokeAccountToken,
  RevocableToken,
} from '../third-party-oauth-token'
import { IOAuthToken } from '../oauth-token'
import { deserializeAccountCredential } from '../account-credential'
import {
  AccountRequiresSignInError,
  CredentialSessions,
  IAccountTokenExpiration,
  TokenRefreshEvent,
  refreshMargin,
} from '../credential-sessions'
import { ChunkedSecureStore } from './chunked-secure-store'
import {
  getPersistedUserKey,
  hasLegacyCredentialFields,
  ILegacyCredentialFields,
  migrateLegacyCredential,
  parsePersistedUsers,
  PersistedUsers,
  withPersistedUsers,
} from './legacy-account-credential'
import { migrateForkAccountIds } from './helpers/migrate-fork-account-assignments'

// Ensure that GitHub.com accounts appear first followed by Enterprise
// accounts, sorted by the order in which they were added.
const sortAccounts = (accounts: ReadonlyArray<Account>) =>
  accounts
    .map((account, ix) => [account, ix] as const)
    .sort(
      ([xAccount, xIx], [yAccount, yIx]) =>
        compareDescending(
          isDotComAccount(xAccount),
          isDotComAccount(yAccount)
        ) || compare(xIx, yIx)
    )
    .map(([account]) => account)

/** The data-only interface for storage. */
interface IEmail {
  readonly email: string
  /**
   * Represents whether GitHub has confirmed the user has access to this
   * email address. New users require a verified email address before
   * they can sign into GitHub Desktop.
   */
  readonly verified: boolean
  /**
   * Flag for the user's preferred email address. Other email addresses
   * are provided for associating commit authors with the one GitHub account.
   */
  readonly primary: boolean

  /** The way in which the email is visible. */
  readonly visibility: EmailVisibility
}

function isKeyChainError(e: any) {
  const error = e as Error
  return (
    error.message &&
    error.message.startsWith(
      'The user name or passphrase you entered is not correct'
    )
  )
}

function isMissingSecretServiceError(e: unknown) {
  return (
    e instanceof Error &&
    (e.message.includes('org.freedesktop.secrets') ||
      e.message.includes('The name is not activatable'))
  )
}

/** The data-only interface for storage. */
interface IAccount extends ILegacyCredentialFields {
  readonly token: string
  readonly login: string
  readonly endpoint: string
  readonly emails: ReadonlyArray<IEmail>
  readonly avatarURL: string
  readonly id: number
  readonly name: string
  readonly plan?: string
  readonly apiType?: AccountAPIType
}

const getCloudEndpointForApiType = (type: RegisteredApiType) => {
  switch (type) {
    case 'bitbucket':
      return BitbucketCloudAPIEndpoint
    case 'gitlab':
      return GitLabCloudAPIEndpoint
    case 'forgejo':
      return CodebergCloudAPIEndpoint
    case 'gitea':
      return GiteaCloudAPIEndpoint
    default:
      assertNever(type, `Unknown API type: ${type}`)
  }
}

const registerSelfHostedAccountEndpoint = (account: Account) => {
  const { apiType, endpoint } = account
  if (
    isRegisteredApiType(apiType) &&
    endpoint !== getCloudEndpointForApiType(apiType)
  ) {
    registerEndpointApiType(endpoint, apiType)
  }
}

const friendlyApiTypeName = (apiType: AccountAPIType) => {
  switch (apiType) {
    case 'dotcom':
      return 'GitHub.com'
    case 'enterprise':
      return 'GitHub Enterprise'
    case 'bitbucket':
      return 'Bitbucket'
    case 'gitlab':
      return 'GitLab'
    case 'forgejo':
      return 'Forgejo'
    case 'gitea':
      return 'Gitea'
  }
}

function withLogin(account: Account, login: string): Account {
  return account.login === login
    ? account
    : new Account(
        login,
        account.endpoint,
        account.apiType,
        account.token,
        account.emails,
        account.avatarURL,
        account.id,
        account.name,
        account.plan,
        account.copilotEndpoint,
        account.isCopilotDesktopEnabled,
        account.features,
        account.copilotLicenseType
      )
}

/** The store for logged in accounts. */
export class AccountsStore extends TypedBaseStore<ReadonlyArray<Account>> {
  private dataStore: IDataStore
  private secureStore: ISecureStore

  private accounts: ReadonlyArray<Account> = []
  private readonly credentials: CredentialSessions
  /** Sign-in keys whose legacy refresh token could not be saved securely yet. */
  private readonly pendingLegacyCredentials = new Set<string>()
  /**
   * Persisted `users` keys this window wrote for its own accounts. Other
   * entries were written by other app windows and are kept.
   */
  private ownUserKeys = new Set<string>()

  /** A promise that will resolve when the accounts have been loaded. */
  private loadingPromise: Promise<void>

  /**
   * The endpoint and login of every account persisted when the store loaded,
   * including those whose credentials couldn't be read or were unusable.
   */
  private persistedIdentities: ReadonlyArray<IAccountIdentity> = []

  public constructor(
    dataStore: IDataStore,
    secureStore: ISecureStore,
    renewToken = renewAccountToken,
    now = Date.now,
    revokeToken = revokeAccountToken
  ) {
    super()
    secureStore = new ChunkedSecureStore(secureStore)

    this.dataStore = dataStore
    this.secureStore = secureStore
    this.credentials = new CredentialSessions(
      secureStore,
      {
        requireSignIn: this.requireSignIn,
        onTokenRenewed: this.onTokenRenewed,
        onSignedIn: this.onSignedIn,
        onRemovedElsewhere: this.onRemovedElsewhere,
        onTokenRefreshEvent: event => this.emitter.emit('token-refresh', event),
      },
      renewToken,
      now,
      revokeToken
    )
    migrateForkAccountIds(dataStore)
    this.loadingPromise = this.loadFromStore()
  }

  /**
   * Get the list of accounts in the cache.
   */
  /**
   * Get the endpoint and login of every account that was persisted when the
   * store loaded, whether or not its credentials could be loaded.
   *
   * Use this when only the identity matters, such as migrating repository
   * account assignments, so a locked keychain at launch doesn't lose them.
   */
  public async getPersistedIdentities(): Promise<
    ReadonlyArray<IAccountIdentity>
  > {
    await this.loadingPromise
    return this.persistedIdentities
  }

  public async getAll(): Promise<ReadonlyArray<Account>> {
    await this.loadingPromise

    return this.accounts.slice()
  }

  /** Notify once per account when invalid credentials sign it out. */
  public onTokenInvalidated(callback: (account: Account) => void): Disposable {
    return this.emitter.on('token-invalidated', callback)
  }

  /** Subscribe to credential-free renewal events, excluding debug overrides. */
  public onTokenRefreshEvent(
    callback: (event: TokenRefreshEvent) => void
  ): Disposable {
    return this.emitter.on('token-refresh', callback)
  }

  /** Handle a rejected API token without leaving unhandled callback errors. */
  public handleTokenInvalidated = (endpoint: string, token: string): void => {
    void this.invalidateToken(endpoint, token).catch(error => {
      log.error('Unable to invalidate rejected GitHub credentials', error)
      this.emitError(error)
    })
  }

  /** Resolve token snapshots held by long-lived clients without changing identity. */
  public resolveToken = async (
    endpoint: string,
    token: string,
    login?: string | UnknownLogin
  ): Promise<string> => {
    await this.loadingPromise
    return this.credentials.resolveToken(
      endpoint,
      token,
      typeof login === 'string' ? login : undefined
    )
  }

  /** Get the current credential for an account before handing it to another consumer. */
  public async getAccountWithFreshToken(
    account: Account,
    minimumValidity = refreshMargin
  ): Promise<Account> {
    await this.loadingPromise
    const token = await this.credentials.getFreshToken(account, minimumValidity)
    const current = this.findAccount(account)
    if (current === undefined) {
      throw new AccountRequiresSignInError()
    }
    return this.credentials.inheritSession(current, current.withToken(token))
  }

  /**
   * Get the account's credential for `holder`, holding off renewal of that
   * token until the lease is released. See `CredentialSessions.leaseToken`.
   *
   * Leases only hold off renewal in this window; another window may still
   * renew, and so revoke, a leased token near expiry.
   */
  public async leaseAccountToken(
    account: Account,
    holder: string
  ): Promise<{ readonly account: Account; readonly release: () => void }> {
    await this.loadingPromise
    const lease = await this.credentials.leaseToken(account, holder)
    const current = this.findAccount(account)
    if (current === undefined || current.id !== account.id) {
      lease.release()
      throw new AccountRequiresSignInError()
    }
    return {
      account: this.credentials.inheritSession(
        current,
        current.withToken(lease.token)
      ),
      release: lease.release,
    }
  }

  /** Whether an account owns a rotating credential pair. */
  public isRefreshable(account: Account): boolean {
    return this.credentials.isRefreshable(account)
  }

  /** Read test-dialog expiry metadata without acquiring or refreshing a token. */
  public async getTokenExpirationForTesting(
    account: Account
  ): Promise<IAccountTokenExpiration> {
    await this.loadingPromise
    return this.credentials.getTokenExpirationForTesting(account)
  }

  /** Apply or reset a session-only access-token expiry override for testing. */
  public async setTokenExpirationForTesting(
    account: Account,
    expiresAt: number | undefined
  ): Promise<IAccountTokenExpiration> {
    await this.loadingPromise
    return this.credentials.setTokenExpirationForTesting(account, expiresAt)
  }

  /**
   * Bind fresh access tokens and expiry metadata to the account's issuing session.
   *
   * Throws if the account snapshot is unknown or its session has retired.
   */
  public createTokenGetter(
    account: Account,
    minimumValidity = refreshMargin
  ): () => Promise<Pick<IOAuthToken, 'accessToken' | 'expiresAt'>> {
    return this.credentials.createTokenGetter(account, minimumValidity)
  }

  /** Ignore obsolete 401s; sign out when the current token is rejected. */
  public async invalidateToken(endpoint: string, token: string): Promise<void> {
    await this.loadingPromise
    await this.credentials.invalidateToken(endpoint, token)
  }

  /**
   * Revoke an unused credential, even if account lookup has not completed.
   *
   * Cleanup is bounded and failures are logged. Callers need not await it, but
   * must only pass credentials that have not been installed for an account.
   */
  public revokeUnusedToken(account: RevocableToken): Promise<void> {
    return this.credentials.revokeUnusedToken(account)
  }

  /** Sign out an account whose credential can no longer be used. */
  private requireSignIn = async (account: Account): Promise<Account | null> => {
    const retired = this.retireAccount(account)
    if (retired === null) {
      return null
    }
    log.info(
      `[AccountsStore] signing out account ${retired.login} (${retired.name}) because its credentials can no longer be used`
    )
    this.emitter.emit(
      'token-invalidated',
      this.credentials.inheritSession(account, account.withToken(''))
    )
    await this.deleteStoredAccount(retired)
    return retired
  }

  private onTokenRenewed = (account: Account, accessToken: string) => {
    this.pendingLegacyCredentials.delete(getPersistedUserKey(account))
    const key = getAccountKey(account)
    this.accounts = this.accounts.map(a =>
      getAccountKey(a) === key
        ? this.credentials.inheritSession(a, a.withToken(accessToken))
        : a
    )
    this.save()
  }

  private onRemovedElsewhere = (account: Account): boolean => {
    const persisted = parsePersistedUsers(this.dataStore.getItem('users'))
    if (
      persisted === undefined ||
      persisted.has(getPersistedUserKey(account))
    ) {
      return false
    }
    this.retireAccount(account)
    return true
  }

  /** Add the account, or replace an existing account with the same identity. */
  private onSignedIn = (account: Account) => {
    this.pendingLegacyCredentials.delete(getPersistedUserKey(account))
    // Even if another window removed this account, the new sign-in is kept.
    this.ownUserKeys.delete(getPersistedUserKey(account))

    const key = getAccountKey(account)
    const existing = this.accounts.findIndex(a => getAccountKey(a) === key)
    this.accounts =
      existing === -1
        ? sortAccounts([...this.accounts, account])
        : this.accounts.map((a, i) => (i === existing ? account : a))
    this.save()
  }

  /** The installed account with the same identity (endpoint, login and id). */
  private findAccount(account: Account): Account | undefined {
    const key = getAccountKey(account)
    return this.accounts.find(
      a => getAccountKey(a) === key && a.id === account.id
    )
  }

  /**
   * Look for a live account on the same host as the given endpoint but with a
   * different API type, and describe the conflict if there is one.
   */
  public async findApiTypeConflict(
    endpoint: string,
    apiType: AccountAPIType
  ): Promise<Error | null> {
    await this.loadingPromise
    return this.apiTypeConflictFor(endpoint, apiType)
  }

  private apiTypeConflictFor(
    endpoint: string,
    apiType: AccountAPIType
  ): Error | null {
    const host = tryGetHost(endpoint)
    if (host === undefined) {
      return null
    }

    const conflicting = this.accounts.find(
      a => tryGetHost(a.endpoint) === host && a.apiType !== apiType
    )

    return conflicting === undefined
      ? null
      : new Error(
          `The host ${host} is already associated with a ` +
            `${friendlyApiTypeName(conflicting.apiType)} account ` +
            `(${conflicting.login}). Remove that account before signing ` +
            `in to ${host} as ${friendlyApiTypeName(apiType)}.`
        )
  }

  /**
   * Add the account, or refresh an existing endpoint and login identity.
   *
   * Returns a new signed-in snapshot. Previous snapshots retain their old session.
   */
  public async addAccount(
    account: Account,
    credential: IOAuthToken = { accessToken: account.token }
  ): Promise<Account | null> {
    await this.loadingPromise

    // Reject the account if a live account on the same host has a different API type.
    const host = tryGetHost(account.endpoint)
    if (host !== undefined) {
      const conflict = this.apiTypeConflictFor(
        account.endpoint,
        account.apiType
      )
      if (conflict !== null) {
        this.emitError(conflict)
        return null
      }

      if (account.apiType === 'enterprise') {
        unregisterHost(host)
      } else {
        registerSelfHostedAccountEndpoint(account)
      }
    }

    let authenticatedAccount: Account
    try {
      authenticatedAccount = await this.credentials.add(account, credential)
    } catch (e) {
      log.error(`Error adding account '${account.login}'`, e)
      this.emitCredentialStorageError(e)
      return null
    }

    return authenticatedAccount
  }

  /** Refresh all accounts by fetching their latest info from the API. */
  public async refresh(): Promise<void> {
    await this.loadingPromise
    await Promise.all(this.accounts.map(acc => this.tryUpdateAccount(acc)))
  }

  private emitCredentialStorageError(e: Error) {
    if ((__DARWIN__ || __LINUX__) && isKeyChainError(e)) {
      this.emitError(
        new Error(
          `Desktop Plus was unable to store the account token in the keychain. Please check you have unlocked access to the 'login' keychain.`
        )
      )
    } else if (__LINUX__ && isMissingSecretServiceError(e)) {
      this.emitError(
        new Error(
          `Desktop Plus was unable to store the account token because no keyring service is running. Please install and start a Secret Service provider (such as gnome-keyring) and try again.`
        )
      )
    } else {
      this.emitError(e)
    }
  }

  /**
   * Refresh profile data without resurrecting a removed account or replacing
   * credentials that rotated while the profile request was in flight.
   */
  private async tryUpdateAccount(account: Account): Promise<void> {
    const currentToken = this.credentials.trackToken(account)
    try {
      const fresh = await this.getAccountWithFreshToken(account)
      const updated = await updatedAccount(fresh)
      // The login keys the account's session, secure-storage item and
      // repository associations, so a renamed user keeps the previous login
      // until they sign in again. A change of case only keeps the stored login
      // too, since it keys the (case-sensitive) secure-storage item.
      if (!caseInsensitiveEquals(updated.login, account.login)) {
        log.warn(
          `Account '${account.login}' was renamed to '${updated.login}'. Sign in again to use the new login.`
        )
        return
      }
      const refreshed = withLogin(updated, account.login)
      const token = currentToken()
      if (token !== null) {
        const key = getAccountKey(account)
        this.accounts = this.accounts.map(a =>
          getAccountKey(a) === key
            ? this.credentials.inheritSession(a, refreshed.withToken(token))
            : a
        )
        this.save()
      }
    } catch (e) {
      log.warn(`Error refreshing account '${account.login}'`, e)
    }
  }

  private retireAccount(account: Account): Account | null {
    const current = this.findAccount(account)
    if (current === undefined) {
      return null
    }
    this.credentials.retire(current)
    this.accounts = this.accounts.filter(a => a !== current)
    this.save()
    return current
  }

  private async deleteStoredAccount(account: Account): Promise<void> {
    try {
      await this.credentials.delete(account)
    } catch (e) {
      log.error(`Error removing account '${account.login}'`, e)
      this.emitError(e)
    }
  }

  /**
   * Remove an account and return its credential snapshot for remote revocation.
   *
   * Capture and retire the current session without yielding so renewal cannot
   * publish a token between those steps. Return the snapshot even if deleting
   * secure storage fails, or null if this account is no longer installed.
   */
  public async removeAccount(account: Account): Promise<Account | null> {
    await this.loadingPromise
    const current = this.retireAccount(account)
    if (current !== null) {
      await this.revokeNewerStoredCredential(current)
      await this.deleteStoredAccount(current)
    }
    return current
  }

  /**
   * Another window may have renewed the pair since this window's snapshot,
   * which the caller revokes; revoke the newer token too.
   */
  private async revokeNewerStoredCredential(account: Account) {
    const stored = await this.credentials.readStoredCredential(account)
    if (stored && stored.accessToken !== account.token) {
      void this.revokeUnusedToken(account.withToken(stored.accessToken))
    }
  }

  private getMigratedGHEAccounts(
    accounts: ReadonlyArray<IAccount>
  ): ReadonlyArray<IAccount> | null {
    let migrated = false
    const migratedAccounts = accounts.map(account => {
      let endpoint = account.endpoint
      const endpointURL = new URL(endpoint)
      // Migrate endpoints of subdomains of `.ghe.com` that use the `/api/v3`
      // path to the correct URL using the `api.` subdomain.
      if (isGHE(endpoint) && !endpointURL.hostname.startsWith('api.')) {
        endpoint = getEnterpriseAPIURL(endpoint)
        migrated = true
      }

      return {
        ...account,
        endpoint,
      }
    })

    return migrated ? migratedAccounts : null
  }

  /**
   * Load the users into memory from storage.
   */
  private async loadFromStore(): Promise<void> {
    const raw = this.dataStore.getItem('users')
    if (!raw || !raw.length) {
      return
    }

    const parsedAccounts: ReadonlyArray<IAccount> = JSON.parse(raw)
    this.ownUserKeys = new Set(parsedAccounts.map(getPersistedUserKey))
    const migratedAccounts = this.getMigratedGHEAccounts(parsedAccounts)
    const rawAccounts = migratedAccounts ?? parsedAccounts
    this.persistedIdentities = rawAccounts.map(({ endpoint, login }) => ({
      endpoint,
      login,
    }))

    const needsApiTypeBackfill = rawAccounts.some(a => a.apiType === undefined)
    const hasLegacyCredentials = rawAccounts.some(hasLegacyCredentialFields)

    // Duplicate accounts keep the last entry, like CredentialSessions.restore.
    const accountsByKey = new Map<string, Account>()
    let removedInvalidAccounts = false
    for (const [index, account] of rawAccounts.entries()) {
      const accountWithoutToken = new Account(
        account.login,
        account.endpoint,
        account.apiType ?? deriveApiType(account.endpoint),
        '',
        account.emails,
        account.avatarURL,
        account.id,
        account.name,
        account.plan
      )

      registerSelfHostedAccountEndpoint(accountWithoutToken)

      const key = getKeyForAccount(accountWithoutToken)
      try {
        const stored = await this.secureStore.getItem(key, account.login)
        const { credential, pending } = await migrateLegacyCredential(
          this.secureStore,
          key,
          accountWithoutToken,
          account,
          deserializeAccountCredential(stored)
        )
        if (pending) {
          this.pendingLegacyCredentials.add(
            getPersistedUserKey(accountWithoutToken)
          )
        }
        if (credential === null && stored !== null) {
          removedInvalidAccounts = true
          try {
            await this.secureStore.deleteItem(key, account.login)
          } catch (e) {
            log.error('Unable to remove unusable credentials.', e)
            this.emitError(new Error('Unable to remove unusable credentials.'))
          }
          continue
        }
        const loaded = accountWithoutToken.withToken(
          credential?.accessToken ?? ''
        )
        const restored = this.credentials.restore(loaded, credential)
        accountsByKey.set(getAccountKey(restored), restored)
      } catch (e) {
        log.error(`Error getting token for '${key}'. Skipping.`, e)
        // Kept like another window's entry, so it loads again later.
        this.ownUserKeys.delete(getPersistedUserKey(parsedAccounts[index]))

        this.emitError(e)
      }
    }

    this.accounts = sortAccounts([...accountsByKey.values()])
    // If any account was migrated, make sure to persist the new value
    if (
      migratedAccounts !== null ||
      needsApiTypeBackfill ||
      hasLegacyCredentials ||
      removedInvalidAccounts
    ) {
      this.save() // Save already emits an update
    } else {
      this.emitUpdate(this.accounts)
    }
  }

  /** This window's accounts that are gone from `persisted` were removed elsewhere. */
  private forgetAccountsRemovedElsewhere(
    persisted: PersistedUsers | undefined
  ) {
    const isRemoved = (a: Account) =>
      persisted !== undefined &&
      this.ownUserKeys.has(getPersistedUserKey(a)) &&
      !persisted.has(getPersistedUserKey(a))
    for (const account of this.accounts.filter(isRemoved)) {
      log.info(`Account '${account.login}' was removed in another window.`)
      this.credentials.retire(account)
    }
    this.accounts = this.accounts.filter(a => !isRemoved(a))
  }

  private save() {
    const persisted = parsePersistedUsers(this.dataStore.getItem('users'))
    this.forgetAccountsRemovedElsewhere(persisted)
    const usersWithoutTokens = this.accounts.map(account =>
      account.withToken('')
    )
    this.dataStore.setItem(
      'users',
      JSON.stringify(
        withPersistedUsers(
          usersWithoutTokens,
          persisted,
          a => this.pendingLegacyCredentials.has(getPersistedUserKey(a)),
          this.ownUserKeys
        )
      )
    )
    this.ownUserKeys = new Set(usersWithoutTokens.map(getPersistedUserKey))

    this.emitUpdate(this.accounts)
  }
}

async function updatedAccount(account: Account): Promise<Account> {
  if (!account.token) {
    return fatalError(
      `Cannot update an account which doesn't have a token: ${account.login}`
    )
  }

  return fetchUser(
    account.endpoint,
    account.apiType,
    account.token,
    account.login
  )
}
