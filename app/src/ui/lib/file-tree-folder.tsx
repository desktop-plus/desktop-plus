import * as React from 'react'
import classNames from 'classnames'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Checkbox, CheckboxValue } from './checkbox'
import { Button } from './button'
import { getBoolean, setBoolean } from '../../lib/local-storage'
import * as Path from 'path'
import { Repository } from '../../models/repository'
import { Dispatcher } from '../dispatcher'
import { IMenuItem } from '../../lib/menu-item'
import { revealInFileManager } from '../../lib/app-shell'
import {
  CopyFolderPathLabel,
  CopyRelativeFolderPathLabel,
  RevealInFileManagerLabel,
} from './context-menu'

const fileTreeViewKey = 'file-list-tree-view'

/** Whether changed files should be shown as a tree (persisted per machine) */
export const getFileTreeView = () => getBoolean(fileTreeViewKey, false)

export const setFileTreeView = (treeView: boolean) =>
  setBoolean(fileTreeViewKey, treeView)

/** Horizontal indentation per tree level, in pixels */
const FileTreeIndent = 16

/** Width taken by the indentation of a tree row at the given depth */
export const fileTreeIndentWidth = (depth: number) => depth * FileTreeIndent

/**
 * Indentation of a tree row, with a thin vertical line for each ancestor
 * folder. The lines of consecutive rows join into continuous guides.
 */
export const FileTreeGuides: React.FunctionComponent<{
  readonly depth: number
}> = ({ depth }) =>
  depth > 0 ? (
    <span className="file-tree-indent" aria-hidden={true}>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="file-tree-guide" />
      ))}
    </span>
  ) : null

/** Context menu items acting on the path of a folder in a file tree */
export function getFolderPathMenuItems(
  repository: Repository,
  dispatcher: Dispatcher,
  path: string
): ReadonlyArray<IMenuItem> {
  return [
    {
      label: CopyFolderPathLabel,
      action: () =>
        dispatcher.copyPathToClipboard(Path.join(repository.path, path)),
    },
    {
      label: CopyRelativeFolderPathLabel,
      action: () => dispatcher.copyPathToClipboard(Path.normalize(path)),
    },
    { type: 'separator' },
    {
      label: RevealInFileManagerLabel,
      action: () => revealInFileManager(repository, path),
    },
  ]
}

interface IFileTreeFolderProps {
  readonly path: string
  readonly name: string
  readonly depth: number
  readonly collapsed: boolean
  /** Number of changed files in the folder, including nested ones */
  readonly fileCount: number
  readonly onToggleCollapsed: (path: string) => void
  readonly onContextMenu?: (
    path: string,
    event: React.MouseEvent<HTMLDivElement>
  ) => void

  /** When set, render a checkbox for including all files in the folder */
  readonly include?: CheckboxValue
  readonly disableInclude?: boolean
  readonly onIncludeChanged?: (path: string, include: boolean) => void
}

/** A collapsible folder row in a file tree view */
export class FileTreeFolder extends React.Component<IFileTreeFolderProps> {
  private onToggle = () => {
    this.props.onToggleCollapsed(this.props.path)
  }

  private onIncludeChanged = (event: React.FormEvent<HTMLInputElement>) => {
    this.props.onIncludeChanged?.(this.props.path, event.currentTarget.checked)
  }

  private onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    this.props.onContextMenu?.(this.props.path, event)
  }

  public render() {
    const { path, name, depth, collapsed, fileCount, include, disableInclude } =
      this.props
    const prefixEnd = name.lastIndexOf('/') + 1

    return (
      <div className="file file-tree-folder" onContextMenu={this.onContextMenu}>
        <FileTreeGuides depth={depth} />
        {include !== undefined && (
          <Checkbox
            tabIndex={-1}
            value={include}
            onChange={this.onIncludeChanged}
            disabled={disableInclude}
          />
        )}
        <button
          className="file-tree-toggle"
          aria-expanded={!collapsed}
          aria-label={`${path} folder, ${fileCount} changed`}
          onClick={this.onToggle}
        >
          <Octicon
            className="file-tree-chevron"
            symbol={collapsed ? octicons.chevronRight : octicons.chevronDown}
          />
          <span className="folder-name">
            <span className="folder-name-prefix">
              {name.substring(0, prefixEnd)}
            </span>
            {name.substring(prefixEnd)}
          </span>
        </button>
        <span className="folder-count" aria-hidden={true}>
          {fileCount}
        </span>
      </div>
    )
  }
}

interface IFileTreeViewToggleProps {
  readonly treeView: boolean
  readonly onChange: (treeView: boolean) => void
}

/** Buttons switching a file list between a plain list and a folder tree */
export class FileTreeViewToggle extends React.Component<IFileTreeViewToggleProps> {
  private onPathView = () => this.props.onChange(false)
  private onTreeView = () => this.props.onChange(true)

  public render() {
    const { treeView } = this.props
    return (
      <div
        className="file-tree-view-toggle view-mode-switch"
        role="group"
        aria-label="File list view mode"
      >
        <Button
          size="small"
          className={classNames('view-mode-switch-item', {
            selected: !treeView,
          })}
          onClick={this.onPathView}
          ariaLabel="Plain list"
          ariaPressed={!treeView}
          tooltip="Plain list"
        >
          <Octicon symbol={octicons.listUnordered} />
        </Button>
        <Button
          size="small"
          className={classNames('view-mode-switch-item', {
            selected: treeView,
          })}
          onClick={this.onTreeView}
          ariaLabel="Folder tree"
          ariaPressed={treeView}
          tooltip="Folder tree"
        >
          <Octicon symbol={octicons.fileDirectory} />
        </Button>
      </div>
    )
  }
}
