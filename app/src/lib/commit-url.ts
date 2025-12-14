import * as crypto from 'crypto'
import { GitHubRepository } from '../models/github-repository'
import { assertNever } from './fatal-error'

/** Method to create the url for viewing a commit on dotcom */
export function createCommitURL(
  gitHubRepository: GitHubRepository,
  SHA: string,
  filePath?: string
): string | null {
  const baseURL = gitHubRepository.htmlURL

  if (baseURL === null) {
    return null
  }

  if (filePath === undefined) {
    switch (gitHubRepository.type) {
      case 'github':
        return `${baseURL}/commit/${SHA}`
      case 'bitbucket':
        return `${baseURL}/commits/${SHA}`
      case 'gitlab':
        return `${baseURL}/-/commit/${SHA}`
      default:
        assertNever(
          gitHubRepository.type,
          `Unknown type: ${gitHubRepository.type}`
        )
    }
  }

  const fileHash = crypto.createHash('sha256').update(filePath).digest('hex')
  switch (gitHubRepository.type) {
    case 'github':
      return `${baseURL}/commit/${SHA}#diff-${fileHash}`
    case 'bitbucket':
      return `${baseURL}/commits/${SHA}#chg-${filePath}`
    case 'gitlab':
      return `${baseURL}/-/commit/${SHA}#diff-${fileHash}`
    default:
      assertNever(
        gitHubRepository.type,
        `Unknown type: ${gitHubRepository.type}`
      )
  }
}
