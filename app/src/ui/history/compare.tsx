import * as React from 'react'

import { Commit, CommitOneLine, ICommitContext } from '../../models/commit'
import {
  HistoryTabMode,
  ICompareState,
  ICompareBranch,
  ComparisonMode,
  IDisplayHistory,
} from '../../lib/app-state'
import { CommitList } from './commit-list'
import { Repository } from '../../models/repository'
import { Branch } from '../../models/branch'
import { defaultErrorHandler, Dispatcher } from '../dispatcher'
import { ThrottledScheduler } from '../lib/throttled-scheduler'
import { BranchList } from '../branches'
import { TextBox } from '../lib/text-box'
import { IBranchListItem } from '../branches/group-branches'
import { TabBar } from '../tab-bar'
import { CompareBranchListItem } from './compare-branch-list-item'
import { FancyTextBox } from '../lib/fancy-text-box'
import * as octicons from '../octicons/octicons.generated'
import { SelectionSource } from '../lib/filter-list'
import { IMatches } from '../../lib/fuzzy-find'
import { Ref } from '../lib/ref'
import { MergeCallToActionWithConflicts } from './merge-call-to-action-with-conflicts'
import { AheadBehindStore } from '../../lib/stores/ahead-behind-store'
import { DragType } from '../../models/drag-drop'
import { PopupType } from '../../models/popup'
import { getUniqueCoauthorsAsAuthors } from '../../lib/unique-coauthors-as-authors'
import { getSquashedCommitDescription } from '../../lib/squash/squashed-commit-description'
import { BranchSortOrder } from '../../models/branch-sort-order'
import { doMergeCommitsExistAfterCommit } from '../../lib/git'
import { KeyboardInsertionData } from '../lib/list'
import { Account } from '../../models/account'
import { Emoji } from '../../lib/emoji'
import { syncClockwise } from '../octicons'
import { formatNumber } from '../../lib/format-number'

interface ICompareSidebarProps {
  readonly isCompareView: boolean
  readonly repository: Repository
  readonly isLocalRepository: boolean
  readonly compareState: ICompareState
  readonly emoji: Map<string, Emoji>
  readonly commitLookup: Map<string, Commit>
  readonly localCommitSHAs: ReadonlyArray<string>
  readonly askForConfirmationOnCheckoutCommit: boolean
  readonly dispatcher: Dispatcher
  readonly currentBranch: Branch | null
  readonly selectedCommitShas: ReadonlyArray<string>
  readonly branchSortOrder: BranchSortOrder
  readonly onRevertCommit: (commit: Commit) => void
  readonly onRevertCommits: (commits: ReadonlyArray<Commit>) => void
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
  readonly aheadBehindStore: AheadBehindStore
  readonly isMultiCommitOperationInProgress?: boolean
  /** Whether assisted execution or retained recovery locks this repository. */
  readonly isAssistedCommitRepositoryLocked: boolean
  readonly shasToHighlight: ReadonlyArray<string>
  readonly accounts: ReadonlyArray<Account>
  readonly preferAbsoluteDates: boolean
  readonly showConventionalCommitBadges: boolean
}
interface ICompareSidebarState {
  /**
   * This branch should only be used when tracking interactions that the user is performing.
   *
   * For all other cases, use the prop
   */
  readonly focusedBranch: Branch | null

  /** Data to be reordered via keyboard */
  readonly keyboardReorderData?: KeyboardInsertionData

  readonly isSearching: boolean
}

/** If we're within this many rows from the bottom, load the next history batch. */
const CloseToBottomThreshold = 30

export class CompareSidebar extends React.Component<
  ICompareSidebarProps,
  ICompareSidebarState
> {
  private textbox: TextBox | null = null
  private readonly loadChangedFilesScheduler = new ThrottledScheduler(200)
  private branchList: BranchList | null = null
  private commitListRef = React.createRef<CommitList>()
  private loadingMoreCommitsPromise: Promise<void> | null = null
  private resultCount = 0

  public constructor(props: ICompareSidebarProps) {
    super(props)

    this.state = { focusedBranch: null, isSearching: false }
  }

  public componentWillReceiveProps(nextProps: ICompareSidebarProps) {
    const newFormState = nextProps.compareState.formState
    const oldFormState = this.props.compareState.formState

    if (
      newFormState.kind !== oldFormState.kind &&
      newFormState.kind === HistoryTabMode.History
    ) {
      this.setState({
        focusedBranch: null,
      })
      return
    }

    if (
      newFormState.kind !== HistoryTabMode.History &&
      oldFormState.kind !== HistoryTabMode.History
    ) {
      const oldBranch = oldFormState.comparisonBranch
      const newBranch = newFormState.comparisonBranch

      if (oldBranch.name !== newBranch.name) {
        // ensure the focused branch is in sync with the chosen branch
        this.setState({
          focusedBranch: newBranch,
        })
      }
    }
  }

  public componentDidUpdate(prevProps: ICompareSidebarProps) {
    const { showBranchList } = this.props.compareState

    if (
      prevProps.compareState.commitSearchQuery !== '' &&
      this.props.compareState.commitSearchQuery === ''
    ) {
      this.commitListRef.current?.scrollToSelectedCommit()
    }

    if (showBranchList === prevProps.compareState.showBranchList) {
      return
    }

    if (this.textbox !== null) {
      if (showBranchList) {
        this.textbox.focus()
      } else if (!showBranchList) {
        this.textbox.blur()
      }
    }
  }

  public focusHistory() {
    this.commitListRef.current?.focus()
  }

  public focusBranchFilter() {
    this.textbox?.focus()
  }

  public componentWillMount() {
    this.props.dispatcher.initializeCompare(this.props.repository)
  }

  public componentWillUnmount() {
    this.textbox = null

    // by hiding the branch list here when the component is torn down
    // we ensure any ahead/behind computation work is discarded
    this.props.dispatcher.updateCompareForm(this.props.repository, {
      showBranchList: false,
    })
  }

  public render() {
    return this.props.isCompareView
      ? this.renderCompareView()
      : this.renderHistoryView()
  }

  private renderHistoryView() {
    const { commitSearchQuery } = this.props.compareState
    return (
      <div id="compare-view" role="tabpanel" aria-labelledby="compare-tab">
        <div className="commit-search-form">
          <FancyTextBox
            ariaLabel="Commit filter"
            type="search"
            symbol={this.state.isSearching ? syncClockwise : octicons.search}
            symbolClassName={this.state.isSearching ? 'spin' : undefined}
            placeholder={__DARWIN__ ? 'Search Commits' : 'Search commits'}
            value={commitSearchQuery}
            onValueChanged={this.onCommitSearchQueryChanged}
          />
        </div>

        {this.renderCommitList()}
      </div>
    )
  }

  private renderCompareView() {
    const { branches, filterText, showBranchList } = this.props.compareState
    const placeholderText = getPlaceholderText(this.props.compareState)

    return (
      <div id="compare-view" role="tabpanel" aria-labelledby="compare-tab">
        <div className="compare-form">
          <FancyTextBox
            ariaLabel="Branch filter"
            symbol={octicons.gitBranch}
            displayClearButton={true}
            placeholder={placeholderText}
            onFocus={this.onTextBoxFocused}
            value={filterText}
            disabled={!branches.some(b => !b.isDesktopForkRemoteBranch)}
            onRef={this.onTextBoxRef}
            onValueChanged={this.onBranchFilterTextChanged}
            onKeyDown={this.onBranchFilterKeyDown}
            onSearchCleared={this.handleEscape}
          />
        </div>

        {showBranchList ? this.renderFilterList() : this.renderCommits()}
      </div>
    )
  }

  private onBranchesListRef = (branchList: BranchList | null) => {
    this.branchList = branchList
  }

  private renderCommits() {
    const formState = this.props.compareState.formState
    return (
      <div className="compare-commit-list">
        {formState.kind === HistoryTabMode.History
          ? this.renderCommitList()
          : this.renderTabBar(formState)}
      </div>
    )
  }

  private filterListResultsChanged = (resultCount: number) => {
    this.resultCount = resultCount
  }

  private viewBranchList = () => {
    this.props.dispatcher.updateCompareForm(this.props.repository, {
      showBranchList: true,
    })
  }

  private renderCommitList() {
    const {
      formState,
      filteredHistoryCommitSHAs,
      compareCommitSHAs,
      commitSearchQuery,
    } = this.props.compareState

    let emptyListMessage: string | JSX.Element
    if (formState.kind === HistoryTabMode.History) {
      emptyListMessage = commitSearchQuery ? 'No results found' : 'No history'
    } else {
      const currentlyComparedBranchName = formState.comparisonBranch.name

      emptyListMessage =
        formState.comparisonMode === ComparisonMode.Ahead ? (
          <p>
            The compared branch (<Ref>{currentlyComparedBranchName}</Ref>) is up
            to date with your branch
          </p>
        ) : (
          <p>
            Your branch is up to date with the compared branch (
            <Ref>{currentlyComparedBranchName}</Ref>)
          </p>
        )
    }

    const dragSourceBranch =
      formState.kind === HistoryTabMode.Compare &&
      formState.comparisonMode === ComparisonMode.Behind
        ? formState.comparisonBranch
        : undefined

    return (
      <CommitList
        ref={this.commitListRef}
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        isLocalRepository={this.props.isLocalRepository}
        commitLookup={this.props.commitLookup}
        commitSHAs={
          this.props.isCompareView
            ? compareCommitSHAs
            : filteredHistoryCommitSHAs
        }
        allHistoryCommitSHAs={
          formState.kind === HistoryTabMode.History
            ? this.props.compareState.allHistoryCommitSHAs
            : undefined
        }
        selectedSHAs={this.props.selectedCommitShas}
        shasToHighlight={this.props.shasToHighlight}
        localCommitSHAs={this.props.localCommitSHAs}
        canResetToCommits={formState.kind === HistoryTabMode.History}
        canUndoCommits={formState.kind === HistoryTabMode.History}
        canAmendCommits={formState.kind === HistoryTabMode.History}
        emoji={this.props.emoji}
        reorderingEnabled={formState.kind === HistoryTabMode.History}
        onViewCommitOnGitHub={this.props.onViewCommitOnGitHub}
        onUndoCommit={this.onUndoCommit}
        onResetToCommit={this.onResetToCommit}
        onRevertCommit={
          ableToRevertCommit(this.props.compareState.formState)
            ? this.props.onRevertCommit
            : undefined
        }
        onRevertCommits={
          ableToRevertCommit(this.props.compareState.formState)
            ? this.props.onRevertCommits
            : undefined
        }
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
        disableReordering={formState.kind === HistoryTabMode.Compare}
        disableSquashing={formState.kind === HistoryTabMode.Compare}
        isMultiCommitOperationInProgress={
          this.props.isMultiCommitOperationInProgress
        }
        isAssistedCommitRepositoryLocked={
          this.props.isAssistedCommitRepositoryLocked
        }
        keyboardReorderData={this.state.keyboardReorderData}
        accounts={this.props.accounts}
        dragSourceBranch={dragSourceBranch}
        preferAbsoluteDates={this.props.preferAbsoluteDates}
        showConventionalCommitBadges={this.props.showConventionalCommitBadges}
      />
    )
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

  private renderActiveTab(view: ICompareBranch) {
    return (
      <div className="compare-commit-list">
        {this.renderCommitList()}
        {view.comparisonMode === ComparisonMode.Behind
          ? this.renderMergeCallToAction(view)
          : null}
      </div>
    )
  }

  private renderFilterList() {
    const { defaultBranch, branches, recentBranches, filterText } =
      this.props.compareState

    return (
      <BranchList
        repository={this.props.repository}
        ref={this.onBranchesListRef}
        defaultBranch={defaultBranch}
        currentBranch={this.props.currentBranch}
        allBranches={branches}
        recentBranches={recentBranches}
        branchSortOrder={this.props.branchSortOrder}
        filterText={filterText}
        textbox={this.textbox!}
        selectedBranch={this.state.focusedBranch}
        canCreateNewBranch={false}
        onSelectionChanged={this.onSelectionChanged}
        onItemClick={this.onBranchItemClicked}
        onFilterTextChanged={this.onBranchFilterTextChanged}
        renderBranch={this.renderCompareBranchListItem}
        getBranchAriaLabel={this.getBranchAriaLabel}
        onFilterListResultsChanged={this.filterListResultsChanged}
        noBranchesMessage={getNoBranchesMessage(this.props.compareState)}
      />
    )
  }

  private renderMergeCallToAction(formState: ICompareBranch) {
    if (this.props.currentBranch == null) {
      return null
    }

    return (
      <MergeCallToActionWithConflicts
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
        mergeStatus={this.props.compareState.mergeStatus}
        currentBranch={this.props.currentBranch}
        comparisonBranch={formState.comparisonBranch}
        commitsBehind={formState.aheadBehind.behind}
      />
    )
  }

  private onTabClicked = (index: number) => {
    const formState = this.props.compareState.formState

    if (formState.kind === HistoryTabMode.History) {
      return
    }

    const comparisonMode =
      index === 0 ? ComparisonMode.Behind : ComparisonMode.Ahead
    const branch = formState.comparisonBranch

    this.props.dispatcher.executeCompare(this.props.repository, {
      kind: HistoryTabMode.Compare,
      branch,
      comparisonMode,
    })
  }

  private renderTabBar(formState: ICompareBranch) {
    const selectedTab =
      formState.comparisonMode === ComparisonMode.Behind ? 0 : 1

    return (
      <div className="compare-content">
        <TabBar selectedIndex={selectedTab} onTabClicked={this.onTabClicked}>
          <span>{`Behind (${formatNumber(
            formState.aheadBehind.behind
          )})`}</span>
          <span>{`Ahead (${formatNumber(formState.aheadBehind.ahead)})`}</span>
        </TabBar>
        {this.renderActiveTab(formState)}
      </div>
    )
  }

  private renderCompareBranchListItem = (
    item: IBranchListItem,
    matches: IMatches
  ) => {
    return (
      <CompareBranchListItem
        branch={item.branch}
        currentBranch={this.props.currentBranch}
        matches={matches}
        repository={this.props.repository}
        aheadBehindStore={this.props.aheadBehindStore}
      />
    )
  }

  private getBranchAriaLabel = (item: IBranchListItem): string => {
    return item.branch.name
  }

  private onBranchFilterKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    const key = event.key

    if (key === 'Enter') {
      if (this.resultCount === 0) {
        event.preventDefault()
        return
      }
      const branch = this.state.focusedBranch

      if (branch === null) {
        this.viewBranchList()
      } else {
        const comparisonMode = this.getInitialComparisonMode(branch)

        this.props.dispatcher.executeCompare(this.props.repository, {
          kind: HistoryTabMode.Compare,
          comparisonMode,
          branch,
        })

        this.props.dispatcher.updateCompareForm(this.props.repository, {
          filterText: branch.name,
          showBranchList: false,
        })
      }

      if (this.textbox) {
        this.textbox.blur()
      }
    } else if (key === 'Escape') {
      this.handleEscape()
    } else if (key === 'ArrowDown') {
      if (this.branchList !== null) {
        this.branchList.selectNextItem(true, 'down')
      }
    } else if (key === 'ArrowUp') {
      if (this.branchList !== null) {
        this.branchList.selectNextItem(true, 'up')
      }
    }
  }

  private handleEscape = () => {
    this.clearFilterState()
    if (this.textbox) {
      this.textbox.blur()
    }
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
    const compareState = this.props.compareState

    if (this.props.isCompareView) {
      // as the app is currently comparing the current branch to some other
      // branch, everything needed should be loaded
      return
    }

    const commits = compareState.filteredHistoryCommitSHAs
    if (commits.length - end <= CloseToBottomThreshold) {
      if (this.loadingMoreCommitsPromise != null) {
        // as this callback fires for any scroll event we need to guard
        // against re-entrant calls to loadCommitBatch
        return
      }

      this.loadingMoreCommitsPromise = this.props.dispatcher
        .loadNextCommitBatch(this.props.repository)
        .then(() => {
          // deferring unsetting this flag to some time _after_ the commits
          // have been appended to prevent eagerly adding more commits due
          // to scroll events (which fire indiscriminately)
          window.setTimeout(() => {
            this.loadingMoreCommitsPromise = null
          }, 500)
        })
    }
  }

  private onBranchFilterTextChanged = (filterText: string) => {
    if (filterText.length === 0) {
      this.setState({ focusedBranch: null })
    }

    this.props.dispatcher.updateCompareForm(this.props.repository, {
      filterText,
    })
  }

  private onCommitSearchQueryChanged = async (text: string) => {
    this.setState({ isSearching: true })
    await this.props.dispatcher.setCommitSearchQuery(
      this.props.repository,
      text
    )
    this.setState({ isSearching: false })
  }

  private clearFilterState = () => {
    this.setState({
      focusedBranch: null,
    })

    this.props.dispatcher.updateCompareForm(this.props.repository, {
      filterText: '',
    })
  }

  private onBranchItemClicked = (branch: Branch) => {
    const comparisonMode = this.getInitialComparisonMode(branch)

    this.props.dispatcher.executeCompare(this.props.repository, {
      kind: HistoryTabMode.Compare,
      comparisonMode,
      branch,
    })

    this.setState({
      focusedBranch: null,
    })

    this.props.dispatcher.updateCompareForm(this.props.repository, {
      filterText: branch.name,
      showBranchList: false,
    })
  }

  private onSelectionChanged = (
    branch: Branch | null,
    source: SelectionSource
  ) => {
    this.setState({
      focusedBranch: branch,
    })
  }

  private onTextBoxFocused = () => {
    this.props.dispatcher.updateCompareForm(this.props.repository, {
      showBranchList: true,
    })
  }

  private onTextBoxRef = (textbox: TextBox) => {
    this.textbox = textbox
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
    const { compareState } = this.props
    const { formState } = compareState

    let sourceBranch: Branch | undefined

    if (
      formState.kind === HistoryTabMode.Compare &&
      formState.comparisonMode === ComparisonMode.Behind
    ) {
      sourceBranch = formState.comparisonBranch
    }

    this.props.onCherryPick(this.props.repository, commits, sourceBranch)
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

  private getInitialComparisonMode(branch: Branch): ComparisonMode {
    const { currentBranch, repository, aheadBehindStore } = this.props

    if (currentBranch === null) {
      return ComparisonMode.Behind
    }

    const aheadBehind = aheadBehindStore.tryGetAheadBehind(
      repository,
      currentBranch.tip.sha,
      branch.tip.sha
    )

    if (
      aheadBehind !== undefined &&
      aheadBehind.behind === 0 &&
      aheadBehind.ahead > 0
    ) {
      return ComparisonMode.Ahead
    }

    return ComparisonMode.Behind
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

function getPlaceholderText(state: ICompareState) {
  const { branches } = state

  if (!branches.some(b => !b.isDesktopForkRemoteBranch)) {
    return __DARWIN__ ? 'No Branches to Compare' : 'No branches to compare'
  } else {
    return __DARWIN__
      ? 'Select Branch to Compare…'
      : 'Select branch to compare…'
  }
}

function getNoBranchesMessage(state: ICompareState) {
  const { branches } = state
  if (!branches.some(b => !b.isDesktopForkRemoteBranch)) {
    return 'Create a new branch to start comparing commits.'
  } else {
    return undefined
  }
}

// determine if the `onRevertCommit` function should be exposed to the CommitList/CommitListItem.
// `onRevertCommit` is only exposed if the form state of the branch compare form is either
// 1: History mode, 2: Comparison Mode with the 'Ahead' list shown.
// When not exposed, the context menu item 'Revert this commit' is disabled.
function ableToRevertCommit(
  formState: IDisplayHistory | ICompareBranch
): boolean {
  return (
    formState.kind === HistoryTabMode.History ||
    formState.comparisonMode === ComparisonMode.Ahead
  )
}
