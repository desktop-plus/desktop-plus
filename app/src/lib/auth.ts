import { Account } from '../models/account'
import { enableMultipleLoginAccounts } from './feature-flag'

/** Get the auth key for the user. */
export function getKeyForAccount(account: Account): string {
  if (enableMultipleLoginAccounts()) {
    return getKeyForEndpointAndLogin(account.endpoint, account.login)
  } else {
    return getKeyForEndpoint(account.endpoint)
  }
}

/** Get the auth key for the endpoint. */
export function getKeyForEndpoint(endpoint: string): string {
  const appName = __DEV__ ? 'GitHub Desktop Dev' : 'GitHub'

  return `${appName} - ${endpoint}`
}

/** Get the auth key for the endpoint. */
export function getKeyForEndpointAndLogin(
  endpoint: string,
  login: string | undefined
): string {
  const appName = __DEV__ ? 'GitHub Desktop Dev' : 'GitHub'

  return `${appName} - ${endpoint} - ${login}`
}
