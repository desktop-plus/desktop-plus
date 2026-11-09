import * as React from 'react'
import * as Path from 'path'

import { Dispatcher } from '../dispatcher'
import { IMenuItem } from '../../lib/menu-item'
import { revealInFileManager } from '../../lib/app-shell'
import { encodePathAsUrl } from '../../lib/path'
import {
  WorkingDirectoryStatus,
  WorkingDirectoryFileChange,
  AppFileStatusKind,
} from '../../models/status'
import { DiffSelectionType } from '../../models/diff'
import { CommitIdentity } from '../../models/commit-identity'
import { IConfigValueOrigin } from '../../lib/git/config'
import { ICommitMessage } from '../../models/commit-message'
import { CommitMode } from '../../models/commit-mode'
import { ICopilotAssistedCommitRequest } from '../../models/copilot-assisted-commit'
import { AssistedCommitRunState } from '../../models/assisted-commit-run'
import {
  isRepositoryWithGitHubRepository,
  Repository,
} from '../../models/repository'
import { Account } from '../../models/account'
import { Author, UnknownAuthor } from '../../models/author'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { CommitOptions, IFileListFilterState } from '../../lib/app-state'
import {
  isSafeFileExtension,
  DefaultEditorLabel,
  CopyFilePathLabel,
  RevealInFileManagerLabel,
  OpenWithDefaultProgramLabel,
  CopyRelativeFilePathLabel,
  CopySelectedPathsLabel,
  CopySelectedRelativePathsLabel,
} from '../lib/context-menu'
import { CommitMessage } from './commit-message'
import { ChangedFile } from './changed-file'
import { IAutocompletionProvider } from '../autocompletion'
import { showContextualMenu } from '../../lib/menu-item'
import { arrayEquals } from '../../lib/equality'
import { basename } from 'path'
import { Commit, ICommitContext } from '../../models/commit'
import {
  RebaseConflictState,
  ConflictState,
  Foldout,
} from '../../lib/app-state'
import { ContinueRebase } from './continue-rebase'
import { Octicon, OcticonSymbolVariant } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { entryToString, IStashEntry } from '../../models/stash-entry'
import classNames from 'classnames'
import { hasWritePermission } from '../../models/github-repository'
import { hasConflictedFiles } from '../../lib/status'
import { createObservableRef } from '../lib/observable-ref'
import { Popup, PopupType } from '../../models/popup'
import { RepoRulesInfo } from '../../models/repo-rules'
import { IAheadBehind } from '../../models/branch'
import { StashDiffViewerId } from '../stashing'
import { AugmentedSectionFilterList } from '../lib/augmented-filter-list'
import { IFilterListGroup, IFilterListItem } from '../lib/filter-list'
import { ClickSource } from '../lib/list'
import memoizeOne from 'memoize-one'
import { IMatches } from '../../lib/fuzzy-find'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { LinkButton } from '../lib/link-button'
import { plural } from '../lib/plural'
import {
  isCommittingFileHiddenByFilter,
  getNoResultsMessage,
  hasActiveFilters,
  applyFilters,
} from './filter-changes-logic'
import { ChangesListFilterOptions } from './changes-list-filter-options'
import { generateStashListContextMenu } from '../stashing/stash-list-item-context-menu'
import { HookProgress } from '../../lib/git'
import { formatNumber } from '../../lib/format-number'
import {
  buildFileTreeRows,
  FileTreeRow,
  getNestedFolderPaths,
} from '../../lib/file-tree'
import {
  FileTreeFolder,
  FileTreeViewToggle,
  getFolderPathMenuItems,
} from '../lib/file-tree-folder'
import { match } from '../../lib/fuzzy-find'
import { getText } from '../lib/augmented-filter-list'
import { SelectionSource } from '../lib/filter-list'
import { FancyTextBox } from '../lib/fancy-text-box'

export interface IChangesListItem extends IFilterListItem {
  readonly id: string
  readonly text: ReadonlyArray<string>
  readonly change: WorkingDirectoryFileChange
  /** Tree depth when the list is shown as a tree */
  readonly depth?: number
}

const RowHeight = 29
const StashIcon: OcticonSymbolVariant = {
  w: 16,
  h: 16,
  p: [
    'M10.5 1.286h-9a.214.214 0 0 0-.214.214v9a.214.214 0 0 0 .214.214h9a.214.214 0 0 0 ' +
      '.214-.214v-9a.214.214 0 0 0-.214-.214zM1.5 0h9A1.5 1.5 0 0 1 12 1.5v9a1.5 1.5 0 0 1-1.5 ' +
      '1.5h-9A1.5 1.5 0 0 1 0 10.5v-9A1.5 1.5 0 0 1 1.5 0zm5.712 7.212a1.714 1.714 0 1 ' +
      '1-2.424-2.424 1.714 1.714 0 0 1 2.424 2.424zM2.015 12.71c.102.729.728 1.29 1.485 ' +
      '1.29h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.29-1.485v1.442a.216.216 0 0 1 ' +
      '.004.043v9a.214.214 0 0 1-.214.214h-9a.216.216 0 0 1-.043-.004H2.015zm2 2c.102.729.728 ' +
      '1.29 1.485 1.29h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.29-1.485v1.442a.216.216 0 0 1 ' +
      '.004.043v9a.214.214 0 0 1-.214.214h-9a.216.216 0 0 1-.043-.004H4.015z',
  ],
}

const GitIgnoreFileName = '.gitignore'

interface IFilterChangesListProps {
  readonly repository: Repository
  readonly repositoryAccount: Account | null
  readonly workingDirectory: WorkingDirectoryStatus
  readonly mostRecentLocalCommit: Commit | null
  /**
   * An object containing the conflicts in the working directory.
   * When null it means that there are no conflicts.
   */
  readonly conflictState: ConflictState | null
  readonly rebaseConflictState: RebaseConflictState | null
  readonly selectedFileIDs: ReadonlyArray<string>
  readonly onFileSelectionChanged: (rows: ReadonlyArray<number>) => void
  readonly onIncludeChanged: (
    file:
      | WorkingDirectoryFileChange
      | ReadonlyArray<WorkingDirectoryFileChange>,
    include: boolean
  ) => void
  readonly onCreateCommit: (context: ICommitContext) => Promise<boolean>
  readonly onDiscardChanges: (file: WorkingDirectoryFileChange) => void
  readonly askForConfirmationOnDiscardChanges: boolean
  readonly askForConfirmationOnCommitFilteredChanges: boolean
  readonly focusCommitMessage: boolean
  readonly isShowingModal: boolean
  readonly isShowingFoldout: boolean
  readonly askForConfirmationOnDiscardStash: boolean
  readonly onDiscardChangesFromFiles: (
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    isDiscardingAllChanges: boolean,
    permanentlyDelete: boolean
  ) => void
  readonly onStashChangesFromFiles: (
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    isStashingAllChanges: boolean
  ) => void

  /** Callback that fires on page scroll to pass the new scrollTop location */
  readonly onChangesListScrolled: (scrollTop: number) => void

  /* The scrollTop of the compareList. It is stored to allow for scroll position persistence */
  readonly changesListScrollTop?: number

  /**
   * Called to open a file in its default application
   *
   * @param path The path of the file relative to the root of the repository
   */
  readonly onOpenItem: (path: string) => void

  /**
   * Called to open a file in the default external editor
   *
   * @param path The path of the file relative to the root of the repository
   */
  readonly onOpenItemInExternalEditor: (path: string) => void

  /**
   * The currently checked out branch (null if no branch is checked out).
   */
  readonly branch: string | null
  readonly commitAuthor: CommitIdentity | null
  readonly commitAuthorNameOrigin?: IConfigValueOrigin | null
  readonly commitAuthorEmailOrigin?: IConfigValueOrigin | null
  readonly dispatcher: Dispatcher
  readonly availableWidth: number
  readonly isCommitting: boolean
  readonly hookProgress: HookProgress | null
  readonly onShowCommitProgress?: (() => void) | undefined
  readonly isGeneratingCommitMessage: boolean
  readonly shouldShowGenerateCommitMessageCallOut: boolean
  readonly commitMessageGenerationDisabled: boolean
  readonly commitToAmend: Commit | null
  readonly currentBranchProtected: boolean
  readonly currentRepoRulesInfo: RepoRulesInfo
  readonly aheadBehind: IAheadBehind | null

  /**
   * Click event handler passed directly to the onRowClick prop of List, see
   * List Props for documentation.
   */
  readonly onRowClick?: (row: number, source: ClickSource) => void
  readonly commitMessage: ICommitMessage
  readonly commitMode: CommitMode
  readonly pushAfterAssistedCommit?: boolean

  /** Provided only when a real Desktop-owned assisted commit executor is available. */
  readonly onCreateCopilotAssistedCommits?: (
    request: ICopilotAssistedCommitRequest
  ) => void

  /** Assisted operation progress, separate from manual message generation. */
  readonly isCreatingCopilotAssistedCommits?: boolean
  readonly repositoryMutationBlocked?: boolean

  readonly assistedCommitState?: AssistedCommitRunState
  readonly onPrepareCopilotAssistedCommitRequest?: (
    request: ICopilotAssistedCommitRequest
  ) => Promise<ICopilotAssistedCommitRequest>

  /** The autocompletion providers available to the repository. */
  readonly autocompletionProviders: ReadonlyArray<IAutocompletionProvider<any>>

  /** Called when the given file should be ignored. */
  readonly onIgnoreFile: (pattern: string | string[]) => void

  /** Called when the given pattern should be ignored. */
  readonly onIgnorePattern: (pattern: string | string[]) => void

  /**
   * Whether or not to show a field for adding co-authors to
   * a commit (currently only supported for GH/GHE repositories)
   */
  readonly showCoAuthoredBy: boolean

  /**
   * A list of authors (name, email pairs) which have been
   * entered into the co-authors input box in the commit form
   * and which _may_ be used in the subsequent commit to add
   * Co-Authored-By commit message trailers depending on whether
   * the user has chosen to do so.
   */
  readonly coAuthors: ReadonlyArray<Author>

  /** The name of the currently selected external editor */
  readonly externalEditorLabel?: string

  readonly stashEntries: ReadonlyArray<IStashEntry>

  readonly isShowingStashEntry: boolean

  /** The currently selected/viewed stash entry (if viewing stash) */
  readonly selectedStashEntry: IStashEntry | null

  /**
   * Whether we should show the onboarding tutorial nudge
   * arrow pointing at the commit summary box
   */
  readonly shouldNudgeToCommit: boolean

  readonly commitSpellcheckEnabled: boolean

  readonly showCommitLengthWarning: boolean

  readonly showCommitAuthorInfo: boolean

  readonly accounts: ReadonlyArray<Account>

  /** The file list filter state containing all filter options */
  readonly fileListFilter: IFileListFilterState

  /** Whether or not to show the changes filter */
  readonly showChangesFilter: boolean

  /** Whether the list of changed files is shown as a tree */
  readonly fileTreeView: boolean

  /** Whether the list/tree view mode switch is shown */
  readonly showViewModeSwitches: boolean

  /**
   * Whether or not to skip blocking commit hooks when creating commits
   * by means of passing the `--no-verify` flag to git commit
   */
  readonly skipCommitHooks: boolean

  /**
   * Whether or not to add a `Signed-off-by` trailer to commit messages
   * by means of passing the `--signoff` flag to git commit
   */
  readonly signOffCommits: boolean

  /**
   * Whether or not to allow creating a commit without any file changes
   * by means of passing the `--allow-empty` flag to git commit.
   * This option resets to false after each commit.
   */
  readonly allowEmptyCommit: boolean

  /** Callback to set commit options for the given repository */
  readonly onUpdateCommitOptions: (
    repository: Repository,
    options: Partial<CommitOptions>
  ) => void
}

interface IFilterChangesListState {
  readonly filteredItems: Map<string, IChangesListItem>
  readonly selectedItems: ReadonlyArray<IChangesListItem>
  readonly focusedRow: string | null
  readonly groups: ReadonlyArray<IFilterListGroup<IChangesListItem>>
  readonly collapsedFolders: ReadonlySet<string>
  /**
   * Folders collapsed while filtering, which only apply to the filter they
   * were collapsed with so that changing the filter never hides new matches.
   */
  readonly collapsedFoldersWhileFiltering: {
    readonly filter: IFileListFilterState | null
    readonly folders: ReadonlySet<string>
  }
}

const noCollapsedFolders: ReadonlySet<string> = new Set()

function getSelectedItemsFromProps(
  props: IFilterChangesListProps
): ReadonlyArray<IChangesListItem> {
  if (props.selectedFileIDs.length === 0) {
    return []
  }

  const selectedItems = []
  for (let i = 0; i < props.selectedFileIDs.length; i++) {
    const fid = props.selectedFileIDs[i]
    const file = props.workingDirectory.findFileWithID(fid)
    if (file === null) {
      continue
    }

    selectedItems.push({
      text: [file.path, file.status.kind.toString()],
      id: file.id,
      change: file,
    })
  }

  return selectedItems
}

/** Get checkbox value from includeAll status */
function getCheckBoxValueFromIncludeAll(
  includeAll: boolean | null
): CheckboxValue {
  if (includeAll === true) {
    return CheckboxValue.On
  }

  if (includeAll === false) {
    return CheckboxValue.Off
  }

  return CheckboxValue.Mixed
}

export class FilterChangesList extends React.Component<
  IFilterChangesListProps,
  IFilterChangesListState
> {
  private filterTextBox: TextBox | undefined = undefined
  private headerRef = createObservableRef<HTMLDivElement>()
  private includeAllCheckBoxRef = React.createRef<Checkbox>()
  private filterListRef =
    React.createRef<AugmentedSectionFilterList<IChangesListItem>>()

  /** Compute the 'Include All' checkbox value */
  private getCheckAllValue = memoizeOne(
    (
      workingDirectory: WorkingDirectoryStatus,
      rebaseConflictState: RebaseConflictState | null,
      filteredItems: Map<string, IChangesListItem>
    ): CheckboxValue => {
      if (
        filteredItems.size === workingDirectory.files.length &&
        rebaseConflictState === null
      ) {
        return getCheckBoxValueFromIncludeAll(workingDirectory.includeAll)
      }

      const files = workingDirectory.files.filter(f => filteredItems.has(f.id))

      if (files.length === 0) {
        // the current commit will be skipped in the rebase
        return CheckboxValue.Off
      }

      if (rebaseConflictState !== null) {
        // untracked files will be skipped by the rebase, so we need to ensure that
        // the "Include All" checkbox matches this state
        const onlyUntrackedFilesFound = files.every(
          f => f.status.kind === AppFileStatusKind.Untracked
        )

        if (onlyUntrackedFilesFound) {
          return CheckboxValue.Off
        }

        const onlyTrackedFilesFound = files.every(
          f => f.status.kind !== AppFileStatusKind.Untracked
        )

        // show "Mixed" if we have a mixture of tracked and untracked changes
        return onlyTrackedFilesFound ? CheckboxValue.On : CheckboxValue.Mixed
      }

      const filteredStatus = WorkingDirectoryStatus.fromFiles(files)

      return getCheckBoxValueFromIncludeAll(filteredStatus.includeAll)
    }
  )

  /** Folder rows of the current tree, keyed by folder path (group id) */
  private folderRows = new Map<
    string,
    Extract<FileTreeRow<WorkingDirectoryFileChange>, { kind: 'folder' }>
  >()

  /** The files passing the active filters, when the tree view is filtered */
  private getFilteredFiles = memoizeOne(
    (
      files: ReadonlyArray<WorkingDirectoryFileChange>,
      fileListFilter: IFileListFilterState
    ): ReadonlyArray<WorkingDirectoryFileChange> => {
      const items = this.createListItems(files).items.filter(this.applyFilters)
      const filterText = fileListFilter.filterText.toLowerCase()
      const matches =
        filterText.length > 0
          ? match(filterText, items, getText).map(m => m.item)
          : items
      return matches.map(i => i.change)
    }
  )

  private getTreeGroups = memoizeOne(
    (
      files: ReadonlyArray<WorkingDirectoryFileChange>,
      collapsedFolders: ReadonlySet<string>
    ): ReadonlyArray<IFilterListGroup<IChangesListItem>> => {
      this.folderRows = new Map()

      const rows = buildFileTreeRows(files, collapsedFolders)
      const groups = new Array<{
        identifier: string
        showHeader: boolean
        alwaysShowHeader: boolean
        items: Array<IChangesListItem>
      }>()
      // Each folder is a group whose header is the folder row. Since subfolders
      // come before files, a folder's own files go in a headerless group after
      // its last subfolder. Folders with only subfolders are empty groups, so
      // their headers must always be shown.
      let currentDir: string | null = null

      for (const row of rows) {
        if (row.kind === 'folder') {
          this.folderRows.set(row.path, row)
          groups.push({
            identifier: row.path,
            showHeader: true,
            alwaysShowHeader: true,
            items: [],
          })
          currentDir = row.path
        } else {
          const { file, depth } = row
          const dir = file.path.substring(0, file.path.lastIndexOf('/'))
          if (dir !== currentDir) {
            groups.push({
              identifier: `\0${dir}`,
              showHeader: false,
              alwaysShowHeader: false,
              items: [],
            })
            currentDir = dir
          }
          groups[groups.length - 1].items.push({
            text: [file.path],
            id: file.id,
            change: file,
            depth,
          })
        }
      }

      return groups
    }
  )

  public constructor(props: IFilterChangesListProps) {
    super(props)

    const listItems = this.createListItems(props.workingDirectory.files)
    const groups = [listItems]

    this.state = {
      filteredItems: new Map<string, IChangesListItem>(
        listItems.items.map(i => [i.id, i])
      ),
      selectedItems: getSelectedItemsFromProps(props),
      focusedRow: null,
      groups,
      collapsedFolders: new Set(),
      collapsedFoldersWhileFiltering: { filter: null, folders: new Set() },
    }
  }

  public componentWillReceiveProps(nextProps: IFilterChangesListProps) {
    // No need to update state unless we haven't done it yet or the
    // selected file id list has changed.
    if (
      !arrayEquals(nextProps.selectedFileIDs, this.props.selectedFileIDs) ||
      !arrayEquals(
        nextProps.workingDirectory.files,
        this.props.workingDirectory.files
      )
    ) {
      this.setState({
        selectedItems: getSelectedItemsFromProps(nextProps),
        groups: [this.createListItems(nextProps.workingDirectory.files)],
      })
    }
  }

  private get isFiltering() {
    return (
      this.props.showChangesFilter &&
      hasActiveFilters(this.props.fileListFilter)
    )
  }

  private get activeCollapsedFolders() {
    if (!this.isFiltering) {
      return this.state.collapsedFolders
    }
    const { filter, folders } = this.state.collapsedFoldersWhileFiltering
    return filter === this.props.fileListFilter ? folders : noCollapsedFolders
  }

  private updateCollapsedFolders(update: (folders: Set<string>) => void) {
    const folders = new Set(this.activeCollapsedFolders)
    update(folders)
    if (this.isFiltering) {
      const filter = this.props.fileListFilter
      this.setState({ collapsedFoldersWhileFiltering: { filter, folders } })
    } else {
      this.setState({ collapsedFolders: folders })
    }
  }

  /**
   * While filtering, the tree is built from the matching files only so that
   * every folder shown contains matches and folder actions only apply to them.
   */
  private getGroups(): ReadonlyArray<IFilterListGroup<IChangesListItem>> {
    if (!this.props.fileTreeView) {
      return this.state.groups
    }
    const { files } = this.props.workingDirectory
    return this.getTreeGroups(
      this.isFiltering
        ? this.getFilteredFiles(files, this.props.fileListFilter)
        : files,
      this.activeCollapsedFolders
    )
  }

  /** IDs of the files hidden inside collapsed folders of the tree */
  private getIdsInCollapsedFolders(): ReadonlySet<string> {
    const ids = new Set<string>()
    if (this.props.fileTreeView) {
      for (const folder of this.folderRows.values()) {
        if (folder.collapsed) {
          folder.files.forEach(f => ids.add(f.id))
        }
      }
    }
    return ids
  }

  private createListItems(
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ): IFilterListGroup<IChangesListItem> {
    const items = files.map(file => ({
      text: [file.path],
      id: file.id,
      change: file,
    }))

    return {
      identifier: 'changed-files',
      showHeader: false,
      items,
    }
  }

  private onIncludeAllChanged = (event: React.FormEvent<HTMLInputElement>) => {
    const include = event.currentTarget.checked
    const filteredItemPaths = Array.from(
      this.state.filteredItems,
      ([, v]) => v.change
    )
    this.props.onIncludeChanged(filteredItemPaths, include)
  }

  private renderChangedFile = (
    changeListItem: IChangesListItem,
    matches: IMatches
  ): JSX.Element | null => {
    const {
      rebaseConflictState,
      isCommitting,
      onIncludeChanged,
      availableWidth,
    } = this.props

    const file = changeListItem.change
    const selection = file.selection.getSelectionType()
    const { submoduleStatus } = file.status

    const isUncommittableSubmodule =
      submoduleStatus !== undefined &&
      file.status.kind === AppFileStatusKind.Modified &&
      !submoduleStatus.commitChanged

    const isPartiallyCommittableSubmodule =
      submoduleStatus !== undefined &&
      (submoduleStatus.commitChanged ||
        file.status.kind === AppFileStatusKind.New) &&
      (submoduleStatus.modifiedChanges || submoduleStatus.untrackedChanges)

    const includeAll =
      selection === DiffSelectionType.All
        ? true
        : selection === DiffSelectionType.None
        ? false
        : null

    const include = isUncommittableSubmodule
      ? false
      : rebaseConflictState !== null
      ? file.status.kind !== AppFileStatusKind.Untracked
      : includeAll

    const disableSelection =
      isCommitting || rebaseConflictState !== null || isUncommittableSubmodule

    const checkboxTooltip = isUncommittableSubmodule
      ? 'This submodule change cannot be added to a commit in this repository because it contains changes that have not been committed.'
      : isPartiallyCommittableSubmodule
      ? 'Only changes that have been committed within the submodule will be added to this repository. You need to commit any other modified or untracked changes in the submodule before including them in this repository.'
      : undefined

    return (
      <ChangedFile
        file={file}
        include={isPartiallyCommittableSubmodule && include ? null : include}
        key={file.id}
        onIncludeChanged={onIncludeChanged}
        availableWidth={availableWidth}
        disableSelection={disableSelection}
        checkboxTooltip={checkboxTooltip}
        focused={this.state.focusedRow === changeListItem.id}
        matches={matches}
        depth={this.props.fileTreeView ? changeListItem.depth : undefined}
      />
    )
  }

  private renderFolder = (path: string): JSX.Element | null => {
    const folder = this.folderRows.get(path)
    if (folder === undefined) {
      return null
    }

    const { isCommitting, rebaseConflictState } = this.props
    const include = getCheckBoxValueFromIncludeAll(
      WorkingDirectoryStatus.fromFiles(folder.files).includeAll
    )

    return (
      <FileTreeFolder
        path={folder.path}
        name={folder.name}
        depth={folder.depth}
        collapsed={folder.collapsed}
        fileCount={folder.files.length}
        onToggleCollapsed={this.onToggleFolderCollapsed}
        onContextMenu={this.onFolderContextMenu}
        include={include}
        disableInclude={isCommitting || rebaseConflictState !== null}
        onIncludeChanged={this.onFolderIncludeChanged}
      />
    )
  }

  private onToggleFolderCollapsed = (path: string) => {
    this.updateCollapsedFolders(folders => {
      if (!folders.delete(path)) {
        folders.add(path)
      }
    })
  }

  private setFoldersCollapsedRecursively(path: string, collapsed: boolean) {
    this.updateCollapsedFolders(folders => {
      for (const p of getNestedFolderPaths(
        this.props.workingDirectory.files,
        path
      )) {
        if (collapsed) {
          folders.add(p)
        } else {
          folders.delete(p)
        }
      }
    })
  }

  private onFolderContextMenu = (
    path: string,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    const folder = this.folderRows.get(path)
    if (folder === undefined || this.props.isCommitting) {
      return
    }

    event.preventDefault()

    const { files } = folder
    const { repository, dispatcher, workingDirectory } = this.props
    const canChange = this.props.rebaseConflictState === null

    showContextualMenu([
      {
        label: __DARWIN__ ? 'Expand Recursively' : 'Expand recursively',
        action: () => this.setFoldersCollapsedRecursively(path, false),
      },
      {
        label: __DARWIN__ ? 'Collapse Recursively' : 'Collapse recursively',
        action: () => this.setFoldersCollapsedRecursively(path, true),
      },
      { type: 'separator' },
      {
        label: __DARWIN__
          ? 'Include Files in Folder'
          : 'Include files in folder',
        action: () => this.props.onIncludeChanged(files, true),
        enabled: canChange,
      },
      {
        label: __DARWIN__
          ? 'Exclude Files in Folder'
          : 'Exclude files in folder',
        action: () => this.props.onIncludeChanged(files, false),
        enabled: canChange,
      },
      { type: 'separator' },
      {
        label: __DARWIN__
          ? 'Discard All Changes in Folder…'
          : 'Discard all changes in folder…',
        action: () =>
          this.props.onDiscardChangesFromFiles(
            files,
            files.length === workingDirectory.files.length,
            false
          ),
        enabled: canChange,
      },
      {
        label: __DARWIN__
          ? 'Ignore Folder (Add to .gitignore)'
          : 'Ignore folder (add to .gitignore)',
        action: () => this.props.onIgnoreFile(`/${path}`),
        enabled: canChange,
      },
      { type: 'separator' },
      ...getFolderPathMenuItems(repository, dispatcher, path),
    ])
  }

  private onFolderIncludeChanged = (path: string, include: boolean) => {
    const folder = this.folderRows.get(path)
    if (folder !== undefined) {
      this.props.onIncludeChanged(folder.files, include)
    }
  }

  private renderTreeViewToggle() {
    if (!this.props.showViewModeSwitches) {
      return null
    }

    return (
      <FileTreeViewToggle
        treeView={this.props.fileTreeView}
        onChange={this.onTreeViewChanged}
      />
    )
  }

  private onTreeViewChanged = (treeView: boolean) => {
    this.props.dispatcher.setFileTreeView(treeView)
  }

  private onStashAllChanges = () => {
    this.props.dispatcher.createStashForCurrentBranch(this.props.repository)
  }

  private onDiscardAllChanges = () => {
    this.props.onDiscardChangesFromFiles(
      this.props.workingDirectory.files,
      true,
      false
    )
  }

  private onPermanentlyDiscardAllChanges = () => {
    this.props.onDiscardChangesFromFiles(
      this.props.workingDirectory.files,
      true,
      true
    )
  }

  private onStashChanges = (files: ReadonlyArray<string>) => {
    const workingDirectory = this.props.workingDirectory
    const modifiedFiles = new Array<WorkingDirectoryFileChange>()

    files.forEach(file => {
      const modifiedFile = workingDirectory.files.find(f => f.path === file)

      if (modifiedFile != null) {
        modifiedFiles.push(modifiedFile)
      }
    })

    const stashingAllChanges =
      modifiedFiles.length === workingDirectory.files.length

    this.props.onStashChangesFromFiles(modifiedFiles, stashingAllChanges)
  }

  private onDiscardChanges = (files: ReadonlyArray<string>) => {
    const workingDirectory = this.props.workingDirectory

    if (files.length === 1) {
      const modifiedFile = workingDirectory.files.find(f => f.path === files[0])

      if (modifiedFile != null) {
        this.props.onDiscardChanges(modifiedFile)
      }
    } else {
      const modifiedFiles = new Array<WorkingDirectoryFileChange>()

      files.forEach(file => {
        const modifiedFile = workingDirectory.files.find(f => f.path === file)

        if (modifiedFile != null) {
          modifiedFiles.push(modifiedFile)
        }
      })

      if (modifiedFiles.length > 0) {
        // DiscardAllChanges can also be used for discarding several selected changes.
        // Therefore, we update the pop up to reflect whether or not it is "all" changes.
        const discardingAllChanges =
          modifiedFiles.length === workingDirectory.files.length

        this.props.onDiscardChangesFromFiles(
          modifiedFiles,
          discardingAllChanges,
          false
        )
      }
    }
  }

  private getDiscardChangesMenuItemLabel = (files: ReadonlyArray<string>) => {
    const label =
      files.length === 1
        ? __DARWIN__
          ? `Discard Changes`
          : `Discard changes`
        : __DARWIN__
        ? `Discard ${files.length} Selected Changes`
        : `Discard ${files.length} selected changes`

    return this.props.askForConfirmationOnDiscardChanges ? `${label}…` : label
  }

  private getStashChangesMenuItemLabel = (files: ReadonlyArray<string>) => {
    const label =
      files.length === 1
        ? __DARWIN__
          ? `Stash Changes`
          : `Stash changes`
        : __DARWIN__
        ? `Stash ${files.length} Selected Changes`
        : `Stash ${files.length} selected changes`

    return this.props.askForConfirmationOnDiscardChanges ? `${label}…` : label
  }

  private onContextMenu = (event: React.MouseEvent<any>) => {
    event.preventDefault()

    // need to preserve the working directory state while dealing with conflicts
    if (this.props.rebaseConflictState !== null || this.props.isCommitting) {
      return
    }

    const hasLocalChanges = this.props.workingDirectory.files.length > 0
    const hasStash = this.props.stashEntries.length > 0
    const hasConflicts =
      this.props.conflictState !== null ||
      hasConflictedFiles(this.props.workingDirectory)

    const stashAllChangesLabel = __DARWIN__
      ? 'Stash All Changes'
      : 'Stash all changes'
    const confirmStashAllChangesLabel = __DARWIN__
      ? 'Stash All Changes…'
      : 'Stash all changes…'

    const items: IMenuItem[] = [
      {
        label: __DARWIN__ ? 'Discard All Changes…' : 'Discard all changes…',
        action: this.onDiscardAllChanges,
        enabled: hasLocalChanges,
      },
      {
        label: __DARWIN__
          ? 'Permanently Discard All Changes…'
          : 'Permanently discard all changes…',
        action: this.onPermanentlyDiscardAllChanges,
        enabled: hasLocalChanges,
      },
      {
        label: hasStash ? confirmStashAllChangesLabel : stashAllChangesLabel,
        action: this.onStashAllChanges,
        enabled: hasLocalChanges && this.props.branch !== null && !hasConflicts,
      },
    ]

    showContextualMenu(items)
  }

  private getDiscardChangesMenuItem = (
    paths: ReadonlyArray<string>
  ): IMenuItem => {
    return {
      label: this.getDiscardChangesMenuItemLabel(paths),
      action: () => this.onDiscardChanges(paths),
    }
  }

  private getStashChangesMenuItem = (
    paths: ReadonlyArray<string>
  ): IMenuItem => {
    return {
      label: this.getStashChangesMenuItemLabel(paths),
      action: () => this.onStashChanges(paths),
    }
  }

  private getCopyPathMenuItem = (
    file: WorkingDirectoryFileChange
  ): IMenuItem => {
    return {
      label: CopyFilePathLabel,
      action: () => {
        const fullPath = Path.join(this.props.repository.path, file.path)
        this.props.dispatcher.copyPathToClipboard(fullPath)
      },
    }
  }

  private getCopyRelativePathMenuItem = (
    file: WorkingDirectoryFileChange
  ): IMenuItem => {
    return {
      label: CopyRelativeFilePathLabel,
      action: () =>
        this.props.dispatcher.copyPathToClipboard(Path.normalize(file.path)),
    }
  }

  private getCopySelectedPathsMenuItem = (
    files: WorkingDirectoryFileChange[]
  ): IMenuItem => {
    return {
      label: CopySelectedPathsLabel,
      action: () => {
        const fullPaths = files.map(file =>
          Path.join(this.props.repository.path, file.path)
        )
        this.props.dispatcher.copyPathsToClipboard(fullPaths)
      },
    }
  }

  private getCopySelectedRelativePathsMenuItem = (
    files: WorkingDirectoryFileChange[]
  ): IMenuItem => {
    return {
      label: CopySelectedRelativePathsLabel,
      action: () => {
        const paths = files.map(file => Path.normalize(file.path))
        this.props.dispatcher.copyPathsToClipboard(paths)
      },
    }
  }

  private getRevealInFileManagerMenuItem = (
    file: WorkingDirectoryFileChange
  ): IMenuItem => {
    return {
      label: RevealInFileManagerLabel,
      action: () => revealInFileManager(this.props.repository, file.path),
      enabled: file.status.kind !== AppFileStatusKind.Deleted,
    }
  }

  private getOpenInExternalEditorMenuItem = (
    file: WorkingDirectoryFileChange,
    enabled: boolean
  ): IMenuItem => {
    const { externalEditorLabel } = this.props

    const openInExternalEditor = externalEditorLabel
      ? `Open in ${externalEditorLabel}`
      : DefaultEditorLabel

    return {
      label: openInExternalEditor,
      action: () => {
        this.props.onOpenItemInExternalEditor(file.path)
      },
      enabled,
    }
  }

  private getDefaultContextMenu(
    file: WorkingDirectoryFileChange
  ): ReadonlyArray<IMenuItem> {
    const { id, path, status } = file

    const extension = Path.extname(path)
    const isSafeExtension = isSafeFileExtension(extension)

    const { workingDirectory, selectedFileIDs } = this.props

    const selectedFiles = new Array<WorkingDirectoryFileChange>()
    const paths = new Array<string>()
    const extensions = new Set<string>()

    const addItemToArray = (fileID: string) => {
      const newFile = workingDirectory.findFileWithID(fileID)
      if (newFile) {
        selectedFiles.push(newFile)
        paths.push(newFile.path)

        const extension = Path.extname(newFile.path)
        if (extension.length) {
          extensions.add(extension)
        }
      }
    }

    if (selectedFileIDs.includes(id)) {
      // user has selected a file inside an existing selection
      // -> context menu entries should be applied to all selected files
      selectedFileIDs.forEach(addItemToArray)
    } else {
      // this is outside their previous selection
      // -> context menu entries should be applied to just this file
      addItemToArray(id)
    }

    const items: IMenuItem[] = [
      this.getDiscardChangesMenuItem(paths),
      this.getStashChangesMenuItem(paths),
      { type: 'separator' },
    ]
    if (paths.length === 1) {
      const enabled = Path.basename(path) !== GitIgnoreFileName
      items.push({
        label: __DARWIN__
          ? 'Ignore File (Add to .gitignore)'
          : 'Ignore file (add to .gitignore)',
        action: () => this.props.onIgnoreFile(path),
        enabled,
      })

      // Even on Windows, the path separator is '/' for git operations so cannot
      // use Path.sep
      const pathComponents = path.split('/').slice(0, -1)
      if (pathComponents.length > 0) {
        const submenu = pathComponents.map((_, index) => {
          const label = `/${pathComponents
            .slice(0, pathComponents.length - index)
            .join('/')}`
          return {
            label,
            action: () => this.props.onIgnoreFile(label),
          }
        })

        items.push({
          label: __DARWIN__
            ? 'Ignore Folder (Add to .gitignore)'
            : 'Ignore folder (add to .gitignore)',
          submenu,
          enabled,
        })
      }
    } else if (paths.length > 1) {
      items.push({
        label: __DARWIN__
          ? `Ignore ${paths.length} Selected Files (Add to .gitignore)`
          : `Ignore ${paths.length} selected files (add to .gitignore)`,
        action: () => {
          // Filter out any .gitignores that happens to be selected, ignoring
          // those doesn't make sense.
          this.props.onIgnoreFile(
            paths.filter(path => Path.basename(path) !== GitIgnoreFileName)
          )
        },
        // Enable this action as long as there's something selected which isn't
        // a .gitignore file.
        enabled: paths.some(path => Path.basename(path) !== GitIgnoreFileName),
      })
    }
    // Five menu items should be enough for everyone
    Array.from(extensions)
      .slice(0, 5)
      .forEach(extension => {
        items.push({
          label: __DARWIN__
            ? `Ignore All ${extension} Files (Add to .gitignore)`
            : `Ignore all ${extension} files (add to .gitignore)`,
          action: () => this.props.onIgnorePattern(`*${extension}`),
        })
      })

    if (paths.length > 1) {
      items.push(
        { type: 'separator' },
        {
          label: __DARWIN__
            ? 'Include Selected Files'
            : 'Include selected files',
          action: () => {
            selectedFiles.map(file => this.props.onIncludeChanged(file, true))
          },
        },
        {
          label: __DARWIN__
            ? 'Exclude Selected Files'
            : 'Exclude selected files',
          action: () => {
            selectedFiles.map(file => this.props.onIncludeChanged(file, false))
          },
        },
        { type: 'separator' },
        this.getCopySelectedPathsMenuItem(selectedFiles),
        this.getCopySelectedRelativePathsMenuItem(selectedFiles)
      )
    } else {
      items.push(
        { type: 'separator' },
        this.getCopyPathMenuItem(file),
        this.getCopyRelativePathMenuItem(file)
      )
    }

    const enabled = status.kind !== AppFileStatusKind.Deleted
    items.push(
      { type: 'separator' },
      this.getRevealInFileManagerMenuItem(file),
      this.getOpenInExternalEditorMenuItem(file, enabled),
      {
        label: OpenWithDefaultProgramLabel,
        action: () => this.props.onOpenItem(path),
        enabled: enabled && isSafeExtension,
      }
    )

    return items
  }

  private getRebaseContextMenu(
    file: WorkingDirectoryFileChange
  ): ReadonlyArray<IMenuItem> {
    const { path, status } = file

    const extension = Path.extname(path)
    const isSafeExtension = isSafeFileExtension(extension)

    const items = new Array<IMenuItem>()

    if (file.status.kind === AppFileStatusKind.Untracked) {
      items.push(this.getDiscardChangesMenuItem([file.path]), {
        type: 'separator',
      })
    }

    const enabled = status.kind !== AppFileStatusKind.Deleted

    items.push(
      this.getCopyPathMenuItem(file),
      this.getCopyRelativePathMenuItem(file),
      { type: 'separator' },
      this.getRevealInFileManagerMenuItem(file),
      this.getOpenInExternalEditorMenuItem(file, enabled),
      {
        label: OpenWithDefaultProgramLabel,
        action: () => this.props.onOpenItem(path),
        enabled: enabled && isSafeExtension,
      }
    )

    return items
  }

  private onItemContextMenu = (
    item: IChangesListItem,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    const file = item.change

    if (this.props.isCommitting) {
      return
    }

    event.preventDefault()

    const items =
      this.props.rebaseConflictState === null
        ? this.getDefaultContextMenu(file)
        : this.getRebaseContextMenu(file)

    showContextualMenu(items)
  }

  private getPlaceholderMessage(
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    prepopulateCommitSummary: boolean
  ) {
    if (!prepopulateCommitSummary) {
      return 'Summary (required)'
    }

    const firstFile = files[0]
    const fileName = basename(firstFile.path)

    switch (firstFile.status.kind) {
      case AppFileStatusKind.New:
      case AppFileStatusKind.Untracked:
        return `Create ${fileName}`
      case AppFileStatusKind.Deleted:
        return `Delete ${fileName}`
      default:
        // TODO:
        // this doesn't feel like a great message for AppFileStatus.Copied or
        // AppFileStatus.Renamed but without more insight (and whether this
        // affects other parts of the flow) we can just default to this for now
        return `Update ${fileName}`
    }
  }

  private onScroll = (scrollTop: number, _clientHeight: number) => {
    this.props.onChangesListScrolled(scrollTop)
  }

  private renderCommitMessageForm = (): JSX.Element => {
    const {
      rebaseConflictState,
      workingDirectory,
      repository,
      repositoryAccount,
      dispatcher,
      isCommitting,
      hookProgress,
      isGeneratingCommitMessage,
      commitToAmend,
      currentBranchProtected,
      currentRepoRulesInfo: currentRepoRulesInfo,
      shouldShowGenerateCommitMessageCallOut,
    } = this.props

    if (rebaseConflictState !== null) {
      const hasUntrackedChanges = workingDirectory.files.some(
        f => f.status.kind === AppFileStatusKind.Untracked
      )

      return (
        <ContinueRebase
          dispatcher={dispatcher}
          repository={repository}
          rebaseConflictState={rebaseConflictState}
          workingDirectory={workingDirectory}
          isCommitting={isCommitting}
          hasUntrackedChanges={hasUntrackedChanges}
        />
      )
    }

    const fileCount = workingDirectory.files.length

    // Files selected to commit (to be committed) (not selected to see in diff)
    const filesSelected = workingDirectory.files.filter(
      f => f.selection.getSelectionType() !== DiffSelectionType.None
    )

    const anyFilesSelected = filesSelected.length > 0

    // When a single file is selected, we use a default commit summary
    // based on the file name and change status.
    // However, for onboarding tutorial repositories, we don't want to do this.
    // See https://github.com/desktop/desktop/issues/8354
    const prepopulateCommitSummary =
      filesSelected.length === 1 && !repository.isTutorialRepository

    // if this is not a github repo, we don't want to
    // restrict what the user can do at all
    const hasWritePermissionForRepository =
      this.props.repository.gitHubRepository === null ||
      hasWritePermission(this.props.repository.gitHubRepository)

    const showPromptForCommittingFileHiddenByFilter =
      this.props.askForConfirmationOnCommitFilteredChanges &&
      isCommittingFileHiddenByFilter(
        filesSelected.map(f => f.id),
        this.state.filteredItems,
        fileCount,
        this.props.fileListFilter
      )

    return (
      <CommitMessage
        onCreateCommit={this.props.onCreateCommit}
        branch={this.props.branch}
        mostRecentLocalCommit={this.props.mostRecentLocalCommit}
        commitAuthor={this.props.commitAuthor}
        commitAuthorNameOrigin={this.props.commitAuthorNameOrigin}
        commitAuthorEmailOrigin={this.props.commitAuthorEmailOrigin}
        showCommitAuthorInfo={this.props.showCommitAuthorInfo}
        isShowingModal={this.props.isShowingModal}
        isShowingFoldout={this.props.isShowingFoldout}
        anyFilesSelected={anyFilesSelected}
        showPromptForCommittingFileHiddenByFilter={
          showPromptForCommittingFileHiddenByFilter
        }
        anyFilesAvailable={fileCount > 0}
        filesSelected={filesSelected}
        filesToBeCommittedCount={filesSelected.length}
        repository={repository}
        repositoryAccount={repositoryAccount}
        commitMessage={this.props.commitMessage}
        commitMode={this.props.commitMode}
        onCommitModeChanged={this.onCommitModeChanged}
        pushAfterAssistedCommit={this.props.pushAfterAssistedCommit}
        onPushAfterAssistedCommitChanged={this.onPushAfterAssistedCommitChanged}
        focusCommitMessage={this.props.focusCommitMessage}
        autocompletionProviders={this.props.autocompletionProviders}
        isCommitting={isCommitting}
        hookProgress={hookProgress}
        onShowCommitProgress={this.props.onShowCommitProgress}
        isGeneratingCommitMessage={isGeneratingCommitMessage}
        shouldShowGenerateCommitMessageCallOut={
          shouldShowGenerateCommitMessageCallOut
        }
        commitToAmend={commitToAmend}
        showCoAuthoredBy={this.props.showCoAuthoredBy}
        coAuthors={this.props.coAuthors}
        placeholder={this.getPlaceholderMessage(
          filesSelected,
          prepopulateCommitSummary
        )}
        prepopulateCommitSummary={prepopulateCommitSummary}
        key={repository.id}
        showBranchProtected={fileCount > 0 && currentBranchProtected}
        repoRulesInfo={currentRepoRulesInfo}
        aheadBehind={this.props.aheadBehind}
        showNoWriteAccess={fileCount > 0 && !hasWritePermissionForRepository}
        shouldNudge={this.props.shouldNudgeToCommit}
        commitSpellcheckEnabled={this.props.commitSpellcheckEnabled}
        showCommitLengthWarning={this.props.showCommitLengthWarning}
        onCoAuthorsUpdated={this.onCoAuthorsUpdated}
        onShowCoAuthoredByChanged={this.onShowCoAuthoredByChanged}
        onConfirmCommitWithUnknownCoAuthors={
          this.onConfirmCommitWithUnknownCoAuthors
        }
        onPersistCommitMessage={this.onPersistCommitMessage}
        onGenerateCommitMessage={
          this.props.commitMessageGenerationDisabled
            ? undefined
            : this.onGenerateCommitMessage
        }
        onCancelGenerateCommitMessage={this.onCancelGenerateCommitMessage}
        onCommitMessageFocusSet={this.onCommitMessageFocusSet}
        onRefreshAuthor={this.onRefreshAuthor}
        onShowPopup={this.onShowPopup}
        onShowFoldout={this.onShowFoldout}
        onCommitSpellcheckEnabledChanged={this.onCommitSpellcheckEnabledChanged}
        onStopAmending={this.onStopAmending}
        onShowCreateForkDialog={this.onShowCreateForkDialog}
        onFilesToCommitNotVisible={this.onFilesToCommitNotVisible}
        accounts={this.props.accounts}
        onSuccessfulCommitCreated={this.onSuccessfulCommitCreated}
        submitButtonAriaDescribedBy={'hidden-changes-warning'}
        skipCommitHooks={this.props.skipCommitHooks}
        signOffCommits={this.props.signOffCommits}
        allowEmptyCommit={this.props.allowEmptyCommit}
        showAllowEmptyCommitOption={true}
        onUpdateCommitOptions={this.props.onUpdateCommitOptions}
        onCreateCopilotAssistedCommits={
          this.props.onCreateCopilotAssistedCommits
        }
        isCreatingCopilotAssistedCommits={
          this.props.isCreatingCopilotAssistedCommits
        }
        repositoryMutationBlocked={this.props.repositoryMutationBlocked}
        assistedCommitState={this.props.assistedCommitState}
        onPrepareCopilotAssistedCommitRequest={
          this.props.onPrepareCopilotAssistedCommitRequest
        }
        onCancelCopilotAssistedCommits={this.onCancelCopilotAssistedCommits}
        onRetryCopilotAssistedCommitRecovery={
          this.onRetryCopilotAssistedCommitRecovery
        }
        onRetryCopilotAssistedCommitPush={this.onRetryCopilotAssistedCommitPush}
        onDismissCopilotAssistedCommitError={
          this.onDismissCopilotAssistedCommitError
        }
        onAssistedCommitErrorDetails={this.onAssistedCommitErrorDetails}
      />
    )
  }

  private onSuccessfulCommitCreated = () => {
    this.clearFilter()
  }

  private onCoAuthorsUpdated = (coAuthors: ReadonlyArray<Author>) =>
    this.props.dispatcher.setCoAuthors(this.props.repository, coAuthors)

  private onShowCoAuthoredByChanged = (showCoAuthors: boolean) => {
    const { dispatcher, repository } = this.props
    dispatcher.setShowCoAuthoredBy(repository, showCoAuthors)
  }

  private onConfirmCommitWithUnknownCoAuthors = (
    coAuthors: ReadonlyArray<UnknownAuthor>,
    onCommitAnyway: () => void
  ) => {
    const { dispatcher } = this.props
    dispatcher.showUnknownAuthorsCommitWarning(coAuthors, onCommitAnyway)
  }

  private onRefreshAuthor = () =>
    this.props.dispatcher.refreshAuthor(this.props.repository)

  private onCommitMessageFocusSet = () =>
    this.props.dispatcher.setCommitMessageFocus(false)

  private onPersistCommitMessage = (message: ICommitMessage) =>
    this.props.dispatcher.setCommitMessage(this.props.repository, message)

  private onCommitModeChanged = (commitMode: CommitMode) =>
    this.props.dispatcher.setCommitMode(this.props.repository, commitMode)

  private onPushAfterAssistedCommitChanged = (enabled: boolean) =>
    this.props.dispatcher.setPushAfterAssistedCommit(
      this.props.repository,
      enabled
    )

  private onGenerateCommitMessage = (
    filesSelected: ReadonlyArray<WorkingDirectoryFileChange>,
    mustOverrideExistingMessage: boolean
  ) => {
    this.props.dispatcher.incrementMetric(
      'generateCommitMessageButtonClickCount'
    )

    return mustOverrideExistingMessage
      ? this.props.dispatcher.promptOverrideWithGeneratedCommitMessage(
          this.props.repository,
          filesSelected
        )
      : this.props.dispatcher.generateCommitMessage(
          this.props.repository,
          filesSelected
        )
  }

  private onCancelGenerateCommitMessage = () => {
    this.props.dispatcher.cancelGenerateCommitMessage(this.props.repository)
  }

  private onCancelCopilotAssistedCommits = () => {
    const state = this.props.assistedCommitState
    if (state !== undefined && state.kind !== 'idle') {
      this.props.dispatcher.cancelCopilotAssistedCommits(
        this.props.repository,
        state.runId
      )
    }
  }

  private onRetryCopilotAssistedCommitRecovery = () => {
    const state = this.props.assistedCommitState
    if (state?.kind === 'error') {
      this.props.dispatcher.retryCopilotAssistedCommitRecovery(
        this.props.repository,
        state.runId
      )
    }
  }

  private onRetryCopilotAssistedCommitPush = () => {
    const state = this.props.assistedCommitState
    if (state?.kind === 'push-error') {
      this.props.dispatcher.retryCopilotAssistedCommitPush(
        this.props.repository,
        state.runId
      )
    }
  }

  private onDismissCopilotAssistedCommitError = () => {
    const state = this.props.assistedCommitState
    if (state?.kind === 'error' || state?.kind === 'push-error') {
      this.props.dispatcher.dismissCopilotAssistedCommitError(
        this.props.repository,
        state.runId
      )
    }
  }

  private onAssistedCommitErrorDetails = () => {
    const state = this.props.assistedCommitState
    if (state?.kind === 'push-error' || state?.kind === 'error') {
      this.props.dispatcher.showPopup({
        type: PopupType.Error,
        error: state.error,
        showCauses: true,
      })
    }
  }

  private onShowPopup = (p: Popup) => this.props.dispatcher.showPopup(p)
  private onShowFoldout = (f: Foldout) => this.props.dispatcher.showFoldout(f)

  private onCommitSpellcheckEnabledChanged = (enabled: boolean) =>
    this.props.dispatcher.setCommitSpellcheckEnabled(enabled)

  private onStopAmending = () =>
    this.props.dispatcher.stopAmendingRepository(this.props.repository)

  private onShowCreateForkDialog = () => {
    if (isRepositoryWithGitHubRepository(this.props.repository)) {
      this.props.dispatcher.showCreateForkDialog(this.props.repository)
    }
  }

  private onStashEntryClicked = (entry: IStashEntry) => {
    const { isShowingStashEntry, selectedStashEntry, dispatcher, repository } =
      this.props

    // If we're viewing this specific stash entry, toggle back to working directory
    if (
      isShowingStashEntry &&
      selectedStashEntry?.stashSha === entry.stashSha
    ) {
      dispatcher.selectWorkingDirectoryFiles(repository)
      // If the button is clicked, that implies the stash was not restored or discarded
      dispatcher.incrementMetric('noActionTakenOnStashCount')
    } else {
      // Otherwise, select this stash entry
      dispatcher.selectStashedFile(repository, entry)
      dispatcher.incrementMetric('stashViewCount')
    }
  }

  private onStashEntryClickedFn = (entry: IStashEntry) => {
    return () => this.onStashEntryClicked(entry)
  }

  private onStashEntryContextMenu = (entry: IStashEntry) => {
    const { dispatcher, repository } = this.props
    const items = generateStashListContextMenu({
      stashEntry: entry,
      repository,
      dispatcher,
      askForConfirmationOnDiscardStash:
        this.props.askForConfirmationOnDiscardStash,
    })
    showContextualMenu(items)
  }

  private onStashEntryContextMenuFn = (entry: IStashEntry) => {
    return (event: React.MouseEvent) => {
      event.preventDefault()
      this.onStashEntryContextMenu(entry)
    }
  }

  private renderStashedChanges() {
    const { stashEntries } = this.props

    if (stashEntries.length === 0) {
      return null
    }

    const className = classNames(
      'stashed-changes-button',
      this.props.isShowingStashEntry ? 'selected' : null
    )

    if (stashEntries.length === 1) {
      const entry = stashEntries[0]
      return (
        <button
          className={className}
          onClick={this.onStashEntryClickedFn(entry)}
          onContextMenu={this.onStashEntryContextMenuFn(entry)}
          tabIndex={0}
          aria-expanded={this.props.isShowingStashEntry}
          aria-controls={
            this.props.isShowingStashEntry ? StashDiffViewerId : undefined
          }
        >
          <Octicon className="stack-icon" symbol={StashIcon} />
          <div className="text">1 stash ({entryToString(entry)})</div>
          <Octicon symbol={octicons.chevronRight} />
        </button>
      )
    }

    return (
      <div className="stashed-changes-section">
        <div className="stashed-changes-header">
          <Octicon className="stack-icon" symbol={StashIcon} />
          <div className="text">{stashEntries.length} stashes</div>
        </div>
        <div className="stashed-changes-list">
          {stashEntries.map(entry => {
            const isSelected =
              this.props.isShowingStashEntry &&
              this.props.selectedStashEntry !== null &&
              this.props.selectedStashEntry.stashSha === entry.stashSha

            const className = classNames(
              'stashed-changes-button',
              isSelected ? 'selected' : null
            )

            return (
              <button
                key={entry.stashSha}
                className={className}
                onClick={this.onStashEntryClickedFn(entry)}
                onContextMenu={this.onStashEntryContextMenuFn(entry)}
                tabIndex={0}
                aria-expanded={isSelected}
                aria-controls={isSelected ? StashDiffViewerId : undefined}
              >
                <div className="text">{entryToString(entry)}</div>
                <Octicon symbol={octicons.chevronRight} />
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  private onChangedFileDoubleClick = (item: IChangesListItem) => {
    this.props.onOpenItemInExternalEditor(item.change.path)
  }

  private onItemKeyDown = (
    _item: IChangesListItem,
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    // The commit is already in-flight but this check prevents the
    // user from changing selection.
    if (
      this.props.isCommitting &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault()
    }

    return
  }

  public focus() {
    this.filterListRef.current?.focus()
  }

  private onChangedFileClick = (
    item: IChangesListItem,
    source: ClickSource
  ) => {
    const fileIndex = this.props.workingDirectory.findFileIndexByID(
      item.change.id
    )

    this.props.onRowClick?.(fileIndex, source)
  }

  private onFilterTextChanged = (text: string) => {
    if (this.props.fileListFilter.filterText === '' && text !== '') {
      this.props.dispatcher.incrementMetric('typedInChangesFilterCount')
    }

    this.props.dispatcher.setChangesListFilterText(this.props.repository, text)
  }

  private onFilterListResultsChanged = (
    filteredItems: ReadonlyArray<IChangesListItem>
  ) => {
    const filteredSet = new Map<string, IChangesListItem>()
    filteredItems.forEach(f => filteredSet.set(f.id, f))
    // Files in collapsed tree folders are hidden, not filtered out
    const hiddenIds = this.getIdsInCollapsedFolders()
    for (const change of this.props.workingDirectory.files) {
      if (hiddenIds.has(change.id)) {
        filteredSet.set(change.id, {
          text: [change.path],
          id: change.id,
          change,
        })
      }
    }
    this.setState({ filteredItems: filteredSet })
  }

  private onListSelectionChanged = (
    items: ReadonlyArray<IChangesListItem>,
    source: SelectionSource
  ) => {
    // Collapsing a folder removes its selected files from the list, which the
    // list reports as them being deselected. Keep them selected instead.
    if (source.kind === 'filter') {
      const hiddenIds = this.getIdsInCollapsedFolders()
      const shownIds = new Set(items.map(i => i.id))
      const { selectedItems } = this.state
      if (
        selectedItems.some(i => hiddenIds.has(i.id)) &&
        selectedItems.every(i => shownIds.has(i.id) || hiddenIds.has(i.id))
      ) {
        return
      }
    }
    this.onFileSelectionChanged(items)
  }

  private onFileSelectionChanged = (items: ReadonlyArray<IChangesListItem>) => {
    const rows = items.map(i =>
      this.props.workingDirectory.findFileIndexByID(i.change.id)
    )
    this.props.onFileSelectionChanged(rows)
  }

  private onFilesToCommitNotVisible = (onCommitAnyway: () => void) => {
    this.props.dispatcher.showPopup({
      type: PopupType.ConfirmCommitFilteredChanges,
      onCommitAnyway,
      showFilesToBeCommitted: this.showFilesToBeCommitted,
    })
  }

  private clearFilter = () => {
    this.props.dispatcher.setChangesListFilterText(this.props.repository, '')
  }

  private showFilesToBeCommitted = () => {
    this.props.dispatcher.incrementMetric(
      'adjustedFiltersForHiddenChangesCount'
    )
    // Clear all filters first to ensure all files are visible
    this.clearFilter()
    this.props.dispatcher.setFilterExcludedFiles(this.props.repository, false)
    this.props.dispatcher.setFilterNewFiles(this.props.repository, false)
    this.props.dispatcher.setFilterModifiedFiles(this.props.repository, false)
    this.props.dispatcher.setFilterDeletedFiles(this.props.repository, false)

    // Then apply only the "Included in commit" filter to show only files being committed
    this.props.dispatcher.setIncludedChangesInCommitFilter(
      this.props.repository,
      true
    )
  }

  private onTextBoxRef = (component: TextBox | null) => {
    this.filterTextBox = component ?? undefined
  }

  private onFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (this.filterListRef.current) {
      this.filterListRef.current.onKeyDown(event)
    }
  }

  private renderFilterRow = () => {
    return (
      <div
        className="header filter-field-row"
        onContextMenu={this.onContextMenu}
        ref={this.headerRef}
      >
        {this.renderFilterBox()}
        {this.renderCheckBoxRow()}
      </div>
    )
  }

  private renderCheckBoxRow = () => {
    const { workingDirectory, rebaseConflictState, isCommitting } = this.props
    const { files } = workingDirectory

    const visibleFiles = this.state.filteredItems.size

    const includeAllValue = this.getCheckAllValue(
      workingDirectory,
      rebaseConflictState,
      this.state.filteredItems
    )

    const disableAllCheckbox =
      files.length === 0 || isCommitting || rebaseConflictState !== null

    const checkAllLabel = `${
      visibleFiles !== files.length ? `${formatNumber(visibleFiles)} of ` : ''
    }
    ${formatNumber(files.length)} changed file${plural(files.length)}`

    return (
      <div className="checkbox-container">
        <Checkbox
          ref={this.includeAllCheckBoxRef}
          value={includeAllValue}
          onChange={this.onIncludeAllChanged}
          disabled={disableAllCheckbox}
          ariaLabelledBy="changes-list-check-all-label"
          className="changes-list-check-all"
          label={checkAllLabel}
        />
        {!this.props.showChangesFilter && this.renderTreeViewToggle()}
      </div>
    )
  }

  private renderFilterBox = () => {
    if (!this.props.showChangesFilter) {
      return null
    }

    return (
      <div className="filter-box-container">
        <span>
          <ChangesListFilterOptions
            fileListFilter={this.props.fileListFilter}
            filteredItems={this.state.filteredItems}
            onFilterToIncludedInCommit={this.onFilterToIncludedInCommit}
            onFilterExcludedFiles={this.onFilterExcludedFiles}
            onFilterDeletedFiles={this.onFilterDeletedFiles}
            onFilterModifiedFiles={this.onFilterModifiedFiles}
            onFilterNewFiles={this.onFilterNewFiles}
            onClearAllFilters={this.onClearAllFilters}
            workingDirectory={this.props.workingDirectory}
          />
        </span>
        <FancyTextBox
          onRef={this.onTextBoxRef}
          symbol={octicons.search}
          displayClearButton={true}
          placeholder={'Filter'}
          className="filter-list-filter-field"
          onValueChanged={this.onFilterTextChanged}
          onKeyDown={this.onFilterKeyDown}
          value={this.props.fileListFilter.filterText}
        />
        {this.renderTreeViewToggle()}
      </div>
    )
  }

  private applyFilters = (item: IChangesListItem) => {
    return applyFilters(
      item,
      this.props.showChangesFilter,
      this.props.fileListFilter
    )
  }

  private getListAriaLabel = () => {
    const { files } = this.props.workingDirectory
    return `${formatNumber(files.length)} changed file${plural(files.length)}`
  }

  public render() {
    const { workingDirectory, isCommitting } = this.props

    return (
      <>
        <div
          className={classNames(
            'changes-list-container file-list filtered-changes-list',
            { 'tree-view': this.props.fileTreeView }
          )}
        >
          <AugmentedSectionFilterList<IChangesListItem>
            ref={this.filterListRef}
            id="changes-list"
            rowHeight={RowHeight}
            filterText={
              this.props.showChangesFilter
                ? this.props.fileListFilter.filterText
                : ''
            }
            filterTextBox={this.filterTextBox}
            onFilterListResultsChanged={this.onFilterListResultsChanged}
            selectedItems={this.state.selectedItems}
            selectionMode="multi"
            renderItem={this.renderChangedFile}
            renderGroupHeader={this.renderFolder}
            onItemClick={this.onChangedFileClick}
            onItemDoubleClick={this.onChangedFileDoubleClick}
            onItemKeyboardFocus={this.onChangedFileFocus}
            onItemBlur={this.onChangedFileBlur}
            onScroll={this.onScroll}
            setScrollTop={this.props.changesListScrollTop}
            onItemKeyDown={this.onItemKeyDown}
            onSelectionChanged={this.onListSelectionChanged}
            groups={this.getGroups()}
            filterMethod={
              this.props.fileListFilter.isIncludedInCommit ||
              this.props.fileListFilter.isNewFile ||
              this.props.fileListFilter.isModifiedFile ||
              this.props.fileListFilter.isDeletedFile ||
              this.props.fileListFilter.isExcludedFromCommit
                ? this.applyFilters
                : undefined
            }
            invalidationProps={{
              workingDirectory: workingDirectory,
              isCommitting: isCommitting,
              focusedRow: this.state.focusedRow,
              treeView: this.props.fileTreeView,
              collapsedFolders: this.activeCollapsedFolders,
              showChangesFilter: this.props.showChangesFilter,
              filterNewFiles: this.props.fileListFilter.isNewFile,
              filterModifiedFiles: this.props.fileListFilter.isModifiedFile,
              filterDeletedFiles: this.props.fileListFilter.isDeletedFile,
              filterExcludedFiles:
                this.props.fileListFilter.isExcludedFromCommit,
            }}
            onItemContextMenu={this.onItemContextMenu}
            renderCustomFilterRow={this.renderFilterRow}
            getGroupAriaLabel={this.getListAriaLabel}
            renderNoItems={this.renderNoChanges}
            postNoResultsMessage={getNoResultsMessage(
              this.props.fileListFilter
            )}
          />
        </div>
        {this.renderStashedChanges()}
        {this.renderHiddenChangesWarning()}
        {this.renderCommitMessageForm()}
      </>
    )
  }

  private renderHiddenChangesWarning = () => {
    const { files } = this.props.workingDirectory
    const filesSelected = files.filter(
      f => f.selection.getSelectionType() !== DiffSelectionType.None
    )

    if (
      !isCommittingFileHiddenByFilter(
        filesSelected.map(f => f.id),
        this.state.filteredItems,
        files.length,
        this.props.fileListFilter
      )
    ) {
      return null
    }

    return (
      <div className="hidden-changes-warning" id="hidden-changes-warning">
        <Octicon symbol={octicons.alert} />
        <span className="sr-only">Warning:</span>
        <span>Hidden changes will be committed. </span>
        <LinkButton onClick={this.showFilesToBeCommitted}>
          Adjust the filters to see all {formatNumber(filesSelected.length)}{' '}
          changes
        </LinkButton>
      </div>
    )
  }

  private renderNoChanges = () => {
    if (!hasActiveFilters(this.props.fileListFilter)) {
      return null
    }

    // Check if any filters are active (including text filter)
    const filtersActive = hasActiveFilters(this.props.fileListFilter)

    const BlankSlateImage = encodePathAsUrl(
      __dirname,
      'static/empty-no-file-selected.svg'
    )

    return (
      <div className="no-changes-filtered">
        <img src={BlankSlateImage} className="blankslate-image" alt="" />

        <div className="title">No files match your current filters</div>

        <div className="subtitle">
          {getNoResultsMessage(this.props.fileListFilter)}
        </div>

        {filtersActive && (
          <Button
            className="clear-filters-button"
            onClick={this.onClearAllFilters}
          >
            Clear filters
          </Button>
        )}
      </div>
    )
  }

  private onFilterToIncludedInCommit = () => {
    if (!this.props.fileListFilter.isIncludedInCommit) {
      this.props.dispatcher.incrementMetric(
        'appliesIncludedInCommitFilterCount'
      )
    }
    this.props.dispatcher.setIncludedChangesInCommitFilter(
      this.props.repository,
      !this.props.fileListFilter.isIncludedInCommit
    )
  }

  private onFilterNewFiles = () => {
    if (!this.props.fileListFilter.isNewFile) {
      this.props.dispatcher.incrementMetric('appliesNewFilesChangesFilterCount')
    }
    this.props.dispatcher.setFilterNewFiles(
      this.props.repository,
      !this.props.fileListFilter.isNewFile
    )
  }

  private onFilterModifiedFiles = () => {
    if (!this.props.fileListFilter.isModifiedFile) {
      this.props.dispatcher.incrementMetric(
        'appliesModifiedFilesChangesFilterCount'
      )
    }
    this.props.dispatcher.setFilterModifiedFiles(
      this.props.repository,
      !this.props.fileListFilter.isModifiedFile
    )
  }

  private onFilterDeletedFiles = () => {
    if (!this.props.fileListFilter.isDeletedFile) {
      this.props.dispatcher.incrementMetric(
        'appliesDeletedFilesChangesFilterCount'
      )
    }
    this.props.dispatcher.setFilterDeletedFiles(
      this.props.repository,
      !this.props.fileListFilter.isDeletedFile
    )
  }

  private onFilterExcludedFiles = () => {
    if (!this.props.fileListFilter.isExcludedFromCommit) {
      this.props.dispatcher.incrementMetric(
        'appliesExcludedFromCommitFilterCount'
      )
    }
    this.props.dispatcher.setFilterExcludedFiles(
      this.props.repository,
      !this.props.fileListFilter.isExcludedFromCommit
    )
  }

  private onClearAllFilters = () => {
    this.props.dispatcher.incrementMetric(
      'appliesClearAllChangesListFilterCount'
    )

    // Clear all filters including text filter
    this.props.dispatcher.setChangesListFilterText(this.props.repository, '')
    this.props.dispatcher.setIncludedChangesInCommitFilter(
      this.props.repository,
      false
    )
    this.props.dispatcher.setFilterExcludedFiles(this.props.repository, false)
    this.props.dispatcher.setFilterNewFiles(this.props.repository, false)
    this.props.dispatcher.setFilterModifiedFiles(this.props.repository, false)
    this.props.dispatcher.setFilterDeletedFiles(this.props.repository, false)
  }

  private onChangedFileFocus = (changeListItem: IChangesListItem) => {
    this.setState({ focusedRow: changeListItem.id })
  }

  private onChangedFileBlur = (changeListItem: IChangesListItem) => {
    if (this.state.focusedRow === changeListItem.id) {
      this.setState({ focusedRow: null })
    }
  }
}
