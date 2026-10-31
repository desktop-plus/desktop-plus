import * as React from 'react'
import * as Path from 'path'
import memoizeOne from 'memoize-one'

import { Repository } from '../../models/repository'
import { CommittedFileChange } from '../../models/status'
import { Commit } from '../../models/commit'
import { IDiff, ImageDiffType } from '../../models/diff'

import { encodePathAsUrl } from '../../lib/path'
import { revealInFileManager } from '../../lib/app-shell'

import { openFile } from '../lib/open-file'
import {
  isSafeFileExtension,
  CopyFilePathLabel,
  DefaultEditorLabel,
  RevealInFileManagerLabel,
  OpenWithDefaultProgramLabel,
  CopyRelativeFilePathLabel,
  CopySelectedPathsLabel,
  CopySelectedRelativePathsLabel,
} from '../lib/context-menu'
import { ThrottledScheduler } from '../lib/throttled-scheduler'

import { Dispatcher } from '../dispatcher'
import { Resizable } from '../resizable'
import { showContextualMenu } from '../../lib/menu-item'

import { FileList } from './file-list'
import { getFolderPathMenuItems } from '../lib/file-tree-folder'
import { SeamlessDiffSwitcher } from '../diff/seamless-diff-switcher'
import { getDotComAPIEndpoint } from '../../lib/api'
import { IMenuItem } from '../../lib/menu-item'
import { IChangesetData } from '../../lib/git'
import { IConstrainedValue } from '../../lib/app-state'
import { clamp } from '../../lib/clamp'
import { pathExists } from '../../lib/path-exists'
import { UnreachableCommitsTab } from './unreachable-commits-dialog'
import { ExpandableCommitSummary } from './expandable-commit-summary'
import { DiffHeader } from '../diff/diff-header'
import { Account } from '../../models/account'
import { Emoji } from '../../lib/emoji'
import { assertNever } from '../../lib/fatal-error'
import { getForgejoName } from '../../lib/forgejo-name'
import { GitHubRepository } from '../../models/github-repository'
import {
  DiffPresentationStateComponent,
  IDiffPresentationState,
} from '../diff/diff-presentation-state'
import { ChangedFilesHeader } from './changed-files-header'

interface ISelectedCommitsProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly emoji: Map<string, Emoji>
  readonly selectedCommits: ReadonlyArray<Commit>
  readonly shasInDiff: ReadonlyArray<string>
  readonly localCommitSHAs: ReadonlyArray<string>
  readonly changesetData: IChangesetData
  readonly selectedFile: CommittedFileChange | null
  readonly currentDiff: IDiff | null
  readonly commitSummaryWidth: IConstrainedValue
  readonly selectedDiffType: ImageDiffType
  /** The name of the currently selected external editor */
  readonly externalEditorLabel?: string

  /**
   * Called to open a file using the user's configured applications
   *
   * @param path The path of the file relative to the root of the repository
   */
  readonly onOpenInExternalEditor: (path: string) => void
  readonly onViewCommitOnGitHub: (SHA: string, filePath?: string) => void
  readonly hideWhitespaceInDiff: boolean

  /** Whether we should display side by side diffs. */
  readonly showSideBySideDiff: boolean

  /** Whether we should display the diff minimap. */
  readonly showDiffMinimap: boolean

  /** Whether text diff lines should wrap within the viewport. */
  readonly wrapDiffLines: boolean

  /** Whether the list of changed files is shown as a tree */
  readonly fileTreeView: boolean

  /**
   * Called when the user requests to open a binary file in an the
   * system-assigned application for said file type.
   */
  readonly onOpenBinaryFile: (fullPath: string) => void

  /** Called when the user requests to open a submodule. */
  readonly onOpenSubmodule: (fullPath: string) => void

  /**
   * Called when the user is viewing an image diff and requests
   * to change the diff presentation mode.
   */
  readonly onChangeImageDiffType: (type: ImageDiffType) => void

  /** Called when the user opens the diff options popover */
  readonly onDiffOptionsOpened: () => void

  /** Whether or not to show the drag overlay */
  readonly showDragOverlay: boolean

  /** Whether or not the selection of commits is contiguous */
  readonly isContiguous: boolean

  readonly accounts: ReadonlyArray<Account>
}

interface ISelectedCommitsState extends IDiffPresentationState {
  readonly isExpanded: boolean
  readonly selectedFiles: ReadonlyArray<CommittedFileChange>
  readonly fileFilterText: string
}

/** The History component. Contains the commit list, commit summary, and diff. */
export class SelectedCommits extends DiffPresentationStateComponent<
  ISelectedCommitsProps,
  ISelectedCommitsState
> {
  private readonly loadChangedFilesScheduler = new ThrottledScheduler(200)

  private readonly getFilteredFiles = memoizeOne(
    (files: ReadonlyArray<CommittedFileChange>, filterText: string) => {
      const query = filterText.trim().toLowerCase()
      return query === ''
        ? files
        : files.filter(f => f.path.toLowerCase().includes(query))
    }
  )

  public constructor(props: ISelectedCommitsProps) {
    super(props)

    this.state = {
      isExpanded: false,
      selectedFiles: [],
      fileFilterText: '',
      ...this.createDiffPresentationState(),
    }
  }

  private onFileSelectionChanged = (
    files: ReadonlyArray<CommittedFileChange>
  ) => {
    this.setState({ selectedFiles: files })
    if (files.length === 1) {
      this.props.dispatcher.changeFileSelection(this.props.repository, files[0])
    }
  }

  private get filteredFiles() {
    return this.getFilteredFiles(
      this.props.changesetData.files,
      this.state.fileFilterText
    )
  }

  private onFileFilterTextChanged = (fileFilterText: string) => {
    this.setState({ fileFilterText })
  }

  private onRowDoubleClick = (row: number) => {
    const files = this.filteredFiles
    const file = files[row]

    this.props.onOpenInExternalEditor(file.path)
  }

  public componentWillUpdate(nextProps: ISelectedCommitsProps) {
    // reset isExpanded if we're switching commits.
    const currentValue = this.props.selectedCommits.map(c => c.sha).join('')
    const nextValue = nextProps.selectedCommits.map(c => c.sha).join('')

    if (currentValue !== nextValue) {
      if (this.state.isExpanded) {
        this.setState({ isExpanded: false })
      }
      if (this.state.selectedFiles.length > 0) {
        this.setState({ selectedFiles: [] })
      }
      if (this.state.fileFilterText !== '') {
        this.setState({ fileFilterText: '' })
      }
    }
  }

  public componentDidUpdate(prevProps: ISelectedCommitsProps) {
    const previousFileId = prevProps.selectedFile?.id ?? null
    const nextFileId = this.props.selectedFile?.id ?? null

    if (
      (previousFileId !== nextFileId ||
        prevProps.currentDiff !== this.props.currentDiff) &&
      this.state.canExpandWholeFile
    ) {
      this.resetWholeFileExpansionAvailability()
    }
  }

  public componentWillUnmount() {
    this.loadChangedFilesScheduler.clear()
  }

  protected getDispatcher() {
    return this.props.dispatcher
  }

  private renderDiff() {
    const file = this.props.selectedFile
    const diff = this.props.currentDiff

    if (file == null) {
      // don't show both 'empty' messages
      const message =
        this.props.changesetData.files.length === 0 ? '' : 'No file selected'

      return (
        <div className="panel blankslate" id="diff">
          {message}
        </div>
      )
    }

    return (
      <div className="diff-container">
        {this.renderDiffHeader()}
        <SeamlessDiffSwitcher
          repository={this.props.repository}
          imageDiffType={this.props.selectedDiffType}
          file={file}
          diff={diff}
          readOnly={true}
          hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
          showDiffCheckMarks={false}
          showSideBySideDiff={this.props.showSideBySideDiff}
          showDiffMinimap={this.props.showDiffMinimap}
          wrapDiffLines={this.props.wrapDiffLines}
          showWholeFile={this.state.showWholeFile}
          onShowWholeFileChanged={this.onShowWholeFileChanged}
          onWholeFileExpansionAvailabilityChanged={
            this.onWholeFileExpansionAvailabilityChanged
          }
          onOpenBinaryFile={this.props.onOpenBinaryFile}
          onChangeImageDiffType={this.props.onChangeImageDiffType}
          onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
          onOpenSubmodule={this.props.onOpenSubmodule}
        />
      </div>
    )
  }

  private renderDiffHeader() {
    const { selectedFile } = this.props
    if (selectedFile === null) {
      return null
    }

    const { path, status } = selectedFile
    const showWholeFileInHeader = this.getShowWholeFileToggleState()

    return (
      <DiffHeader
        diff={this.props.currentDiff}
        path={path}
        status={status}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onShowSideBySideDiffChanged={this.onShowSideBySideDiffChanged}
        showDiffMinimap={this.props.showDiffMinimap}
        onShowDiffMinimapChanged={this.onShowDiffMinimapChanged}
        wrapDiffLines={this.props.wrapDiffLines}
        onWrapDiffLinesChanged={this.onWrapDiffLinesChanged}
        canExpandWholeFile={this.state.canExpandWholeFile}
        showWholeFile={showWholeFileInHeader}
        onShowWholeFileChanged={this.onShowWholeFileChanged}
        hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
        onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
        onDiffOptionsOpened={this.props.onDiffOptionsOpened}
      />
    )
  }

  private renderCommitSummary(commits: ReadonlyArray<Commit>) {
    return (
      <ExpandableCommitSummary
        selectedCommits={commits}
        shasInDiff={this.props.shasInDiff}
        changesetData={this.props.changesetData}
        emoji={this.props.emoji}
        repository={this.props.repository}
        onExpandChanged={this.onExpandChanged}
        isExpanded={this.state.isExpanded}
        onHighlightShas={this.onHighlightShas}
        showUnreachableCommits={this.showUnreachableCommits}
        accounts={this.props.accounts}
      />
    )
  }

  private showUnreachableCommits = (selectedTab: UnreachableCommitsTab) => {
    this.props.dispatcher.showUnreachableCommits(selectedTab)
  }

  private onHighlightShas = (shasToHighlight: ReadonlyArray<string>) => {
    this.props.dispatcher.updateShasToHighlight(
      this.props.repository,
      shasToHighlight
    )
  }

  private onExpandChanged = (isExpanded: boolean) => {
    this.setState({ isExpanded })
  }

  private onHideWhitespaceInDiffChanged = (hideWhitespaceInDiff: boolean) => {
    return this.props.dispatcher.onHideWhitespaceInHistoryDiffChanged(
      hideWhitespaceInDiff,
      this.props.repository,
      this.props.selectedFile as CommittedFileChange
    )
  }

  private onShowSideBySideDiffChanged = (showSideBySideDiff: boolean) => {
    this.props.dispatcher.onShowSideBySideDiffChanged(showSideBySideDiff)
  }

  private onCommitSummaryReset = () => {
    this.props.dispatcher.resetCommitSummaryWidth()
  }

  private onCommitSummaryResize = (width: number) => {
    this.props.dispatcher.setCommitSummaryWidth(width)
  }

  private renderFileList() {
    const files = this.props.changesetData.files
    if (files.length === 0) {
      return <div className="fill-window">No files in commit</div>
    }

    // -1 for right hand side border
    const availableWidth = clamp(this.props.commitSummaryWidth) - 1

    const filteredFiles = this.filteredFiles

    return (
      <>
        {this.renderFileHeader()}
        {filteredFiles.length === 0 && (
          <div className="file-list-no-results">No matching files</div>
        )}
        <FileList
          files={filteredFiles}
          onSelectionChanged={this.onFileSelectionChanged}
          selectedFiles={this.state.selectedFiles}
          availableWidth={availableWidth}
          onContextMenu={this.onContextMenu}
          onRowDoubleClick={this.onRowDoubleClick}
          treeView={this.props.fileTreeView}
          getFolderContextMenuItems={this.getFolderContextMenuItems}
        />
      </>
    )
  }

  private renderFileHeader() {
    return (
      <ChangedFilesHeader
        fileCount={this.props.changesetData.files.length}
        filterText={this.state.fileFilterText}
        onFilterTextChanged={this.onFileFilterTextChanged}
      />
    )
  }

  private getFolderContextMenuItems = (path: string) =>
    getFolderPathMenuItems(this.props.repository, this.props.dispatcher, path)

  /**
   * Open file with default application.
   *
   * @param path The path of the file relative to the root of the repository
   */
  private onOpenItem = (path: string) => {
    const fullPath = Path.join(this.props.repository.path, path)
    openFile(fullPath, this.props.dispatcher)
  }

  public render() {
    const { selectedCommits, isContiguous } = this.props

    if (selectedCommits.length > 1 && !isContiguous) {
      return this.renderMultipleCommitsBlankSlate()
    }

    if (selectedCommits.length === 0) {
      return <NoCommitSelected />
    }

    const className = this.state.isExpanded ? 'expanded' : 'collapsed'
    const { commitSummaryWidth } = this.props

    return (
      <div id="history" className={className}>
        {this.renderCommitSummary(selectedCommits)}
        <div className="commit-details">
          <Resizable
            width={commitSummaryWidth.value}
            minimumWidth={commitSummaryWidth.min}
            maximumWidth={commitSummaryWidth.max}
            onResize={this.onCommitSummaryResize}
            onReset={this.onCommitSummaryReset}
            description="Selected commit file list"
          >
            {this.renderFileList()}
          </Resizable>
          {this.renderDiff()}
        </div>
        {this.renderDragOverlay()}
      </div>
    )
  }

  private renderDragOverlay(): JSX.Element | null {
    if (!this.props.showDragOverlay) {
      return null
    }

    return <div id="drag-overlay-background"></div>
  }

  private renderMultipleCommitsBlankSlate(): JSX.Element {
    const BlankSlateImage = encodePathAsUrl(
      __dirname,
      'static/empty-no-commit.svg'
    )

    return (
      <div id="multiple-commits-selected" className="blankslate">
        <div className="panel blankslate">
          <img src={BlankSlateImage} className="blankslate-image" alt="" />
          <div>
            <p>
              Unable to display diff when multiple non-consecutive selected.
            </p>
            <div>You can:</div>
            <ul>
              <li>
                Select a single commit or a range of consecutive commits to view
                a diff.
              </li>
              <li>Drag the commits to the branch menu to cherry-pick them.</li>
              <li>Drag the commits to squash or reorder them.</li>
              <li>Right click on multiple commits to see options.</li>
            </ul>
          </div>
        </div>
        {this.renderDragOverlay()}
      </div>
    )
  }

  private onContextMenu = async (
    file: CommittedFileChange,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const {
      selectedCommits,
      localCommitSHAs,
      repository,
      externalEditorLabel,
    } = this.props

    const fullPath = Path.join(repository.path, file.path)
    const fileExistsOnDisk = await pathExists(fullPath)
    if (!fileExistsOnDisk) {
      showContextualMenu([
        {
          label: __DARWIN__
            ? 'File Does Not Exist on Disk'
            : 'File does not exist on disk',
          enabled: false,
        },
      ])
      return
    }

    const extension = Path.extname(file.path)

    const isSafeExtension = isSafeFileExtension(extension)
    const openInExternalEditor = externalEditorLabel
      ? `Open in ${externalEditorLabel}`
      : DefaultEditorLabel

    const visibleFiles = this.filteredFiles
    const selectedFiles = this.state.selectedFiles.filter(sf =>
      visibleFiles.some(f => f.path === sf.path)
    )
    const isMultiSelect =
      selectedFiles.length > 1 && selectedFiles.some(f => f.path === file.path)
    const filesToCopy = isMultiSelect ? selectedFiles : [file]

    const copyPathItems: ReadonlyArray<IMenuItem> =
      filesToCopy.length === 1
        ? [
            {
              label: CopyFilePathLabel,
              action: () => this.props.dispatcher.copyPathToClipboard(fullPath),
            },
            {
              label: CopyRelativeFilePathLabel,
              action: () =>
                this.props.dispatcher.copyPathToClipboard(
                  Path.normalize(file.path)
                ),
            },
          ]
        : [
            {
              label: CopySelectedPathsLabel,
              action: () =>
                this.props.dispatcher.copyPathsToClipboard(
                  filesToCopy.map(f => Path.join(repository.path, f.path))
                ),
            },
            {
              label: CopySelectedRelativePathsLabel,
              action: () =>
                this.props.dispatcher.copyPathsToClipboard(
                  filesToCopy.map(f => Path.normalize(f.path))
                ),
            },
          ]

    const items: IMenuItem[] = [
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(repository, file.path),
        enabled: fileExistsOnDisk,
      },
      {
        label: openInExternalEditor,
        action: () => this.props.onOpenInExternalEditor(file.path),
        enabled: fileExistsOnDisk,
      },
      {
        label: OpenWithDefaultProgramLabel,
        action: () => this.onOpenItem(file.path),
        enabled: isSafeExtension && fileExistsOnDisk,
      },
      { type: 'separator' },
      ...copyPathItems,
      { type: 'separator' },
    ]

    const gitHubRepository = repository.gitHubRepository

    items.push({
      label: gitHubRepository
        ? getViewOnGitHubLabel(gitHubRepository)
        : 'Not uploaded to GitHub',
      action: () => this.onViewOnGitHub(selectedCommits[0].sha, file),
      enabled:
        selectedCommits.length === 1 &&
        !localCommitSHAs.includes(selectedCommits[0].sha) &&
        !!gitHubRepository &&
        this.props.selectedCommits.length > 0,
    })

    showContextualMenu(items)
  }

  private onViewOnGitHub = (sha: string, file: CommittedFileChange) => {
    this.props.onViewCommitOnGitHub(sha, file.path)
  }
}

function NoCommitSelected() {
  const BlankSlateImage = encodePathAsUrl(
    __dirname,
    'static/empty-no-commit.svg'
  )

  return (
    <div className="panel blankslate">
      <img src={BlankSlateImage} className="blankslate-image" alt="" />
      No commit selected
    </div>
  )
}

function getViewOnGitHubLabel(gitHubRepository: GitHubRepository) {
  switch (gitHubRepository.type) {
    case 'github':
      return gitHubRepository.endpoint === getDotComAPIEndpoint()
        ? 'View on GitHub'
        : 'View on GitHub Enterprise'
    case 'bitbucket':
      return 'View on Bitbucket'
    case 'gitlab':
      return 'View on GitLab'
    case 'forgejo':
      return `View on ${getForgejoName(gitHubRepository.endpoint)}`
    case 'gitea':
      return 'View on Gitea'
    default:
      assertNever(
        gitHubRepository.type,
        `Unknown type: ${gitHubRepository.type}`
      )
  }
}
