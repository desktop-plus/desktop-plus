import memoizeOne from 'memoize-one'
import { getHTMLURL } from '../api'
import { getGenericPassword, getGenericUsername } from '../generic-git-auth'
import { AccountsStore } from '../stores'
import { urlWithoutCredentials } from './url-without-credentials'
import { Account } from '../../models/account'

/**
 * When we're asked for credentials we're typically first asked for the username
 * immediately followed by the password. We memoize the getGenericPassword call
 * such that we only call it once per endpoint/login pair. Since we include the
 * trampoline token in the invalidation key we'll only call it once per
 * trampoline session.
 */
const memoizedGetGenericPassword = memoizeOne(
  (_trampolineToken: string, endpoint: string, login: string) =>
    getGenericPassword(endpoint, login)
)

export async function findGitHubTrampolineAccount(
  accountsStore: AccountsStore,
  remoteUrl: string,
  login?: string
): Promise<Account | undefined> {
  const accounts = await accountsStore.getAll()
  const parsedUrl = new URL(remoteUrl)
  if (login !== undefined && login === '') {
    // TODO: This is here temporarily for debugging, remove it when we're sure this isn't a possibility
    throw new Error(`Empty string is not a valid login`)
  }
  return accounts.find(
    a =>
      new URL(getHTMLURL(a.endpoint)).origin === parsedUrl.origin &&
      (login === undefined || a.login === login)
  )
}

export async function findGenericTrampolineAccount(
  trampolineToken: string,
  remoteUrl: string
) {
  const parsedUrl = new URL(remoteUrl)
  const endpoint = urlWithoutCredentials(remoteUrl)

  const login =
    parsedUrl.username === ''
      ? getGenericUsername(endpoint)
      : parsedUrl.username

  if (!login) {
    return undefined
  }

  const token = await memoizedGetGenericPassword(
    trampolineToken,
    endpoint,
    login
  )

  if (!token) {
    // We have a username but no password, that warrants a warning
    log.warn(`credential: generic password for ${remoteUrl} missing`)
    return undefined
  }

  return { login, endpoint, token }
}
