import * as Path from 'path'

import { IMenuItem } from '../../lib/menu-item'
import { writeClipboardText } from '../main-process-proxy'
import { isRepositoryAffectedByAssistedCommit } from '../../lib/git/repository-operation'

interface IWorktreeContextMenuConfig {
  readonly path: string
  readonly isMainWorktree: boolean
  readonly isLocked: boolean
  readonly onRenameWorktree?: (path: string) => void
  readonly onRemoveWorktree?: (path: string) => void
  readonly onOpenInNewWindow?: () => void
}

export function generateWorktreeContextMenuItems(
  config: IWorktreeContextMenuConfig
): ReadonlyArray<IMenuItem> {
  const {
    path,
    isMainWorktree,
    isLocked,
    onRenameWorktree,
    onRemoveWorktree,
    onOpenInNewWindow,
  } = config
  const name = Path.basename(path)
  const canMutate =
    !isMainWorktree && !isLocked && !isRepositoryAffectedByAssistedCommit(path)
  const items = new Array<IMenuItem>()

  if (onOpenInNewWindow !== undefined) {
    items.push({
      label: __DARWIN__
        ? 'Open Worktree in New Window'
        : 'Open worktree in new window',
      action: () => onOpenInNewWindow(),
    })
    items.push({ type: 'separator' })
  }

  if (onRenameWorktree !== undefined) {
    items.push({
      label: 'Rename…',
      action: () => onRenameWorktree(path),
      enabled: canMutate,
    })
  }

  items.push({
    label: __DARWIN__ ? 'Copy Worktree Name' : 'Copy worktree name',
    action: () => writeClipboardText(name),
  })

  items.push({
    label: __DARWIN__ ? 'Copy Worktree Path' : 'Copy worktree path',
    action: () => writeClipboardText(path),
  })

  if (onRemoveWorktree !== undefined) {
    items.push({ type: 'separator' })
    items.push({
      label: 'Delete…',
      action: () => onRemoveWorktree(path),
      enabled: canMutate,
    })
  }

  return items
}
