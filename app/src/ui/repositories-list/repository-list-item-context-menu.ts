import * as Path from 'path'

import {
  Repository,
  getRepositoryAccountIdentity,
} from '../../models/repository'
import { Account, isSameAccount } from '../../models/account'
import { IMenuItem } from '../../lib/menu-item'
import { Repositoryish } from './group-repositories'
import { writeClipboardText } from '../main-process-proxy'
import {
  RevealInFileManagerLabel,
  DefaultEditorLabel,
  DefaultShellLabel,
} from '../lib/context-menu'
import { isRepositoryWithGitHubRepository } from '../../models/repository'
import { hasDefaultRemoteUrl } from '../../lib/repository-remote-url'
import { GitHubRepository } from '../../models/github-repository'
import { getForgejoName } from '../../lib/forgejo-name'
import { WorktreeEntry } from '../../models/worktree'

interface IRepositoryListItemContextMenuConfig {
  repository: Repositoryish
  shellLabel: string | undefined
  externalEditorLabel: string | undefined
  askForConfirmationOnRemoveRepository: boolean
  /** The signed-in accounts. */
  accounts: ReadonlyArray<Account>
  onViewOnGitHub: (repository: Repositoryish) => void
  onOpenInNewWindow?: (repository: Repositoryish, path?: string) => void
  onOpenInShell: (repository: Repositoryish, path?: string) => void
  onShowRepository: (repository: Repositoryish, path?: string) => void
  onOpenInExternalEditor: (repository: Repositoryish, path?: string) => void
  onRemoveRepository: (repository: Repositoryish) => void
  onSnoozeRepository: (repository: Repository) => void
  onChangeRepositoryAlias: (repository: Repository) => void
  onRemoveRepositoryAlias: (repository: Repository) => void
  /** Opens the dialog to create a new group, preselecting this repository */
  onNewGroupForRepository: (repository: Repository) => void
  onRemoveRepositoryGroupName: (repository: Repository) => void
  /** The custom group names currently in use, sorted */
  groupNames: ReadonlyArray<string>
  onAssignRepositoryGroupName: (
    repository: Repository,
    groupName: string
  ) => void
  onCopyRepoPath: (path: string) => void
  isPinned?: boolean
  onTogglePinnedRepository?: (repository: Repository) => void
  onCreateWorktree?: (repository: Repository) => void
  onShowWorktrees?: (repository: Repository) => void
  worktreePath?: string
  onChangeRepositoryAccount: (repository: Repository, login: string) => void
  onShowRepositorySettings: (repository: Repository) => void
}

export const generateRepositoryListContextMenu = (
  config: IRepositoryListItemContextMenuConfig
) => {
  const { repository } = config
  const missing = repository instanceof Repository && repository.missing
  const github =
    repository instanceof Repository &&
    isRepositoryWithGitHubRepository(repository)
  const hasOriginUrl =
    repository instanceof Repository && hasDefaultRemoteUrl(repository)
  const canOpenInNewWindow =
    repository instanceof Repository && !repository.missing
  const openInExternalEditor = config.externalEditorLabel
    ? `Open in ${config.externalEditorLabel}`
    : DefaultEditorLabel
  const openInShell = config.shellLabel
    ? `Open in ${config.shellLabel}`
    : DefaultShellLabel

  const items: ReadonlyArray<IMenuItem> = [
    ...buildAliasMenuItems(config),
    ...buildGroupNameMenuItems(config),
    ...buildWorktreeMenuItems(config),
    ...buildAccountMenuItems(config),
    ...buildRepositorySettingsMenuItems(config),
    { type: 'separator' },
    {
      label: __DARWIN__ ? 'Copy Repo Name' : 'Copy repo name',
      action: () => writeClipboardText(repository.name),
    },
    {
      label: __DARWIN__ ? 'Copy Repo Path' : 'Copy repo path',
      action: () => config.onCopyRepoPath(repository.path),
    },
    { type: 'separator' },
    {
      label: getViewOnBrowserLabel(github ? repository.gitHubRepository : null),
      action: () => config.onViewOnGitHub(repository),
      enabled: github || hasOriginUrl,
    },
    ...(config.onOpenInNewWindow && canOpenInNewWindow
      ? [
          {
            label: __DARWIN__
              ? 'Open Repository in New Window'
              : 'Open repository in new window',
            action: () =>
              config.onOpenInNewWindow?.(repository, config.worktreePath),
          },
        ]
      : []),
    {
      label: openInShell,
      action: () => config.onOpenInShell(repository, config.worktreePath),
      enabled: !missing,
    },
    {
      label: RevealInFileManagerLabel,
      action: () => config.onShowRepository(repository, config.worktreePath),
      enabled: !missing,
    },
    {
      label: openInExternalEditor,
      action: () =>
        config.onOpenInExternalEditor(repository, config.worktreePath),
      enabled: !missing,
    },
    { type: 'separator' },
    ...(repository instanceof Repository
      ? [
          {
            label: 'Snooze…',
            action: () => config.onSnoozeRepository(repository),
          },
        ]
      : []),
    {
      label: config.askForConfirmationOnRemoveRepository ? 'Remove…' : 'Remove',
      action: () => config.onRemoveRepository(repository),
    },
  ]

  return items
}

interface IWorktreeListItemContextMenuConfig {
  repository: Repository
  worktree: WorktreeEntry
  shellLabel: string | undefined
  externalEditorLabel: string | undefined
  onCreateWorktree: (repository: Repository) => void
  onRenameWorktree: (repository: Repository, worktreePath: string) => void
  onDeleteWorktree: (repository: Repository, worktreePath: string) => void
  onViewOnGitHub: (repository: Repositoryish) => void
  onOpenWorktreeInNewWindow: (worktreePath: string) => void
  onOpenInShell: (repository: Repositoryish, path?: string) => void
  onShowRepository: (repository: Repositoryish, path?: string) => void
  onOpenInExternalEditor: (repository: Repositoryish, path?: string) => void
  onCopyWorktreePath: (path: string) => void
}

export const generateWorktreeListItemContextMenu = (
  config: IWorktreeListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository, worktree } = config
  const path = worktree.path
  const name = Path.basename(path)
  const isGitHub = isRepositoryWithGitHubRepository(repository)
  const hasOriginUrl = hasDefaultRemoteUrl(repository)
  const canModify = !worktree.isLocked
  const openInExternalEditor = config.externalEditorLabel
    ? `Open in ${config.externalEditorLabel}`
    : DefaultEditorLabel
  const openInShell = config.shellLabel
    ? `Open in ${config.shellLabel}`
    : DefaultShellLabel

  return [
    {
      label: __DARWIN__ ? 'New Worktree…' : 'New worktree…',
      action: () => config.onCreateWorktree(repository),
    },
    {
      label: __DARWIN__ ? 'Rename Worktree…' : 'Rename worktree…',
      action: () => config.onRenameWorktree(repository, path),
      enabled: canModify,
    },
    { type: 'separator' },
    {
      label: __DARWIN__ ? 'Copy Worktree Name' : 'Copy worktree name',
      action: () => writeClipboardText(name),
    },
    {
      label: __DARWIN__ ? 'Copy Worktree Path' : 'Copy worktree path',
      action: () => config.onCopyWorktreePath(path),
    },
    { type: 'separator' },
    {
      label: getViewOnBrowserLabel(
        isGitHub ? repository.gitHubRepository : null
      ),
      action: () => config.onViewOnGitHub(repository),
      enabled: isGitHub || hasOriginUrl,
    },
    {
      label: __DARWIN__
        ? 'Open Worktree in New Window'
        : 'Open worktree in new window',
      action: () => config.onOpenWorktreeInNewWindow(path),
    },
    {
      label: openInShell,
      action: () => config.onOpenInShell(repository, path),
    },
    {
      label: RevealInFileManagerLabel,
      action: () => config.onShowRepository(repository, path),
    },
    {
      label: openInExternalEditor,
      action: () => config.onOpenInExternalEditor(repository, path),
    },
    { type: 'separator' },
    {
      label: __DARWIN__ ? 'Delete Worktree…' : 'Delete worktree…',
      action: () => config.onDeleteWorktree(repository, path),
      enabled: canModify,
    },
  ]
}

function getViewOnBrowserLabel(gitHubRepository: GitHubRepository | null) {
  switch (gitHubRepository?.type) {
    case 'github':
      return 'View on GitHub'
    case 'bitbucket':
      return 'View on Bitbucket'
    case 'gitlab':
      return 'View on GitLab'
    case 'forgejo':
      return `View on ${getForgejoName(gitHubRepository.endpoint)}`
    case 'gitea':
      return 'View on Gitea'
    default:
      return 'View in your browser'
  }
}

const buildAliasMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (!(repository instanceof Repository)) {
    return []
  }

  const verb = repository.alias == null ? 'Create' : 'Change'
  const items: Array<IMenuItem> = [
    {
      label: __DARWIN__ ? `${verb} Alias` : `${verb} alias`,
      action: () => config.onChangeRepositoryAlias(repository),
    },
  ]

  if (repository.alias !== null) {
    items.push({
      label: __DARWIN__ ? 'Remove Alias' : 'Remove alias',
      action: () => config.onRemoveRepositoryAlias(repository),
    })
  }

  return items
}

/**
 * Builds the list of menu items offered when assigning a repository to a
 * group: a fake "Pinned" entry that just pins/unpins the repository, one
 * toggleable entry per existing custom group, an entry to create a new group,
 * and an entry to leave the current group.
 */
const buildAssignToGroupMenuItems = (
  repository: Repository,
  groupNames: ReadonlyArray<string>,
  onAssignRepositoryGroupName: (
    repository: Repository,
    groupName: string
  ) => void,
  onRemoveRepositoryGroupName: (repository: Repository) => void,
  onNewGroupForRepository: (repository: Repository) => void,
  pin?: {
    isPinned: boolean
    onTogglePinnedRepository: (repository: Repository) => void
  }
): ReadonlyArray<IMenuItem> => {
  const items: Array<IMenuItem> = []

  if (pin) {
    items.push(
      {
        label: 'Pinned',
        type: 'checkbox',
        checked: pin.isPinned,
        action: () => pin.onTogglePinnedRepository(repository),
      },
      { type: 'separator' }
    )
  }

  items.push(
    ...groupNames.map(groupName => {
      const isCurrentGroup = repository.groupName === groupName

      return {
        label: groupName,
        type: 'checkbox' as const,
        checked: isCurrentGroup,
        action: () =>
          isCurrentGroup
            ? onRemoveRepositoryGroupName(repository)
            : onAssignRepositoryGroupName(repository, groupName),
      }
    })
  )

  if (groupNames.length > 0) {
    items.push({ type: 'separator' })
  }

  items.push({
    label: __DARWIN__ ? 'New Group…' : 'New group…',
    action: () => onNewGroupForRepository(repository),
  })

  if (repository.groupName !== null) {
    items.push({
      label: __DARWIN__ ? 'Remove From Group' : 'Remove from group',
      action: () => onRemoveRepositoryGroupName(repository),
    })
  }

  return items
}

const buildGroupNameMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository, groupNames } = config

  if (!(repository instanceof Repository)) {
    return []
  }

  const submenu = buildAssignToGroupMenuItems(
    repository,
    groupNames,
    config.onAssignRepositoryGroupName,
    config.onRemoveRepositoryGroupName,
    config.onNewGroupForRepository,
    config.onTogglePinnedRepository
      ? {
          isPinned: config.isPinned ?? false,
          onTogglePinnedRepository: config.onTogglePinnedRepository,
        }
      : undefined
  )

  return [
    {
      label: __DARWIN__ ? 'Move to Group' : 'Move to group',
      submenu,
    },
  ]
}

const buildWorktreeMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository, onCreateWorktree, onShowWorktrees } = config

  if (!(repository instanceof Repository)) {
    return []
  }

  if (onCreateWorktree === undefined && onShowWorktrees === undefined) {
    return []
  }

  const items: Array<IMenuItem> = []

  if (onShowWorktrees !== undefined) {
    items.push({
      label: __DARWIN__ ? 'Show Worktrees' : 'Show worktrees',
      action: () => onShowWorktrees(repository),
    })
  }

  if (onCreateWorktree !== undefined) {
    items.push({
      label: __DARWIN__ ? 'New Worktree…' : 'New worktree…',
      action: () => onCreateWorktree(repository),
    })
  }

  return items
}

/**
 * Build the Account submenu used to reassign a repository to another
 * signed-in account on its endpoint.
 *
 * The submenu is omitted when there is nothing to choose between: when the
 * repository is assigned and its endpoint has only one retained account
 * identity, or when it's unassigned and no account is signed in on its
 * endpoint. An assigned account that has been signed out is still listed
 * (checked and disabled) so users can see the current association.
 */
const buildAccountMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (
    !(repository instanceof Repository) ||
    repository.gitHubRepository === null
  ) {
    return []
  }

  const { endpoint } = repository.gitHubRepository
  const assigned = getRepositoryAccountIdentity(repository)
  const eligible = config.accounts.filter(a => a.endpoint === endpoint)
  const signedOut =
    assigned !== null && !eligible.some(a => isSameAccount(a, assigned))
  const retainedCount = eligible.length + (signedOut ? 1 : 0)

  if (assigned === null ? eligible.length === 0 : retainedCount <= 1) {
    return []
  }

  const submenu: Array<IMenuItem> = []

  if (signedOut) {
    submenu.push({
      label: `@${assigned.login} (Signed out)`,
      type: 'checkbox',
      checked: true,
      enabled: false,
    })
  }

  for (const account of eligible) {
    const checked = isSameAccount(account, assigned)
    submenu.push({
      label: `@${account.login}`,
      type: 'checkbox',
      checked,
      action: checked
        ? undefined
        : () => config.onChangeRepositoryAccount(repository, account.login),
    })
  }

  return [{ label: 'Account', submenu }]
}

const buildRepositorySettingsMenuItems = (
  config: IRepositoryListItemContextMenuConfig
): ReadonlyArray<IMenuItem> => {
  const { repository } = config

  if (!(repository instanceof Repository) || repository.missing) {
    return []
  }

  return [
    {
      label: __DARWIN__ ? 'Repository Settings…' : 'Repository settings…',
      action: () => config.onShowRepositorySettings(repository),
    },
  ]
}
