import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'
import { render, screen, fireEvent } from '../../helpers/ui/render'
import { Appearance } from '../../../src/ui/preferences/appearance'
import { ApplicationTheme } from '../../../src/ui/lib/application-theme'
import {
  getDateFormatPreference,
  getTimeFormatPreference,
  getNumberFormatPreference,
} from '../../../src/models/formatting-preferences'
import { ShowBranchNameInRepoListSetting } from '../../../src/models/show-branch-name-in-repo-list'
import { BranchSortOrder } from '../../../src/models/branch-sort-order'
import {
  defaultDiffFontFamily,
  defaultDiffFontSize,
} from '../../../src/models/diff-font'

function renderAppearance(alwaysShowWorktreeList = false) {
  const changes: boolean[] = []
  const props = {
    selectedTheme: ApplicationTheme.Light,
    onSelectedThemeChanged: () => {},
    selectedTabSize: 4,
    onSelectedTabSizeChanged: () => {},
    selectedDateFormat: getDateFormatPreference(),
    onSelectedDateFormatChanged: () => {},
    selectedTimeFormat: getTimeFormatPreference(),
    onSelectedTimeFormatChanged: () => {},
    selectedNumberFormat: getNumberFormatPreference(),
    onSelectedNumberFormatChanged: () => {},
    preferAbsoluteDates: false,
    onPreferAbsoluteDatesChanged: () => {},
    alwaysShowWorktreeList,
    onAlwaysShowWorktreeListChanged: (value: boolean) => changes.push(value),
    showChangedFileCount: false,
    onShowChangedFileCountChange: () => {},
    recentRepositoriesCount: 10,
    onRecentRepositoriesCountChanged: () => {},
    selectedDiffFontSize: defaultDiffFontSize,
    onSelectedDiffFontSizeChanged: () => {},
    selectedDiffFontFamily: defaultDiffFontFamily,
    onSelectedDiffFontFamilyChanged: () => {},
    titleBarStyle: 'native' as const,
    onTitleBarStyleChanged: () => {},
    showWorktrees: true,
    onShowWorktreesChanged: () => {},
    showWorktreesInRepoList: true,
    onShowWorktreesInRepoListChanged: () => {},
    showCompareTab: true,
    onShowCompareTabChanged: () => {},
    showConventionalCommitBadges: true,
    onShowConventionalCommitBadgesChanged: () => {},
    showBranchNameInRepoList: ShowBranchNameInRepoListSetting.Never,
    onShowBranchNameInRepoListChanged: () => {},
    branchSortOrder: BranchSortOrder.LastModified,
    onBranchSortOrderChanged: () => {},
  }
  const view = render(<Appearance {...props} />)
  return { ...view, props, changes }
}

// jsdom lacks the font APIs used to detect installed diff fonts. The detection
// runs after a timer, so these stubs must outlive the tests.
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { check: () => false, load: async () => [] },
})
Object.defineProperty(globalThis, 'queryLocalFonts', {
  configurable: true,
  value: async () => [],
})

describe('Appearance preferences', () => {
  it('shows the worktree preference below the toolbar dropdown toggle in Worktrees', () => {
    renderAppearance()

    const heading = screen.getByRole('heading', { name: 'Worktrees' })
    const showWorktrees = screen.getByRole('checkbox', {
      name: 'Show worktrees dropdown in toolbar',
    })
    const checkbox = screen.getByRole('checkbox', {
      name: "Don't hide worktrees dropdown when empty",
    })

    assert.strictEqual(
      heading.parentElement,
      showWorktrees.closest('.advanced-section')
    )
    assert.strictEqual(
      heading.parentElement,
      checkbox.closest('.advanced-section')
    )
    assert.ok(
      showWorktrees.compareDocumentPosition(checkbox) &
        Node.DOCUMENT_POSITION_FOLLOWING
    )
    assert.ok(checkbox instanceof HTMLInputElement)
    assert.strictEqual(checkbox.checked, false)
  })

  it('reports enabling and disabling the preference and reflects updated props', () => {
    const { rerender, props, changes } = renderAppearance()
    const checkbox = screen.getByRole('checkbox', {
      name: "Don't hide worktrees dropdown when empty",
    })
    fireEvent.click(checkbox)
    assert.deepStrictEqual(changes, [true])

    rerender(<Appearance {...props} alwaysShowWorktreeList={true} />)
    assert.ok(checkbox instanceof HTMLInputElement)
    assert.strictEqual(checkbox.checked, true)

    fireEvent.click(checkbox)
    assert.deepStrictEqual(changes, [true, false])
  })
})
