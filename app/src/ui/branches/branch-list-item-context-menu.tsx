import { IMenuItem } from '../../lib/menu-item'
import { clipboard } from 'electron'
import { RepoType } from '../../models/github-repository'
import { assertNever } from '../../lib/fatal-error'

interface IBranchContextMenuConfig {
  name: string
  nameWithoutRemote: string
  isLocal: boolean
  repoType: RepoType | undefined
  onRenameBranch?: (branchName: string) => void
  onViewBranchOnGitHub?: () => void
  onViewPullRequestOnGitHub?: () => void
  onMakeDefaultBranch?: (branchName: string) => void
  onDeleteBranch?: (branchName: string) => void
}

export function generateBranchContextMenuItems(
  config: IBranchContextMenuConfig
): IMenuItem[] {
  const {
    name,
    nameWithoutRemote,
    isLocal,
    repoType,
    onRenameBranch,
    onViewBranchOnGitHub,
    onViewPullRequestOnGitHub,
    onMakeDefaultBranch,
    onDeleteBranch,
  } = config
  const items = new Array<IMenuItem>()

  if (onRenameBranch !== undefined) {
    items.push({
      label: 'Rename…',
      action: () => onRenameBranch(name),
      enabled: isLocal,
    })
  }

  items.push({
    label: __DARWIN__ ? 'Copy Branch Name' : 'Copy branch name',
    action: () => clipboard.writeText(name),
  })

  if (onViewBranchOnGitHub !== undefined && repoType !== undefined) {
    items.push({
      label: getViewBranchLabel(repoType),
      action: () => onViewBranchOnGitHub(),
    })
  }

  if (onViewPullRequestOnGitHub !== undefined && repoType !== undefined) {
    items.push({
      label: getViewPullRequestLabel(repoType),
      action: () => onViewPullRequestOnGitHub(),
    })
  }

  if (onMakeDefaultBranch !== undefined) {
    items.push({
      label: __DARWIN__ ? 'Make The Default Branch' : 'Make the default branch',
      action: () => onMakeDefaultBranch(nameWithoutRemote),
    })
  }

  items.push({ type: 'separator' })

  if (onDeleteBranch !== undefined) {
    items.push({
      label: 'Delete…',
      action: () => onDeleteBranch(name),
    })
  }

  return items
}

function getViewBranchLabel(repoType: RepoType): string {
  const branch = __DARWIN__ ? 'Branch' : 'branch'
  switch (repoType) {
    case 'github':
      return `View ${branch} on GitHub`
    case 'bitbucket':
      return `View ${branch} on Bitbucket`
    case 'gitlab':
      return `View ${branch} on GitLab`
    default:
      return assertNever(repoType, `Unknown repo type: ${repoType}`)
  }
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
      return assertNever(repoType, `Unknown repo type: ${repoType}`)
  }
}
