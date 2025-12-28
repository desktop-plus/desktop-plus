import { Repository } from '../models/repository'
import { Account } from '../models/account'
import { getAccountForEndpointLogin } from './api'

/** Get the authenticated account for the repository. */
export function getAccountForRepository(
  accounts: ReadonlyArray<Account>,
  repository: Repository
): Account | null {
  const gitHubRepository = repository.gitHubRepository
  if (!gitHubRepository) {
    return null
  }

  return getAccountForEndpointLogin(
    accounts,
    gitHubRepository.endpoint,
    gitHubRepository.owner.login
  )
}
