import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Account } from '../../src/models/account'
import { AccountsStore } from '../../src/lib/stores/accounts-store'
import { AccountRequiresSignInError } from '../../src/lib/credential-sessions'
import {
  IOAuthToken,
  OAuthRefreshRejectedError,
  OAuthTokenResponseError,
} from '../../src/lib/oauth-token'
import {
  deserializeAccountCredential,
  serializeAccountCredential,
} from '../../src/lib/account-credential'
import { getKeyForAccount } from '../../src/lib/auth'
import { API, BitbucketCloudAPIEndpoint } from '../../src/lib/api'
import { createMockAPIIdentity } from '../helpers/mock-api'
import { InMemoryStore, AsyncInMemoryStore } from '../helpers/stores'
import { AppStore } from '../../src/lib/stores/app-store'

const now = 1_800_000_000_000
const account = new Account(
  'octocat',
  'https://api.github.com',
  'dotcom',
  'old-access',
  [],
  '',
  1,
  'Octocat'
)
const rotating: IOAuthToken = {
  accessToken: account.token,
  refreshToken: 'old-refresh',
  expiresAt: now + 600_000,
  refreshTokenExpiresAt: now + 100_000_000,
}
const renewed: IOAuthToken = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  expiresAt: now + 28_800_000,
  refreshTokenExpiresAt: now + 200_000_000,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(
  renew: (endpoint: string, token: string) => Promise<IOAuthToken> = async () =>
    renewed
) {
  const data = new InMemoryStore()
  const secure = new AsyncInMemoryStore()
  const revoked: string[] = []
  const store = new AccountsStore(
    data,
    secure,
    renew,
    () => now,
    async a => {
      revoked.push(a.token)
      return true
    }
  )
  return { store, data, secure, revoked }
}

describe('OAuth credential persistence', () => {
  it('reads existing access-token entries', () => {
    assert.deepEqual(deserializeAccountCredential('legacy'), {
      accessToken: 'legacy',
    })
    assert.equal(
      serializeAccountCredential({ accessToken: 'legacy' }),
      'legacy'
    )
  })

  it('round trips the entire rotating pair and reauthentication marker', () => {
    assert.deepEqual(
      deserializeAccountCredential(serializeAccountCredential(rotating)),
      rotating
    )
    assert.equal(
      deserializeAccountCredential(serializeAccountCredential(null)),
      null
    )
  })

  it('rejects corrupted or unsupported records without exposing secrets', () => {
    for (const value of [
      'github-desktop-oauth:secret',
      'github-desktop-oauth:{"version":2,"credential":"secret"}',
      'github-desktop-oauth:{"version":1,"credential":{"accessToken":"secret"}}',
      'github-desktop-oauth:{"version":1,"credential":{"accessToken":" ","refreshToken":"secret"}}',
      'github-desktop-oauth:{"version":1,"credential":{"accessToken":"secret","refreshToken":"a secret"}}',
    ]) {
      assert.throws(
        () => deserializeAccountCredential(value),
        error => error instanceof Error && !error.message.includes('secret')
      )
    }
  })

  it('stores secrets only in secure storage and restores metadata on restart', async () => {
    const { store, data, secure } = setup()
    await store.addAccount(account, rotating)
    const raw = data.getItem('users') ?? ''
    assert.ok(!raw.includes('old-access') && !raw.includes('old-refresh'))
    assert.deepEqual(
      deserializeAccountCredential(
        await secure.getItem(getKeyForAccount(account), account.login)
      ),
      rotating
    )
    const restarted = new AccountsStore(
      data,
      secure,
      async () => renewed,
      () => now
    )
    assert.equal(
      await restarted.resolveToken(account.endpoint, account.token),
      renewed.accessToken
    )
  })

  it('preserves session identity through token, lease, and profile snapshots', async t => {
    const { store } = setup()
    await store.addAccount(account, rotating)
    const fresh = await store.getAccountWithFreshToken(account)
    const [published] = await store.getAll()
    assert.ok(published)
    const lease = await store.leaseAccountToken(fresh, 'snapshot-lineage')
    t.after(lease.release)
    t.mock.method(API.prototype, 'fetchAccount', async () => ({
      ...createMockAPIIdentity(),
      name: 'Updated Name',
    }))
    t.mock.method(API.prototype, 'fetchEmails', async () => [])
    t.mock.method(API.prototype, 'fetchUserCopilotInfo', async () => null)
    t.mock.method(API.prototype, 'fetchFeatureFlags', async () => [])

    await store.refresh()
    const [profile] = await store.getAll()
    assert.ok(profile)
    assert.equal(profile.name, 'Updated Name')
    const snapshots = [account, fresh, published, lease.account, profile]
    for (const snapshot of snapshots) {
      assert.deepEqual(await store.createTokenGetter(snapshot)(), {
        accessToken: renewed.accessToken,
        expiresAt: renewed.expiresAt,
      })
    }
    lease.release()

    await store.removeAccount(profile)
    const replacement = await store.addAccount(profile, {
      ...renewed,
      refreshToken: 'replacement-refresh',
    })
    assert.ok(replacement)
    for (const snapshot of snapshots) {
      assert.throws(
        () => store.createTokenGetter(snapshot),
        AccountRequiresSignInError
      )
    }
    assert.deepEqual(await store.createTokenGetter(replacement)(), {
      accessToken: renewed.accessToken,
      expiresAt: renewed.expiresAt,
    })
    assert.equal(
      (await store.getAccountWithFreshToken(account)).token,
      replacement.token
    )
  })

  it('signs out accounts marked as requiring sign-in by an earlier build', async () => {
    const { store, data, secure } = setup()
    await store.addAccount(account, rotating)
    await secure.setItem(
      getKeyForAccount(account),
      account.login,
      serializeAccountCredential(null)
    )
    const restarted = new AccountsStore(data, secure)
    assert.deepEqual(await restarted.getAll(), [])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
    assert.equal(data.getItem('users'), '[]')
  })
})

describe('Unused OAuth credential cleanup', () => {
  for (const endpoint of [
    'https://api.github.com',
    'https://github.example.com/api/v3',
  ]) {
    it(`revokes a credential before account discovery at ${endpoint}`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const store = new AccountsStore(
        new InMemoryStore(),
        new AsyncInMemoryStore()
      )
      let signal: AbortSignal | null | undefined
      const fetch = t.mock.method(
        globalThis,
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          assert.equal(input, `${endpoint}/applications//token`)
          assert.equal(init?.method, 'DELETE')
          assert.ok(typeof init?.body === 'string')
          assert.deepEqual(JSON.parse(init.body), { access_token: 'unused' })
          signal = init.signal
          return new Response(null, { status: 204 })
        }
      )
      await store.revokeUnusedToken({
        endpoint,
        apiType:
          endpoint === 'https://api.github.com' ? 'dotcom' : 'enterprise',
        token: 'unused',
      })
      assert.equal(fetch.mock.callCount(), 1)
      assert.deepEqual(await store.getAll(), [])
      t.mock.timers.tick(30_000)
      assert.equal(signal?.aborted, false)
    })
  }
})

describe('Coordinated account token renewal', () => {
  it('allows explicitly anonymous public API requests while an account requires sign-in', async t => {
    const { store } = setup()
    await store.addAccount(account)
    await store.invalidateToken(account.endpoint, account.token)
    t.after(API.setTokenProvider(store.resolveToken))
    let calls = 0
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, init: RequestInit) => {
        calls++
        assert.equal(new Headers(init.headers).has('Authorization'), false)
        return Response.json({ name: 'public-repo' })
      }
    )
    const repository = await API.fromAccount(
      Account.anonymous()
    ).fetchRepository('octocat', 'public-repo')
    assert.equal(repository?.name, 'public-repo')
    assert.equal(calls, 1)
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
  })
  it('leaves non-expiring credentials alone', async () => {
    const { store } = setup(async () => {
      throw new Error('Unexpected refresh')
    })
    await store.addAccount(account)
    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      account.token
    )
  })

  for (const expiresAt of [now + 600_000, now - 1, undefined]) {
    it(`renews at the inclusive ten-minute boundary, after expiry, or without expiry (${expiresAt})`, async () => {
      const { store } = setup()
      await store.addAccount(account, { ...rotating, expiresAt })
      assert.equal(
        await store.resolveToken(account.endpoint, account.token),
        renewed.accessToken
      )
    })
  }

  it('does not renew outside the margin', async () => {
    const { store } = setup(async () => {
      throw new Error('Unexpected refresh')
    })
    await store.addAccount(account, { ...rotating, expiresAt: now + 600_001 })
    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      account.token
    )
  })

  it('shares one exchange across simultaneous callers and updates stale snapshots', async () => {
    let calls = 0
    const gate = deferred<IOAuthToken>()
    const { store, secure } = setup(async (endpoint, token) => {
      assert.equal(endpoint, 'https://github.com')
      assert.equal(token, rotating.refreshToken)
      calls++
      return gate.promise
    })
    await store.addAccount(account, rotating)
    const requests = Array.from({ length: 50 }, () =>
      store.resolveToken(account.endpoint, account.token)
    )
    gate.resolve(renewed)
    assert.deepEqual(
      await Promise.all(requests),
      Array(50).fill(renewed.accessToken)
    )
    assert.equal(calls, 1)
    assert.equal(
      (await store.getAccountWithFreshToken(account)).token,
      renewed.accessToken
    )
    assert.deepEqual(
      deserializeAccountCredential(
        await secure.getItem(getKeyForAccount(account), account.login)
      ),
      renewed
    )
  })

  for (const failRenewal of [false, true]) {
    it(`joins a longer-margin renewal before returning an otherwise valid token (failure: ${failRenewal})`, async () => {
      const gate = deferred<void>()
      const started = deferred<void>()
      let calls = 0
      const { store } = setup(async () => {
        calls++
        started.resolve()
        await gate.promise
        if (failRenewal) {
          throw new Error('Network unavailable')
        }
        return renewed
      })
      await store.addAccount(account, {
        ...rotating,
        expiresAt: now + 30 * 60 * 1000,
      })
      const copilot = store.getAccountWithFreshToken(account, 61 * 60 * 1000)
      await started.promise
      let settled = 0
      const requests = [
        copilot.then(a => a.token),
        store.resolveToken(account.endpoint, account.token),
        store.getAccountWithFreshToken(account).then(a => a.token),
      ].map(request =>
        request.finally(() => {
          settled++
        })
      )
      const result = Promise.allSettled(requests)
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(settled, 0)
      } finally {
        gate.resolve()
      }
      assert.deepEqual(
        await result,
        requests.map(() =>
          failRenewal
            ? {
                status: 'rejected',
                reason: new Error(
                  'Unable to renew your session. Check your connection and try again shortly.'
                ),
              }
            : { status: 'fulfilled', value: renewed.accessToken }
        )
      )
      assert.equal(calls, 1)
    })
  }

  it('retains credentials and retries immediately after a temporary failure', async () => {
    let calls = 0
    const { store, secure } = setup(async () => {
      calls++
      if (calls === 1) {
        throw new Error('Network unavailable')
      }
      return renewed
    })
    await store.addAccount(account, rotating)
    let prompts = 0
    store.onTokenInvalidated(() => prompts++)
    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      /try again shortly/
    )
    assert.equal(prompts, 0)
    assert.deepEqual(
      deserializeAccountCredential(
        await secure.getItem(getKeyForAccount(account), account.login)
      ),
      rotating
    )
    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      renewed.accessToken
    )
    assert.equal(calls, 2)
    assert.equal(prompts, 0)
    assert.deepEqual(
      deserializeAccountCredential(
        await secure.getItem(getKeyForAccount(account), account.login)
      ),
      renewed
    )
  })

  for (const error of [
    new OAuthRefreshRejectedError(),
    new OAuthTokenResponseError(),
  ]) {
    it(`signs out and prompts once for ${error.name}`, async () => {
      const { store, data, secure } = setup(async () => {
        throw error
      })
      await store.addAccount(account, rotating)
      let prompts = 0
      let accountsAtPrompt: ReadonlyArray<Account> = [account]
      store.onDidUpdate(accounts => {
        accountsAtPrompt = accounts
      })
      store.onTokenInvalidated(a => {
        prompts++
        assert.equal(a.token, '')
        assert.deepEqual(accountsAtPrompt, [])
      })
      await assert.rejects(store.resolveToken(account.endpoint, account.token))
      await assert.rejects(
        store.resolveToken(account.endpoint, account.token),
        AccountRequiresSignInError
      )
      assert.equal(prompts, 1)
      assert.deepEqual(await store.getAll(), [])
      assert.equal(
        await secure.getItem(getKeyForAccount(account), account.login),
        null
      )
      const restarted = new AccountsStore(data, secure)
      assert.deepEqual(await restarted.getAll(), [])
    })
  }

  it('does not return a new token when persistence fails or downgrade storage', async t => {
    const { store, secure, data, revoked } = setup()
    await store.addAccount(account, rotating)
    t.mock.method(secure, 'setItem', async () => {
      throw new Error('Keychain locked')
    })
    let prompts = 0
    store.onTokenInvalidated(() => prompts++)
    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      /Unable to save/
    )
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
    assert.deepEqual(revoked, [renewed.accessToken])
    assert.equal(prompts, 1)
    assert.deepEqual(await store.getAll(), [])
    assert.ok(
      !data.getItem('users')?.includes(renewed.refreshToken ?? 'new-refresh')
    )
  })

  it('stays signed out if secure deletion fails after renewal rejection', async t => {
    const { store, secure, data } = setup(async () => {
      throw new OAuthRefreshRejectedError()
    })
    await store.addAccount(account, rotating)
    t.mock.method(secure, 'deleteItem', async () => {
      throw new Error('Keychain locked')
    })
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      OAuthRefreshRejectedError
    )
    assert.deepEqual(await store.getAll(), [])
    assert.equal(errors.length, 1)
    assert.deepEqual(await new AccountsStore(data, secure).getAll(), [])
  })

  it('persists recovery and releases callers before a stalled revocation times out', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const data = new InMemoryStore()
    const secure = new AsyncInMemoryStore()
    const store = new AccountsStore(
      data,
      secure,
      async () => renewed,
      () => now
    )
    await store.addAccount(account, rotating)
    const original = secure.setItem.bind(secure)
    t.mock.method(
      secure,
      'setItem',
      async (key: string, login: string, value: string) => {
        if (value === serializeAccountCredential(renewed)) {
          throw new Error('Keychain locked')
        }
        return original(key, login, value)
      }
    )
    let signal: AbortSignal | null | undefined
    const stalled = deferred<Response>()
    t.after(() => stalled.resolve(new Response(null, { status: 204 })))
    const fetch = t.mock.method(
      globalThis,
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return stalled.promise
      }
    )
    const warnings = t.mock.method(log, 'warn')
    let prompts = 0
    store.onTokenInvalidated(() => prompts++)
    const results = Promise.allSettled([
      store.resolveToken(account.endpoint, account.token),
      store.getAccountWithFreshToken(account),
    ])
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(prompts, 1)
    assert.deepEqual(await store.getAll(), [])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
    for (const result of await results) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert.match(result.reason.message, /Unable to save/)
      }
    }
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(signal?.aborted, false)
    t.mock.timers.tick(29_999)
    assert.equal(signal?.aborted, false)
    t.mock.timers.tick(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(signal?.aborted, true)
    assert.deepEqual(
      warnings.mock.calls.map(call => call.arguments),
      [['Unable to revoke unused OAuth credentials.']]
    )
  })

  for (const rejects of [false, true]) {
    it(`keeps recovery independent of revocation failure (rejects: ${rejects})`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const data = new InMemoryStore()
      const secure = new AsyncInMemoryStore()
      const warnings = t.mock.method(log, 'warn')
      let signal: AbortSignal | undefined
      const store = new AccountsStore(
        data,
        secure,
        async () => renewed,
        () => now,
        async (_account, cancellation) => {
          signal = cancellation
          if (rejects) {
            throw new Error('secret-revocation-failure')
          }
          return false
        }
      )
      await store.addAccount(account, rotating)
      const original = secure.setItem.bind(secure)
      t.mock.method(
        secure,
        'setItem',
        async (key: string, login: string, value: string) => {
          if (value === serializeAccountCredential(renewed)) {
            throw new Error('Keychain locked')
          }
          return original(key, login, value)
        }
      )
      await assert.rejects(
        store.resolveToken(account.endpoint, account.token),
        /Unable to save/
      )
      assert.deepEqual(await store.getAll(), [])
      assert.equal(
        await secure.getItem(getKeyForAccount(account), account.login),
        null
      )
      assert.deepEqual(
        warnings.mock.calls.map(call => call.arguments),
        [['Unable to revoke unused OAuth credentials.']]
      )
      t.mock.timers.tick(30_000)
      assert.equal(signal?.aborted, false)
    })
  }

  it('sign-out revokes the token published between account lookup and retirement', async t => {
    const gate = deferred<IOAuthToken>()
    const { store, secure, revoked } = setup(() => gate.promise)
    await store.addAccount(account, rotating)
    const renewal = store.resolveToken(account.endpoint, account.token)
    const remove = store.removeAccount.bind(store)
    t.mock.method(store, 'removeAccount', async (removed: Account) => {
      gate.resolve(renewed)
      await renewal
      return remove(removed)
    })
    const deleted: string[] = []
    t.mock.method(
      globalThis,
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.method, 'DELETE')
        assert.ok(typeof init.body === 'string')
        const body: unknown = JSON.parse(init.body)
        assert.deepEqual(body, { access_token: renewed.accessToken })
        deleted.push(renewed.accessToken)
        return new Response(null, { status: 204 })
      }
    )
    await AppStore.prototype._removeAccount.call(
      { accountsStore: store },
      account
    )
    assert.deepEqual(deleted, [renewed.accessToken])
    assert.deepEqual(revoked, [])
    assert.deepEqual(await store.getAll(), [])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
  })

  it('returns the retired credential even when secure-store deletion fails', async t => {
    const { store, secure } = setup()
    await store.addAccount(account, rotating)
    await store.resolveToken(account.endpoint, account.token)
    t.mock.method(secure, 'deleteItem', async () => {
      throw new Error('Keychain locked')
    })
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    const removed = await store.removeAccount(account)
    assert.equal(removed?.token, renewed.accessToken)
    assert.deepEqual(await store.getAll(), [])
    assert.equal(errors.length, 1)
    await assert.rejects(
      store.resolveToken(account.endpoint, renewed.accessToken),
      AccountRequiresSignInError
    )
  })

  it('does not revoke a credential for an absent or different account', async t => {
    const { store } = setup()
    assert.equal(await store.removeAccount(account), null)
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected revocation')
    })
    await AppStore.prototype._removeAccount.call(
      { accountsStore: store },
      account
    )
    const replacement = new Account(
      'other',
      account.endpoint,
      'dotcom',
      'other-token',
      [],
      '',
      2,
      'Other'
    )
    await store.addAccount(replacement)
    assert.equal(await store.removeAccount(account), null)
    await AppStore.prototype._removeAccount.call(
      { accountsStore: store },
      account
    )
    assert.equal(fetch.mock.callCount(), 0)
    assert.deepEqual(await store.getAll(), [replacement])
    assert.equal(
      (await store.getAccountWithFreshToken(replacement)).token,
      replacement.token
    )
  })

  it('keeps retirement and its returned credential together during replacement', async t => {
    const { store, secure } = setup()
    await store.addAccount(account)
    const started = deferred<void>()
    const gate = deferred<void>()
    const remove = secure.deleteItem.bind(secure)
    t.mock.method(secure, 'deleteItem', async (key: string, login: string) => {
      started.resolve()
      await gate.promise
      return remove(key, login)
    })
    const removal = store.removeAccount(account)
    await started.promise
    const replacement = account.withToken('replacement-token')
    const addition = store.addAccount(replacement)
    gate.resolve()
    const removed = await removal
    await addition
    assert.equal(removed?.token, account.token)
    assert.deepEqual(await store.getAll(), [replacement])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      replacement.token
    )
  })

  it('sign-out during exchange prevents resurrection and revokes the unused replacement', async () => {
    const gate = deferred<IOAuthToken>()
    const started = deferred<void>()
    const { store, secure, revoked } = setup(async () => {
      started.resolve()
      return gate.promise
    })
    await store.addAccount(account, rotating)
    const pending = store.resolveToken(account.endpoint, account.token)
    const rejected = assert.rejects(pending, AccountRequiresSignInError)
    await started.promise
    await store.removeAccount(account)
    gate.resolve(renewed)
    await rejected
    assert.deepEqual(await store.getAll(), [])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
    assert.deepEqual(revoked, [renewed.accessToken])
    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      AccountRequiresSignInError
    )
  })

  it('sign-out during persistence deletes the late write', async t => {
    const { store, secure } = setup()
    await store.addAccount(account, rotating)
    const original = secure.setItem.bind(secure)
    const writing = deferred<void>()
    const gate = deferred<void>()
    t.mock.method(
      secure,
      'setItem',
      async (key: string, login: string, value: string) => {
        writing.resolve()
        await gate.promise
        await original(key, login, value)
      }
    )
    const pending = store.resolveToken(account.endpoint, account.token)
    const rejected = assert.rejects(pending, AccountRequiresSignInError)
    await writing.promise
    const removal = store.removeAccount(account)
    gate.resolve()
    await Promise.all([removal, rejected])
    assert.deepEqual(await store.getAll(), [])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
  })

  it('keeps the current account usable when saving a replacement fails', async t => {
    const { store, secure } = setup()
    await store.addAccount(account, rotating)
    t.mock.method(secure, 'setItem', async () => {
      throw new Error('Keychain locked')
    })
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    const replacement = new Account(
      'other',
      account.endpoint,
      'dotcom',
      renewed.accessToken,
      [],
      '',
      2,
      'Other'
    )
    assert.equal(await store.addAccount(replacement, renewed), null)
    assert.equal(errors.length, 1)
    assert.deepEqual(await store.getAll(), [account])
    assert.equal(store.isRefreshable(account), true)
    assert.equal(
      (await store.getAccountWithFreshToken(account, 0)).token,
      account.token
    )
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      serializeAccountCredential(rotating)
    )
  })

  it('a renewal finishing after a replacement cannot overwrite it', async () => {
    const gate = deferred<IOAuthToken>()
    const started = deferred<void>()
    const { store, secure, revoked } = setup(async () => {
      started.resolve()
      return gate.promise
    })
    await store.addAccount(account, rotating)
    const pending = store.resolveToken(account.endpoint, account.token)
    const rejected = assert.rejects(pending, AccountRequiresSignInError)
    await started.promise
    const replacement = account.withToken('replacement-token')
    await store.addAccount(replacement)
    gate.resolve(renewed)
    await rejected
    assert.deepEqual(revoked, [renewed.accessToken])
    assert.deepEqual(await store.getAll(), [replacement])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      replacement.token
    )
  })

  it('keeps memory, storage, and restart in sync when overlapping sign-ins race', async t => {
    const { store, secure, data } = setup()
    await store.addAccount(account, rotating)
    const original = secure.setItem.bind(secure)
    const writing = deferred<void>()
    const gate = deferred<void>()
    let calls = 0
    t.mock.method(
      secure,
      'setItem',
      async (key: string, login: string, value: string) => {
        calls++
        if (calls === 1) {
          writing.resolve()
          await gate.promise
          return original(key, login, value)
        }
        throw new Error('Keychain locked')
      }
    )
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    const first = account.withToken('first-access')
    const second = account.withToken('second-access')

    const firstAddition = store.addAccount(first)
    await writing.promise
    const secondAddition = store.addAccount(second)
    gate.resolve()

    assert.equal((await firstAddition)?.token, first.token)
    assert.equal(await secondAddition, null)
    assert.equal(errors.length, 1)
    assert.deepEqual(await store.getAll(), [first])
    assert.equal(
      await store.resolveToken(first.endpoint, first.token),
      first.token
    )
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      first.token
    )
    assert.deepEqual(await new AccountsStore(data, secure).getAll(), [first])
  })

  it('a sign-in saved after signing out the previous account stays signed in', async t => {
    for (const login of [account.login, 'other']) {
      const { store, secure, data } = setup()
      await store.addAccount(account, rotating)
      const original = secure.setItem.bind(secure)
      const writing = deferred<void>()
      const gate = deferred<void>()
      const setItem = t.mock.method(
        secure,
        'setItem',
        async (key: string, user: string, value: string) => {
          writing.resolve()
          await gate.promise
          return original(key, user, value)
        }
      )
      const replacement = new Account(
        login,
        account.endpoint,
        'dotcom',
        'replacement-access',
        [],
        '',
        login === account.login ? account.id : 2,
        login
      )

      const addition = store.addAccount(replacement)
      await writing.promise
      const removal = store.removeAccount(account)
      gate.resolve()
      await Promise.all([addition, removal])
      setItem.mock.restore()

      assert.deepEqual(await store.getAll(), [replacement])
      assert.equal(
        await secure.getItem(getKeyForAccount(replacement), login),
        replacement.token
      )
      if (login !== account.login) {
        assert.equal(
          await secure.getItem(getKeyForAccount(account), account.login),
          null
        )
      }
      assert.deepEqual(await new AccountsStore(data, secure).getAll(), [
        replacement,
      ])
    }
  })

  it('a sign-out resuming as a sign-in is installed sees one consistent account', async t => {
    // Sweep the microtasks between the sign-in's save and its caller resuming.
    for (let delay = 0; delay < 8; delay++) {
      const { store, secure, data } = setup()
      await store.addAccount(account, rotating)
      const other = new Account(
        'other',
        account.endpoint,
        'dotcom',
        'other-access',
        [],
        '',
        2,
        'Other'
      )
      const original = secure.setItem.bind(secure)
      let removal: Promise<Account | null> | undefined
      const setItem = t.mock.method(
        secure,
        'setItem',
        async (key: string, user: string, value: string) => {
          await original(key, user, value)
          removal = (async () => {
            for (let i = 0; i < delay; i++) {
              await Promise.resolve()
            }
            return store.removeAccount(account)
          })()
        }
      )

      assert.deepEqual(await store.addAccount(other), other)
      await removal
      setItem.mock.restore()

      assert.deepEqual(await store.getAll(), [other], `delay ${delay}`)
      assert.equal(
        (await store.getAccountWithFreshToken(other)).token,
        other.token,
        `delay ${delay}`
      )
      assert.deepEqual(
        await new AccountsStore(data, secure).getAll(),
        [other],
        `delay ${delay}`
      )
    }
  })

  it('loading multiple accounts for an endpoint keeps a session for each', async () => {
    const { data, secure } = setup()
    const other = new Account(
      'other',
      account.endpoint,
      'dotcom',
      'other-access',
      [],
      '',
      2,
      'Other'
    )
    data.setItem(
      'users',
      JSON.stringify([account.withToken(''), other.withToken('')])
    )
    await secure.setItem(
      getKeyForAccount(account),
      account.login,
      serializeAccountCredential({ ...rotating, expiresAt: now })
    )
    await secure.setItem(getKeyForAccount(other), other.login, other.token)
    let renewals = 0
    const store = new AccountsStore(
      data,
      secure,
      async () => {
        renewals++
        return renewed
      },
      () => now,
      async () => true
    )

    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      renewed.accessToken
    )
    assert.equal(
      await store.resolveToken(other.endpoint, other.token),
      other.token
    )
    assert.equal(renewals, 1)
    assert.deepEqual(await store.getAll(), [
      account.withToken(renewed.accessToken),
      other,
    ])
    assert.deepEqual(await store.removeAccount(other), other)
    assert.deepEqual(await store.getAll(), [
      account.withToken(renewed.accessToken),
    ])
  })

  it('loading duplicate entries for the same login keeps the last one', async () => {
    const { data, secure } = setup()
    const renamed = new Account(
      account.login,
      account.endpoint,
      'dotcom',
      account.token,
      [],
      '',
      account.id,
      'Renamed'
    )
    data.setItem(
      'users',
      JSON.stringify([account.withToken(''), renamed.withToken('')])
    )
    await secure.setItem(
      getKeyForAccount(account),
      account.login,
      account.token
    )
    const store = new AccountsStore(data, secure)

    assert.deepEqual(await store.getAll(), [renamed])
    assert.equal(
      await store.resolveToken(renamed.endpoint, renamed.token),
      renamed.token
    )
  })

  it('loading duplicate entries for an account keeps only the last session live', async () => {
    const { data, secure } = setup()
    data.setItem(
      'users',
      JSON.stringify([account.withToken(''), account.withToken('')])
    )
    await secure.setItem(getKeyForAccount(account), account.login, 'stored')
    const store = new AccountsStore(data, secure)

    assert.deepEqual(await store.getAll(), [account.withToken('stored')])
    assert.deepEqual(
      await store.removeAccount(account),
      account.withToken('stored')
    )
    assert.deepEqual(await store.getAll(), [])
  })

  it('signing in to another account on the endpoint keeps the first account', async () => {
    const { store } = setup()
    await store.addAccount(account, rotating)
    const other = new Account(
      'other',
      account.endpoint,
      'dotcom',
      'other-token',
      [],
      '',
      2,
      'Other'
    )
    await store.addAccount(other)
    assert.deepEqual(await store.getAll(), [account, other])
    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      renewed.accessToken
    )
    assert.equal(
      await store.resolveToken(other.endpoint, other.token),
      other.token
    )
  })

  it('reports failures from API invalidation callbacks through the store', async t => {
    const { store } = setup()
    const failure = new Error('Keychain unavailable')
    t.mock.method(store, 'invalidateToken', async () => {
      throw failure
    })
    const errors: Error[] = []
    store.onDidError(error => errors.push(error))
    t.mock.method(log, 'error')

    store.handleTokenInvalidated(account.endpoint, account.token)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(errors, [failure])
  })

  it('ignores stale 401s after rotation and rejects current invalidated credentials', async () => {
    const { store } = setup()
    await store.addAccount(account, rotating)
    await store.resolveToken(account.endpoint, account.token)
    await store.invalidateToken(account.endpoint, account.token)
    assert.equal((await store.getAll())[0].token, renewed.accessToken)
    await store.invalidateToken(account.endpoint, renewed.accessToken)
    // A rotating pair is renewed once before it is given up.
    assert.equal((await store.getAll()).length, 1)
    await store.invalidateToken(account.endpoint, renewed.accessToken)
    assert.deepEqual(await store.getAll(), [])
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
  })

  it('does not invalidate a new pair for an old 401 arriving during renewal', async () => {
    const gate = deferred<IOAuthToken>()
    const started = deferred<void>()
    const { store } = setup(async () => {
      started.resolve()
      return gate.promise
    })
    await store.addAccount(account, rotating)
    const pending = store.resolveToken(account.endpoint, account.token)
    await started.promise
    const invalidation = store.invalidateToken(account.endpoint, account.token)
    gate.resolve(renewed)
    await Promise.all([pending, invalidation])
    assert.equal((await store.getAll())[0].token, renewed.accessToken)
  })
})

describe('Several accounts on one endpoint', () => {
  const other = new Account(
    'hubot',
    account.endpoint,
    'dotcom',
    'other-access',
    [],
    '',
    2,
    'Hubot'
  )
  const otherRotating: IOAuthToken = {
    ...rotating,
    accessToken: other.token,
    refreshToken: 'other-refresh',
  }
  const otherRenewed: IOAuthToken = {
    ...renewed,
    accessToken: 'other-new-access',
    refreshToken: 'other-new-refresh',
  }
  const longLived = (credential: IOAuthToken): IOAuthToken => ({
    ...credential,
    expiresAt: now + 60 * 60 * 1000,
  })
  const renewByRefreshToken = async (_endpoint: string, refreshToken: string) =>
    refreshToken === rotating.refreshToken ? renewed : otherRenewed
  const stored = async (secure: AsyncInMemoryStore, a: Account) =>
    deserializeAccountCredential(
      await secure.getItem(getKeyForAccount(a), a.login)
    )
  const logins = (accounts: ReadonlyArray<Account>) =>
    accounts.map(a => `${a.login}:${a.token}`)

  async function expectUsable(
    store: AccountsStore,
    snapshot: Account,
    token: string
  ) {
    assert.equal(await store.resolveToken(snapshot.endpoint, token), token)
    const fresh = await store.getAccountWithFreshToken(snapshot)
    assert.equal(fresh.login, snapshot.login)
    assert.equal(fresh.token, token)
    const lease = await store.leaseAccountToken(snapshot, 'git')
    assert.equal(lease.account.login, snapshot.login)
    assert.equal(lease.account.token, token)
    lease.release()
    assert.equal((await store.createTokenGetter(snapshot)()).accessToken, token)
    assert.equal(
      (await store.createTokenGetter(fresh)()).accessToken,
      token,
      'derived snapshots keep their own session'
    )
  }

  it('keeps every login usable after adding another and after restarting', async () => {
    const { store, data, secure } = setup(renewByRefreshToken)
    await store.addAccount(account, longLived(rotating))
    await store.addAccount(other, longLived(otherRotating))

    await expectUsable(store, account, account.token)
    await expectUsable(store, other, other.token)

    const restarted = new AccountsStore(
      data,
      secure,
      renewByRefreshToken,
      () => now
    )
    const [loadedAccount, loadedOther] = await restarted.getAll()
    assert.deepEqual([loadedAccount, loadedOther], [account, other])
    await expectUsable(restarted, loadedAccount, account.token)
    await expectUsable(restarted, loadedOther, other.token)
  })

  it('renewing one login leaves the other untouched', async () => {
    let calls = 0
    const { store, secure } = setup(async (endpoint, refreshToken) => {
      calls++
      return renewByRefreshToken(endpoint, refreshToken)
    })
    await store.addAccount(account, rotating)
    await store.addAccount(other, otherRotating)

    assert.equal(
      await store.resolveToken(account.endpoint, account.token),
      renewed.accessToken
    )
    assert.equal(calls, 1)
    assert.deepEqual(logins(await store.getAll()), [
      `${account.login}:${renewed.accessToken}`,
      `${other.login}:${other.token}`,
    ])
    assert.deepEqual(await stored(secure, account), renewed)
    assert.deepEqual(await stored(secure, other), otherRotating)

    assert.equal(
      (await store.getAccountWithFreshToken(other)).token,
      otherRenewed.accessToken
    )
    assert.equal(calls, 2)
    assert.deepEqual(logins(await store.getAll()), [
      `${account.login}:${renewed.accessToken}`,
      `${other.login}:${otherRenewed.accessToken}`,
    ])
    assert.deepEqual(await stored(secure, other), otherRenewed)
  })

  it('a rejected renewal signs out only that login', async () => {
    const { store, data, secure } = setup(async (endpoint, refreshToken) => {
      if (refreshToken === rotating.refreshToken) {
        throw new OAuthRefreshRejectedError()
      }
      return renewByRefreshToken(endpoint, refreshToken)
    })
    await store.addAccount(account, rotating)
    await store.addAccount(other, otherRotating)
    const invalidated: Account[] = []
    store.onTokenInvalidated(a => invalidated.push(a))

    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      OAuthRefreshRejectedError
    )

    assert.deepEqual(
      invalidated.map(a => [a.login, a.token]),
      [[account.login, '']]
    )
    assert.deepEqual(logins(await store.getAll()), [
      `${other.login}:${other.token}`,
    ])
    assert.equal(await stored(secure, account), null)
    assert.deepEqual(await stored(secure, other), otherRotating)
    assert.equal(
      (await store.getAccountWithFreshToken(other)).token,
      otherRenewed.accessToken
    )
    assert.deepEqual(logins(await new AccountsStore(data, secure).getAll()), [
      `${other.login}:${otherRenewed.accessToken}`,
    ])
  })

  it('a 401 for one login signs out only that login', async t => {
    const { store, secure } = setup()
    await store.addAccount(account)
    await store.addAccount(other)
    t.after(API.setTokenProvider(store.resolveToken))
    t.after(API.onTokenInvalidated(store.handleTokenInvalidated))
    const invalidated = new Promise<Account>(resolve =>
      store.onTokenInvalidated(resolve)
    )
    t.mock.method(
      globalThis,
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          `Bearer ${other.token}`
        )
        return Response.json(
          { message: 'Bad credentials' },
          { status: 401, headers: { 'X-GitHub-Request-Id': 'test-request' } }
        )
      }
    )

    await assert.rejects(
      API.fromAccount(other).fetchAccount(),
      /Bad credentials/
    )
    const signedOut = await invalidated
    assert.equal(signedOut.login, other.login)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(logins(await store.getAll()), [
      `${account.login}:${account.token}`,
    ])
    assert.equal(await stored(secure, other), null)
    await expectUsable(store, account, account.token)
  })

  it('signing out one login keeps the other fully working', async () => {
    const { store, data, secure } = setup(renewByRefreshToken)
    await store.addAccount(account, longLived(rotating))
    await store.addAccount(other, longLived(otherRotating))
    const accountGetter = store.createTokenGetter(account)
    const otherGetter = store.createTokenGetter(other)

    assert.deepEqual(await store.removeAccount(account), account)

    await assert.rejects(accountGetter(), AccountRequiresSignInError)
    assert.throws(
      () => store.createTokenGetter(account),
      AccountRequiresSignInError
    )
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
    assert.equal((await otherGetter()).accessToken, other.token)
    await expectUsable(store, other, other.token)
    assert.equal(await stored(secure, account), null)
    assert.deepEqual(await stored(secure, other), longLived(otherRotating))
    assert.deepEqual(await new AccountsStore(data, secure).getAll(), [other])
  })

  it('saving one login neither waits for nor overwrites another', async t => {
    const { store, secure } = setup()
    const setItem = secure.setItem.bind(secure)
    const gate = deferred<void>()
    t.mock.method(
      secure,
      'setItem',
      async (key: string, login: string, value: string) => {
        if (login === account.login) {
          await gate.promise
        }
        return setItem(key, login, value)
      }
    )

    const addingAccount = store.addAccount(account, rotating)
    assert.deepEqual(await store.addAccount(other, otherRotating), other)
    assert.deepEqual(await store.getAll(), [other])

    gate.resolve()
    assert.deepEqual(await addingAccount, account)
    assert.deepEqual(await store.getAll(), [other, account])
    assert.deepEqual(await stored(secure, account), rotating)
    assert.deepEqual(await stored(secure, other), otherRotating)
  })

  it('signing in again replaces only the session of that login', async () => {
    const { store } = setup(renewByRefreshToken)
    await store.addAccount(account, longLived(rotating))
    await store.addAccount(other, longLived(otherRotating))
    const otherGetter = store.createTokenGetter(other)

    const again = await store.addAccount(account.withToken('again'), {
      accessToken: 'again',
    })
    assert.ok(again)

    assert.throws(
      () => store.createTokenGetter(account),
      AccountRequiresSignInError
    )
    await assert.rejects(
      store.resolveToken(account.endpoint, account.token),
      AccountRequiresSignInError
    )
    assert.equal((await store.createTokenGetter(again)()).accessToken, 'again')
    assert.equal((await otherGetter()).accessToken, other.token)
    assert.deepEqual(logins(await store.getAll()), [
      `${account.login}:again`,
      `${other.login}:${other.token}`,
    ])
  })

  it('resolves an account loaded without a credential by its login', async () => {
    const { data, secure } = setup()
    data.setItem(
      'users',
      JSON.stringify([account.withToken(''), other.withToken('')])
    )
    await secure.setItem(getKeyForAccount(other), other.login, other.token)
    const store = new AccountsStore(data, secure)
    const invalidated: string[] = []
    store.onTokenInvalidated(a => invalidated.push(a.login))
    assert.deepEqual(logins(await store.getAll()), [
      `${account.login}:`,
      `${other.login}:${other.token}`,
    ])

    assert.equal(
      await store.resolveToken(account.endpoint, '', other.login),
      ''
    )
    assert.deepEqual(invalidated, [])

    await assert.rejects(
      store.resolveToken(account.endpoint, '', account.login),
      AccountRequiresSignInError
    )
    assert.deepEqual(invalidated, [account.login])
    const [loadedOther] = await store.getAll()
    assert.deepEqual([loadedOther], [other])
    await expectUsable(store, loadedOther, other.token)
  })

  it('refreshes the profile of each login with its own session', async t => {
    const { store } = setup(renewByRefreshToken)
    await store.addAccount(account, longLived(rotating))
    await store.addAccount(other, longLived(otherRotating))
    t.mock.method(API.prototype, 'fetchAccount', async function (this: API) {
      return this['token'] === account.token
        ? { ...createMockAPIIdentity(), name: 'Updated Octocat' }
        : {
            ...createMockAPIIdentity({ id: 2, login: other.login }),
            name: 'Updated Hubot',
          }
    })
    t.mock.method(API.prototype, 'fetchEmails', async () => [])
    t.mock.method(API.prototype, 'fetchUserCopilotInfo', async () => null)
    t.mock.method(API.prototype, 'fetchFeatureFlags', async () => [])

    await store.refresh()

    const [refreshedAccount, refreshedOther] = await store.getAll()
    assert.equal(refreshedAccount.name, 'Updated Octocat')
    assert.equal(refreshedOther.name, 'Updated Hubot')
    await expectUsable(store, refreshedAccount, account.token)
    await expectUsable(store, refreshedOther, other.token)
  })

  it('keeps the stored login when the API reports that the user was renamed', async t => {
    const { store, secure } = setup()
    await store.addAccount(account)
    t.mock.method(API.prototype, 'fetchAccount', async () => ({
      ...createMockAPIIdentity({ login: 'renamed' }),
      name: 'Renamed',
    }))
    t.mock.method(API.prototype, 'fetchEmails', async () => [])
    t.mock.method(API.prototype, 'fetchUserCopilotInfo', async () => null)
    t.mock.method(API.prototype, 'fetchFeatureFlags', async () => [])
    t.mock.method(log, 'warn')

    await store.refresh()

    assert.deepEqual(await store.getAll(), [account])
    assert.deepEqual(await stored(secure, account), {
      accessToken: account.token,
    })
    await expectUsable(store, account, account.token)
  })

  it('keeps the stored login when the API only changes its case', async t => {
    const { store, secure } = setup()
    await store.addAccount(account)
    t.mock.method(API.prototype, 'fetchAccount', async () => ({
      ...createMockAPIIdentity({ login: 'OctoCat' }),
      name: 'Updated Octocat',
    }))
    t.mock.method(API.prototype, 'fetchEmails', async () => [])
    t.mock.method(API.prototype, 'fetchUserCopilotInfo', async () => null)
    t.mock.method(API.prototype, 'fetchFeatureFlags', async () => [])

    await store.refresh()

    const [refreshed] = await store.getAll()
    assert.equal(refreshed.login, account.login)
    assert.equal(refreshed.name, 'Updated Octocat')
    assert.deepEqual(await stored(secure, account), {
      accessToken: account.token,
    })
    await expectUsable(store, refreshed, account.token)
  })

  it('renewing a third-party login leaves another login untouched', async () => {
    // Bitbucket identities always have id 0.
    const bitbucket = (login: string, token: string) =>
      new Account(
        login,
        BitbucketCloudAPIEndpoint,
        'bitbucket',
        token,
        [],
        '',
        0,
        login
      )
    const renewals = new Array<string>()
    const { store, secure } = setup(async (_, refreshToken) => {
      renewals.push(refreshToken)
      return {
        accessToken: `${refreshToken}-access`,
        refreshToken: `${refreshToken}-next`,
        expiresAt: now + 3_600_000,
      }
    })
    const first = bitbucket('first', 'first-token')
    const second = bitbucket('second', 'second-token')
    const secondCredential = {
      accessToken: second.token,
      refreshToken: 'second-refresh',
      expiresAt: now + 3_600_000,
    }
    assert.ok(
      await store.addAccount(first, {
        accessToken: first.token,
        refreshToken: 'first-refresh',
        expiresAt: now,
      })
    )
    assert.ok(await store.addAccount(second, secondCredential))

    const renewedFirst = await store.getAccountWithFreshToken(first)

    assert.equal(renewedFirst.token, 'first-refresh-access')
    assert.deepEqual(renewals, ['first-refresh'])
    assert.deepEqual(logins(await store.getAll()), [
      `${first.login}:first-refresh-access`,
      `${second.login}:${second.token}`,
    ])
    assert.deepEqual(await stored(secure, first), {
      accessToken: 'first-refresh-access',
      refreshToken: 'first-refresh-next',
      expiresAt: now + 3_600_000,
      refreshTokenExpiresAt: undefined,
    })
    assert.deepEqual(await stored(secure, second), {
      ...secondCredential,
      refreshTokenExpiresAt: undefined,
    })
    await expectUsable(store, second, second.token)
  })
})

describe('Several app windows', () => {
  const other = new Account(
    'hubot',
    account.endpoint,
    'dotcom',
    'other-access',
    [],
    '',
    2,
    'Hubot'
  )
  const third = new Account(
    'monalisa',
    account.endpoint,
    'dotcom',
    'third-access',
    [],
    '',
    3,
    'Mona'
  )
  const window = (data: InMemoryStore, secure: AsyncInMemoryStore) =>
    new AccountsStore(
      data,
      secure,
      async () => renewed,
      () => now
    )
  const persistedLogins = (data: InMemoryStore) =>
    JSON.parse(data.getItem('users') ?? '[]').map(
      (user: { login: string }) => user.login
    )

  it("keeps other windows' sign-ins and forgets accounts they removed", async () => {
    const { store: first, data, secure } = setup()
    await first.addAccount(account)
    const second = window(data, secure)
    assert.deepEqual(await second.getAll(), [account])

    await first.addAccount(other)
    await first.removeAccount(account)
    await second.addAccount(third)

    assert.deepEqual(await second.getAll(), [third])
    assert.deepEqual(persistedLogins(data), [third.login, other.login])
    await assert.rejects(
      second.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
  })

  it('keeps an account whose credential is missing until its entry is gone', async () => {
    let renewals = 0
    const { store, data, secure } = setup(async () => {
      renewals++
      return renewed
    })
    await store.addAccount(account, rotating)
    await secure.deleteItem(getKeyForAccount(account), account.login)

    await assert.rejects(
      store.getAccountWithFreshToken(account),
      /Unlock your keychain/
    )
    assert.deepEqual(await store.getAll(), [account])

    data.setItem('users', '[]')
    await assert.rejects(
      store.getAccountWithFreshToken(account),
      AccountRequiresSignInError
    )
    assert.deepEqual(await store.getAll(), [])
    assert.equal(renewals, 0)
  })

  it('revokes a pair another window renewed when removing the account', async () => {
    const { store: first, data, secure, revoked } = setup()
    await first.addAccount(account, rotating)
    const second = window(data, secure)
    const [loaded] = await second.getAll()
    assert.equal(
      (await second.getAccountWithFreshToken(loaded)).token,
      renewed.accessToken
    )

    const removed = await first.removeAccount(account)
    assert.equal(removed?.token, account.token)
    assert.deepEqual(revoked, [renewed.accessToken])
    assert.equal(
      await secure.getItem(getKeyForAccount(account), account.login),
      null
    )
  })

  it('adopts a credential that could not be read while loading', async t => {
    const { store: first, data, secure } = setup()
    await first.addAccount(account)
    const getItem = secure.getItem.bind(secure)
    let locked = true
    t.mock.method(secure, 'getItem', (key: string, login?: string) =>
      locked ? Promise.resolve(null) : getItem(key, login)
    )
    const second = window(data, secure)
    const [loaded] = await second.getAll()
    assert.equal(loaded.token, '')
    locked = false

    assert.equal(
      (await second.getAccountWithFreshToken(loaded)).token,
      account.token
    )
    assert.deepEqual(await second.getAll(), [account])
    await first.addAccount(other)
    assert.deepEqual(persistedLogins(data), [account.login, other.login])
  })

  it('signs out a rejected token even if its credential is missing', async () => {
    const { store, secure } = setup()
    await store.addAccount(account)
    await secure.deleteItem(getKeyForAccount(account), account.login)
    const invalidated: Account[] = []
    store.onTokenInvalidated(a => invalidated.push(a))

    await store.invalidateToken(account.endpoint, account.token)

    assert.equal(invalidated.length, 1)
    assert.deepEqual(await store.getAll(), [])
  })

  it('keeps an entry that could not be loaded until it is signed in again', async t => {
    const { store: first, data, secure } = setup()
    await first.addAccount(account)
    await first.addAccount(other)
    const entryOf = (login: string) =>
      JSON.parse(data.getItem('users') ?? '[]').find(
        (user: { login: string }) => user.login === login
      )
    const entry = entryOf(other.login)
    const getItem = secure.getItem.bind(secure)
    const locked = t.mock.method(
      secure,
      'getItem',
      (key: string, login?: string) =>
        login === other.login
          ? Promise.reject(new Error('Keychain locked'))
          : getItem(key, login)
    )
    const second = window(data, secure)
    assert.deepEqual(await second.getAll(), [account])

    await second.addAccount(third)
    assert.deepEqual(entryOf(other.login), entry)

    locked.mock.restore()
    await second.addAccount(other)
    assert.deepEqual(persistedLogins(data), [
      account.login,
      third.login,
      other.login,
    ])
  })
})
