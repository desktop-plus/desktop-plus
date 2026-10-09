import { IDataStore, ISecureStore } from './stores'
import { getKeyForAccount } from '../auth'
import { Account, AccountAPIType, isDotComAccount } from '../../models/account'
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
import {
  isRegisteredApiType,
  registerEndpointApiType,
  RegisteredApiType,
  tryGetHost,
  unregisterHost,
} from '../endpoint-api-type-registry'

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
interface IAccount {
  readonly token: string
  readonly login: string
  readonly endpoint: string
  readonly refreshToken: string
  readonly tokenExpiresAt: number
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

/** The store for logged in accounts. */
export class AccountsStore extends TypedBaseStore<ReadonlyArray<Account>> {
  private dataStore: IDataStore
  private secureStore: ISecureStore

  private accounts: ReadonlyArray<Account> = []

  /** A promise that will resolve when the accounts have been loaded. */
  private loadingPromise: Promise<void>

  public constructor(dataStore: IDataStore, secureStore: ISecureStore) {
    super()

    this.dataStore = dataStore
    this.secureStore = secureStore
    this.loadingPromise = this.loadFromStore()
  }

  /**
   * Get the list of accounts in the cache.
   */
  public async getAll(): Promise<ReadonlyArray<Account>> {
    await this.loadingPromise

    return this.accounts.slice()
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
   * Add the account to the store.
   */
  public async addAccount(account: Account): Promise<Account | null> {
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

    if (!(await this.storeAccountKey(account))) {
      return null
    }

    const accountsByEndpoint = this.accounts.reduce(
      (map, x) => map.set(x.endpoint + ':' + x.login, x),
      new Map<string, Account>()
    )
    accountsByEndpoint.set(account.endpoint + ':' + account.login, account)

    this.accounts = sortAccounts([...accountsByEndpoint.values()])

    this.save()
    return account
  }

  public async modifyAccount(newAccount: Account): Promise<Account | null> {
    await this.loadingPromise
    const index = this.accounts.findIndex(
      a => a.endpoint === newAccount.endpoint && a.id === newAccount.id
    )
    if (index === -1) {
      log.warn(
        `Account not found in store when trying to modify: ${newAccount.login}`
      )
      return null
    }
    if (!(await this.storeAccountKey(newAccount))) {
      return null
    }
    this.accounts = this.accounts.map((a, i) => (i === index ? newAccount : a))

    this.save()
    this.emitUpdate(this.accounts)
    return this.accounts[index]
  }

  /** Refresh all accounts by fetching their latest info from the API. */
  public async refresh(): Promise<void> {
    this.accounts = await Promise.all(
      this.accounts.map(acc => this.tryUpdateAccount(acc))
    )

    this.save()
    this.emitUpdate(this.accounts)
  }

  private async storeAccountKey(account: Account) {
    try {
      const key = getKeyForAccount(account)
      await this.secureStore.setItem(key, account.login, account.token)
      return true
    } catch (e) {
      log.error(`Error adding account '${account.login}'`, e)

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
      return false
    }
  }

  /**
   * Attempts to update the Account with new information from
   * the API.
   *
   * If the update fails for whatever reason this function
   * will return the old Account instance. Usually updates fails
   * due to connectivity issues but in the future we should
   * investigate whether we're able to detect here that the
   * token is definitely not valid anymore and let the
   * user know that they've been signed out.
   */
  private async tryUpdateAccount(account: Account): Promise<Account> {
    try {
      return await updatedAccount(account)
    } catch (e) {
      log.warn(`Error refreshing account '${account.login}'`, e)
      return account
    }
  }

  /**
   * Remove the account from the store.
   */
  public async removeAccount(account: Account): Promise<void> {
    await this.loadingPromise

    try {
      await this.secureStore.deleteItem(
        getKeyForAccount(account),
        account.login
      )
    } catch (e) {
      log.error(`Error removing account '${account.login}'`, e)
      this.emitError(e)
      return
    }

    this.accounts = this.accounts.filter(
      a =>
        !(
          a.endpoint === account.endpoint &&
          a.login === account.login &&
          a.id === account.id
        )
    )

    this.save()
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
    const migratedAccounts = this.getMigratedGHEAccounts(parsedAccounts)
    const rawAccounts = migratedAccounts ?? parsedAccounts

    const needsApiTypeBackfill = rawAccounts.some(a => a.apiType === undefined)

    const accountsWithTokens = []
    for (const account of rawAccounts) {
      const accountWithoutToken = new Account(
        account.login,
        account.endpoint,
        account.apiType ?? deriveApiType(account.endpoint),
        '',
        account.refreshToken,
        account.tokenExpiresAt,
        account.emails,
        account.avatarURL,
        account.id,
        account.name,
        account.plan
      )

      registerSelfHostedAccountEndpoint(accountWithoutToken)

      const key = getKeyForAccount(accountWithoutToken)
      try {
        const token = await this.secureStore.getItem(key, account.login)
        accountsWithTokens.push(accountWithoutToken.withToken(token || ''))
      } catch (e) {
        log.error(`Error getting token for '${key}'. Skipping.`, e)

        this.emitError(e)
      }
    }

    this.accounts = sortAccounts(accountsWithTokens)
    // If any account was migrated, make sure to persist the new value
    if (migratedAccounts !== null || needsApiTypeBackfill) {
      this.save() // Save already emits an update
    } else {
      this.emitUpdate(this.accounts)
    }
  }

  private save() {
    const usersWithoutTokens = this.accounts.map(account =>
      account.withToken('')
    )
    this.dataStore.setItem('users', JSON.stringify(usersWithoutTokens))

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
    account.refreshToken,
    account.tokenExpiresAt,
    account.login
  )
}
