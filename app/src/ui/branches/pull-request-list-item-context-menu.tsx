import { assertNever } from '../../lib/fatal-error'
import { IMenuItem } from '../../lib/menu-item'
import { RepoType } from '../../models/github-repository'

interface IPullRequestContextMenuConfig {
  onViewPullRequestOnGitHub?: () => void
  repoType: RepoType
}

export function generatePullRequestContextMenuItems(
  config: IPullRequestContextMenuConfig
): IMenuItem[] {
  const { onViewPullRequestOnGitHub } = config
  const items = new Array<IMenuItem>()

  if (onViewPullRequestOnGitHub !== undefined) {
    items.push({
      label: getViewPullRequestLabel(config.repoType),
      action: () => onViewPullRequestOnGitHub(),
    })
  }

  return items
}

function getViewPullRequestLabel(repoType: RepoType): string {
  switch (repoType) {
    case 'github':
      return 'View Pull Request on GitHub'
    case 'bitbucket':
      return 'View Pull Request on Bitbucket'
    case 'gitlab':
      return 'View Merge Request on GitLab'
    default:
      assertNever(repoType, `Unknown repo type: ${repoType}`)
  }
}
