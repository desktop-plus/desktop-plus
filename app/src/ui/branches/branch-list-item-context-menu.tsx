import { IMenuItem } from '../../lib/menu-item'
import { writeClipboardText } from '../main-process-proxy'
import { Branch, BranchType } from '../../models/branch'
import { GitHubRepository } from '../../models/github-repository'
import { getForgejoName } from '../../lib/forgejo-name'
import { assertNever } from '../../lib/fatal-error'

interface IBranchContextMenuConfig {
  branch: Branch
  gitHubRepository: GitHubRepository | null
  onRenameBranch?: (branchName: string) => void
  onViewBranchOnGitHub?: () => void
  onViewPullRequestOnGitHub?: () => void
  onSetAsDefaultBranch?: (branchName: string) => void
  onDuplicateBranch?: (branch: Branch) => void
  onDeleteBranch?: (branchName: string) => void
  onDeleteUnusedLocalBranches?: () => void
  onPullSingleBranch?: (branchName: string) => void
  onCheckoutInNewWorktree?: (branch: Branch) => void
}

export function generateBranchContextMenuItems(
  config: IBranchContextMenuConfig
): IMenuItem[] {
  const {
    branch,
    gitHubRepository,
    onRenameBranch,
    onViewBranchOnGitHub,
    onViewPullRequestOnGitHub,
    onSetAsDefaultBranch,
    onDuplicateBranch,
    onDeleteBranch,
    onDeleteUnusedLocalBranches,
    onPullSingleBranch,
    onCheckoutInNewWorktree,
  } = config
  const items = new Array<IMenuItem>()

  if (onRenameBranch !== undefined) {
    items.push({
      label: 'Rename…',
      action: () => onRenameBranch(branch.name),
      enabled: branch.type === BranchType.Local,
    })
  }

  items.push({
    label: __DARWIN__ ? 'Copy Branch Name' : 'Copy branch name',
    action: () => writeClipboardText(branch.name),
  })

  if (onViewBranchOnGitHub !== undefined && gitHubRepository !== null) {
    items.push({
      label: getViewBranchLabel(gitHubRepository),
      action: () => onViewBranchOnGitHub(),
    })
  }

  if (onViewPullRequestOnGitHub !== undefined && gitHubRepository !== null) {
    items.push({
      label: getViewPullRequestLabel(gitHubRepository),
      action: () => onViewPullRequestOnGitHub(),
    })
  }

  if (onCheckoutInNewWorktree !== undefined) {
    items.push({
      label: __DARWIN__
        ? 'Checkout in New Worktree…'
        : 'Checkout in new worktree…',
      action: () => onCheckoutInNewWorktree(branch),
    })
  }

  if (onDuplicateBranch !== undefined) {
    items.push({
      label: __DARWIN__ ? 'Duplicate Branch…' : 'Duplicate branch…',
      action: () => onDuplicateBranch(branch),
    })
  }

  if (onPullSingleBranch) {
    items.push({ type: 'separator' })
    items.push({
      label: __DARWIN__ ? 'Pull Branch' : 'Pull branch',
      action: () => onPullSingleBranch(branch.name),
      enabled: true,
    })
  }

  if (onSetAsDefaultBranch !== undefined) {
    items.push({
      label: __DARWIN__ ? 'Set as Default Branch' : 'Set as default branch',
      action: () => onSetAsDefaultBranch(branch.nameWithoutRemote),
    })
  }

  if (onDeleteBranch !== undefined) {
    items.push({ type: 'separator' })
    items.push({
      label: 'Delete…',
      action: () => onDeleteBranch(branch.name),
    })
  }

  if (onDeleteUnusedLocalBranches !== undefined) {
    items.push({
      label: __DARWIN__
        ? 'Delete Unused Local Branches…'
        : 'Delete unused local branches…',
      action: () => onDeleteUnusedLocalBranches(),
    })
  }

  return items
}

function getViewBranchLabel(gitHubRepository: GitHubRepository): string {
  const branch = __DARWIN__ ? 'Branch' : 'branch'
  switch (gitHubRepository.type) {
    case 'github':
      return `View ${branch} on GitHub`
    case 'bitbucket':
      return `View ${branch} on Bitbucket`
    case 'gitlab':
      return `View ${branch} on GitLab`
    case 'forgejo':
      return `View ${branch} on ${getForgejoName(gitHubRepository.endpoint)}`
    case 'gitea':
      return `View ${branch} on Gitea`
    default:
      return assertNever(
        gitHubRepository.type,
        `Unknown repo type: ${gitHubRepository.type}`
      )
  }
}

function getViewPullRequestLabel(gitHubRepository: GitHubRepository): string {
  switch (gitHubRepository.type) {
    case 'github':
      return 'View Pull Request on GitHub'
    case 'bitbucket':
      return 'View Pull Request on Bitbucket'
    case 'gitlab':
      return 'View Merge Request on GitLab'
    case 'forgejo':
      return `View Pull Request on ${getForgejoName(gitHubRepository.endpoint)}`
    case 'gitea':
      return 'View Pull Request on Gitea'
    default:
      return assertNever(
        gitHubRepository.type,
        `Unknown repo type: ${gitHubRepository.type}`
      )
  }
}
