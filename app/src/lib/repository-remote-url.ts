import {
  Repository,
  getGitHubHtmlUrl,
  isRepositoryWithGitHubRepository,
} from '../models/repository'
import { memoizedGetRemotesFromPath } from './git'
import { findDefaultRemote } from './stores/helpers/find-default-remote'
import { remoteUrlToWebUrl } from './remote-parsing'

const remoteUrls = new WeakMap<Repository, string>()

/**
 * The URL of the repository's default remote, or null until it has been read
 * from git (the first call starts reading it).
 */
export function getDefaultRemoteUrl(repository: Repository): string | null {
  const url = remoteUrls.get(repository)
  if (url !== undefined) {
    return url
  }

  memoizedGetRemotesFromPath(repository.path)
    .then(remotes => {
      const defaultRemote = findDefaultRemote(remotes)
      if (defaultRemote) {
        remoteUrls.set(repository, defaultRemote.url)
      }
    })
    .catch(e => log.warn(`Couldn't read the remotes of ${repository.path}`, e))
  return null
}

/**
 * Get the html URL for a non-GitHub repository, if it has one.
 * Will return the origin repository's URL if it has one and the URL is trusted.
 * Otherwise, returns null.
 */
export function getNonGitHubUrl(repository: Repository): string | null {
  // Usually, this method will not be called for GitHub repositories, but better be safe than sorry.
  if (isRepositoryWithGitHubRepository(repository)) {
    return null
  }

  const url = getDefaultRemoteUrl(repository)
  return url ? remoteUrlToWebUrl(url) : null
}

/**
 * Returns whether the passed repository has a default remote URL set.
 *
 * This function does not check the validity of the URL.
 */
export function hasDefaultRemoteUrl(repository: Repository): boolean {
  return (getGitHubHtmlUrl(repository) ?? getNonGitHubUrl(repository)) !== null
}
