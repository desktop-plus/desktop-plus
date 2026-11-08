import { RepositoriesDatabase } from '../../databases/repositories-database'
import { GitHubRepository } from '../../../models/github-repository'
import {
  AccountAPIType,
  IAccountIdentity,
  isSameAccount,
} from '../../../models/account'
import { caseInsensitiveEquals } from '../../compare'
import { deriveNumericAccountId } from '../../derive-numeric-account-id'
import { IDataStore } from '../stores'

/**
 * Set once the account data has been migrated
 */
export const ForkAccountMigrationKey = 'fork-account-assignments-migrated'

interface IPersistedAccountId {
  readonly login: string
  readonly id: number
  readonly apiType?: AccountAPIType
}

const needsBitbucketId = (account: IPersistedAccountId) =>
  account.apiType === 'bitbucket' && account.id === 0

export function migrateForkAccountIds(dataStore: IDataStore) {
  if (localStorage.getItem(ForkAccountMigrationKey) !== null) {
    return
  }
  const raw = dataStore.getItem('users')
  if (!raw) {
    return
  }
  const accounts: ReadonlyArray<IPersistedAccountId> = JSON.parse(raw)
  if (!Array.isArray(accounts) || !accounts.some(needsBitbucketId)) {
    return
  }
  const migrated = accounts.map(a =>
    needsBitbucketId(a) ? { ...a, id: deriveNumericAccountId(a.login) } : a
  )
  dataStore.setItem('users', JSON.stringify(migrated))
}

type GetGitHubRepositoryForAccount = (
  id: number,
  login: string | null
) => Promise<GitHubRepository>

function hasLegacyLogin(record: object): boolean {
  return Object.prototype.hasOwnProperty.call(record, 'login')
}

function getLegacyLogin(record: object): string | null {
  const login = Reflect.get(record, 'login')
  return typeof login === 'string' && login.length > 0 ? login : null
}

export async function migrateForkAccountAssignments(
  db: RepositoriesDatabase,
  accounts: ReadonlyArray<IAccountIdentity>,
  getGitHubRepositoryForAccount: GetGitHubRepositoryForAccount
): Promise<boolean> {
  if (localStorage.getItem(ForkAccountMigrationKey) !== null) {
    return false
  }

  await db.transaction(
    'rw',
    db.repositories,
    db.gitHubRepositories,
    db.owners,
    async () => {
      for (const record of await db.repositories.toArray()) {
        if (record.id === undefined || record.gitHubRepositoryID === null) {
          continue
        }

        const ghRecord = await db.gitHubRepositories.get(
          record.gitHubRepositoryID
        )
        if (ghRecord === undefined || !hasLegacyLogin(ghRecord)) {
          continue
        }
        const owner = await db.owners.get(ghRecord.ownerID)
        if (owner === undefined) {
          continue
        }

        const endpoint = owner.endpoint
        const onEndpoint = accounts.filter(a => a.endpoint === endpoint)
        const candidate =
          typeof record.login === 'string' && record.login.length > 0
            ? record.login
            : getLegacyLogin(ghRecord)

        const login =
          candidate !== null
            ? onEndpoint.find(a =>
                isSameAccount(a, { endpoint, login: candidate })
              )?.login ?? candidate
            : (
                onEndpoint.find(a =>
                  caseInsensitiveEquals(a.login, owner.login)
                ) ?? onEndpoint.at(0)
              )?.login ?? null

        const ghRepo = await getGitHubRepositoryForAccount(
          record.gitHubRepositoryID,
          login
        )
        await db.repositories.update(record.id, {
          login,
          gitHubRepositoryID: ghRepo.dbID,
        })
      }

      await db.gitHubRepositories.filter(hasLegacyLogin).modify(r => {
        Reflect.deleteProperty(r, 'login')
      })
    }
  )

  localStorage.setItem(ForkAccountMigrationKey, '1')
  return true
}
