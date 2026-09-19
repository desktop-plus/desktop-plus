import { getStringArray, setStringArray } from '../local-storage'

const ExpandedRepositoryListRowsKey = 'expanded-repository-list-rows'

export function getExpandedRepositoryListRows(): ReadonlySet<string> {
  return new Set(getStringArray(ExpandedRepositoryListRowsKey))
}

export function setRepositoryListRowsExpanded(
  rowIds: Iterable<string>,
  expanded: boolean,
  knownRowIds: ReadonlySet<string>
): ReadonlySet<string> {
  const expandedRows = new Set(
    [...getExpandedRepositoryListRows()].filter(id => knownRowIds.has(id))
  )

  for (const rowId of rowIds) {
    if (expanded) {
      expandedRows.add(rowId)
    } else {
      expandedRows.delete(rowId)
    }
  }

  setStringArray(ExpandedRepositoryListRowsKey, [...expandedRows])

  return expandedRows
}
