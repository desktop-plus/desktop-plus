import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { RepositoriesStore } from '../../src/lib/stores/repositories-store'
import {
  ForkAccountMigrationKey,
  migrateForkAccountIds,
} from '../../src/lib/stores/helpers/migrate-fork-account-assignments'
import { deriveNumericAccountId } from '../../src/lib/derive-numeric-account-id'
import { getOwnerKey } from '../../src/lib/databases/repositories-database'
import { IAccountIdentity } from '../../src/models/account'
import { RepoType } from '../../src/models/github-repository'
import { TestRepositoriesDatabase } from '../helpers/databases'
import { AccountsStore } from '../../src/lib/stores/accounts-store'
import { BitbucketCloudAPIEndpoint } from '../../src/lib/api'
import { InMemoryStore, AsyncInMemoryStore } from '../helpers/stores'

const dotcom = 'https://api.github.com'
const gitlab = 'https://gitlab.example.com/api/v4'

const alice = { endpoint: dotcom, login: 'Alice' }
const bob = { endpoint: dotcom, login: 'bob' }
const owner = { endpoint: dotcom, login: 'owner' }

interface ILegacyRepository {
  /** The fork's per-repository override; `null` meant no override. */
  readonly login?: string | null
  /** The fork's legacy `gitHubRepositories.login` field. */
  readonly ghLogin?: string | null
  /** Whether the GitHub repository record has no legacy field at all. */
  readonly withoutLegacyField?: boolean
  readonly endpoint?: string
  readonly ownerLogin?: string
  readonly apiType?: RepoType
}

describe('Desktop Plus account migration', () => {
  let db: TestRepositoriesDatabase
  let store: RepositoriesStore

  beforeEach(async () => {
    localStorage.removeItem(ForkAccountMigrationKey)
    db = new TestRepositoriesDatabase()
    await db.reset()
    store = new RepositoriesStore(db)
  })

  afterEach(async () => {
    localStorage.removeItem(ForkAccountMigrationKey)
    await setImmediate()
    db.close()
  })

  async function addLegacy(repo: ILegacyRepository) {
    const endpoint = repo.endpoint ?? dotcom
    const ownerLogin = repo.ownerLogin ?? 'owner'
    const key = getOwnerKey(endpoint, ownerLogin)
    const ownerID =
      (await db.owners.get({ key }))?.id ??
      (await db.owners.add({
        key,
        login: ownerLogin,
        endpoint,
        apiType: repo.apiType ?? 'github',
      }))
    const gitHubRepositoryID = await db.gitHubRepositories.add({
      ownerID,
      name: `repo-${await db.gitHubRepositories.count()}`,
      accountLogin: '',
      private: false,
      htmlURL: null,
      cloneURL: null,
      parentID: null,
      lastPruneDate: null,
      permissions: null,
      ...(repo.withoutLegacyField ? {} : { login: repo.ghLogin ?? null }),
    })
    await db.repositories.add({
      path: `/repo-${gitHubRepositoryID}`,
      gitHubRepositoryID,
      alias: null,
      groupName: null,
      defaultBranch: null,
      missing: false,
      ...('login' in repo ? { login: repo.login } : { login: null }),
    })
  }

  async function migrate(accounts: ReadonlyArray<IAccountIdentity>) {
    await store.migrateForkAccountAssignments(accounts)
    await store.migrateAccountAssignments(accounts)
    return store.getAll()
  }

  async function logins(accounts: ReadonlyArray<IAccountIdentity>) {
    return (await migrate(accounts)).map(r => r.login)
  }

  it('keeps an explicit per-repository override', async () => {
    await addLegacy({ login: 'bob', ghLogin: 'Alice' })
    const [repository] = await migrate([alice, bob])
    assert.equal(repository.login, 'bob')
    const ghRecord = await db.gitHubRepositories.get(
      repository.gitHubRepository!.dbID
    )
    assert.equal(ghRecord?.accountLogin, 'bob')
  })

  it("uses the GitHub repository's login without an override", async () => {
    await addLegacy({ ghLogin: 'bob' })
    assert.deepEqual(await logins([alice, bob]), ['bob'])
  })

  it("falls back to the owner's account", async () => {
    await addLegacy({})
    assert.deepEqual(await logins([alice, owner, bob]), ['owner'])
  })

  it('falls back to the first account on the endpoint', async () => {
    await addLegacy({})
    await addLegacy({ endpoint: 'https://ghe.example.com/api/v3' })
    assert.deepEqual(await logins([alice, bob]), ['Alice', null])
  })

  it('keeps a candidate whose account is signed out', async () => {
    await addLegacy({ login: 'carol' })
    await addLegacy({ ghLogin: 'dave' })
    assert.deepEqual(await logins([alice]), ['carol', 'dave'])
  })

  it('matches logins case-insensitively and keeps the canonical case', async () => {
    await addLegacy({ login: 'ALICE' })
    await addLegacy({ ghLogin: 'alice' })
    await addLegacy({ ownerLogin: 'BOB' })
    assert.deepEqual(await logins([alice, bob]), ['Alice', 'Alice', 'bob'])
  })

  it('runs only once', async () => {
    await addLegacy({ ghLogin: 'bob' })
    assert.deepEqual(await logins([alice, bob]), ['bob'])
    const [repository] = await store.getAll()
    await store.updateRepositoryAccount(repository, null)
    const before = await db.gitHubRepositories.toArray()
    assert.deepEqual(await logins([alice, bob]), [null])
    assert.deepEqual(await db.gitHubRepositories.toArray(), before)
  })

  it('changes nothing when run again', async () => {
    await addLegacy({ login: 'bob' })
    await addLegacy({ ghLogin: 'ALICE' })
    await addLegacy({})
    await addLegacy({ endpoint: gitlab, apiType: 'gitlab' })
    const first = await migrate([alice, bob])
    const records = await db.repositories.toArray()
    const ghRecords = await db.gitHubRepositories.toArray()
    localStorage.removeItem(ForkAccountMigrationKey)
    const second = await migrate([alice, bob])
    assert.deepEqual(
      second.map(r => r.hash),
      first.map(r => r.hash)
    )
    assert.deepEqual(await db.repositories.toArray(), records)
    assert.deepEqual(await db.gitHubRepositories.toArray(), ghRecords)
  })

  it('removes the legacy GitHub repository login', async () => {
    await addLegacy({ ghLogin: 'bob' })
    await migrate([bob])
    for (const record of await db.gitHubRepositories.toArray()) {
      assert.equal('login' in record, false)
    }
  })

  it("uses the GitHub repository's login for records without a persisted login", async () => {
    await addLegacy({ login: undefined, ghLogin: 'bob' })
    await addLegacy({ login: undefined, ownerLogin: 'bob' })
    assert.deepEqual(await logins([alice, bob]), ['bob', 'bob'])
  })

  it('leaves records without the legacy field to the upstream migration', async () => {
    await addLegacy({ login: undefined, withoutLegacyField: true })
    await addLegacy({ login: null, withoutLegacyField: true })
    assert.deepEqual(await logins([alice, bob]), ['Alice', null])
  })

  it('is a no-op for a second window that missed the marker', async () => {
    await addLegacy({})
    assert.deepEqual(await logins([alice, bob]), ['Alice'])
    // Another window starting at the same time hasn't seen the marker yet and
    // loaded a different set of accounts.
    localStorage.removeItem(ForkAccountMigrationKey)
    const before = await db.repositories.toArray()
    await store.migrateForkAccountAssignments([bob])
    assert.deepEqual(await db.repositories.toArray(), before)
  })

  it('migrates repositories on a third-party provider', async () => {
    const carol = { endpoint: gitlab, login: 'carol' }
    const dave = { endpoint: gitlab, login: 'dave' }
    await addLegacy({ endpoint: gitlab, apiType: 'gitlab', ghLogin: 'dave' })
    await addLegacy({ endpoint: gitlab, apiType: 'gitlab' })
    const repositories = await migrate([alice, carol, dave])
    assert.deepEqual(
      repositories.map(r => r.login),
      ['dave', 'carol']
    )
    assert.deepEqual(
      repositories.map(r => r.gitHubRepository?.type),
      ['gitlab', 'gitlab']
    )
  })

  it('leaves repositories without a GitHub repository unassigned', async () => {
    await db.repositories.add({
      path: '/local',
      gitHubRepositoryID: null,
      alias: null,
      groupName: null,
      defaultBranch: null,
      missing: false,
      login: null,
    })
    assert.deepEqual(await logins([alice]), [null])
  })
})

describe('Desktop Plus account id migration', () => {
  const bitbucket = (login: string, id = 0) => ({
    login,
    endpoint: BitbucketCloudAPIEndpoint,
    apiType: 'bitbucket',
    token: '',
    emails: [],
    avatarURL: '',
    id,
    name: '',
  })

  const storeWith = (users: ReadonlyArray<object>) => {
    const dataStore = new InMemoryStore()
    dataStore.setItem('users', JSON.stringify(users))
    return dataStore
  }

  const persistedIds = (dataStore: InMemoryStore): ReadonlyArray<number> =>
    JSON.parse(dataStore.getItem('users')).map((u: { id: number }) => u.id)

  beforeEach(() => localStorage.removeItem(ForkAccountMigrationKey))
  afterEach(() => localStorage.removeItem(ForkAccountMigrationKey))

  it('derives distinct Bitbucket ids from the username, ignoring case', () => {
    assert.notEqual(
      deriveNumericAccountId('joan'),
      deriveNumericAccountId('anna')
    )
    assert.equal(deriveNumericAccountId('joan'), deriveNumericAccountId('Joan'))
    assert.ok(deriveNumericAccountId('joan') > 0)
  })

  it('assigns derived ids only to Bitbucket accounts without one', () => {
    const dataStore = storeWith([
      bitbucket('joan'),
      bitbucket('anna'),
      bitbucket('kept', 7),
    ])
    migrateForkAccountIds(dataStore)
    assert.deepEqual(persistedIds(dataStore), [
      deriveNumericAccountId('joan'),
      deriveNumericAccountId('anna'),
      7,
    ])
  })

  it('does nothing once the fork migration has run', () => {
    localStorage.setItem(ForkAccountMigrationKey, '1')
    const dataStore = storeWith([bitbucket('joan')])
    migrateForkAccountIds(dataStore)
    assert.deepEqual(persistedIds(dataStore), [0])
  })

  it('loads legacy Bitbucket users with distinct ids', async () => {
    const dataStore = storeWith([bitbucket('joan'), bitbucket('anna')])
    const accountsStore = new AccountsStore(dataStore, new AsyncInMemoryStore())

    const expected = ['joan', 'anna'].map(deriveNumericAccountId)
    const users = await accountsStore.getAll()
    assert.deepEqual(
      ['joan', 'anna'].map(l => users.find(u => u.login === l)?.id),
      expected
    )
    assert.deepEqual(persistedIds(dataStore), expected)
  })
})
