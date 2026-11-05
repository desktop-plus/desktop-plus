import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import {
  SignInResult,
  SignInStore,
  SignInStep,
  SelfHostedApiType,
} from '../../src/lib/stores/sign-in-store'
import { AccountsStore } from '../../src/lib/stores'
import { Account } from '../../src/models/account'
import { getDotComAPIEndpoint, getHTMLURL } from '../../src/lib/api'
import {
  getRegisteredEndpoint,
  resetEndpointApiTypeRegistryForTesting,
} from '../../src/lib/endpoint-api-type-registry'
import { InMemoryStore, AsyncInMemoryStore } from '../helpers/stores'
import { shell } from '../../src/lib/app-shell'

function createAccountsStore(
  accounts: ReadonlyArray<Account> = []
): AccountsStore {
  const dataStore = new InMemoryStore()
  if (accounts.length > 0) {
    const serialized = accounts.map(a => ({
      login: a.login,
      endpoint: a.endpoint,
      token: a.token,
      emails: a.emails,
      avatarURL: a.avatarURL,
      id: a.id,
      name: a.name,
      plan: a.plan,
    }))
    dataStore.setItem('users', JSON.stringify(serialized))
  }
  return new AccountsStore(dataStore, new AsyncInMemoryStore())
}

function createDotComAccount(login = 'octocat'): Account {
  return new Account(
    login,
    getDotComAPIEndpoint(),
    'dotcom',
    'test-token',
    [],
    'https://avatars.githubusercontent.com/u/1',
    1,
    login,
    'free'
  )
}

function createEnterpriseAccount(
  login = 'enterprise-user',
  endpoint = 'https://github.example.com/api/v3'
): Account {
  return new Account(
    login,
    endpoint,
    'enterprise',
    'ent-token',
    [],
    '',
    2,
    login,
    'free'
  )
}

function createSelfHostedAccount(
  login: string,
  endpoint: string,
  apiType: SelfHostedApiType
): Account {
  return new Account(login, endpoint, apiType, 'pat', [], '', 3, login)
}

/** Serve every request from the given handler for the duration of `fn`. */
async function withFetch(
  handler: (url: string) => Response,
  fn: () => Promise<void>
) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(input.toString())) as typeof globalThis.fetch

  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('SignInStore', () => {
  let accountsStore: AccountsStore
  let signInStore: SignInStore

  beforeEach(() => {
    localStorage.removeItem('api-endpoint-types')
    resetEndpointApiTypeRegistryForTesting()
    accountsStore = createAccountsStore()
    signInStore = new SignInStore(accountsStore)
  })

  afterEach(() => {
    localStorage.removeItem('api-endpoint-types')
    resetEndpointApiTypeRegistryForTesting()
  })

  describe('initial state', () => {
    it('starts with null state', () => {
      assert.equal(signInStore.getState(), null)
    })
  })

  describe('beginDotComSignIn', () => {
    it('retains a second login and refreshes a repeated login after authentication', async () => {
      const first = createDotComAccount()
      const second = createDotComAccount('second-user')
      const refreshed = first.withToken('refreshed-token')
      await accountsStore.addAccount(first)
      signInStore.onDidAuthenticate(account => {
        void accountsStore.addAccount(account)
      })

      for (const account of [second, refreshed]) {
        signInStore.beginDotComSignIn()
        await signInStore.authenticateWithBrowser()
        const state = signInStore.getState()
        assert.ok(state?.kind === SignInStep.Authentication)
        state.oauthState?.onAuthCompleted(account)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.strictEqual(signInStore.getState()?.kind, SignInStep.Success)
      }

      assert.deepStrictEqual(await accountsStore.getAll(), [refreshed, second])
    })

    it('transitions to Authentication step when no existing account', async () => {
      signInStore.beginDotComSignIn()
      const state = signInStore.getState()
      assert.notEqual(state, null)
      assert.equal(state?.kind, SignInStep.Authentication)
      if (state?.kind === SignInStep.Authentication) {
        assert.equal(state.endpoint, getDotComAPIEndpoint())
        assert.equal(state.error, null)
        assert.equal(state.loading, false)
      }
    })

    it('allows another sign-in when a dotcom account exists', async () => {
      const existingAccount = createDotComAccount()
      accountsStore = createAccountsStore()
      signInStore = new SignInStore(accountsStore)

      await accountsStore.addAccount(existingAccount)

      signInStore.beginDotComSignIn()
      const state = signInStore.getState()
      assert.notEqual(state, null)
      assert.equal(state?.kind, SignInStep.Authentication)
      await signInStore.authenticateWithBrowser()
      assert.deepStrictEqual(await accountsStore.getAll(), [existingAccount])
      signInStore.reset()
    })

    it('calls resultCallback when provided', async () => {
      let callbackCalled = false
      signInStore.beginDotComSignIn(() => {
        callbackCalled = true
      })

      // Reset triggers the callback with 'cancelled'
      signInStore.reset()
      assert.equal(callbackCalled, true)
    })
  })

  describe('beginEnterpriseSignIn', () => {
    it('transitions to EndpointEntry step', () => {
      signInStore.beginEnterpriseSignIn()
      const state = signInStore.getState()
      assert.notEqual(state, null)
      assert.equal(state?.kind, SignInStep.EndpointEntry)
    })

    it('sets initial state correctly', () => {
      signInStore.beginEnterpriseSignIn()
      const state = signInStore.getState()
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.equal(state.error, null)
        assert.equal(state.loading, false)
      }
    })

    it('resets previous state before starting', () => {
      // Start a dotcom sign-in first
      signInStore.beginDotComSignIn()
      assert.equal(signInStore.getState()?.kind, SignInStep.Authentication)

      // Starting enterprise sign-in should replace that state
      signInStore.beginEnterpriseSignIn()
      assert.equal(signInStore.getState()?.kind, SignInStep.EndpointEntry)
    })
  })

  describe('setEndpoint', () => {
    it('marks a new Enterprise server requested by Git for confirmation', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)

      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      assert.strictEqual(state.endpoint, 'https://github.example.com/api/v3')
      assert.strictEqual(state.isUnrecognizedEnterpriseServer, true)
    })

    it('retains server confirmation guidance while opening the browser', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)

      await signInStore.authenticateWithBrowser()

      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      assert.strictEqual(state.isUnrecognizedEnterpriseServer, true)
      assert.notStrictEqual(state.oauthState, undefined)
      signInStore.reset()
    })

    it('does not resolve OAuth callbacks before browser authentication', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)
      const state = signInStore.getState()

      await signInStore.resolveOAuthRequest({
        name: 'oauth',
        code: 'test-code',
        state: 'test-state',
      })

      assert.strictEqual(signInStore.getState(), state)
    })

    it('cancels a Git-requested sign-in before opening the browser', async () => {
      const results: string[] = []
      signInStore.beginEnterpriseSignIn(result => results.push(result.kind))
      await signInStore.setEndpoint('https://github.example.com', true)

      signInStore.reset()

      assert.strictEqual(signInStore.getState(), null)
      assert.deepStrictEqual(results, ['cancelled'])
    })

    it('shows guidance again after cancelling and starting a new sign-in', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)
      signInStore.reset()

      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)

      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      assert.strictEqual(state.isUnrecognizedEnterpriseServer, true)
    })

    it('validates Git-requested endpoints before showing confirmation guidance', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('http://github.example.com', true)

      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.EndpointEntry)
      assert.ok(state.error)
      assert.strictEqual(state.loading, false)
    })

    for (const url of [
      'https://github.com',
      'https://api.github.com',
      'https://example.ghe.com',
    ]) {
      it(`does not show server confirmation guidance for ${url}`, async () => {
        signInStore.beginEnterpriseSignIn()
        await signInStore.setEndpoint(url, true)

        const state = signInStore.getState()
        assert.ok(state?.kind === SignInStep.Authentication)
        assert.notStrictEqual(state.isUnrecognizedEnterpriseServer, true)
      })
    }

    it('allows another account without server guidance for a known Enterprise endpoint', async () => {
      await accountsStore.addAccount(createEnterpriseAccount())
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com', true)

      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      assert.strictEqual(state.isUnrecognizedEnterpriseServer, false)
    })

    it('transitions to Authentication step for valid enterprise URL', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.Authentication)
    })

    it('redirects to dotcom flow for github.com URLs', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.com')

      const state = signInStore.getState()
      // Should redirect to the Authentication step with the dotcom endpoint
      assert.equal(state?.kind, SignInStep.Authentication)
      if (state?.kind === SignInStep.Authentication) {
        assert.equal(state.endpoint, getDotComAPIEndpoint())
      }
    })

    it('redirects to dotcom flow for api.github.com URLs', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://api.github.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.Authentication)
      if (state?.kind === SignInStep.Authentication) {
        assert.equal(state.endpoint, getDotComAPIEndpoint())
      }
    })

    it('sets error for non-HTTPS URL', async () => {
      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('http://github.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.notEqual(state.error, null)
        assert.equal(state.loading, false)
      }
    })

    it('retains an existing enterprise account when starting another sign-in', async () => {
      const endpoint = 'https://github.example.com/api/v3'
      const existingAccount = createEnterpriseAccount('user', endpoint)
      accountsStore = createAccountsStore()
      signInStore = new SignInStore(accountsStore)

      await accountsStore.addAccount(existingAccount)

      signInStore.beginEnterpriseSignIn()
      await signInStore.setEndpoint('https://github.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.Authentication)
      await signInStore.authenticateWithBrowser()
      assert.deepStrictEqual(await accountsStore.getAll(), [existingAccount])
      signInStore.reset()
    })
  })

  describe('beginSelfHostedSignIn', () => {
    it('transitions to EndpointEntry with the chosen provider', () => {
      signInStore.beginSelfHostedSignIn('gitlab')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.equal(state.apiType, 'gitlab')
        assert.equal(state.error, null)
        assert.equal(state.loading, false)
      }
    })

    it('resets previous state before starting', () => {
      signInStore.beginDotComSignIn()
      signInStore.beginSelfHostedSignIn('forgejo')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.equal(state.apiType, 'forgejo')
      }
    })
  })

  describe('setEndpoint for a self-hosted instance', () => {
    it('derives the GitLab API endpoint and advances to token entry', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://git.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.equal(state.endpoint, 'https://git.example.com/api/v4')
        assert.equal(state.webBaseUrl, 'https://git.example.com')
        assert.equal(state.apiType, 'gitlab')
        assert.equal(state.error, null)
        assert.equal(state.loading, false)
      }
    })

    it('derives the Forgejo API endpoint and advances to token entry', async () => {
      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('https://git.example.com/')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.equal(state.endpoint, 'https://git.example.com/api/v1')
        assert.equal(state.webBaseUrl, 'https://git.example.com')
      }
    })

    it('keeps an explicit port', async () => {
      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('git.example.com:3000')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.equal(state.endpoint, 'https://git.example.com:3000/api/v1')
        assert.equal(state.webBaseUrl, 'https://git.example.com:3000')
      }
    })

    it('rejects an empty address', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('   ')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /valid URL/)
      }
    })

    it('rejects an address with a path', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://example.com/gitlab')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /can't contain a path/)
        assert.equal(state.loading, false)
      }
    })

    it('accepts an address with redundant trailing slashes', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://git.example.com//')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.equal(state.webBaseUrl, 'https://git.example.com')
      }
    })

    it('keeps an IPv6 literal and its port', async () => {
      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('https://[2001:db8::1]:3000')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.equal(state.endpoint, 'https://[2001:db8::1]:3000/api/v1')
      }
    })

    it('rejects an unbracketed IPv6 address with a friendly error', async () => {
      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('https://::1')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /valid URL/)
      }
    })

    it('rejects a GitHub address', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://github.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /is a GitHub address/)
      }
    })

    it('rejects a non-HTTPS address', async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('http://git.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /Only https is supported/)
      }
    })

    it('rejects a host already used by another provider', async () => {
      await accountsStore.addAccount(
        createEnterpriseAccount('joan', 'https://git.example.com/api/v3')
      )

      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://git.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /already associated with a/)
      }
    })

    it('rejects a host already signed in to as another self-hosted provider', async () => {
      await accountsStore.addAccount(
        createSelfHostedAccount(
          'joan',
          'https://git.example.com/api/v1',
          'gitea'
        )
      )

      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('https://git.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.EndpointEntry)
      if (state?.kind === SignInStep.EndpointEntry) {
        assert.match(state.error?.message ?? '', /already associated with a/)
      }
    })

    it('allows the same hostname on a different port', async () => {
      await accountsStore.addAccount(
        createSelfHostedAccount(
          'joan',
          'https://git.example.com:8443/api/v4',
          'gitlab'
        )
      )

      signInStore.beginSelfHostedSignIn('forgejo')
      await signInStore.setEndpoint('https://git.example.com:3000')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
    })
  })

  describe('setToken', () => {
    const gitlabUser = {
      id: 42,
      username: 'joan',
      name: 'Joan',
      avatar_url: 'https://git.example.com/avatar.png',
      web_url: 'https://git.example.com/joan',
    }

    const beginTokenEntry = async () => {
      signInStore.beginSelfHostedSignIn('gitlab')
      await signInStore.setEndpoint('https://git.example.com')
      assert.equal(signInStore.getState()?.kind, SignInStep.TokenEntry)
    }

    const signIn = async (
      apiType: 'gitlab' | 'forgejo' | 'gitea',
      address: string,
      token = 'pat-1234'
    ) => {
      const results = new Array<SignInResult>()
      signInStore.beginSelfHostedSignIn(apiType, r => results.push(r))
      await signInStore.setEndpoint(address)
      assert.equal(signInStore.getState()?.kind, SignInStep.TokenEntry)

      await withFetch(
        url =>
          url.includes('/user/emails')
            ? jsonResponse([])
            : jsonResponse(gitlabUser),
        () => signInStore.setToken(token)
      )

      return results
    }

    it('signs in to GitLab with a personal access token', async () => {
      const results = await signIn('gitlab', 'https://git.example.com')

      assert.equal(signInStore.getState()?.kind, SignInStep.Success)
      assert.equal(results.length, 1)

      const [result] = results
      assert.equal(result.kind, 'success')
      if (result.kind === 'success') {
        const { account } = result
        assert.equal(account.login, 'joan')
        assert.equal(account.apiType, 'gitlab')
        assert.equal(account.endpoint, 'https://git.example.com/api/v4')
        assert.equal(account.token, 'pat-1234')
        assert.ok(!accountsStore.isRefreshable(account))
        assert.deepEqual(await accountsStore.getAll(), [account])
      }
    })

    it('reports an error without signing in when the account cannot be saved', async t => {
      t.mock.method(accountsStore, 'addAccount', async () => null)
      const results = await signIn('gitlab', 'https://git.example.com')

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.match(state.error?.message ?? '', /Unable to save/)
        assert.equal(state.loading, false)
      }
      assert.deepEqual(results, [])
    })

    it('signs in to Forgejo with a personal access token', async () => {
      const results = await signIn('forgejo', 'https://git.example.com:3000')

      const [result] = results
      assert.equal(result?.kind, 'success')
      if (result?.kind === 'success') {
        assert.equal(result.account.apiType, 'forgejo')
        assert.equal(
          result.account.endpoint,
          'https://git.example.com:3000/api/v1'
        )
      }
    })

    it('registers the instance so its web URLs resolve', async () => {
      const results = await signIn('forgejo', 'https://git.example.com:3000')
      const [result] = results
      assert.equal(result?.kind, 'success')

      const endpoint = 'https://git.example.com:3000/api/v1'
      assert.deepEqual(getRegisteredEndpoint(endpoint), {
        apiType: 'forgejo',
        webBaseUrl: 'https://git.example.com:3000',
      })
      assert.equal(getHTMLURL(endpoint), 'https://git.example.com:3000')
    })

    it('reports a friendly error when the token is rejected', async () => {
      await beginTokenEntry()

      await withFetch(
        () => jsonResponse({ message: '401 Unauthorized' }, 401),
        () => signInStore.setToken('bad-token')
      )

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.match(
          state.error?.message ?? '',
          /personal access token was rejected by https:\/\/git.example.com/
        )
        assert.equal(state.loading, false)
      }
    })

    it('reports a friendly error when the instance has no such API', async () => {
      await beginTokenEntry()

      await withFetch(
        () => jsonResponse({ message: '404 Not Found' }, 404),
        () => signInStore.setToken('pat-1234')
      )

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.match(
          state.error?.message ?? '',
          /Couldn't find a GitLab API at https:\/\/git.example.com\/api\/v4/
        )
      }
    })

    it('reports a friendly error when the instance is unreachable', async () => {
      await beginTokenEntry()

      const original = globalThis.fetch
      globalThis.fetch = (async () => {
        throw new TypeError('Failed to fetch')
      }) as typeof globalThis.fetch

      try {
        await signInStore.setToken('pat-1234')
      } finally {
        globalThis.fetch = original
      }

      const state = signInStore.getState()
      assert.equal(state?.kind, SignInStep.TokenEntry)
      if (state?.kind === SignInStep.TokenEntry) {
        assert.match(
          state.error?.message ?? '',
          /Could not sign in to https:\/\/git.example.com\. Failed to fetch/
        )
      }
    })
  })

  describe('beginSignInForAccount', () => {
    it('enters authentication at the supplied API endpoint with the expected login', () => {
      signInStore.beginSignInForAccount(
        'https://enterprise.example.com/api/v3',
        'mona'
      )
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      assert.strictEqual(
        state.endpoint,
        'https://enterprise.example.com/api/v3'
      )
      assert.strictEqual(state.expectedLogin, 'mona')
      assert.strictEqual(state.error, null)
      assert.strictEqual(state.loading, false)
    })

    it('opens OAuth with the required login and signup disabled', async t => {
      const openedURLs: string[] = []
      t.mock.method(shell, 'openExternal', async (url: string) => {
        openedURLs.push(url)
      })
      signInStore.beginSignInForAccount(getDotComAPIEndpoint(), 'mona+work')
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      const url = new URL(openedURLs[0])
      assert.strictEqual(url.searchParams.get('login'), 'mona+work')
      assert.strictEqual(url.searchParams.get('allow_signup'), 'false')
      assert.strictEqual(url.searchParams.get('state'), state.oauthState?.state)
      signInStore.reset()
    })

    it('accepts matching endpoint and login case-insensitively', async () => {
      const authenticated: Account[] = []
      const results: SignInResult[] = []
      const account = createDotComAccount()
      signInStore.onDidAuthenticate(account => authenticated.push(account))
      signInStore.beginSignInForAccount(
        account.endpoint.toUpperCase(),
        account.login.toUpperCase(),
        result => results.push(result)
      )
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      state.oauthState?.onAuthCompleted(account)
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.strictEqual(signInStore.getState()?.kind, SignInStep.Success)
      assert.deepStrictEqual(authenticated, [account])
      assert.deepStrictEqual(results, [{ kind: 'success', account }])
    })

    it('ignores an OAuth callback with an invalid state', async () => {
      signInStore.beginSignInForAccount(getDotComAPIEndpoint(), 'octocat')
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      await signInStore.resolveOAuthRequest({
        name: 'oauth',
        state: 'incorrect-state',
        code: 'unused-code',
      })
      assert.strictEqual(signInStore.getState(), state)
      signInStore.reset()
    })

    it('does not authenticate an account resolved after the session changes', async () => {
      const authenticated: Account[] = []
      signInStore.onDidAuthenticate(account => authenticated.push(account))
      signInStore.beginSignInForAccount(getDotComAPIEndpoint(), 'octocat')
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      state.oauthState?.onAuthCompleted(createDotComAccount())
      signInStore.beginSignInForAccount(getDotComAPIEndpoint(), 'other-user')
      await signInStore.authenticateWithBrowser()
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.deepStrictEqual(authenticated, [])
      const currentState = signInStore.getState()
      assert.ok(currentState?.kind === SignInStep.Authentication)
      assert.strictEqual(currentState.expectedLogin, 'other-user')
      signInStore.reset()
    })
  })

  describe('reset', () => {
    it('reports cancellation once even when its callback resets again', () => {
      const results: SignInResult[] = []
      signInStore.beginDotComSignIn(result => {
        results.push(result)
        signInStore.reset()
      })
      signInStore.reset()
      signInStore.reset()
      assert.deepStrictEqual(results, [{ kind: 'cancelled' }])
      assert.strictEqual(signInStore.getState(), null)
    })

    it('delivers one success when completion is repeated and success observers reset', async () => {
      const results: SignInResult[] = []
      const authenticated: Account[] = []
      signInStore.onDidAuthenticate(account => authenticated.push(account))
      signInStore.onDidUpdate(state => {
        if (state?.kind === SignInStep.Success) {
          signInStore.reset()
        }
      })
      signInStore.beginDotComSignIn(result => results.push(result))
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      const account = createDotComAccount()
      state.oauthState?.onAuthCompleted(account)
      state.oauthState?.onAuthCompleted(account)
      await new Promise<void>(resolve => setImmediate(resolve))
      signInStore.reset()
      assert.deepStrictEqual(authenticated, [account])
      assert.deepStrictEqual(results, [{ kind: 'success', account }])
      assert.strictEqual(signInStore.getState(), null)
    })

    it('reports success exactly once when the result callback resets the store', async () => {
      const results: SignInResult[] = []
      signInStore.beginDotComSignIn(result => {
        results.push(result)
        if (result.kind === 'success') {
          signInStore.reset()
        }
      })
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      state.oauthState?.onAuthCompleted(createDotComAccount())
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.strictEqual(signInStore.getState(), null)
      assert.deepStrictEqual(
        results.map(result => result.kind),
        ['success']
      )
    })

    it('does not overwrite a new sign-in started by a success callback', async () => {
      const results: SignInResult[] = []
      const nextResults: SignInResult[] = []
      signInStore.beginDotComSignIn(result => {
        results.push(result)
        if (result.kind === 'success') {
          signInStore.beginSignInForAccount(
            getDotComAPIEndpoint(),
            'next-account',
            next => nextResults.push(next)
          )
        }
      })
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      state.oauthState?.onAuthCompleted(createDotComAccount())
      await new Promise<void>(resolve => setImmediate(resolve))

      const next = signInStore.getState()
      assert.ok(next?.kind === SignInStep.Authentication)
      assert.strictEqual(next.expectedLogin, 'next-account')
      assert.deepStrictEqual(
        results.map(result => result.kind),
        ['success']
      )
      assert.deepStrictEqual(nextResults, [])
      signInStore.reset()
      assert.deepStrictEqual(nextResults, [{ kind: 'cancelled' }])
    })

    it('delivers success after the authentication subscriber resets the store', async () => {
      const events: string[] = []
      signInStore.onDidAuthenticate(() => {
        events.push('authenticated')
        signInStore.reset()
      })
      signInStore.beginDotComSignIn(result => events.push(result.kind))
      await signInStore.authenticateWithBrowser()
      const state = signInStore.getState()
      assert.ok(state?.kind === SignInStep.Authentication)
      state.oauthState?.onAuthCompleted(createDotComAccount())
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.deepStrictEqual(events, ['authenticated', 'success'])
      assert.strictEqual(signInStore.getState(), null)
    })

    it('clears the state back to null', () => {
      signInStore.beginDotComSignIn()
      assert.notEqual(signInStore.getState(), null)

      signInStore.reset()
      assert.equal(signInStore.getState(), null)
    })

    it('calls resultCallback with cancelled', async () => {
      let result: any = null
      signInStore.beginDotComSignIn(r => {
        result = r
      })

      signInStore.reset()
      assert.notEqual(result, null)
      assert.equal(result.kind, 'cancelled')
    })
  })

  describe('onDidUpdate', () => {
    it('emits updates when state changes', async () => {
      const states: Array<any> = []
      signInStore.onDidUpdate(state => {
        states.push(state)
      })

      signInStore.beginDotComSignIn()
      assert.equal(states.length, 1)
      assert.equal(states[0]?.kind, SignInStep.Authentication)
    })

    it('emits null when reset', () => {
      const states: Array<any> = []
      signInStore.onDidUpdate(state => {
        states.push(state)
      })

      signInStore.beginDotComSignIn()
      signInStore.reset()

      // Should have: cancelled callback + null state + possibly more
      const lastState = states[states.length - 1]
      assert.equal(lastState, null)
    })
  })
})
