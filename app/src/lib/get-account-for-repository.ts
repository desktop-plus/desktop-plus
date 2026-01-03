import { Repository } from '../models/repository'
import { Account } from '../models/account'
import { getAccountForEndpoint } from './api'

/** Get the authenticated account for the repository. */
export function getAccountForRepository(
  accounts: ReadonlyArray<Account>,
  repository: Repository,
  strict: boolean = false
): Account | null {
  const gitHubRepository = repository.gitHubRepository
  if (!gitHubRepository) {
    return null
  }

  return getAccountForEndpoint(
    accounts,
    gitHubRepository.endpoint,
    gitHubRepository.login,
    strict
  )
}
