import { Account } from '../models/account'
import { enableMultipleNamedAccounts } from './feature-flag'

/** Get the auth key for the user. */
export function getKeyForAccount(account: Account): string {
  if (enableMultipleNamedAccounts()) {
    return getKeyForEndpointAndAccountName(
      account.endpoint,
      account.accountname
    )
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
export function getKeyForEndpointAndAccountName(
  endpoint: string,
  accountname: string | undefined
): string {
  const appName = __DEV__ ? 'GitHub Desktop Dev' : 'GitHub'

  return `${appName} - ${endpoint} - ${accountname}`
}
