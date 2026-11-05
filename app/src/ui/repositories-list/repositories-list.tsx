import * as React from 'react'
import * as ReactDOM from 'react-dom'

import { commitGrammar, RepositoryListItem } from './repository-list-item'
import {
  groupRepositories,
  buildPinnedGroup,
  filterPinnedFromGroups,
  IRepositoryListItem,
  Repositoryish,
  RepositoryListGroup,
  getGroupKey,
  getGroupForRepository,
  applyRepositoryGroupOrder,
  isReorderableRepositoryGroup,
  moveRepositoryGroupInOrder,
  IRepositoryGroupDropTarget,
  getRepositoryGroupDropBoundary,
  areRepositoryGroupDropTargetsEqual,
} from './group-repositories'
import {
  RepositoryGroupDropPosition,
  RepositoryGroupDropZone,
} from './repository-group-drop-zone'
import {
  getRepositoryGroupOrder,
  resetRepositoryGroupOrder,
  setRepositoryGroupOrder,
} from '../../lib/stores/repository-group-order'
import { Draggable } from '../lib/draggable'
import { dragAndDropManager } from '../../lib/drag-and-drop-manager'
import { DragType, DropTargetSelector } from '../../models/drag-drop'
import {
  getPinnedRepositories,
  addPinnedRepository,
  removePinnedRepository,
} from '../../lib/stores/repository-pinning'
import {
  getCollapsedRepositoryGroups,
  setRepositoryGroupsCollapsed,
} from '../../lib/stores/repository-group-collapse'
import { IFilterListGroup } from '../lib/filter-list'
import { IMatch, IMatches } from '../../lib/fuzzy-find'
import { ILocalRepositoryState, Repository } from '../../models/repository'
import { normalizePath } from '../../lib/helpers/path'
import { FoldoutType } from '../../lib/app-state'
import { Account } from '../../models/account'
import { Dispatcher } from '../dispatcher'
import { Button } from '../lib/button'
import { Octicon, syncClockwise } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { showContextualMenu } from '../../lib/menu-item'
import { IMenuItem } from '../../lib/menu-item'
import { PopupType } from '../../models/popup'
import { encodePathAsUrl } from '../../lib/path'
import { TooltippedContent } from '../lib/tooltipped-content'
import memoizeOne from 'memoize-one'
import { KeyboardShortcut } from '../keyboard-shortcut/keyboard-shortcut'
import { generateRepositoryListContextMenu } from '../repositories-list/repository-list-item-context-menu'
import { generateWorktreeListItemContextMenu } from '../repositories-list/repository-list-item-context-menu'
import { openRepositoryInNewWindow } from '../main-process-proxy'
import { enableWorktreeSupport } from '../../lib/feature-flag'
import { SectionFilterList } from '../lib/section-filter-list'
import { assertNever } from '../../lib/fatal-error'
import { IAheadBehind } from '../../models/branch'
import { ShowBranchNameInRepoListSetting } from '../../models/show-branch-name-in-repo-list'
import { getEditorOverrideLabel } from '../../models/editor-override'
import { AriaLiveContainer } from '../accessibility/aria-live-container'
import classNames from 'classnames'

const BlankSlateImage = encodePathAsUrl(__dirname, 'static/empty-no-repo.svg')

interface IRepositoriesListProps {
  readonly selectedRepository: Repositoryish | null
  readonly repositories: ReadonlyArray<Repositoryish>
  readonly recentRepositories: ReadonlyArray<number>

  /** The ids of the snoozed repositories, mapped to when their snooze ends */
  readonly snoozedRepositories: ReadonlyMap<number, number>

  /** A cache of the latest repository state values, keyed by the repository id */
  readonly localRepositoryStateLookup: ReadonlyMap<
    number,
    ILocalRepositoryState
  >

  /** Called when a repository has been selected. */
  readonly onSelectionChanged: (repository: Repositoryish) => void

  /** Whether the user has enabled the setting to confirm removing a repository from the app */
  readonly askForConfirmationOnRemoveRepository: boolean

  /** Called when the repository should be removed. */
  readonly onRemoveRepository: (repository: Repositoryish) => void

  /** Called when the repository should be shown in Finder/Explorer/File Manager. */
  readonly onShowRepository: (repository: Repositoryish, path?: string) => void

  /** Called when the repository should be opened in the default web browser. */
  readonly onViewOnGitHub: (repository: Repositoryish) => void

  /** Called when the repository should be shown in the shell. */
  readonly onOpenInShell: (repository: Repositoryish, path?: string) => void

  /** Called when the repository should be opened in a new window. */
  readonly onOpenInNewWindow: (repository: Repositoryish, path?: string) => void

  /** Called when the repository should be opened in an external editor */
  readonly onOpenInExternalEditor: (
    repository: Repositoryish,
    path?: string
  ) => void

  /** The current external editor selected by the user */
  readonly externalEditorLabel?: string

  /** The label for the user's preferred shell. */
  readonly shellLabel?: string

  /** The callback to fire when the filter text has changed */
  readonly onFilterTextChanged: (text: string) => void

  /** The text entered by the user to filter their repository list */
  readonly filterText: string

  /** The signed-in accounts, used to offer repository account choices. */
  readonly accounts: ReadonlyArray<Account>

  /** Called when the repository should be assigned to another account. */
  readonly onChangeRepositoryAccount: (
    repository: Repository,
    login: string
  ) => void

  /** Called when the repository's settings should be shown. */
  readonly onShowRepositorySettings: (repository: Repository) => void

  readonly dispatcher: Dispatcher

  /** Whether to show changed file counts in the repository list */
  readonly showChangedFileCount: boolean

  /** Controls when to show the branch name next to each repository */
  readonly showBranchNameInRepoList: ShowBranchNameInRepoListSetting

  /** Whether or not the worktrees dropdown should be shown in the toolbar */
  readonly showWorktrees: boolean

  /** Whether or not linked worktrees should be shown in the repository list */
  readonly showWorktreesInRepoList: boolean
}

interface IRepositoriesListState {
  readonly newRepositoryMenuExpanded: boolean
  readonly pullingRepositories: boolean
  readonly selectedItem: IRepositoryListItem | null
  readonly pinnedRepositoriesIds: ReadonlyArray<number>

  /** The keys of the groups currently being pulled */
  readonly pullingGroupKeys: ReadonlySet<string>

  /** The keys of the groups the user has collapsed */
  readonly collapsedGroups: ReadonlySet<string>

  /** The keys of the groups in the order chosen by the user, if any */
  readonly groupOrder: ReadonlyArray<string>

  /** The group currently being dragged to a new position, if any */
  readonly draggedGroup: { readonly key: string; readonly label: string } | null

  /** The drop zone hovered by the group being dragged, if any */
  readonly hoveredGroupDropZone: IRepositoryGroupDropTarget | null

  /** The screen reader announcement of the last group moved with the keyboard */
  readonly groupOrderMessage: string | null
}

const RowHeight = 29

/**
 * Iterate over all groups until a list item is found that matches
 * the id of the provided repository.
 */
function findMatchingListItem(
  groups: ReadonlyArray<
    IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
  >,
  selectedRepository: Repositoryish | null
) {
  if (selectedRepository !== null) {
    let fallback: IRepositoryListItem | null = null

    for (const group of groups) {
      for (const item of group.items) {
        if (item.repository.id === selectedRepository.id) {
          if (
            item.worktree !== null &&
            normalizePath(item.worktree.path) ===
              normalizePath(selectedRepository.path)
          ) {
            return item
          }

          fallback ??= item
        }
      }
    }

    return fallback
  }

  return null
}

interface IRepositoryGroupHeaderProps {
  readonly group: RepositoryListGroup

  /** The name of the group as shown to the user */
  readonly label: string

  /** Whether only this header is rendered, hiding the group's repositories */
  readonly collapsed: boolean

  /** The user-given name of the group, or null if it's not a custom group */
  readonly groupName: string | null

  /** Whether the repositories in this group are currently being pulled */
  readonly isPulling: boolean
  readonly onToggleCollapsed: (group: RepositoryListGroup) => void
  readonly onPullAll: (group: RepositoryListGroup) => void
  readonly onDelete: (groupName: string) => void
  readonly onContextMenu: (
    group: RepositoryListGroup,
    event: React.MouseEvent<HTMLDivElement>
  ) => void

  /** Whether the group can be dragged to a different position in the list */
  readonly canDrag: boolean
  readonly onRenderDragElement: (group: RepositoryListGroup) => void
  readonly onRemoveDragElement: () => void
  readonly onDragEnd: () => void

  /**
   * Whether clicks on the header's buttons must be ignored, as they come from
   * releasing the mouse at the end of a drag rather than from a real click
   */
  readonly isClickSuppressed: () => boolean
}

/**
 * Wraps a repository group header adding a button to pull all repositories in
 * the group and, for custom groups, a button to delete the group, with the same
 * actions available on right-click.
 */
class RepositoryGroupHeader extends React.Component<IRepositoryGroupHeaderProps> {
  private onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    this.props.onContextMenu(this.props.group, event)
  }

  private onToggleCollapsed = () => {
    if (this.props.isClickSuppressed()) {
      return
    }
    this.props.onToggleCollapsed(this.props.group)
  }

  private onDragStart = () => {
    // Otherwise the header keeps its focus ring while being dragged
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    dragAndDropManager.setDragData({
      type: DragType.RepositoryGroup,
      groupKey: getGroupKey(this.props.group),
    })
  }

  private onRenderDragElement = () => {
    this.props.onRenderDragElement(this.props.group)
  }

  /**
   * The enclosing list row treats Enter and Space as "activate the selected
   * repository", cancelling the default action of any button inside it, so
   * header buttons have to keep those key presses to themselves.
   */
  private onButtonKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }

  private onPullAllClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (this.props.isClickSuppressed()) {
      return
    }
    this.props.onPullAll(this.props.group)
  }

  private onDeleteClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!this.props.isClickSuppressed() && this.props.groupName !== null) {
      this.props.onDelete(this.props.groupName)
    }
  }

  private renderPullAllButton() {
    const { isPulling, label } = this.props
    const pullLabel = `Pull all repositories in "${label}"`

    return (
      <Button
        className={classNames('pull-group-button', { pulling: isPulling })}
        onClick={this.onPullAllClick}
        onKeyDown={this.onButtonKeyDown}
        tooltip={pullLabel}
        ariaLabel={pullLabel}
        disabled={isPulling}
      >
        <Octicon
          symbol={isPulling ? syncClockwise : octicons.arrowDown}
          className={isPulling ? 'spin' : undefined}
        />
      </Button>
    )
  }

  private renderDeleteGroupButton(groupName: string) {
    const deleteLabel = `Delete group "${groupName}"`

    return (
      <Button
        className="delete-group-button"
        onClick={this.onDeleteClick}
        onKeyDown={this.onButtonKeyDown}
        tooltip={deleteLabel}
        ariaLabel={deleteLabel}
      >
        <Octicon symbol={octicons.trash} />
      </Button>
    )
  }

  public render() {
    const { label, collapsed, groupName } = this.props

    return (
      <Draggable
        isEnabled={this.props.canDrag}
        onDragStart={this.onDragStart}
        onDragEnd={this.props.onDragEnd}
        onRenderDragElement={this.onRenderDragElement}
        onRemoveDragElement={this.props.onRemoveDragElement}
        dropTargetSelectors={[DropTargetSelector.ListInsertionPoint]}
      >
        <div
          className="repository-group-header"
          onContextMenu={this.onContextMenu}
        >
          <button
            type="button"
            className="repository-group-disclosure"
            aria-expanded={!collapsed}
            onClick={this.onToggleCollapsed}
            onKeyDown={this.onButtonKeyDown}
          >
            <Octicon
              symbol={
                collapsed ? octicons.triangleRight : octicons.triangleDown
              }
            />
            <TooltippedContent
              className="filter-list-group-header"
              tooltip={label}
              onlyWhenOverflowed={true}
              tagName="span"
            >
              {label}
            </TooltippedContent>
          </button>
          {this.renderPullAllButton()}
          {groupName !== null && this.renderDeleteGroupButton(groupName)}
        </div>
      </Draggable>
    )
  }
}

/**
 * Returns the user-given name of a group, or null if the group wasn't named by
 * the user. Pins and recents can contain repositories of other groups so they
 * never count as custom groups.
 */
function getCustomGroupName(group: RepositoryListGroup) {
  return group.kind !== 'pins' && group.kind !== 'recent'
    ? group.displayName
    : null
}

/**
 * Maps the key of every rendered group to the repositories it contains.
 */
function getGroupRepositories(
  groups: ReadonlyArray<
    IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
  >
): ReadonlyMap<string, ReadonlyArray<Repository>> {
  return new Map(
    groups.map(group => {
      const repositories = new Map<number, Repository>()

      for (const { repository } of group.items) {
        if (repository instanceof Repository) {
          repositories.set(repository.id, repository)
        }
      }

      return [getGroupKey(group.identifier), [...repositories.values()]]
    })
  )
}

/** The list of user-added repositories. */
export class RepositoriesList extends React.Component<
  IRepositoriesListProps,
  IRepositoriesListState
> {
  /**
   * A memoized function for grouping repositories for display
   * in the FilterList. The group will not be recomputed as long
   * as the provided list of repositories is equal to the last
   * time the method was called (reference equality).
   */
  private getRepositoryGroups = memoizeOne(
    (
      repositories: ReadonlyArray<Repositoryish> | null,
      localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>,
      recentRepositories: ReadonlyArray<number>
    ) =>
      repositories === null
        ? []
        : groupRepositories(
            repositories,
            localRepositoryStateLookup,
            recentRepositories
          )
  )

  /**
   * A memoized function for finding the selected list item based
   * on an IAPIRepository instance. The selected item will not be
   * recomputed as long as the provided list of repositories and
   * the selected data object is equal to the last time the method
   * was called (reference equality).
   *
   * See findMatchingListItem for more details.
   */
  private getSelectedListItem = memoizeOne(findMatchingListItem)

  private getUnsnoozedRepositories = memoizeOne(
    (
      repositories: ReadonlyArray<Repositoryish>,
      snoozedRepositories: ReadonlyMap<number, number>
    ) =>
      repositories.filter(
        r => !(r instanceof Repository && snoozedRepositories.has(r.id))
      )
  )

  private getOrderedRepositoryGroups = memoizeOne(applyRepositoryGroupOrder)

  /**
   * The keys of the groups that can be reordered, in the order they were
   * rendered the last time the list was rendered.
   */
  private renderedReorderableGroupKeys: ReadonlyArray<string> = []

  /**
   * The boundary between groups that the hovered drop zone belongs to, as of
   * the last time the list was rendered, or `null` if no zone is hovered.
   */
  private renderedGroupDropBoundary: IRepositoryGroupDropTarget | null = null

  /**
   * While a group is being dragged, maps the last row of each expanded group
   * that can be reordered to the group's key, so the row can offer dropping
   * after the group. Keyed by item rather than id since the recent group
   * repeats the ids of other groups.
   */
  private lastItemGroupKeys: ReadonlyMap<IRepositoryListItem, string> =
    new Map()

  /** Whether a group drag has started and not ended yet */
  private isGroupDragInProgress = false

  /** Whether the mouse button holding the current group drag was released */
  private wasGroupDragMouseReleased = false

  /**
   * Whether clicks on group headers must be ignored. Releasing the mouse over
   * a header's buttons after dragging fires a click on them, which must not
   * trigger their action since the user meant to drop rather than click.
   */
  private suppressGroupHeaderClicks = false
  private suppressGroupHeaderClicksTimeoutId: number | null = null

  /**
   * The keys of the groups rendered the last time the list was rendered. Used
   * to know which groups the "collapse all"/"expand all" actions apply to, and
   * to drop stored state for groups that no longer exist.
   */
  private renderedGroupKeys: ReadonlySet<string> = new Set()

  /**
   * The repositories of each group rendered the last time the list was
   * rendered, keyed by group key.
   */
  private renderedGroupRepositories: ReadonlyMap<
    string,
    ReadonlyArray<Repository>
  > = new Map()

  public constructor(props: IRepositoriesListProps) {
    super(props)

    this.state = {
      newRepositoryMenuExpanded: false,
      pullingRepositories: false,
      selectedItem: null,
      pinnedRepositoriesIds: getPinnedRepositories(),
      pullingGroupKeys: new Set<string>(),
      collapsedGroups: getCollapsedRepositoryGroups(),
      groupOrder: getRepositoryGroupOrder(),
      draggedGroup: null,
      hoveredGroupDropZone: null,
      groupOrderMessage: null,
    }
  }

  public componentWillUnmount() {
    this.stopSuppressingGroupHeaderClicks()
  }

  public componentDidUpdate(prevProps: IRepositoriesListProps) {
    // The edit dialog moves the saved position of a renamed group to its new
    // key while this list stays mounted, so pick it up with the renamed repos
    if (prevProps.repositories !== this.props.repositories) {
      const groupOrder = getRepositoryGroupOrder()
      if (!areStringArraysEqual(groupOrder, this.state.groupOrder)) {
        this.setState({ groupOrder })
      }
    }
  }

  private shouldShowBranchName(item: IRepositoryListItem): boolean {
    const { showBranchNameInRepoList } = this.props
    switch (showBranchNameInRepoList) {
      case ShowBranchNameInRepoListSetting.Never:
        return false
      case ShowBranchNameInRepoListSetting.Always:
        return true
      case ShowBranchNameInRepoListSetting.WhenNotDefault:
        return item.branchName !== item.defaultBranchName
      default:
        assertNever(
          showBranchNameInRepoList,
          `Unknown show branch name setting: ${showBranchNameInRepoList}`
        )
    }
  }

  private renderItem = (item: IRepositoryListItem, matches: IMatches) => {
    const repository = item.repository
    return (
      <RepositoryListItem
        key={item.id}
        repository={repository}
        needsDisambiguation={item.needsDisambiguation}
        matches={matches}
        aheadBehind={item.aheadBehind}
        changedFilesCount={item.changedFilesCount}
        showChangedFileCount={this.props.showChangedFileCount}
        branchName={this.shouldShowBranchName(item) ? item.branchName : null}
        worktree={item.worktree}
      />
    )
  }

  private renderItemWithDropZone = (
    item: IRepositoryListItem,
    matches: IMatches
  ) => {
    const groupKey = this.lastItemGroupKeys.get(item)

    return (
      <>
        {this.renderItem(item, matches)}
        {groupKey !== undefined && this.renderGroupDropZone(groupKey, 'after')}
      </>
    )
  }

  private renderGroupDropZone(
    groupKey: string,
    position: RepositoryGroupDropPosition
  ) {
    // Both zones of a boundary show the indicator of the boundary's canonical
    // zone, so it doesn't jump between the two rows sharing the boundary
    const showIndicator = areRepositoryGroupDropTargetsEqual(
      this.renderedGroupDropBoundary,
      { groupKey, position }
    )

    return (
      <RepositoryGroupDropZone
        groupKey={groupKey}
        position={position}
        showIndicator={showIndicator}
        onMouseEnter={this.onGroupDropZoneMouseEnter}
        onMouseLeave={this.onGroupDropZoneMouseLeave}
        onDrop={this.onDropGroup}
      />
    )
  }

  private onGroupDropZoneMouseEnter = (
    groupKey: string,
    position: RepositoryGroupDropPosition
  ) => {
    this.setState({ hoveredGroupDropZone: { groupKey, position } })
  }

  private onGroupDropZoneMouseLeave = (
    groupKey: string,
    position: RepositoryGroupDropPosition
  ) => {
    this.setState(state =>
      areRepositoryGroupDropTargetsEqual(state.hoveredGroupDropZone, {
        groupKey,
        position,
      })
        ? { hoveredGroupDropZone: null }
        : null
    )
  }

  private getAheadBehindTooltip = (aheadBehind: IAheadBehind | null) => {
    if (aheadBehind === null) {
      return null
    }

    const { ahead, behind } = aheadBehind

    if (behind === 0 && ahead === 0) {
      return null
    }

    return (
      'The currently checked out branch is' +
      (behind ? ` ${commitGrammar(behind)} behind ` : '') +
      (behind && ahead ? 'and' : '') +
      (ahead ? ` ${commitGrammar(ahead)} ahead of ` : '') +
      'its tracked branch.'
    )
  }

  private renderRowFocusTooltip = (
    item: IRepositoryListItem
  ): JSX.Element | string | null => {
    const { repository, aheadBehind, changedFilesCount } = item
    const branchName = this.shouldShowBranchName(item) ? item.branchName : null
    const gitHubRepo =
      repository instanceof Repository ? repository.gitHubRepository : null
    const alias = repository instanceof Repository ? repository.alias : null
    const realName = gitHubRepo ? gitHubRepo.fullName : repository.name
    const aheadBehindTooltip = this.getAheadBehindTooltip(aheadBehind)
    const hasChanges = changedFilesCount > 0
    const uncommittedChangesTooltip = hasChanges
      ? `There are uncommitted changes in this repository.`
      : null

    const ahead = aheadBehind?.ahead ?? 0
    const behind = aheadBehind?.behind ?? 0

    return (
      <div className="repository-list-item-tooltip list-item-tooltip">
        <div>
          <div className="label">Full Name: </div>
          {realName}
          {alias && <> ({alias})</>}
        </div>
        <div>
          <div className="label">Path: </div>
          {repository.path}
        </div>
        {branchName && (
          <div>
            <div className="label">Branch: </div>
            {branchName}
          </div>
        )}
        {aheadBehindTooltip && (
          <div>
            <div className="label">
              <div className="ahead-behind">
                {ahead > 0 && <Octicon symbol={octicons.arrowUp} />}
                {behind > 0 && <Octicon symbol={octicons.arrowDown} />}
              </div>
            </div>
            {aheadBehindTooltip}
          </div>
        )}
        {uncommittedChangesTooltip && (
          <div>
            <div className="label">
              <span className="change-indicator-wrapper">
                <Octicon symbol={octicons.dotFill} />
              </span>
            </div>
            {uncommittedChangesTooltip}
          </div>
        )}
      </div>
    )
  }

  private getGroupLabel(group: RepositoryListGroup) {
    const { kind } = group
    const { displayName } = group
    if (kind === 'enterprise') {
      return displayName ?? group.host
    } else if (kind === 'other') {
      return displayName ?? 'Other'
    } else if (kind === 'dotcom') {
      return displayName ?? group.owner.login
    } else if (kind === 'recent') {
      return 'Recent'
    } else if (kind === 'pins') {
      return 'Pinned'
    } else {
      assertNever(kind, `Unknown repository group kind ${kind}`)
    }
  }

  private renderGroupHeader = (group: RepositoryListGroup) => {
    const groupKey = getGroupKey(group)
    const collapsed = this.isGroupCollapsed(group)
    const showDropZones =
      this.state.draggedGroup !== null && isReorderableRepositoryGroup(group)

    return (
      <>
        {showDropZones && this.renderGroupDropZone(groupKey, 'before')}
        {this.renderGroupHeaderContent(group, groupKey)}
        {showDropZones &&
          collapsed &&
          this.renderGroupDropZone(groupKey, 'after')}
      </>
    )
  }

  private renderGroupHeaderContent(
    group: RepositoryListGroup,
    groupKey: string
  ) {
    return (
      <RepositoryGroupHeader
        key={groupKey}
        group={group}
        label={this.getGroupLabel(group)}
        collapsed={this.isGroupCollapsed(group)}
        groupName={getCustomGroupName(group)}
        isPulling={this.state.pullingGroupKeys.has(groupKey)}
        onToggleCollapsed={this.onToggleGroupCollapsed}
        onPullAll={this.onPullAllInGroup}
        onDelete={this.onDeleteGroup}
        onContextMenu={this.onGroupHeaderContextMenu}
        canDrag={
          isReorderableRepositoryGroup(group) &&
          this.props.filterText.length === 0
        }
        onRenderDragElement={this.onRenderGroupDragElement}
        onRemoveDragElement={this.onRemoveGroupDragElement}
        onDragEnd={this.onGroupDragEnd}
        isClickSuppressed={this.isGroupHeaderClickSuppressed}
      />
    )
  }

  private onRenderGroupDragElement = (group: RepositoryListGroup) => {
    this.stopSuppressingGroupHeaderClicks()
    this.isGroupDragInProgress = true
    this.wasGroupDragMouseReleased = false
    document.addEventListener('mouseup', this.onGroupDragMouseUp, true)
    document.addEventListener('mousedown', this.onGroupDragMouseDown, true)

    this.setState({
      draggedGroup: {
        key: getGroupKey(group),
        label: this.getGroupLabel(group),
      },
    })
  }

  private onRemoveGroupDragElement = () => {
    const { draggedGroup } = this.state
    // Draggable also calls this when a slow click on a header ends without
    // ever starting a drag
    if (draggedGroup === null) {
      return
    }

    this.setState({ draggedGroup: null, hoveredGroupDropZone: null })
  }

  private onGroupDragEnd = () => {
    if (!this.isGroupDragInProgress) {
      return
    }

    this.isGroupDragInProgress = false
    this.suppressGroupHeaderClicks = true

    // A drag cancelled with Escape ends while the button is still held, and
    // its click only comes after the button is released
    if (this.wasGroupDragMouseReleased) {
      this.stopSuppressingGroupHeaderClicksSoon()
    }
  }

  private onGroupDragMouseUp = () => {
    this.wasGroupDragMouseReleased = true
    if (!this.isGroupDragInProgress) {
      this.stopSuppressingGroupHeaderClicksSoon()
    }
  }

  /**
   * A new press means the button held during a cancelled drag was released
   * outside of the window, so the click it starts is a real one
   */
  private onGroupDragMouseDown = () => {
    if (!this.isGroupDragInProgress) {
      this.stopSuppressingGroupHeaderClicks()
    }
  }

  private isGroupHeaderClickSuppressed = () => this.suppressGroupHeaderClicks

  private stopSuppressingGroupHeaderClicksSoon() {
    this.removeGroupDragMouseListeners()
    this.clearSuppressGroupHeaderClicksTimeout()
    // The click that follows a mouseup is dispatched before any timer runs
    this.suppressGroupHeaderClicksTimeoutId = window.setTimeout(() => {
      this.suppressGroupHeaderClicks = false
      this.suppressGroupHeaderClicksTimeoutId = null
    }, 0)
  }

  private stopSuppressingGroupHeaderClicks() {
    this.removeGroupDragMouseListeners()
    this.clearSuppressGroupHeaderClicksTimeout()
    this.suppressGroupHeaderClicks = false
  }

  private clearSuppressGroupHeaderClicksTimeout() {
    if (this.suppressGroupHeaderClicksTimeoutId !== null) {
      window.clearTimeout(this.suppressGroupHeaderClicksTimeoutId)
      this.suppressGroupHeaderClicksTimeoutId = null
    }
  }

  private removeGroupDragMouseListeners() {
    document.removeEventListener('mouseup', this.onGroupDragMouseUp, true)
    document.removeEventListener('mousedown', this.onGroupDragMouseDown, true)
  }

  private renderGroupDragElement() {
    const { draggedGroup } = this.state
    if (draggedGroup === null) {
      return null
    }

    const dragElementHost = document.getElementById('dragElement')
    if (dragElementHost === null) {
      return null
    }

    return ReactDOM.createPortal(
      <div id="repository-group-drag-element">
        <Octicon symbol={octicons.fileDirectory} />
        <span className="label">{draggedGroup.label}</span>
      </div>,
      dragElementHost
    )
  }

  private onDropGroup = (
    targetGroupKey: string,
    position: RepositoryGroupDropPosition
  ) => {
    const { dragData } = dragAndDropManager
    if (dragData === null || dragData.type !== DragType.RepositoryGroup) {
      return
    }

    this.moveGroup(dragData.groupKey, targetGroupKey, position)
  }

  private moveGroup(
    groupKey: string,
    targetGroupKey: string,
    position: RepositoryGroupDropPosition
  ): ReadonlyArray<string> | null {
    const savedOrder = getRepositoryGroupOrder()
    const groupOrder = moveRepositoryGroupInOrder(
      savedOrder,
      this.renderedReorderableGroupKeys,
      groupKey,
      targetGroupKey,
      position
    )

    if (groupOrder === savedOrder) {
      return null
    }

    setRepositoryGroupOrder(groupOrder)
    this.setState({ groupOrder })
    return groupOrder
  }

  /** Moves the group one position up (-1) or down (+1) in the list */
  private moveGroupBy(group: RepositoryListGroup, offset: -1 | 1) {
    const keys = this.renderedReorderableGroupKeys
    const groupKey = getGroupKey(group)
    const index = keys.indexOf(groupKey)
    const targetGroupKey = index < 0 ? undefined : keys[index + offset]

    if (targetGroupKey === undefined) {
      return
    }

    const groupOrder = this.moveGroup(
      groupKey,
      targetGroupKey,
      offset < 0 ? 'before' : 'after'
    )

    if (groupOrder !== null) {
      const displayedKeys = new Set(keys)
      const newIndex = groupOrder
        .filter(key => displayedKeys.has(key))
        .indexOf(groupKey)
      const label = this.getGroupLabel(group)
      const position = `${newIndex + 1} of ${keys.length}`
      this.setState({
        groupOrderMessage: `Moved group "${label}" to position ${position}`,
      })
    }
  }

  private onResetGroupOrder = () => {
    resetRepositoryGroupOrder()
    this.setState({ groupOrder: [] })
  }

  /** The repositories that "Pull all" in the given group applies to. */
  private getPullableGroupRepositories(
    group: RepositoryListGroup
  ): ReadonlyArray<Repository> {
    return this.renderedGroupRepositories.get(getGroupKey(group)) ?? []
  }

  // Filtering force-expands every group
  private isGroupCollapsed = (group: RepositoryListGroup) =>
    this.props.filterText.length === 0 &&
    this.state.collapsedGroups.has(getGroupKey(group))

  private canToggleCollapsedGroups = () => this.props.filterText.length === 0

  private setGroupsCollapsed(groupKeys: Iterable<string>, collapsed: boolean) {
    this.setState({
      collapsedGroups: setRepositoryGroupsCollapsed(
        groupKeys,
        collapsed,
        this.renderedGroupKeys
      ),
    })
  }

  private onToggleGroupCollapsed = (group: RepositoryListGroup) => {
    if (!this.canToggleCollapsedGroups()) {
      return
    }

    this.setGroupsCollapsed([getGroupKey(group)], !this.isGroupCollapsed(group))
  }

  private onCollapseAllGroups = () => {
    this.setGroupsCollapsed(this.renderedGroupKeys, true)
  }

  private onExpandAllGroups = () => {
    this.setGroupsCollapsed(this.renderedGroupKeys, false)
  }

  private onGroupHeaderContextMenu = (
    group: RepositoryListGroup,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const collapsed = this.isGroupCollapsed(group)
    const canToggle = this.canToggleCollapsedGroups()
    const { collapsedGroups } = this.state
    const label = this.getGroupLabel(group)
    const items: ReadonlyArray<IMenuItem> = [
      {
        label: collapsed
          ? __DARWIN__
            ? 'Expand Group'
            : 'Expand group'
          : __DARWIN__
          ? 'Collapse Group'
          : 'Collapse group',
        action: () => this.onToggleGroupCollapsed(group),
        enabled: canToggle,
      },
      {
        label: __DARWIN__ ? 'Collapse All Groups' : 'Collapse all groups',
        action: this.onCollapseAllGroups,
        enabled:
          canToggle &&
          [...this.renderedGroupKeys].some(key => !collapsedGroups.has(key)),
      },
      {
        label: __DARWIN__ ? 'Expand All Groups' : 'Expand all groups',
        action: this.onExpandAllGroups,
        enabled:
          canToggle &&
          [...this.renderedGroupKeys].some(key => collapsedGroups.has(key)),
      },
      ...this.getGroupOrderMenuItems(group),
      { type: 'separator' },
      {
        label: __DARWIN__
          ? `Pull All Repositories in "${label}"`
          : `Pull all repositories in "${label}"`,
        action: () => this.onPullAllInGroup(group),
      },
    ]

    // Pins and recents aren't real groups, so they can't be turned into one
    const isCustomizable = group.kind !== 'pins' && group.kind !== 'recent'
    const editItems: ReadonlyArray<IMenuItem> = isCustomizable
      ? [
          { type: 'separator' },
          {
            label: __DARWIN__ ? 'Edit Group' : 'Edit group',
            action: () => this.onEditGroup(group),
          },
        ]
      : []

    const groupName = getCustomGroupName(group)
    const deleteItems: ReadonlyArray<IMenuItem> =
      groupName === null
        ? []
        : [
            {
              label: __DARWIN__
                ? `Delete Group "${groupName}"`
                : `Delete group "${groupName}"`,
              action: () => this.onDeleteGroup(groupName),
            },
          ]

    showContextualMenu([...items, ...editItems, ...deleteItems])
  }

  private getGroupOrderMenuItems(
    group: RepositoryListGroup
  ): ReadonlyArray<IMenuItem> {
    const keys = this.renderedReorderableGroupKeys
    const index = keys.indexOf(getGroupKey(group))
    // Consistent with dragging, which filtering disables
    const canMove = this.props.filterText.length === 0
    const moveItems: ReadonlyArray<IMenuItem> = isReorderableRepositoryGroup(
      group
    )
      ? [
          {
            label: __DARWIN__ ? 'Move Group Up' : 'Move group up',
            action: () => this.moveGroupBy(group, -1),
            enabled: canMove && index > 0,
          },
          {
            label: __DARWIN__ ? 'Move Group Down' : 'Move group down',
            action: () => this.moveGroupBy(group, 1),
            enabled: canMove && index >= 0 && index < keys.length - 1,
          },
        ]
      : []

    return [
      { type: 'separator' },
      ...moveItems,
      {
        label: __DARWIN__ ? 'Reset Group Order' : 'Reset group order',
        action: this.onResetGroupOrder,
        enabled: this.state.groupOrder.length > 0,
      },
    ]
  }

  private onEditGroup = (group: RepositoryListGroup) => {
    const repositories = this.props.repositories.filter(
      (r): r is Repository => r instanceof Repository
    )

    const groupKey = getGroupKey(group)
    const preselectedRepositoryIds = repositories
      .filter(r => getGroupKey(getGroupForRepository(r)) === groupKey)
      .map(r => r.id)

    this.props.dispatcher.showPopup({
      type: PopupType.CreateRepositoryGroup,
      repositories,
      preselectedRepositoryIds,
      // Editing an automatic group creates a new custom group out of it
      editedGroupName: getCustomGroupName(group) ?? undefined,
    })
  }

  private onDeleteGroup = (groupName: string) => {
    const repositories = this.props.repositories.filter(
      (r): r is Repository =>
        r instanceof Repository && r.groupName === groupName
    )

    this.props.dispatcher.showPopup({
      type: PopupType.DeleteRepositoryGroup,
      groupName,
      repositories,
    })
  }

  private onPullAllInGroup = async (group: RepositoryListGroup) => {
    const repositories = this.getPullableGroupRepositories(group)

    if (repositories.length === 0) {
      return
    }

    const groupKey = getGroupKey(group)

    this.setState(({ pullingGroupKeys }) => ({
      pullingGroupKeys: new Set(pullingGroupKeys).add(groupKey),
    }))

    await this.props.dispatcher.pullRepositories(repositories)

    this.setState(({ pullingGroupKeys }) => {
      const remaining = new Set(pullingGroupKeys)
      remaining.delete(groupKey)
      return { pullingGroupKeys: remaining }
    })
  }

  private onAssignRepositoryGroupName = (
    repository: Repository,
    groupName: string
  ) => {
    this.props.dispatcher.changeRepositoryGroupName(repository, groupName)
  }

  private onItemClick = (item: IRepositoryListItem) => {
    const hasIndicator =
      item.changedFilesCount > 0 ||
      (item.aheadBehind !== null
        ? item.aheadBehind.ahead > 0 || item.aheadBehind.behind > 0
        : false)
    this.props.dispatcher.recordRepoClicked(hasIndicator)

    // Each row maps to a specific worktree. Clicking a row switches to
    // its worktree, unless the row is already the checked-out one.
    // Switching worktrees already selects the corresponding repository
    if (
      item.worktree !== null &&
      item.repository instanceof Repository &&
      normalizePath(item.worktree.path) !== normalizePath(item.repository.path)
    ) {
      this.props.dispatcher.closeFoldout(FoldoutType.Repository)
      this.props.dispatcher.switchWorktree(item.repository, item.worktree)
      return
    }

    this.props.onSelectionChanged(item.repository)
  }

  private onItemContextMenu = (
    item: IRepositoryListItem,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    if (
      item.worktree !== null &&
      item.worktree.type === 'linked' &&
      item.repository instanceof Repository
    ) {
      showContextualMenu(
        generateWorktreeListItemContextMenu({
          repository: item.repository,
          worktree: item.worktree,
          shellLabel: this.props.shellLabel,
          externalEditorLabel: this.getExternalEditorLabel(item.repository),
          onCreateWorktree: this.onCreateWorktree,
          onRenameWorktree: this.onRenameWorktree,
          onDeleteWorktree: this.onDeleteWorktree,
          onViewOnGitHub: this.props.onViewOnGitHub,
          onOpenWorktreeInNewWindow: this.onOpenWorktreeInNewWindow,
          onOpenInShell: this.props.onOpenInShell,
          onShowRepository: this.props.onShowRepository,
          onOpenInExternalEditor: this.props.onOpenInExternalEditor,
          onCopyWorktreePath: path =>
            this.props.dispatcher.copyPathToClipboard(path),
        })
      )
      return
    }

    const isPinned =
      item.repository instanceof Repository &&
      this.state.pinnedRepositoriesIds.includes(item.repository.id)

    const items = generateRepositoryListContextMenu({
      worktreePath: item.worktree?.path,
      onRemoveRepository: this.props.onRemoveRepository,
      onSnoozeRepository: this.onSnoozeRepository,
      onShowRepository: this.props.onShowRepository,
      onOpenInNewWindow: this.props.onOpenInNewWindow,
      onOpenInShell: this.props.onOpenInShell,
      onOpenInExternalEditor: this.props.onOpenInExternalEditor,
      askForConfirmationOnRemoveRepository:
        this.props.askForConfirmationOnRemoveRepository,
      accounts: this.props.accounts,
      onChangeRepositoryAccount: this.props.onChangeRepositoryAccount,
      onShowRepositorySettings: this.props.onShowRepositorySettings,
      externalEditorLabel: this.getExternalEditorLabel(item.repository),
      onChangeRepositoryAlias: this.onChangeRepositoryAlias,
      onRemoveRepositoryAlias: this.onRemoveRepositoryAlias,
      onNewGroupForRepository: this.onNewGroupForRepository,
      onRemoveRepositoryGroupName: this.onRemoveRepositoryGroupName,
      groupNames: getKnownGroupNames(this.props.repositories),
      onAssignRepositoryGroupName: this.onAssignRepositoryGroupName,
      onViewOnGitHub: this.props.onViewOnGitHub,
      onCreateWorktree: enableWorktreeSupport()
        ? this.onCreateWorktree
        : undefined,
      onShowWorktrees:
        enableWorktreeSupport() && this.props.showWorktrees
          ? this.onShowWorktrees
          : undefined,
      repository: item.repository,
      shellLabel: this.props.shellLabel,
      onCopyRepoPath: path => this.props.dispatcher.copyPathToClipboard(path),
      isPinned,
      onTogglePinnedRepository:
        item.repository instanceof Repository
          ? this.onTogglePinnedRepository
          : undefined,
    })

    showContextualMenu(items)
  }

  private getItemAriaLabel = (item: IRepositoryListItem) => item.repository.name
  private getGroupAriaLabelGetter =
    (
      groups: ReadonlyArray<
        IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
      >
    ) =>
    (group: number) =>
      this.getGroupLabel(groups[group].identifier)

  public render() {
    const repositories = this.getUnsnoozedRepositories(
      this.props.repositories,
      this.props.snoozedRepositories
    )
    const snoozedCount = this.props.repositories.length - repositories.length
    let groups = this.getRepositoryGroups(
      repositories,
      this.props.localRepositoryStateLookup,
      this.props.recentRepositories
    )
    groups = this.getOrderedRepositoryGroups(groups, this.state.groupOrder)

    const { pinnedRepositoriesIds } = this.state
    if (pinnedRepositoriesIds.length > 0) {
      const pinsGroup = buildPinnedGroup(pinnedRepositoriesIds, groups)
      if (pinsGroup !== null) {
        groups = [
          pinsGroup,
          ...filterPinnedFromGroups(pinnedRepositoriesIds, groups),
        ]
      }
    }

    this.renderedGroupRepositories = getGroupRepositories(groups)

    // So there's two types of selection at play here. There's the repository
    // selection for the whole app and then there's the keyboard selection in
    // the list itself. If the user has selected a repository using keyboard
    // navigation we want to honor that selection. If the user hasn't selected a
    // repository yet we'll select the repository currently selected in the app.
    const selectedItem =
      this.state.selectedItem ??
      this.getSelectedListItem(groups, this.props.selectedRepository)

    this.renderedGroupKeys = new Set(groups.map(g => getGroupKey(g.identifier)))
    this.renderedReorderableGroupKeys = groups
      .filter(g => isReorderableRepositoryGroup(g.identifier))
      .map(g => getGroupKey(g.identifier))
    const { hoveredGroupDropZone } = this.state
    this.renderedGroupDropBoundary =
      hoveredGroupDropZone === null
        ? null
        : getRepositoryGroupDropBoundary(
            this.renderedReorderableGroupKeys,
            hoveredGroupDropZone
          )
    this.lastItemGroupKeys = this.getLastItemGroupKeys(groups)

    return (
      <div className="repository-list">
        <SectionFilterList<IRepositoryListItem, RepositoryListGroup>
          rowHeight={RowHeight}
          selectedItem={selectedItem}
          filterText={this.props.filterText}
          onFilterTextChanged={this.props.onFilterTextChanged}
          renderItem={this.renderItemWithDropZone}
          renderRowFocusTooltip={this.renderRowFocusTooltip}
          renderGroupHeader={this.renderGroupHeader}
          isGroupCollapsed={this.isGroupCollapsed}
          onItemClick={this.onItemClick}
          renderPostFilter={this.renderPostFilter}
          renderNoItems={this.renderNoItems}
          groups={groups}
          invalidationProps={{
            repositories: this.props.repositories,
            snoozedRepositories: this.props.snoozedRepositories,
            filterText: this.props.filterText,
            localRepositoryStateLookup: this.props.localRepositoryStateLookup,
            showWorktreesInRepoList: this.props.showWorktreesInRepoList,
            showChangedFileCount: this.props.showChangedFileCount,
            collapsedGroups: this.state.collapsedGroups,
            groupOrder: this.state.groupOrder,
            draggedGroup: this.state.draggedGroup,
            hoveredGroupDropZone: this.state.hoveredGroupDropZone,
          }}
          onItemContextMenu={this.onItemContextMenu}
          getGroupAriaLabel={this.getGroupAriaLabelGetter(groups)}
          getItemAriaLabel={this.getItemAriaLabel}
          onSelectionChanged={this.onSelectionChanged}
          postProcessMatches={this.postProcessMatches(
            groups,
            this.props.filterText
          )}
        />
        {this.renderSnoozedRepositoriesButton(snoozedCount)}
        {this.renderGroupDragElement()}
        <AriaLiveContainer message={this.state.groupOrderMessage} />
      </div>
    )
  }

  private renderSnoozedRepositoriesButton(count: number) {
    if (count === 0) {
      return null
    }

    const label = __DARWIN__
      ? `Snoozed Repositories (${count})`
      : `Snoozed repositories (${count})`

    return (
      <button
        type="button"
        className="snoozed-repositories-button"
        onClick={this.onSnoozedRepositoriesButtonClick}
      >
        <Octicon symbol={octicons.clock} />
        <span className="label">{label}</span>
      </button>
    )
  }

  private onSnoozedRepositoriesButtonClick = () => {
    this.props.dispatcher.showPopup({ type: PopupType.SnoozedRepositories })
  }

  private getLastItemGroupKeys(
    groups: ReadonlyArray<
      IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
    >
  ): ReadonlyMap<IRepositoryListItem, string> {
    const lastItemGroupKeys = new Map<IRepositoryListItem, string>()
    if (this.state.draggedGroup === null) {
      return lastItemGroupKeys
    }

    for (const { identifier, items } of groups) {
      const lastItem = items.at(-1)
      if (
        lastItem !== undefined &&
        isReorderableRepositoryGroup(identifier) &&
        !this.isGroupCollapsed(identifier)
      ) {
        lastItemGroupKeys.set(lastItem, getGroupKey(identifier))
      }
    }

    return lastItemGroupKeys
  }

  private getExternalEditorLabel(
    repository: Repositoryish
  ): string | undefined {
    if (repository instanceof Repository && repository.customEditorOverride) {
      return getEditorOverrideLabel(repository.customEditorOverride)
    }
    return this.props.externalEditorLabel
  }

  private onSelectionChanged = (selectedItem: IRepositoryListItem | null) => {
    this.setState({ selectedItem })
  }

  private postProcessMatches(
    groups: ReadonlyArray<
      IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
    >,
    filterText: string
  ) {
    if (!this.props.showWorktreesInRepoList || !filterText) {
      return (items: ReadonlyArray<IMatch<IRepositoryListItem>>) => items
    }

    return (
      items: ReadonlyArray<IMatch<IRepositoryListItem>>
    ): ReadonlyArray<IMatch<IRepositoryListItem>> => {
      const isLinkedWorktree = (item: IRepositoryListItem) =>
        item.worktree !== null && item.worktree.type === 'linked'

      // A query that matches a linked worktree should always show the main worktree row first, even
      // if the main worktree row doesn't match the query. Construct a lookup so we can inject synthetic matches
      const mainWorktreeRowsLookup = new Map<number, IRepositoryListItem>()
      for (const group of groups) {
        for (const listItem of group.items) {
          if (!isLinkedWorktree(listItem)) {
            mainWorktreeRowsLookup.set(listItem.repository.id, listItem)
          }
        }
      }

      const output: IMatch<IRepositoryListItem>[] = []
      const remaining = [...items]

      while (remaining.length > 0) {
        const match = remaining.shift()!
        const repoId = match.item.repository.id

        // Collect this match plus every remaining match for the same
        // repository, preserving relative order.
        const repoMatches = [match]
        for (let i = 0; i < remaining.length; ) {
          if (remaining[i].item.repository.id === repoId) {
            repoMatches.push(...remaining.splice(i, 1))
          } else {
            i++
          }
        }

        // Main worktree row first, creating a synthetic match if necessary
        const mainMatch = repoMatches.find(m => !isLinkedWorktree(m.item))
        if (mainMatch) {
          output.push(mainMatch)
        } else {
          const mainRow = mainWorktreeRowsLookup.get(repoId)
          if (mainRow) {
            output.push({
              item: mainRow,
              score: match.score,
              matches: { title: [], subtitle: [] },
            })
          }
        }

        // Then the linked worktree rows, in their original order
        for (const m of repoMatches) {
          if (isLinkedWorktree(m.item)) {
            output.push(m)
          }
        }
      }

      return output
    }
  }

  private renderPostFilter = () => {
    return (
      <>
        {this.renderPullAllRepositoriesButton()}
        {this.renderAddRepositoryButton()}
      </>
    )
  }

  private renderAddRepositoryButton() {
    return (
      <Button
        className="new-repository-button button-with-icon"
        onClick={this.onNewRepositoryButtonClick}
        ariaExpanded={this.state.newRepositoryMenuExpanded}
        onKeyDown={this.onNewRepositoryButtonKeyDown}
      >
        Add
        <Octicon symbol={octicons.triangleDown} />
      </Button>
    )
  }

  private renderPullAllRepositoriesButton() {
    return this.state.pullingRepositories ? (
      <Button
        className="repo-list-button pull-repositories-spin button-with-icon"
        disabled={true}
      >
        <Octicon symbol={syncClockwise} className="spin" />
        Pulling…
      </Button>
    ) : (
      <Button
        className="repo-list-button pull-repositories button-with-icon"
        onClick={this.onPullRepositoriesButtonClick}
      >
        <Octicon symbol={octicons.arrowDown} />
        {__DARWIN__ ? 'Pull All' : 'Pull all'}
      </Button>
    )
  }

  private onNewRepositoryButtonKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>
  ) => {
    if (event.key === 'ArrowDown') {
      this.onNewRepositoryButtonClick()
    }
  }

  private renderNoItems = () => {
    return (
      <div className="no-items no-results-found">
        <img src={BlankSlateImage} className="blankslate-image" alt="" />
        <div className="title">Sorry, I can't find that repository</div>

        <div className="protip">
          ProTip! Press{' '}
          <div className="kbd-shortcut">
            <KeyboardShortcut darwinKeys={['⌘', 'O']} keys={['Ctrl', 'O']} />
          </div>{' '}
          to quickly add a local repository, and{' '}
          <div className="kbd-shortcut">
            <KeyboardShortcut
              darwinKeys={['⇧', '⌘', 'O']}
              keys={['Ctrl', 'Shift', 'O']}
            />
          </div>{' '}
          to clone from anywhere within the app
        </div>
      </div>
    )
  }

  private onNewRepositoryButtonClick = () => {
    const items: IMenuItem[] = [
      {
        label: __DARWIN__ ? 'Clone Repository…' : 'Clone repository…',
        action: this.onCloneRepository,
      },
      {
        label: __DARWIN__ ? 'Create New Repository…' : 'Create new repository…',
        action: this.onCreateNewRepository,
      },
      {
        label: __DARWIN__
          ? 'Add Existing Repository…'
          : 'Add existing repository…',
        action: this.onAddExistingRepository,
      },
      { type: 'separator' },
      {
        label: __DARWIN__ ? 'New Group…' : 'New group…',
        action: this.onNewGroup,
      },
    ]

    this.setState({ newRepositoryMenuExpanded: true })
    showContextualMenu(items).then(() => {
      this.setState({ newRepositoryMenuExpanded: false })
    })
  }

  private onPullRepositoriesButtonClick = async () => {
    this.setState({ pullingRepositories: true })
    await this.props.dispatcher.pullAllRepositories()
    this.setState({ pullingRepositories: false })
  }

  private onCloneRepository = () => {
    this.props.dispatcher.showPopup({
      type: PopupType.CloneRepository,
      initialURL: null,
    })
  }

  private onAddExistingRepository = () => {
    this.props.dispatcher.showPopup({ type: PopupType.AddRepository })
  }

  private onNewGroup = () => {
    const repositories = this.props.repositories.filter(
      (r): r is Repository => r instanceof Repository
    )

    this.props.dispatcher.showPopup({
      type: PopupType.CreateRepositoryGroup,
      repositories,
    })
  }

  private onCreateNewRepository = () => {
    this.props.dispatcher.showPopup({ type: PopupType.CreateRepository })
  }

  private onChangeRepositoryAlias = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.ChangeRepositoryAlias,
      repository,
    })
  }

  private onRemoveRepositoryAlias = (repository: Repository) => {
    this.props.dispatcher.changeRepositoryAlias(repository, null)
  }

  private onSnoozeRepository = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.SnoozeRepository,
      repository,
    })
  }

  private onCreateWorktree = (repository: Repository) => {
    this.props.dispatcher.showPopup({
      type: PopupType.AddWorktree,
      repository,
    })
  }

  private onShowWorktrees = (repository: Repository) => {
    this.props.dispatcher.selectRepository(repository)
    this.props.dispatcher.showWorktreesFoldout()
  }

  private onRenameWorktree = (repository: Repository, worktreePath: string) => {
    this.props.dispatcher.showPopup({
      type: PopupType.RenameWorktree,
      repository,
      worktreePath,
    })
  }

  private onDeleteWorktree = (repository: Repository, worktreePath: string) => {
    this.props.dispatcher.requestDeleteWorktree(repository, worktreePath)
  }

  private onOpenWorktreeInNewWindow = (worktreePath: string) => {
    openRepositoryInNewWindow(worktreePath)
  }

  private onNewGroupForRepository = (repository: Repository) => {
    const repositories = this.props.repositories.filter(
      (r): r is Repository => r instanceof Repository
    )

    this.props.dispatcher.showPopup({
      type: PopupType.CreateRepositoryGroup,
      repositories,
      preselectedRepositoryIds: [repository.id],
    })
  }

  private onRemoveRepositoryGroupName = (repository: Repository) => {
    this.props.dispatcher.changeRepositoryGroupName(repository, null)
  }

  private onTogglePinnedRepository = (repository: Repository) => {
    if (this.state.pinnedRepositoriesIds.includes(repository.id)) {
      removePinnedRepository(repository)
    } else {
      addPinnedRepository(repository)
    }
    this.setState({ pinnedRepositoriesIds: getPinnedRepositories() })
  }
}

/** Collects the sorted, de-duplicated custom group names currently in use */
export function getKnownGroupNames(
  repositories: ReadonlyArray<Repositoryish>
): ReadonlyArray<string> {
  const groupNames = new Set<string>()

  for (const repository of repositories) {
    if (repository instanceof Repository && repository.groupName !== null) {
      groupNames.add(repository.groupName)
    }
  }

  return [...groupNames.values()].sort((x, y) =>
    x.toLowerCase().localeCompare(y.toLowerCase())
  )
}

function areStringArraysEqual(
  x: ReadonlyArray<string>,
  y: ReadonlyArray<string>
) {
  return x.length === y.length && x.every((value, i) => value === y[i])
}
