import * as React from 'react'

import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import {
  ICompareState,
  IConstrainedValue,
  TSelectedFilters,
} from '../../lib/app-state'
import { Emoji } from '../../lib/emoji'
import { doMergeCommitsExistAfterCommit } from '../../lib/git'
import { getSquashedCommitDescription } from '../../lib/squash/squashed-commit-description'
import {
  commitGraph_getStoredViewMode,
  commitGraph_setStoredViewMode,
  CommitHistoryViewMode,
} from '../../lib/stores/commit-graph-state'
import { getUniqueCoauthorsAsAuthors } from '../../lib/unique-coauthors-as-authors'
import { Account } from '../../models/account'
import { getAvatarUserFromAuthor, IAvatarUser } from '../../models/avatar'
import { Branch, BranchType } from '../../models/branch'
import { Commit, CommitOneLine, ICommitContext } from '../../models/commit'
import { DragType } from '../../models/drag-drop'
import { PopupType } from '../../models/popup'
import { Repository } from '../../models/repository'
import { defaultErrorHandler, Dispatcher } from '../dispatcher'
import { Button } from '../lib/button'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { KeyboardInsertionData } from '../lib/list'
import { ThrottledScheduler } from '../lib/throttled-scheduler'
import { startTimer } from '../lib/timing'
import { Octicon, syncClockwise } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Resizable } from '../resizable'
import { CommitGraphCommitListItem } from './commit-graph-commit-list-item'
import { CommitGraphFilterTextBox } from './commit-graph-filter-text-box'
import {
  commitGraph_buildRows,
  commitGraph_getColor,
  commitGraph_RowHeight,
  ICommitGraphRow,
} from './commit-graph-model'
import type { ICommitListItemRenderProps } from './commit-list'
import { CommitList } from './commit-list'

type CommitGraphBranchGroup =
  | 'local'
  | 'origin'
  | 'upstream'
  | 'remote'
  | 'tags'

interface ICommitGraphSidebarProps {
  readonly repository: Repository
  readonly isLocalRepository: boolean
  readonly compareState: ICompareState
  readonly commitGraphBranchListWidth: IConstrainedValue
  readonly emoji: Map<string, Emoji>
  readonly commitLookup: Map<string, Commit>
  readonly localCommitSHAs: ReadonlyArray<string>
  readonly askForConfirmationOnCheckoutCommit: boolean
  readonly dispatcher: Dispatcher
  readonly currentBranch: Branch | null
  readonly currentTipSha: string | null
  readonly allBranches: ReadonlyArray<Branch>
  readonly selectedCommitShas: ReadonlyArray<string>
  readonly onRevertCommit: (commit: Commit) => void
  readonly onAmendCommit: (commit: Commit, isLocalCommit: boolean) => void
  readonly onViewCommitOnGitHub: (sha: string) => void
  readonly onCompareListScrolled: (scrollTop: number) => void
  readonly onCherryPick: (
    repository: Repository,
    commits: ReadonlyArray<CommitOneLine>,
    sourceBranch?: Branch
  ) => void
  readonly compareListScrollTop?: number
  readonly localTags: Map<string, string> | null
  readonly tagsToPush: ReadonlyArray<string> | null
  readonly isMultiCommitOperationInProgress?: boolean
  readonly shasToHighlight: ReadonlyArray<string>
  readonly accounts: ReadonlyArray<Account>
  readonly preferAbsoluteDates: boolean
  readonly showConventionalCommitBadges: boolean
}

interface ICommitGraphSidebarState {
  readonly keyboardReorderData?: KeyboardInsertionData
  readonly isSearching: boolean
  readonly commitGraphViewMode: CommitHistoryViewMode
  readonly commitGraphSelectedBranchRef: string | null
}

interface ICommitGraphBranches {
  readonly allBranches: ReadonlyArray<Branch>
  readonly visibleBranches: ReadonlyArray<Branch>
}

/** If we're within this many rows from the bottom, load the next history batch. */
const CloseToBottomThreshold = 30
const commitGraph_CloseToBottomThreshold = 200

interface ICommitGraphBranchCheckboxProps {
  readonly branch: Branch
  readonly checked: boolean
  readonly color: string
  readonly currentBranch: Branch | null
  readonly selected: boolean
  readonly onToggle: (branch: Branch) => void
  readonly onSelect: (branch: Branch) => void
  readonly onCheckout?: (branch: Branch) => void
}

class CommitGraphBranchCheckbox extends React.PureComponent<ICommitGraphBranchCheckboxProps> {
  private onChange = () => {
    this.props.onToggle(this.props.branch)
  }

  private onLabelMouseDown = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    this.props.onSelect(this.props.branch)
    event.currentTarget.focus()
  }

  private onLabelClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  private onLabelDoubleClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    this.props.onCheckout?.(this.props.branch)
  }

  private onLabelKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    this.props.onSelect(this.props.branch)
  }

  public render() {
    const { branch, checked, color, currentBranch, selected } = this.props
    const isCurrentBranch = branch.ref === currentBranch?.ref
    const label = (
      <span
        className={classNames('commitGraph-branch-label-content', {
          selected,
        })}
        role="button"
        tabIndex={0}
        onMouseDown={this.onLabelMouseDown}
        onClick={this.onLabelClick}
        onDoubleClick={this.onLabelDoubleClick}
        onKeyDown={this.onLabelKeyDown}
      >
        {checked ? (
          <span
            className="commitGraph-branch-color-swatch"
            style={{ backgroundColor: color }}
          />
        ) : null}
        {isCurrentBranch ? (
          <span className="commitGraph-branch-current-indicator" />
        ) : null}
        <span
          className={classNames('commitGraph-branch-label', {
            current: isCurrentBranch,
          })}
        >
          {branch.nameWithoutRemote}
        </span>
      </span>
    )

    return (
      <Checkbox
        className="commitGraph-branch"
        label={label}
        value={checked ? CheckboxValue.On : CheckboxValue.Off}
        onChange={this.onChange}
      />
    )
  }
}

interface ICommitGraphBranchGroupRowProps {
  readonly group: CommitGraphBranchGroup
  readonly label: string
  readonly collapsed: boolean
  readonly checkboxValue: CheckboxValue
  readonly onToggleSelection: (group: CommitGraphBranchGroup) => void
  readonly onToggleCollapsed: (group: CommitGraphBranchGroup) => void
}

class CommitGraphBranchGroupRow extends React.PureComponent<ICommitGraphBranchGroupRowProps> {
  private onToggleSelection = () => {
    this.props.onToggleSelection(this.props.group)
  }

  private onToggleCollapsed = () => {
    this.props.onToggleCollapsed(this.props.group)
  }

  public render() {
    const { label, collapsed, checkboxValue } = this.props
    const disclosureSymbol = collapsed
      ? octicons.triangleRight
      : octicons.triangleDown

    return (
      <div className="commitGraph-branch-group-row">
        <button
          type="button"
          className="commitGraph-group-disclosure"
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          aria-expanded={!collapsed}
          onClick={this.onToggleCollapsed}
        >
          <Octicon symbol={disclosureSymbol} />
        </button>
        <Checkbox
          className="commitGraph-group-checkbox"
          label={label}
          value={checkboxValue}
          onChange={this.onToggleSelection}
        />
      </div>
    )
  }
}

export class CommitGraphSidebar extends React.Component<
  ICommitGraphSidebarProps,
  ICommitGraphSidebarState
> {
  private readonly loadChangedFilesScheduler = new ThrottledScheduler(200)
  private commitListRef = React.createRef<CommitList>()
  private loadingMoreCommitsPromise: Promise<void> | null = null
  private commitGraph_loadingMoreCommitsPromise: Promise<void> | null = null
  private commitGraph_loadingRefsKey: string | null = null

  private readonly commitGraph_getAllBranchesForState = memoizeOne(
    (
      allBranches: ReadonlyArray<Branch>,
      currentBranch: Branch | null,
      localTags: Map<string, string> | null
    ): ReadonlyArray<Branch> => {
      const branches =
        allBranches.length > 0
          ? allBranches
          : currentBranch !== null
          ? [currentBranch]
          : []

      return branches
        .filter(branch => !branch.isDesktopForkRemoteBranch)
        .toSorted((a, b) => {
          if (a.type !== b.type) {
            return a.type - b.type
          }

          return a.name.localeCompare(b.name)
        })
        .concat(this.commitGraph_getTagsForState(localTags))
    }
  )

  private readonly commitGraph_getTagsForState = memoizeOne(
    (localTags: Map<string, string> | null): ReadonlyArray<Branch> => {
      if (localTags === null) {
        return []
      }

      return Array.from(localTags, ([tagName, sha]) =>
        this.commitGraph_createTag(tagName, sha)
      ).toSorted((a, b) => a.name.localeCompare(b.name))
    }
  )

  private readonly commitGraph_getVisibleBranchesForState = memoizeOne(
    (
      branches: ReadonlyArray<Branch>,
      hiddenBranchRefs: ReadonlyArray<string>,
      currentBranch: Branch | null
    ): ReadonlyArray<Branch> => {
      const hiddenBranchRefsSet = new Set(hiddenBranchRefs)
      const visibleBranches = branches.filter(
        branch => !hiddenBranchRefsSet.has(branch.ref)
      )
      const currentBranchIndex =
        currentBranch === null
          ? -1
          : visibleBranches.findIndex(
              branch => branch.ref === currentBranch.ref
            )

      if (currentBranchIndex <= 0) {
        return visibleBranches
      }

      return [
        visibleBranches[currentBranchIndex],
        ...visibleBranches.slice(0, currentBranchIndex),
        ...visibleBranches.slice(currentBranchIndex + 1),
      ]
    }
  )

  private readonly commitGraph_getSelectedRefsForState = memoizeOne(
    (visibleBranches: ReadonlyArray<Branch>) =>
      visibleBranches.map(branch => branch.ref)
  )

  private readonly commitGraph_getHiddenBranchRefsSetForState = memoizeOne(
    (
      hiddenBranchRefs: ReadonlyArray<string> | null
    ): ReadonlySet<string> | null =>
      hiddenBranchRefs === null ? null : new Set(hiddenBranchRefs)
  )

  private readonly commitGraph_getBranchesForState = memoizeOne(
    (
      allBranches: ReadonlyArray<Branch>,
      currentBranch: Branch | null,
      localTags: Map<string, string> | null,
      hiddenBranchRefs: ReadonlyArray<string> | null
    ): ICommitGraphBranches => {
      const commitGraphBranches = this.commitGraph_getAllBranchesForState(
        allBranches,
        currentBranch,
        localTags
      )
      const visibleBranches =
        hiddenBranchRefs !== null
          ? this.commitGraph_getVisibleBranchesForState(
              commitGraphBranches,
              hiddenBranchRefs,
              currentBranch
            )
          : []

      return { allBranches: commitGraphBranches, visibleBranches }
    }
  )

  private readonly commitGraph_getFilteredCommitSHAsForState = memoizeOne(
    (
      commitSHAs: ReadonlyArray<string>,
      commitSearchQuery: string,
      commitLookup: Map<string, Commit>,
      selectedFilters: TSelectedFilters | null
    ): ReadonlyArray<string> => {
      const query = commitSearchQuery.toLowerCase()
      const authorEmails = selectedFilters?.author

      if (!query && (!authorEmails || authorEmails.size === 0)) {
        return commitSHAs
      }

      return commitSHAs.filter(sha => {
        const commit = commitLookup.get(sha)
        const matchesText = !query || this.commitIsIncluded(commit, query)
        const matchesAuthor =
          !authorEmails ||
          authorEmails.size === 0 ||
          authorEmails.has(commit?.author.email.toLowerCase() ?? '')
        return matchesText && matchesAuthor
      })
    }
  )

  private readonly commitGraph_getPrioritizedCommitSHAsForState = memoizeOne(
    (
      commitSHAs: ReadonlyArray<string>,
      commitLookup: Map<string, Commit>,
      visibleBranches: ReadonlyArray<Branch>,
      primaryLaneSha?: string
    ): ReadonlyArray<string> => {
      if (primaryLaneSha === undefined) {
        return commitSHAs
      }

      const commitsBySha = new Map<string, Commit>()
      for (const sha of commitSHAs) {
        const commit = commitLookup.get(sha)

        if (commit !== undefined) {
          commitsBySha.set(sha, commit)
        }
      }

      if (!commitsBySha.has(primaryLaneSha)) {
        return commitSHAs
      }

      const otherTipShas = visibleBranches.flatMap(branch =>
        !commitGraph_isTag(branch) && branch.tip.sha !== primaryLaneSha
          ? [branch.tip.sha]
          : []
      )

      if (otherTipShas.length === 0) {
        return commitSHAs
      }

      const primaryReachableShas = commitGraph_getReachableCommitSHAs(
        [primaryLaneSha],
        commitsBySha
      )
      const otherReachableShas = commitGraph_getReachableCommitSHAs(
        otherTipShas,
        commitsBySha
      )
      const primaryOnlyShas = new Set(
        Array.from(primaryReachableShas).filter(
          sha => !otherReachableShas.has(sha)
        )
      )

      if (primaryOnlyShas.size === 0) {
        return commitSHAs
      }

      const primaryCommits = new Array<string>()
      const otherCommits = new Array<string>()

      for (const sha of commitSHAs) {
        if (primaryOnlyShas.has(sha)) {
          primaryCommits.push(sha)
        } else {
          otherCommits.push(sha)
        }
      }

      return primaryCommits.length > 0
        ? primaryCommits.concat(otherCommits)
        : commitSHAs
    }
  )

  private readonly commitGraph_lookupCommitsForState = memoizeOne(
    (
      commitLookup: Map<string, Commit>,
      commitSHAs: ReadonlyArray<string>
    ): ReadonlyArray<Commit> => {
      const commits = new Array<Commit>()

      for (const sha of commitSHAs) {
        const commit = commitLookup.get(sha)

        if (commit !== undefined) {
          commits.push(commit)
        }
      }

      return commits
    }
  )

  private readonly commitGraph_getBranchColorsForState = memoizeOne(
    (branches: ReadonlyArray<Branch>): Map<string, string> => {
      const colors = new Map<string, string>()
      const colorsByTipSha = new Map<string, string>()
      let nextColor = 0

      for (const branch of branches) {
        let color = colorsByTipSha.get(branch.tip.sha)

        if (color === undefined) {
          color = commitGraph_getColor(nextColor)
          colorsByTipSha.set(branch.tip.sha, color)
          nextColor++
        }

        colors.set(branch.ref, color)
      }

      return colors
    }
  )

  private readonly commitGraph_getRefColorsForState = memoizeOne(
    (
      visibleBranches: ReadonlyArray<Branch>,
      branchColors: Map<string, string>
    ) =>
      visibleBranches.map(branch => ({
        sha: branch.tip.sha,
        color: branchColors.get(branch.ref) ?? commitGraph_getColor(0),
      }))
  )

  private readonly commitGraph_getBranchesByCommitShaForState = memoizeOne(
    (visibleBranches: ReadonlyArray<Branch>) => {
      const commitGraphBranchesByCommitSha = new Map<string, Array<Branch>>()

      for (const branch of visibleBranches) {
        if (commitGraph_isTag(branch)) {
          continue
        }

        const branches =
          commitGraphBranchesByCommitSha.get(branch.tip.sha) ?? []
        branches.push(branch)
        commitGraphBranchesByCommitSha.set(branch.tip.sha, branches)
      }

      return commitGraphBranchesByCommitSha
    }
  )

  private readonly commitGraph_buildRowsForState = memoizeOne(
    (
      commits: ReadonlyArray<Commit>,
      refColors: ReadonlyArray<{
        readonly sha: string
        readonly color: string
      }>,
      primaryLaneSha?: string
    ): ReadonlyArray<ICommitGraphRow> =>
      commitGraph_buildRows(commits, refColors, primaryLaneSha)
  )

  private readonly commitGraph_getFilterAuthorsWithAvatar = memoizeOne(
    (
      filterAuthorsList: ICommitGraphSidebarProps['compareState']['commitGraphFilterAuthorsList'],
      gitHubRepository: ICommitGraphSidebarProps['repository']['gitHubRepository']
    ): ReadonlyArray<IAvatarUser> | null => {
      if (!filterAuthorsList) {
        return null
      }

      return filterAuthorsList.map(author =>
        getAvatarUserFromAuthor(author, gitHubRepository)
      )
    }
  )

  public constructor(props: ICommitGraphSidebarProps) {
    super(props)

    this.state = {
      isSearching: false,
      commitGraphViewMode: commitGraph_getStoredViewMode(),
      commitGraphSelectedBranchRef: null,
    }
  }

  public componentWillMount() {
    this.props.dispatcher.initializeCompare(this.props.repository)
  }

  public componentDidMount() {
    this.commitGraph_ensureLoaded()

    void this.props.dispatcher.commitGraph_loadFilterAuthors(
      this.props.repository
    )
  }

  public componentDidUpdate() {
    this.commitGraph_ensureLoaded()
  }

  public focusHistory() {
    this.commitListRef.current?.focus()
  }

  private get filterAuthorsList() {
    return this.commitGraph_getFilterAuthorsWithAvatar(
      this.props.compareState.commitGraphFilterAuthorsList,
      this.props.repository.gitHubRepository
    )
  }

  public render() {
    return (
      <div id="compare-view" role="tabpanel" aria-labelledby="history-tab">
        <div className="commitGraph-view-toolbar">
          <div className="commit-search-form">
            <div className="filter-box-container">
              <CommitGraphFilterTextBox
                ariaLabel="Commit filter"
                type="search"
                symbol={
                  this.state.isSearching ? syncClockwise : octicons.search
                }
                symbolClassName={this.state.isSearching ? 'spin' : undefined}
                placeholder={__DARWIN__ ? 'Search Commits' : 'Search commits'}
                filterAuthorsList={this.filterAuthorsList}
                accounts={this.props.accounts}
                onSearchSubmitted={this.onCommitSearchSubmitted}
              />
            </div>
          </div>
          {this.commitGraph_renderViewModeSwitch()}
        </div>

        {this.state.commitGraphViewMode === CommitHistoryViewMode.Graph
          ? this.commitGraph_renderView()
          : this.renderCommitList(false)}
      </div>
    )
  }

  private commitGraph_renderViewModeSwitch() {
    return (
      <div className="commitGraph-view-mode-switch button-group">
        <Button
          size="small"
          className={classNames('button-group-item', {
            selected:
              this.state.commitGraphViewMode === CommitHistoryViewMode.List,
          })}
          ariaPressed={
            this.state.commitGraphViewMode === CommitHistoryViewMode.List
          }
          ariaLabel="List view"
          tooltip="List view"
          onClick={this.commitGraph_onListModeClicked}
        >
          <Octicon symbol={octicons.listUnordered} />
        </Button>
        <Button
          size="small"
          className={classNames('button-group-item', {
            selected:
              this.state.commitGraphViewMode === CommitHistoryViewMode.Graph,
          })}
          ariaPressed={
            this.state.commitGraphViewMode === CommitHistoryViewMode.Graph
          }
          ariaLabel="Graph view"
          tooltip="Graph view"
          onClick={this.commitGraph_onTreeModeClicked}
        >
          <Octicon symbol={octicons.gitBranch} />
        </Button>
      </div>
    )
  }

  private commitGraph_renderView() {
    const commitGraphIsBranchSelectionResolved =
      this.commitGraph_getHiddenBranchRefs() !== null

    return (
      <div className="commitGraph-view">
        {this.commitGraph_renderBranchPane()}
        <div className="commitGraph-list">
          {commitGraphIsBranchSelectionResolved
            ? this.renderCommitList(true)
            : null}
        </div>
      </div>
    )
  }

  private commitGraph_renderBranchPane() {
    const groups =
      this.commitGraph_getHiddenBranchRefs() === null
        ? []
        : this.commitGraph_getBranchGroups()
    const { commitGraphBranchListWidth } = this.props

    return (
      <Resizable
        id="commitGraph-branches-pane"
        width={commitGraphBranchListWidth.value}
        minimumWidth={commitGraphBranchListWidth.min}
        maximumWidth={commitGraphBranchListWidth.max}
        onResize={this.commitGraph_onBranchListResize}
        onReset={this.commitGraph_onBranchListReset}
        description="Commit graph branch list"
      >
        <div className="commitGraph-branches-pane">
          <div className="commitGraph-branch-list" role="group">
            {groups.map(group => this.commitGraph_renderBranchGroup(group))}
          </div>
        </div>
      </Resizable>
    )
  }

  private commitGraph_renderBranchGroup(group: CommitGraphBranchGroup) {
    const branches = this.commitGraph_getBranchesForGroup(group)
    const collapsed = this.commitGraph_isBranchGroupCollapsed(group)
    const label = this.commitGraph_getBranchGroupLabel(group)

    return (
      <div
        key={group}
        className="commitGraph-branch-group"
        role="group"
        aria-label={label}
      >
        <CommitGraphBranchGroupRow
          group={group}
          label={label}
          collapsed={collapsed}
          checkboxValue={this.commitGraph_getBranchGroupCheckboxValue(group)}
          onToggleSelection={this.commitGraph_onBranchGroupSelectionToggled}
          onToggleCollapsed={this.commitGraph_onBranchGroupCollapsedToggled}
        />
        {collapsed
          ? null
          : branches.map(branch => this.commitGraph_renderBranch(branch))}
      </div>
    )
  }

  private commitGraph_renderBranch(branch: Branch) {
    const hiddenBranchRefs = this.commitGraph_getHiddenBranchRefsSet()
    const checked =
      hiddenBranchRefs !== null && !hiddenBranchRefs.has(branch.ref)
    const color = this.commitGraph_getBranchColor(branch)

    return (
      <CommitGraphBranchCheckbox
        key={branch.ref}
        branch={branch}
        checked={checked}
        color={color}
        currentBranch={this.props.currentBranch}
        selected={this.state.commitGraphSelectedBranchRef === branch.ref}
        onToggle={this.commitGraph_onBranchToggled}
        onSelect={this.commitGraph_onBranchSelected}
        onCheckout={
          commitGraph_isTag(branch)
            ? undefined
            : this.commitGraph_onBranchCheckout
        }
      />
    )
  }

  private renderCommitList(commitGraphIsTreeMode: boolean) {
    const {
      filteredHistoryCommitSHAs,
      commitGraphCommitSHAs,
      commitSearchQuery,
    } = this.props.compareState

    const commitGraphCommitSHAsForList = commitGraphIsTreeMode
      ? this.commitGraph_getFilteredCommitSHAs()
      : []
    const commitGraphBranchColors = commitGraphIsTreeMode
      ? this.commitGraph_getBranchColors()
      : undefined
    const commitGraphRows = commitGraphIsTreeMode
      ? this.commitGraph_getRows()
      : undefined
    const commitGraphBranchesByCommitSha = commitGraphIsTreeMode
      ? this.commitGraph_getBranchesByCommitSha()
      : undefined

    const emptyListMessage = commitGraphIsTreeMode
      ? this.commitGraph_getSelectedRefs().length === 0
        ? 'No branches selected'
        : commitSearchQuery
        ? 'No results found'
        : 'No history'
      : commitSearchQuery
      ? 'No results found'
      : 'No history'

    const commitSHAs = commitGraphIsTreeMode
      ? commitGraphCommitSHAsForList
      : filteredHistoryCommitSHAs

    return (
      <CommitList
        ref={this.commitListRef}
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        isLocalRepository={this.props.isLocalRepository}
        commitLookup={this.props.commitLookup}
        commitSHAs={commitSHAs}
        allHistoryCommitSHAs={
          commitGraphIsTreeMode
            ? commitGraphCommitSHAs
            : this.props.compareState.allHistoryCommitSHAs
        }
        selectedSHAs={this.props.selectedCommitShas}
        shasToHighlight={this.props.shasToHighlight}
        localCommitSHAs={this.props.localCommitSHAs}
        canResetToCommits={!commitGraphIsTreeMode}
        canUndoCommits={true}
        canAmendCommits={true}
        headCommitSha={this.props.currentTipSha ?? undefined}
        emoji={this.props.emoji}
        reorderingEnabled={!commitGraphIsTreeMode}
        onViewCommitOnGitHub={this.props.onViewCommitOnGitHub}
        onUndoCommit={this.onUndoCommit}
        onResetToCommit={this.onResetToCommit}
        onRevertCommit={this.props.onRevertCommit}
        onAmendCommit={this.props.onAmendCommit}
        onCommitsSelected={this.onCommitsSelected}
        onScroll={this.onScroll}
        onCreateBranch={this.onCreateBranch}
        onCheckoutCommit={this.onCheckoutCommit}
        onCreateTag={this.onCreateTag}
        onDeleteTag={this.onDeleteTag}
        onCherryPick={this.onCherryPick}
        onDropCommitInsertion={this.onDropCommitInsertion}
        onKeyboardReorder={this.onKeyboardReorder}
        onCancelKeyboardReorder={this.onCancelKeyboardReorder}
        onSquash={this.onSquash}
        emptyListMessage={emptyListMessage}
        onCompareListScrolled={this.props.onCompareListScrolled}
        compareListScrollTop={this.props.compareListScrollTop}
        tagsToPush={this.props.tagsToPush ?? []}
        onRenderCommitDragElement={this.onRenderCommitDragElement}
        onRemoveCommitDragElement={this.onRemoveCommitDragElement}
        disableReordering={commitGraphIsTreeMode}
        disableSquashing={commitGraphIsTreeMode}
        isMultiCommitOperationInProgress={
          this.props.isMultiCommitOperationInProgress
        }
        keyboardReorderData={this.state.keyboardReorderData}
        accounts={this.props.accounts}
        preferAbsoluteDates={this.props.preferAbsoluteDates}
        showConventionalCommitBadges={this.props.showConventionalCommitBadges}
        commitGraphRowHeight={
          commitGraphIsTreeMode ? commitGraph_RowHeight : undefined
        }
        className={
          commitGraphIsTreeMode ? 'commitGraph-commit-list' : undefined
        }
        renderCommitItem={
          commitGraphIsTreeMode ? this.commitGraph_renderCommitItem : undefined
        }
        additionalInvalidationProps={
          commitGraphIsTreeMode
            ? {
                commitGraphRows,
                commitGraphBranchesByCommitSha,
                commitGraphBranchColors,
              }
            : undefined
        }
        disableRowFocusTooltip={commitGraphIsTreeMode}
      />
    )
  }

  private commitGraph_renderCommitItem = (
    props: ICommitListItemRenderProps
  ) => {
    const commitGraphRow = this.commitGraph_getRows()[props.row]

    if (commitGraphRow === undefined) {
      return null
    }

    return (
      <CommitGraphCommitListItem
        key={props.commit.sha}
        commit={props.commit}
        commitGraphRow={commitGraphRow}
        branches={
          this.commitGraph_getBranchesByCommitSha().get(props.commit.sha) ?? []
        }
        branchColors={this.commitGraph_getBranchColors()}
        emoji={this.props.emoji}
        showUnpushedIndicator={props.showUnpushedIndicator}
        unpushedIndicatorTitle={props.unpushedIndicatorTitle}
        preferAbsoluteDates={this.props.preferAbsoluteDates}
        showConventionalCommitBadges={this.props.showConventionalCommitBadges}
        currentBranch={this.props.currentBranch}
        currentTipSha={this.props.currentTipSha}
        gitHubRepository={this.props.repository.gitHubRepository}
        accounts={this.props.accounts}
      />
    )
  }

  private commitGraph_getBranches() {
    return this.commitGraph_getBranchesForState(
      this.props.allBranches,
      this.props.currentBranch,
      this.props.localTags,
      this.commitGraph_getHiddenBranchRefs()
    ).allBranches
  }

  private commitGraph_getVisibleBranches() {
    return this.commitGraph_getBranchesForState(
      this.props.allBranches,
      this.props.currentBranch,
      this.props.localTags,
      this.commitGraph_getHiddenBranchRefs()
    ).visibleBranches
  }

  private commitGraph_getHiddenBranchRefs() {
    return this.props.compareState.commitGraphHiddenBranchRefs
  }

  private commitGraph_getHiddenBranchRefsSet() {
    return this.commitGraph_getHiddenBranchRefsSetForState(
      this.commitGraph_getHiddenBranchRefs()
    )
  }

  private commitGraph_setHiddenBranchRefs(
    hiddenBranchRefs: ReadonlyArray<string>
  ) {
    this.props.dispatcher.commitGraph_setHiddenBranchRefs(
      this.props.repository,
      hiddenBranchRefs
    )
  }

  private commitGraph_getSelectedRefs() {
    return this.commitGraph_getSelectedRefsForState(
      this.commitGraph_getVisibleBranches()
    )
  }

  private commitGraph_getPrimaryLaneSha() {
    const currentBranch = this.props.currentBranch

    if (currentBranch === null) {
      return undefined
    }

    return this.commitGraph_getVisibleBranches().some(
      branch => branch.ref === currentBranch.ref
    )
      ? currentBranch.tip.sha
      : undefined
  }

  private commitGraph_getFilteredCommitSHAs() {
    const commitSHAs = this.commitGraph_getFilteredCommitSHAsForState(
      this.props.compareState.commitGraphCommitSHAs,
      this.props.compareState.commitSearchQuery,
      this.props.commitLookup,
      this.props.compareState.commitGraphSelectedFilters
    )

    return this.commitGraph_getPrioritizedCommitSHAsForState(
      commitSHAs,
      this.props.commitLookup,
      this.commitGraph_getVisibleBranches(),
      this.commitGraph_getPrimaryLaneSha()
    )
  }

  private commitGraph_lookupCommits(commitSHAs: ReadonlyArray<string>) {
    return this.commitGraph_lookupCommitsForState(
      this.props.commitLookup,
      commitSHAs
    )
  }

  private commitGraph_getRows() {
    return this.commitGraph_buildRowsForState(
      this.commitGraph_lookupCommits(this.commitGraph_getFilteredCommitSHAs()),
      this.commitGraph_getRefColors(),
      this.commitGraph_getPrimaryLaneSha()
    )
  }

  private commitIsIncluded(
    commit: Commit | undefined,
    filterTextLowerCase: string
  ) {
    if (commit === undefined) {
      return false
    }

    return (
      !filterTextLowerCase ||
      commit.summary.toLowerCase().includes(filterTextLowerCase) ||
      commit.body.toLowerCase().includes(filterTextLowerCase) ||
      commit.tags.some(tag =>
        tag.toLowerCase().startsWith(filterTextLowerCase)
      ) ||
      commit.sha.toLowerCase().startsWith(filterTextLowerCase)
    )
  }

  private commitGraph_getBranchesByCommitSha() {
    return this.commitGraph_getBranchesByCommitShaForState(
      this.commitGraph_getBranches()
    )
  }

  private commitGraph_getBranchColors() {
    return this.commitGraph_getBranchColorsForState(
      this.commitGraph_getBranches()
    )
  }

  private commitGraph_getBranchColor(branch: Branch) {
    return (
      this.commitGraph_getBranchColors().get(branch.ref) ??
      commitGraph_getColor(0)
    )
  }

  private commitGraph_createTag(tagName: string, sha: string) {
    return new Branch(
      tagName,
      null,
      { sha, author: { date: new Date(0) } },
      BranchType.Local,
      commitGraph_GetTagRef(tagName),
      false
    )
  }

  private commitGraph_getRefColors() {
    const branchColors = this.commitGraph_getBranchColors()

    return this.commitGraph_getRefColorsForState(
      this.commitGraph_getVisibleBranches(),
      branchColors
    )
  }

  private commitGraph_getBranchGroups() {
    const availableGroups = new Set(
      this.commitGraph_getBranches().map(branch =>
        commitGraph_getBranchGroup(branch)
      )
    )

    return (
      [
        'local',
        'origin',
        'upstream',
        'remote',
        'tags',
      ] as ReadonlyArray<CommitGraphBranchGroup>
    ).filter(group => availableGroups.has(group))
  }

  private commitGraph_getBranchesForGroup(group: CommitGraphBranchGroup) {
    return this.commitGraph_getBranches().filter(
      branch => commitGraph_getBranchGroup(branch) === group
    )
  }

  private commitGraph_getBranchGroupLabel(group: CommitGraphBranchGroup) {
    const count = this.commitGraph_getBranchesForGroup(group).length

    switch (group) {
      case 'local':
        return `Local Branches (${count})`
      case 'origin':
        return `origin (${count})`
      case 'upstream':
        return `upstream (${count})`
      case 'remote':
        return `Other Remotes (${count})`
      case 'tags':
        return `Tags (${count})`
    }
  }

  private commitGraph_getBranchGroupCheckboxValue(
    group: CommitGraphBranchGroup
  ) {
    const hiddenBranchRefs = this.commitGraph_getHiddenBranchRefsSet()

    if (hiddenBranchRefs === null) {
      return CheckboxValue.Off
    }

    const branches = this.commitGraph_getBranchesForGroup(group)

    if (branches.length === 0) {
      return CheckboxValue.Off
    }

    const selectedBranchCount = branches.filter(
      branch => !hiddenBranchRefs.has(branch.ref)
    ).length

    if (selectedBranchCount === 0) {
      return CheckboxValue.Off
    }

    if (selectedBranchCount === branches.length) {
      return CheckboxValue.On
    }

    return CheckboxValue.Mixed
  }

  private commitGraph_isBranchGroupCollapsed(group: CommitGraphBranchGroup) {
    return this.props.compareState.commitGraphCollapsedBranchGroups.includes(
      group
    )
  }

  private commitGraph_onBranchListResize = (width: number) => {
    this.props.dispatcher.commitGraph_setBranchListWidth(width)
  }

  private commitGraph_onBranchListReset = () => {
    this.props.dispatcher.commitGraph_resetBranchListWidth()
  }

  private commitGraph_onBranchGroupSelectionToggled = (
    group: CommitGraphBranchGroup
  ) => {
    const hiddenBranchRefs = this.commitGraph_getHiddenBranchRefs()

    if (hiddenBranchRefs === null) {
      return
    }

    const branches = this.commitGraph_getBranchesForGroup(group)
    const hiddenBranchRefsSet = new Set(hiddenBranchRefs)
    const allSelected = branches.every(
      branch => !hiddenBranchRefsSet.has(branch.ref)
    )

    for (const branch of branches) {
      if (allSelected) {
        hiddenBranchRefsSet.add(branch.ref)
      } else {
        hiddenBranchRefsSet.delete(branch.ref)
      }
    }

    this.commitGraph_setHiddenBranchRefs(Array.from(hiddenBranchRefsSet))
  }

  private commitGraph_onBranchGroupCollapsedToggled = (
    group: CommitGraphBranchGroup
  ) => {
    const collapsedGroups = new Set(
      this.props.compareState.commitGraphCollapsedBranchGroups
    )

    if (collapsedGroups.has(group)) {
      collapsedGroups.delete(group)
    } else {
      collapsedGroups.add(group)
    }

    this.props.dispatcher.commitGraph_setCollapsedBranchGroups(
      this.props.repository,
      Array.from(collapsedGroups)
    )
  }

  private commitGraph_onBranchToggled = (branch: Branch) => {
    const hiddenBranchRefs = this.commitGraph_getHiddenBranchRefs()

    if (hiddenBranchRefs === null) {
      return
    }

    const hiddenBranchRefsSet = new Set(hiddenBranchRefs)

    if (hiddenBranchRefsSet.has(branch.ref)) {
      hiddenBranchRefsSet.delete(branch.ref)
    } else {
      hiddenBranchRefsSet.add(branch.ref)
    }

    this.commitGraph_setHiddenBranchRefs(Array.from(hiddenBranchRefsSet))
  }

  private commitGraph_onBranchSelected = (branch: Branch) => {
    this.setState({ commitGraphSelectedBranchRef: branch.ref })
  }

  private commitGraph_onBranchCheckout = (branch: Branch) => {
    const { repository, dispatcher } = this.props
    const timer = startTimer('checkout branch from list', repository)
    dispatcher.checkoutBranch(repository, branch).then(() => timer.done())
  }

  private commitGraph_getCheckoutBranchForCommit(commitSha: string) {
    const branches =
      this.commitGraph_getBranchesByCommitSha().get(commitSha) ?? []
    const localBranches = branches.filter(
      branch => branch.type === BranchType.Local && !commitGraph_isTag(branch)
    )
    const selectedBranch = localBranches.find(
      branch => branch.ref === this.state.commitGraphSelectedBranchRef
    )

    if (selectedBranch !== undefined) {
      return selectedBranch
    }

    return localBranches.length === 1 ? localBranches[0] : null
  }

  private commitGraph_onListModeClicked = () => {
    commitGraph_setStoredViewMode(CommitHistoryViewMode.List)
    const { commitSearchQuery, commitGraphSelectedFilters } =
      this.props.compareState
    const filters: TSelectedFilters = commitGraphSelectedFilters ?? {
      author: new Set<string>(),
    }

    this.setState({ commitGraphViewMode: CommitHistoryViewMode.List }, () => {
      void this.onSearchList(commitSearchQuery, filters)
    })
  }

  private commitGraph_onTreeModeClicked = () => {
    commitGraph_setStoredViewMode(CommitHistoryViewMode.Graph)
    const { commitSearchQuery, commitGraphSelectedFilters } =
      this.props.compareState
    const filters: TSelectedFilters = commitGraphSelectedFilters ?? {
      author: new Set<string>(),
    }

    this.setState({ commitGraphViewMode: CommitHistoryViewMode.Graph }, () => {
      this.commitGraph_ensureLoaded()
      void this.onSearchGraph(commitSearchQuery, filters)
    })
  }

  private commitGraph_ensureLoaded() {
    if (
      this.state.commitGraphViewMode !== CommitHistoryViewMode.Graph ||
      this.commitGraph_getHiddenBranchRefs() === null
    ) {
      return
    }

    const refs = this.commitGraph_getSelectedRefs()
    const refsKey = refs.join('\0')

    if (
      refsKey === this.props.compareState.commitGraphRefs.join('\0') ||
      refsKey === this.commitGraph_loadingRefsKey
    ) {
      return
    }

    this.commitGraph_loadingRefsKey = refsKey
    void this.props.dispatcher
      .commitGraph_load(this.props.repository, refs)
      .finally(() => {
        if (this.commitGraph_loadingRefsKey === refsKey) {
          this.commitGraph_loadingRefsKey = null
        }
      })
  }

  private onCancelKeyboardReorder = () => {
    this.setState({ keyboardReorderData: undefined })
  }

  private onDropCommitInsertion = async (
    baseCommit: Commit | null,
    commitsToInsert: ReadonlyArray<Commit>,
    lastRetainedCommitRef: string | null
  ) => {
    this.setState({ keyboardReorderData: undefined })

    if (
      await doMergeCommitsExistAfterCommit(
        this.props.repository,
        lastRetainedCommitRef
      )
    ) {
      defaultErrorHandler(
        new Error(
          `Unable to reorder. Reordering replays all commits up to the last one required for the reorder. A merge commit cannot exist among those commits.`
        ),
        this.props.dispatcher
      )
      return
    }

    return this.props.dispatcher.reorderCommits(
      this.props.repository,
      commitsToInsert,
      baseCommit,
      lastRetainedCommitRef
    )
  }

  private onRenderCommitDragElement = (
    commit: Commit,
    selectedCommits: ReadonlyArray<Commit>
  ) => {
    this.props.dispatcher.setDragElement({
      type: DragType.Commit,
      commit,
      selectedCommits,
      gitHubRepository: this.props.repository.gitHubRepository,
    })
  }

  private onRemoveCommitDragElement = () => {
    this.props.dispatcher.clearDragElement()
  }

  private onCommitsSelected = (
    commits: ReadonlyArray<Commit>,
    isContiguous: boolean
  ) => {
    this.props.dispatcher.changeCommitSelection(
      this.props.repository,
      commits.map(c => c.sha),
      isContiguous
    )

    this.loadChangedFilesScheduler.queue(() => {
      this.props.dispatcher.loadChangedFilesForCurrentSelection(
        this.props.repository
      )
    })
  }

  private onScroll = (start: number, end: number) => {
    const commitGraphIsTreeMode =
      this.state.commitGraphViewMode === CommitHistoryViewMode.Graph
    const commits = commitGraphIsTreeMode
      ? this.commitGraph_getFilteredCommitSHAs()
      : this.props.compareState.filteredHistoryCommitSHAs
    const closeToBottomThreshold = commitGraphIsTreeMode
      ? commitGraph_CloseToBottomThreshold
      : CloseToBottomThreshold

    if (commits.length - end > closeToBottomThreshold) {
      return
    }

    if (
      commitGraphIsTreeMode
        ? this.commitGraph_loadingMoreCommitsPromise !== null
        : this.loadingMoreCommitsPromise !== null
    ) {
      // This callback fires for any scroll event, so guard against re-entrant batch loads.
      return
    }

    const promise = commitGraphIsTreeMode
      ? this.props.dispatcher.commitGraph_loadNextCommitBatch(
          this.props.repository
        )
      : this.props.dispatcher.loadNextCommitBatch(this.props.repository)

    if (commitGraphIsTreeMode) {
      this.commitGraph_loadingMoreCommitsPromise = promise
    } else {
      this.loadingMoreCommitsPromise = promise
    }

    promise.then(() => {
      // Defer until after commits append so eager scroll events do not immediately reload.
      window.setTimeout(() => {
        if (commitGraphIsTreeMode) {
          this.commitGraph_loadingMoreCommitsPromise = null
        } else {
          this.loadingMoreCommitsPromise = null
        }
      }, 500)
    })
  }

  private onSearchGraph = async (text: string, filters: TSelectedFilters) => {
    this.props.dispatcher.updateCompareForm(this.props.repository, {
      commitSearchQuery: text,
      commitGraphSelectedFilters: filters,
    })

    try {
      if (text.length > 0 || filters.author.size > 0) {
        this.setState({ isSearching: true })
        await this.props.dispatcher.commitGraph_loadNextCommitBatch(
          this.props.repository
        )
      }
    } catch (error) {
      console.error('Error while filtering commits graph:', error)
    } finally {
      this.setState({ isSearching: false })
    }
  }

  private onSearchList = async (text: string, filters: TSelectedFilters) => {
    try {
      this.setState({ isSearching: true })
      await this.props.dispatcher.setCommitSearchQuery(
        this.props.repository,
        text,
        filters
      )
    } catch (error) {
      console.error('Error while filtering commit list:', error)
    } finally {
      this.setState({ isSearching: false })
    }
  }

  private onCommitSearchSubmitted = async (
    text: string,
    emailSet: Set<string>
  ) => {
    const filters = { author: emailSet }

    if (this.state.commitGraphViewMode === CommitHistoryViewMode.Graph) {
      await this.onSearchGraph(text, filters)
    } else {
      await this.onSearchList(text, filters)
    }
  }

  private onCreateTag = (targetCommitSha: string) => {
    this.props.dispatcher.showCreateTagDialog(
      this.props.repository,
      targetCommitSha,
      this.props.localTags
    )
  }

  private onUndoCommit = (commit: Commit) => {
    this.props.dispatcher.undoCommit(this.props.repository, commit)
  }

  private onResetToCommit = (commit: Commit) => {
    this.props.dispatcher.resetToCommit(this.props.repository, commit)
  }

  private onCreateBranch = (commit: CommitOneLine) => {
    const { repository, dispatcher } = this.props

    dispatcher.showPopup({
      type: PopupType.CreateBranch,
      repository,
      targetCommit: commit,
    })
  }

  private onCheckoutCommit = (commit: CommitOneLine) => {
    const { repository, dispatcher, askForConfirmationOnCheckoutCommit } =
      this.props
    const checkoutBranch = this.commitGraph_getCheckoutBranchForCommit(
      commit.sha
    )

    if (this.props.currentTipSha === commit.sha) {
      return
    }

    if (checkoutBranch !== null) {
      const timer = startTimer('checkout branch from commit graph', repository)
      dispatcher
        .checkoutBranch(repository, checkoutBranch)
        .then(() => timer.done())
      return
    }

    if (!askForConfirmationOnCheckoutCommit) {
      dispatcher.checkoutCommit(repository, commit)
    } else {
      dispatcher.showPopup({
        type: PopupType.ConfirmCheckoutCommit,
        commit: commit,
        repository,
      })
    }
  }

  private onDeleteTag = (tagName: string, unpushed: boolean) => {
    const { repository, dispatcher } = this.props
    if (unpushed) {
      dispatcher.showDeleteTagDialog(this.props.repository, tagName)
    } else {
      dispatcher.showPopup({
        type: PopupType.ConfirmDeletePushedTag,
        tagName: tagName,
        repository,
      })
    }
  }

  private onCherryPick = (commits: ReadonlyArray<CommitOneLine>) => {
    this.props.onCherryPick(this.props.repository, commits)
  }

  private onKeyboardReorder = (toReorder: ReadonlyArray<Commit>) => {
    const { allHistoryCommitSHAs } = this.props.compareState

    this.setState({
      keyboardReorderData: {
        type: DragType.Commit,
        commits: toReorder,
        itemIndices: toReorder.map(c => allHistoryCommitSHAs.indexOf(c.sha)),
      },
    })
  }

  private onSquash = async (
    toSquash: ReadonlyArray<Commit>,
    squashOnto: Commit,
    lastRetainedCommitRef: string | null,
    isInvokedByContextMenu: boolean
  ) => {
    const toSquashSansSquashOnto = toSquash.filter(
      c => c.sha !== squashOnto.sha
    )

    const allCommitsInSquash = [...toSquashSansSquashOnto, squashOnto]
    const coAuthors = getUniqueCoauthorsAsAuthors(allCommitsInSquash)

    const squashedDescription = getSquashedCommitDescription(
      toSquashSansSquashOnto,
      squashOnto
    )

    if (
      await doMergeCommitsExistAfterCommit(
        this.props.repository,
        lastRetainedCommitRef
      )
    ) {
      defaultErrorHandler(
        new Error(
          `Unable to squash. Squashing replays all commits up to the last one required for the squash. A merge commit cannot exist among those commits.`
        ),
        this.props.dispatcher
      )
      return
    }

    this.props.dispatcher.recordSquashInvoked(isInvokedByContextMenu)

    this.props.dispatcher.showPopup({
      type: PopupType.CommitMessage,
      repository: this.props.repository,
      coAuthors,
      showCoAuthoredBy: coAuthors.length > 0,
      commitMessage: {
        summary: squashOnto.summary,
        description: squashedDescription,
        timestamp: Date.now(),
      },
      dialogTitle: `Squash ${allCommitsInSquash.length} Commits`,
      dialogButtonText: `Squash ${allCommitsInSquash.length} Commits`,
      prepopulateCommitSummary: true,
      onSubmitCommitMessage: async (context: ICommitContext) => {
        this.props.dispatcher.closePopup(PopupType.CommitMessage)

        this.props.dispatcher.squash(
          this.props.repository,
          toSquashSansSquashOnto,
          squashOnto,
          lastRetainedCommitRef,
          context
        )
        return true
      },
    })
  }
}

function commitGraph_getBranchGroup(branch: Branch): CommitGraphBranchGroup {
  if (commitGraph_isTag(branch)) {
    return 'tags'
  }

  if (branch.type === BranchType.Local) {
    return 'local'
  }

  if (branch.remoteName === 'origin') {
    return 'origin'
  }

  if (branch.remoteName === 'upstream') {
    return 'upstream'
  }

  return 'remote'
}

function commitGraph_GetTagRef(tagName: string) {
  return `refs/tags/${tagName}`
}

function commitGraph_isTag(branch: Branch) {
  return branch.ref.startsWith('refs/tags/')
}

function commitGraph_getReachableCommitSHAs(
  tips: ReadonlyArray<string>,
  commitsBySha: ReadonlyMap<string, Commit>
): Set<string> {
  const reachable = new Set<string>()
  const pending = tips.slice()

  while (pending.length > 0) {
    const sha = pending.pop()

    if (sha === undefined || reachable.has(sha)) {
      continue
    }

    const commit = commitsBySha.get(sha)

    if (commit === undefined) {
      continue
    }

    reachable.add(sha)
    pending.push(...commit.parentSHAs)
  }

  return reachable
}
