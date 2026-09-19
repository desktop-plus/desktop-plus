import * as Path from 'path'
import {
  Repository,
  ILocalRepositoryState,
  nameOf,
  isRepositoryWithGitHubRepository,
  RepositoryWithGitHubRepository,
} from '../../models/repository'
import { CloningRepository } from '../../models/cloning-repository'
import { getHTMLURL } from '../../lib/api'
import { caseInsensitiveCompare, compare } from '../../lib/compare'
import { IFilterListGroup, IFilterListItem } from '../lib/filter-list'
import { IAheadBehind } from '../../models/branch'
import { WorktreeEntry } from '../../models/worktree'
import { SubmoduleEntry } from '../../models/submodule'
import { assertNever } from '../../lib/fatal-error'
import { isGHE, isGHES } from '../../lib/endpoint-capabilities'
import { Owner } from '../../models/owner'
import { normalizePath } from '../../lib/helpers/path'

export type RepositoryListGroup = (
  | {
      kind: 'recent' | 'other' | 'pins'
    }
  | {
      kind: 'dotcom'
      owner: Owner
      login: string | null
    }
  | {
      kind: 'enterprise'
      host: string
    }
) & { displayName: string | null }

/**
 * Returns a unique grouping key (string) for a repository group. Doubles as a
 * case sensitive sorting key (i.e the case sensitive sort order of the keys is
 * the order in which the groups will be displayed in the repository list).
 */
export const getGroupKey = (group: RepositoryListGroup) => {
  const { kind, displayName } = group
  switch (kind) {
    case 'pins':
      return `-1:pins`
    case 'recent':
      return `0:recent`
    case 'dotcom':
      return displayName
        ? `1:${displayName}`
        : `1:${group.owner.login}:${group.login ?? group.owner.login}`
    case 'enterprise':
      // Allow mixing together dotcom and enterprise repos when setting a group name manually
      return displayName ? `1:${displayName}` : `2:${group.host}`
    case 'other':
      return displayName ? `1:${displayName}` : `3:other`
    default:
      assertNever(group, `Unknown repository group kind ${kind}`)
  }
}
export type Repositoryish = Repository | CloningRepository

export interface IRepositoryListItem extends IFilterListItem {
  readonly text: ReadonlyArray<string>
  readonly id: string
  readonly repository: Repositoryish
  readonly needsDisambiguation: boolean
  readonly aheadBehind: IAheadBehind | null
  readonly changedFilesCount: number
  readonly branchName: string | null
  readonly defaultBranchName: string | null
  /**
   * The worktree this row represents, when worktrees are shown in the list.
   *
   * The repository row carries the main worktree (so clicking it switches to
   * the main worktree); linked worktrees each get their own row nested below
   * it. `null` when worktree info isn't available (feature disabled or not yet
   * loaded), in which case the row is a plain repository row.
   */
  readonly worktree: WorktreeEntry | null

  readonly submodule: SubmoduleEntry | null
  readonly submoduleDepth: number
  readonly linkedRepository: Repository | null
  readonly hasChildren: boolean
  readonly parentExpandableRowId: string | null
}

const recentRepositoriesThreshold = 7

const getHostForRepository = (repo: RepositoryWithGitHubRepository) =>
  new URL(getHTMLURL(repo.gitHubRepository.endpoint)).host

export const getGroupForRepository = (
  repo: Repositoryish
): RepositoryListGroup => {
  if (repo instanceof Repository && isRepositoryWithGitHubRepository(repo)) {
    return isGHE(repo.gitHubRepository.endpoint) ||
      isGHES(repo.gitHubRepository.endpoint)
      ? {
          kind: 'enterprise',
          host: getHostForRepository(repo),
          displayName: repo.groupName,
        }
      : {
          kind: 'dotcom',
          owner: repo.gitHubRepository.owner,
          displayName: repo.groupName,
          login: repo.gitHubRepository.login,
        }
  }
  if (repo instanceof Repository) {
    return { kind: 'other', displayName: repo.groupName }
  }
  return { kind: 'other', displayName: null }
}

type RepoGroupItem = { group: RepositoryListGroup; repos: Repositoryish[] }

function findRepositoryAtPath(
  repositories: ReadonlyArray<Repositoryish>,
  path: string
): Repository | null {
  const normalized = normalizePath(path)
  return (
    repositories.find(
      (r): r is Repository =>
        r instanceof Repository && normalizePath(r.path) === normalized
    ) ?? null
  )
}

function getNestedRepositoryIds(
  repositories: ReadonlyArray<Repositoryish>,
  localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>,
  showSubmodulesInRepoList: boolean
): ReadonlySet<number> {
  const nestedIds = new Set<number>()

  if (!showSubmodulesInRepoList) {
    return nestedIds
  }

  for (const repo of repositories) {
    if (!(repo instanceof Repository)) {
      continue
    }

    for (const submodule of localRepositoryStateLookup.get(repo.id)
      ?.submodules ?? []) {
      const linkedRepository = findRepositoryAtPath(
        repositories,
        Path.join(repo.path, submodule.path)
      )
      if (linkedRepository !== null) {
        nestedIds.add(linkedRepository.id)
      }
    }
  }

  return nestedIds
}

export function groupRepositories(
  repositories: ReadonlyArray<Repositoryish>,
  localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>,
  recentRepositories: ReadonlyArray<number>,
  showSubmodulesInRepoList: boolean
): ReadonlyArray<IFilterListGroup<IRepositoryListItem, RepositoryListGroup>> {
  const nestedRepositoryIds = getNestedRepositoryIds(
    repositories,
    localRepositoryStateLookup,
    showSubmodulesInRepoList
  )
  const topLevelRepositories = repositories.filter(
    r => !nestedRepositoryIds.has(r.id)
  )

  const includeRecentGroup =
    topLevelRepositories.length > recentRepositoriesThreshold
  const recentSet = includeRecentGroup ? new Set(recentRepositories) : undefined
  const groups = new Map<string, RepoGroupItem>()

  const addToGroup = (group: RepositoryListGroup, repo: Repositoryish) => {
    const key = getGroupKey(group)
    let rg = groups.get(key)
    if (!rg) {
      rg = { group, repos: [] }
      groups.set(key, rg)
    }

    rg.repos.push(repo)
  }

  for (const repo of topLevelRepositories) {
    if (recentSet?.has(repo.id) && repo instanceof Repository) {
      addToGroup({ kind: 'recent', displayName: repo.groupName }, repo)
    }

    addToGroup(getGroupForRepository(repo), repo)
  }

  return Array.from(groups)
    .sort(([xKey], [yKey]) => compare(xKey.toLowerCase(), yKey.toLowerCase()))
    .map(([, { group, repos }]) => ({
      identifier: group,
      items: toSortedListItems(
        group,
        repos,
        localRepositoryStateLookup,
        groups,
        repositories,
        showSubmodulesInRepoList
      ),
    }))
}

// Returns the display title for a repository, which is either the alias
// (if available) or the name.
const getDisplayTitle = (r: Repositoryish) =>
  r instanceof Repository && r.alias != null ? r.alias : r.name

const toSortedListItems = (
  group: RepositoryListGroup,
  repositories: ReadonlyArray<Repositoryish>,
  localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>,
  groups: Map<string, RepoGroupItem>,
  allRepositories: ReadonlyArray<Repositoryish>,
  showSubmodulesInRepoList: boolean
): IRepositoryListItem[] => {
  const groupNames = new Map<string, number>()
  const allNames = new Map<string, number>()

  for (const groupItem of groups.values()) {
    // All items in the recent group are by definition present in another
    // group and therefore we don't want to count them.
    if (groupItem.group.kind === 'recent') {
      continue
    }

    for (const title of groupItem.repos.map(getDisplayTitle)) {
      allNames.set(title, (allNames.get(title) ?? 0) + 1)
      if (groupItem.group === group) {
        groupNames.set(title, (groupNames.get(title) ?? 0) + 1)
      }
    }
  }

  return repositories
    .map(r => {
      const repoState = localRepositoryStateLookup.get(r.id)
      const title = getDisplayTitle(r)

      const aheadBehind = repoState?.aheadBehind ?? null
      const changedFilesCount = repoState?.changedFilesCount ?? 0
      const mainWorktree =
        getWorktrees(r, repoState).find(wt => wt.type === 'main') ?? null
      const isMainWorktreeActive =
        mainWorktree === null || mainWorktree.path === r.path

      return {
        text: r instanceof Repository ? [title, nameOf(r)] : [title],
        id: r.id.toString(),
        repository: r,
        needsDisambiguation:
          // If the repository is in the enterprise group and has a duplicate
          // name in the group, we need to disambiguate it. We don't have to
          // disambiguate repositories in the 'dotcom' group because they are
          // already grouped by owner. If the repository is in the 'recent'
          // group and has a duplicate name in any group, we need to
          // disambiguate it.
          ((groupNames.get(title) ?? 0) > 1 && group.kind === 'enterprise') ||
          ((allNames.get(title) ?? 0) > 1 && group.kind === 'recent'),
        aheadBehind: isMainWorktreeActive ? aheadBehind : null,
        changedFilesCount: isMainWorktreeActive ? changedFilesCount : 0,
        branchName: mainWorktree
          ? shortBranchName(mainWorktree.branch)
          : repoState?.branchName ?? null,
        defaultBranchName: repoState?.defaultBranchName ?? null,
        worktree: mainWorktree,
        submodule: null,
        submoduleDepth: 0,
        linkedRepository: null,
        hasChildren:
          showSubmodulesInRepoList &&
          (repoState?.submodules.length ?? 0) > 0,
        parentExpandableRowId: null,
      }
    })
    .sort(({ repository: x }, { repository: y }) =>
      caseInsensitiveCompare(getDisplayTitle(x), getDisplayTitle(y))
    )
    .flatMap(item => [
      item,
      ...buildLinkedWorktreeRows(item, localRepositoryStateLookup),
      ...(showSubmodulesInRepoList
        ? buildSubmoduleRows(item, localRepositoryStateLookup, allRepositories)
        : []),
    ])
}

const shortBranchName = (branch: string | null): string | null =>
  branch ? branch.replace(/^refs\/heads\//, '') : null

function getWorktrees(
  r: Repositoryish,
  repoState: ILocalRepositoryState | undefined
): ReadonlyArray<WorktreeEntry> {
  return r instanceof Repository ? repoState?.worktrees ?? [] : []
}

/**
 * Builds the rows for a repository's linked worktrees, which are nested below
 * the repository's own row (that one represents the main worktree).
 */
function buildLinkedWorktreeRows(
  item: IRepositoryListItem,
  localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>
): IRepositoryListItem[] {
  const r = item.repository
  const repoState = localRepositoryStateLookup.get(r.id)
  const aheadBehind = repoState?.aheadBehind ?? null
  const changedFilesCount = repoState?.changedFilesCount ?? 0

  // Linked worktree rows match the same filter text as their repository so they travel with it
  return getWorktrees(r, repoState)
    .filter(wt => wt.type === 'linked')
    .map((wt): IRepositoryListItem => {
      const isActiveWorktree = wt.path === r.path
      return {
        text: [Path.basename(wt.path)],
        id: `${r.id}:${wt.path}`,
        repository: r,
        needsDisambiguation: false,
        aheadBehind: isActiveWorktree ? aheadBehind : null,
        changedFilesCount: isActiveWorktree ? changedFilesCount : 0,
        branchName: shortBranchName(wt.branch),
        defaultBranchName: repoState?.defaultBranchName ?? null,
        worktree: wt,
        submodule: null,
        submoduleDepth: 0,
        linkedRepository: null,
        hasChildren: false,
        parentExpandableRowId: null,
      }
    })
}

function groupSubmodulesByParent(
  submodules: ReadonlyArray<SubmoduleEntry>
): ReadonlyMap<string | null, ReadonlyArray<SubmoduleEntry>> {
  const submodulePaths = submodules.map(s => s.path)
  const findParentPath = (path: string): string | null =>
    submodulePaths
      .filter(p => p !== path && (path + '/').startsWith(p + '/'))
      .sort((x, y) => y.length - x.length)[0] ?? null

  const childrenByParentPath = new Map<string | null, SubmoduleEntry[]>()
  for (const submodule of submodules) {
    const parentPath = findParentPath(submodule.path)
    const children = childrenByParentPath.get(parentPath) ?? []
    children.push(submodule)
    childrenByParentPath.set(parentPath, children)
  }
  for (const children of childrenByParentPath.values()) {
    children.sort((x, y) => caseInsensitiveCompare(x.path, y.path))
  }

  return childrenByParentPath
}

function buildSubmoduleRows(
  item: IRepositoryListItem,
  localRepositoryStateLookup: ReadonlyMap<number, ILocalRepositoryState>,
  allRepositories: ReadonlyArray<Repositoryish>,
  ancestorRepositoryIds: ReadonlySet<number> = new Set(),
  startingDepth: number = 1
): IRepositoryListItem[] {
  const r = item.repository
  if (!(r instanceof Repository) || ancestorRepositoryIds.has(r.id)) {
    return []
  }

  const submodules = localRepositoryStateLookup.get(r.id)?.submodules ?? []
  if (submodules.length === 0) {
    return []
  }

  const ancestorIdsWithSelf = new Set(ancestorRepositoryIds).add(r.id)

  const childrenByParentPath = groupSubmodulesByParent(submodules)
  const rows: IRepositoryListItem[] = []

  const addRowsForParent = (
    parentPath: string | null,
    depth: number,
    parentExpandableRowId: string | null
  ) => {
    for (const submodule of childrenByParentPath.get(parentPath) ?? []) {
      const linkedRepository = findRepositoryAtPath(
        allRepositories,
        Path.join(r.path, submodule.path)
      )
      const linkedState = linkedRepository
        ? localRepositoryStateLookup.get(linkedRepository.id)
        : undefined
      const hasChildren =
        linkedRepository !== null
          ? (linkedState?.submodules.length ?? 0) > 0
          : (childrenByParentPath.get(submodule.path)?.length ?? 0) > 0

      const row: IRepositoryListItem = {
        text: [Path.basename(submodule.path)],
        id: `${r.id}:submodule:${submodule.path}`,
        repository: linkedRepository ?? r,
        needsDisambiguation: false,
        aheadBehind: linkedState?.aheadBehind ?? null,
        changedFilesCount: linkedState?.changedFilesCount ?? 0,
        branchName: linkedState?.branchName ?? null,
        defaultBranchName: linkedState?.defaultBranchName ?? null,
        worktree: null,
        submodule,
        submoduleDepth: depth,
        linkedRepository,
        hasChildren,
        parentExpandableRowId,
      }
      rows.push(row)

      if (linkedRepository !== null) {
        rows.push(
          ...buildLinkedWorktreeRows(row, localRepositoryStateLookup),
          ...buildSubmoduleRows(
            row,
            localRepositoryStateLookup,
            allRepositories,
            ancestorIdsWithSelf,
            depth + 1
          )
        )
      } else {
        addRowsForParent(submodule.path, depth + 1, row.id)
      }
    }
  }

  addRowsForParent(null, startingDepth, item.id)

  return rows
}

/**
 * Extracts pinned items from existing groups and returns a Pins group, or null
 * if none of the pinned IDs are found in the groups.
 */
export function buildPinnedGroup(
  pinnedIds: ReadonlyArray<number>,
  allGroups: ReadonlyArray<
    IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
  >
): IFilterListGroup<IRepositoryListItem, RepositoryListGroup> | null {
  if (pinnedIds.length === 0) {
    return null
  }

  const idToItems = new Map<number, IRepositoryListItem[]>()
  const completedIds = new Set<number>()
  for (const group of allGroups) {
    for (const item of group.items) {
      const id = item.repository.id
      if (id <= 0 || completedIds.has(id)) {
        continue
      }
      const rows = idToItems.get(id)
      if (rows === undefined) {
        idToItems.set(id, [item])
      } else {
        rows.push(item)
      }
    }
    for (const id of idToItems.keys()) {
      completedIds.add(id)
    }
  }

  const items = pinnedIds.flatMap(id => idToItems.get(id) ?? [])

  if (items.length === 0) {
    return null
  }

  return { identifier: { kind: 'pins', displayName: null }, items }
}

/**
 * Returns groups with pinned items removed so they only appear in the Pins group.
 */
export function filterPinnedFromGroups(
  pinnedIds: ReadonlyArray<number>,
  groups: ReadonlyArray<
    IFilterListGroup<IRepositoryListItem, RepositoryListGroup>
  >
): ReadonlyArray<IFilterListGroup<IRepositoryListItem, RepositoryListGroup>> {
  if (pinnedIds.length === 0) {
    return groups
  }

  const pinnedIdSet = new Set(pinnedIds)
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item => !pinnedIdSet.has(item.repository.id)),
    }))
    .filter(group => group.items.length > 0)
}
