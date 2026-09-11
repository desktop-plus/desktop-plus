import * as React from 'react'
import {
  ApplicationTheme,
  supportsSystemThemeChanges,
  getCurrentlyAppliedTheme,
} from '../lib/application-theme'
import { TitleBarStyle } from '../lib/title-bar-style'
import { Row } from '../lib/row'
import { DialogContent } from '../dialog'
import { RadioGroup } from '../lib/radio-group'
import { Select } from '../lib/select'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { encodePathAsUrl } from '../../lib/path'
import { TextBox } from '../lib/text-box'
import {
  tabSizeDefault,
  MaxRecentRepositoriesLength,
} from '../../lib/stores/app-store'
import { ShowBranchNameInRepoListSetting } from '../../models/show-branch-name-in-repo-list'
import { parseEnumValue } from '../../lib/enum'
import { assertNever } from '../../lib/fatal-error'
import { BranchSortOrder } from '../../models/branch-sort-order'
import {
  availableDiffFontSizes,
  defaultDiffFontFamily,
  defaultDiffFontSize,
  DiffFontFamily,
  getAvailableDiffFontFamilies,
  getDiffFontFamilyLabel,
} from '../../models/diff-font'
import { enableFormattingPreferences } from '../../lib/feature-flag'
import {
  DateFormat,
  TimeFormat,
  INumberFormat,
  dateFormats,
  timeFormats,
  numberFormats,
  numberFormatToKey,
} from '../../models/formatting-preferences'
import { formatNumber } from '../../lib/format-number'

interface IAppearanceProps {
  readonly selectedTheme: ApplicationTheme
  readonly onSelectedThemeChanged: (theme: ApplicationTheme) => void
  readonly selectedTabSize: number
  readonly onSelectedTabSizeChanged: (tabSize: number) => void
  readonly recentRepositoriesCount: number
  readonly onRecentRepositoriesCountChanged: (count: number) => void
  readonly selectedDiffFontSize: number
  readonly onSelectedDiffFontSizeChanged: (diffFontSize: number) => void
  readonly selectedDiffFontFamily: DiffFontFamily
  readonly onSelectedDiffFontFamilyChanged: (
    diffFontFamily: DiffFontFamily
  ) => void
  readonly titleBarStyle: TitleBarStyle
  readonly onTitleBarStyleChanged: (titleBarStyle: TitleBarStyle) => void
  readonly showWorktrees: boolean
  readonly onShowWorktreesChanged: (show: boolean) => void
  readonly showWorktreesInRepoList: boolean
  readonly onShowWorktreesInRepoListChanged: (show: boolean) => void
  readonly showCompareTab: boolean
  readonly onShowCompareTabChanged: (show: boolean) => void
  readonly showConventionalCommitBadges: boolean
  readonly onShowConventionalCommitBadgesChanged: (show: boolean) => void
  readonly showBranchNameInRepoList: ShowBranchNameInRepoListSetting
  readonly onShowBranchNameInRepoListChanged: (
    value: ShowBranchNameInRepoListSetting
  ) => void
  readonly branchSortOrder: BranchSortOrder
  readonly onBranchSortOrderChanged: (sortOrder: BranchSortOrder) => void
  readonly selectedDateFormat: DateFormat
  readonly onSelectedDateFormatChanged: (format: DateFormat) => void
  readonly selectedTimeFormat: TimeFormat
  readonly onSelectedTimeFormatChanged: (format: TimeFormat) => void
  readonly selectedNumberFormat: INumberFormat
  readonly onSelectedNumberFormatChanged: (format: INumberFormat) => void
  readonly preferAbsoluteDates: boolean
  readonly onPreferAbsoluteDatesChanged: (value: boolean) => void
}

interface IAppearanceState {
  readonly selectedTheme: ApplicationTheme | null
  readonly selectedTabSize: number
  readonly selectedDiffFontSize: number
  readonly selectedDiffFontFamily: DiffFontFamily
  readonly availableDiffFontFamilies: ReadonlyArray<DiffFontFamily>
  readonly titleBarStyle: TitleBarStyle
  readonly showWorktrees: boolean
  readonly showWorktreesInRepoList: boolean
  readonly showCompareTab: boolean
  readonly showConventionalCommitBadges: boolean
}

function getTitleBarStyleDescription(titleBarStyle: TitleBarStyle): string {
  switch (titleBarStyle) {
    case 'custom':
      return 'Uses the menu system provided by Desktop Plus, hiding the default chrome provided by your window manager.'
    case 'native':
      return 'Uses the menu system and chrome provided by your window manager.'
    case 'native-without-menu-bar':
      return 'Uses the native window chrome, but hides the menu bar. Press Alt to show it temporarily. Takes effect after restarting the app.'
  }
}

export class Appearance extends React.Component<
  IAppearanceProps,
  IAppearanceState
> {
  public constructor(props: IAppearanceProps) {
    super(props)

    const usePropTheme =
      props.selectedTheme !== ApplicationTheme.System ||
      supportsSystemThemeChanges()

    this.state = {
      selectedTheme: usePropTheme ? props.selectedTheme : null,
      selectedTabSize: props.selectedTabSize,
      selectedDiffFontSize: props.selectedDiffFontSize,
      selectedDiffFontFamily: props.selectedDiffFontFamily,
      availableDiffFontFamilies:
        props.selectedDiffFontFamily === defaultDiffFontFamily
          ? [defaultDiffFontFamily]
          : [props.selectedDiffFontFamily, defaultDiffFontFamily],
      titleBarStyle: props.titleBarStyle,
      showWorktrees: props.showWorktrees,
      showWorktreesInRepoList: props.showWorktreesInRepoList,
      showCompareTab: props.showCompareTab,
      showConventionalCommitBadges: props.showConventionalCommitBadges,
    }

    if (!usePropTheme) {
      this.initializeSelectedTheme()
    }
  }

  public componentDidMount() {
    this.updateAvailableDiffFontFamilies()
  }

  public async componentDidUpdate(prevProps: IAppearanceProps) {
    if (prevProps === this.props) {
      return
    }

    const usePropTheme =
      this.props.selectedTheme !== ApplicationTheme.System ||
      supportsSystemThemeChanges()

    const selectedTheme = usePropTheme
      ? this.props.selectedTheme
      : await getCurrentlyAppliedTheme()

    const selectedTabSize = this.props.selectedTabSize
    const selectedDiffFontSize = this.props.selectedDiffFontSize
    const selectedDiffFontFamily = this.props.selectedDiffFontFamily

    this.setState({
      selectedTheme,
      selectedTabSize,
      selectedDiffFontSize,
      selectedDiffFontFamily,
      showWorktrees: this.props.showWorktrees,
      showWorktreesInRepoList: this.props.showWorktreesInRepoList,
      showCompareTab: this.props.showCompareTab,
      showConventionalCommitBadges: this.props.showConventionalCommitBadges,
    })

    if (
      prevProps.selectedDiffFontFamily !== this.props.selectedDiffFontFamily
    ) {
      this.updateAvailableDiffFontFamilies()
    }
  }

  private initializeSelectedTheme = async () => {
    const selectedTheme = await getCurrentlyAppliedTheme()
    const selectedTabSize = this.props.selectedTabSize
    this.setState({
      selectedTheme,
      selectedTabSize,
      selectedDiffFontSize: this.props.selectedDiffFontSize,
      selectedDiffFontFamily: this.props.selectedDiffFontFamily,
    })
  }

  private updateAvailableDiffFontFamilies = async () => {
    const families = await getAvailableDiffFontFamilies()
    const selected = this.props.selectedDiffFontFamily
    const available = families.includes(selected)
      ? families
      : [selected, ...families]

    this.setState({ availableDiffFontFamilies: available })
  }

  private onSelectedThemeChanged = (theme: ApplicationTheme) => {
    this.props.onSelectedThemeChanged(theme)
  }

  private onRecentRepositoriesCountChanged = (countText: string) => {
    const count = parseInt(countText, 10)
    const coerced = isNaN(count) ? 0 : count
    this.props.onRecentRepositoriesCountChanged(coerced)
  }

  private onShowWorktreesChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const show = event.currentTarget.checked
    this.setState({ showWorktrees: show })
    this.props.onShowWorktreesChanged(show)
  }

  private onShowWorktreesInRepoListChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const show = event.currentTarget.checked
    this.setState({ showWorktreesInRepoList: show })
    this.props.onShowWorktreesInRepoListChanged(show)
  }

  private onShowCompareTabChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const show = event.currentTarget.checked
    this.setState({ showCompareTab: show })
    this.props.onShowCompareTabChanged(show)
  }

  private onShowConventionalCommitBadgesChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    const show = event.currentTarget.checked
    this.setState({ showConventionalCommitBadges: show })
    this.props.onShowConventionalCommitBadgesChanged(show)
  }

  private onSelectedTabSizeChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    this.props.onSelectedTabSizeChanged(parseInt(event.currentTarget.value))
  }

  private onSelectedDiffFontSizeChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    this.props.onSelectedDiffFontSizeChanged(
      parseInt(event.currentTarget.value)
    )
  }

  private onSelectedDiffFontFamilyChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    const value = event.currentTarget.value
    if (value) {
      this.props.onSelectedDiffFontFamilyChanged(value)
    }
  }

  private onSelectChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const titleBarStyle = event.currentTarget.value as TitleBarStyle
    this.setState({ titleBarStyle })
    this.props.onTitleBarStyleChanged(titleBarStyle)
  }

  private onDateFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = dateFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedDateFormatChanged(match.pattern)
    }
  }

  private onTimeFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = timeFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedTimeFormatChanged(match.pattern)
    }
  }

  private onNumberFormatChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    const match = numberFormats.find(
      n => numberFormatToKey(n) === event.currentTarget.value
    )
    if (match) {
      this.props.onSelectedNumberFormatChanged(match)
    }
  }

  private onPreferAbsoluteDatesChanged = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.props.onPreferAbsoluteDatesChanged(event.currentTarget.checked)
  }

  public renderThemeSwatch = (theme: ApplicationTheme) => {
    const darkThemeImage = encodePathAsUrl(__dirname, 'static/ghd_dark.svg')
    const lightThemeImage = encodePathAsUrl(__dirname, 'static/ghd_light.svg')

    switch (theme) {
      case ApplicationTheme.Light:
        return (
          <span>
            <img src={lightThemeImage} alt="" />
            <span className="theme-value-label">Light</span>
          </span>
        )
      case ApplicationTheme.Dark:
        return (
          <span>
            <img src={darkThemeImage} alt="" />
            <span className="theme-value-label">Dark</span>
          </span>
        )
      case ApplicationTheme.System:
        /** Why three images? The system theme swatch uses the first image
         * positioned relatively to get the label container size and uses the
         * second and third positioned absolutely over first and third one
         * clipped in half to render a split dark and light theme swatch. */
        return (
          <span>
            <span className="system-theme-swatch">
              <img src={lightThemeImage} alt="" />
              <img src={lightThemeImage} alt="" />
              <img src={darkThemeImage} alt="" />
            </span>
            <span className="theme-value-label">System</span>
          </span>
        )
    }
  }

  private renderTitleBarStyleDropdown() {
    if (!__LINUX__) {
      return null
    }
    const { titleBarStyle } = this.state
    const titleBarStyleDescription = getTitleBarStyleDescription(titleBarStyle)

    return (
      <div className="advanced-section">
        <h2>Title bar style</h2>

        <Select
          value={this.state.titleBarStyle}
          onChange={this.onSelectChanged}
        >
          <option value="native">Native</option>
          <option value="custom">Custom</option>
          <option value="native-without-menu-bar">
            Native without menu bar
          </option>
        </Select>

        <div className="git-settings-description">
          {titleBarStyleDescription}
        </div>
      </div>
    )
  }

  private renderSelectedTheme() {
    const { selectedTheme } = this.state

    if (selectedTheme == null) {
      return <Row>Loading system theme</Row>
    }

    const themes = [
      ApplicationTheme.Light,
      ApplicationTheme.Dark,
      ...(supportsSystemThemeChanges() ? [ApplicationTheme.System] : []),
    ]

    return (
      <div className="advanced-section">
        <h2 id="theme-heading">Theme</h2>

        <RadioGroup<ApplicationTheme>
          ariaLabelledBy="theme-heading"
          className="theme-selector"
          selectedKey={selectedTheme}
          radioButtonKeys={themes}
          onSelectionChanged={this.onSelectedThemeChanged}
          renderRadioButtonLabelContents={this.renderThemeSwatch}
        />
      </div>
    )
  }

  private onShowBranchNameInRepoListChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    const value = parseEnumValue(
      ShowBranchNameInRepoListSetting,
      event.currentTarget.value
    )
    if (value !== undefined) {
      this.props.onShowBranchNameInRepoListChanged(value)
    }
  }

  private onBranchSortOrderChanged = (branchSortOrder: BranchSortOrder) => {
    this.props.onBranchSortOrderChanged(branchSortOrder)
  }

  private renderBranchSortOrder() {
    const { branchSortOrder } = this.props

    return (
      <div className="advanced-section">
        <h2 id="branch-sort-order-heading">Sort branches</h2>

        <RadioGroup<BranchSortOrder>
          ariaLabelledBy="branch-sort-order-heading"
          selectedKey={branchSortOrder}
          radioButtonKeys={[
            BranchSortOrder.Alphabetical,
            BranchSortOrder.LastModified,
          ]}
          onSelectionChanged={this.onBranchSortOrderChanged}
          renderRadioButtonLabelContents={this.renderBranchSortOptionLabel}
        />
      </div>
    )
  }

  private renderBranchSortOptionLabel = (branchSortOrder: BranchSortOrder) => {
    switch (branchSortOrder) {
      case BranchSortOrder.Alphabetical:
        return 'Alphabetical'
      case BranchSortOrder.LastModified:
        return 'Last modified'
      default:
        return assertNever(
          branchSortOrder,
          `Unknown branch sort order: ${branchSortOrder}`
        )
    }
  }

  private renderRepositoryList() {
    return (
      <div className="advanced-section">
        <h2 id="repository-list-heading">{'Repository list'}</h2>

        <TextBox
          type="number"
          min={0}
          max={MaxRecentRepositoriesLength}
          label="Recent repository count"
          value={
            this.props.recentRepositoriesCount === 0
              ? ''
              : this.props.recentRepositoriesCount.toString()
          }
          onValueChanged={this.onRecentRepositoriesCountChanged}
        />
        <Select
          label="Show current branch name next to repository name"
          value={this.props.showBranchNameInRepoList}
          onChange={this.onShowBranchNameInRepoListChanged}
        >
          <option value={ShowBranchNameInRepoListSetting.Never}>Never</option>
          <option value={ShowBranchNameInRepoListSetting.Always}>Always</option>
          <option value={ShowBranchNameInRepoListSetting.WhenNotDefault}>
            When it's not the default branch
          </option>
        </Select>
      </div>
    )
  }

  private renderWorktreeVisibility() {
    return (
      <>
        <div className="advanced-section">
          <h2 id="worktree-heading">{'Worktrees'}</h2>

          <Checkbox
            label="Show worktrees dropdown in toolbar"
            value={
              this.state.showWorktrees ? CheckboxValue.On : CheckboxValue.Off
            }
            onChange={this.onShowWorktreesChanged}
          />

          <Checkbox
            label="Show worktrees in repository list"
            value={
              this.state.showWorktreesInRepoList
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onShowWorktreesInRepoListChanged}
          />
        </div>
        <div className="advanced-section">
          <h2>{'Commit list'}</h2>

          <Checkbox
            label="Show Compare tab"
            value={
              this.state.showCompareTab ? CheckboxValue.On : CheckboxValue.Off
            }
            onChange={this.onShowCompareTabChanged}
          />

          <Checkbox
            label="Show Conventional Commits prefixes as badges"
            value={
              this.state.showConventionalCommitBadges
                ? CheckboxValue.On
                : CheckboxValue.Off
            }
            onChange={this.onShowConventionalCommitBadgesChanged}
          />
        </div>
      </>
    )
  }

  private renderFormatting() {
    if (!enableFormattingPreferences()) {
      return null
    }

    return (
      <div className="appearance-section formatting-section">
        <h2 id="formatting-heading">Formatting</h2>

        <Row>
          <Select
            label={__DARWIN__ ? 'Date Format' : 'Date format'}
            value={this.props.selectedDateFormat}
            onChange={this.onDateFormatChanged}
          >
            {dateFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>

          <Select
            label={__DARWIN__ ? 'Time Format' : 'Time format'}
            value={this.props.selectedTimeFormat}
            onChange={this.onTimeFormatChanged}
          >
            {timeFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>
        </Row>

        <Select
          label={__DARWIN__ ? 'Number Format' : 'Number format'}
          value={numberFormatToKey(this.props.selectedNumberFormat)}
          onChange={this.onNumberFormatChanged}
        >
          {numberFormats.map(format => (
            <option
              key={numberFormatToKey(format)}
              value={numberFormatToKey(format)}
            >
              {formatNumber(1234567.89, format)}
            </option>
          ))}
        </Select>

        <Checkbox
          className="prefer-absolute-dates"
          label="Prefer absolute dates over relative"
          value={
            this.props.preferAbsoluteDates
              ? CheckboxValue.On
              : CheckboxValue.Off
          }
          onChange={this.onPreferAbsoluteDatesChanged}
        />
      </div>
    )
  }

  private renderDiffSettings() {
    const availableTabSizes: number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12]

    return (
      <div className="advanced-section">
        <h2 id="diff-heading">Diff</h2>

        <Select
          value={this.state.selectedDiffFontSize.toString()}
          label={__DARWIN__ ? 'Font Size' : 'Font size'}
          onChange={this.onSelectedDiffFontSizeChanged}
        >
          {availableDiffFontSizes.map(n => (
            <option key={n} value={n}>
              {n === defaultDiffFontSize ? `${n} (default)` : n}
            </option>
          ))}
        </Select>

        <Select
          value={this.state.selectedDiffFontFamily}
          label="Font"
          onChange={this.onSelectedDiffFontFamilyChanged}
        >
          {this.state.availableDiffFontFamilies.map(fontFamily => (
            <option key={fontFamily} value={fontFamily}>
              {getDiffFontFamilyLabel(fontFamily)}
            </option>
          ))}
        </Select>

        <Select
          value={this.state.selectedTabSize.toString()}
          label={__DARWIN__ ? 'Tab Size' : 'Tab size'}
          onChange={this.onSelectedTabSizeChanged}
        >
          {availableTabSizes.map(n => (
            <option key={n} value={n}>
              {n === tabSizeDefault ? `${n} (default)` : n}
            </option>
          ))}
        </Select>
      </div>
    )
  }

  public render() {
    return (
      <DialogContent className="appearance-tab">
        {this.renderSelectedTheme()}
        {this.renderFormatting()}
        {this.renderRepositoryList()}
        {this.renderBranchSortOrder()}
        {this.renderWorktreeVisibility()}
        {this.renderDiffSettings()}
        {this.renderTitleBarStyleDropdown()}
      </DialogContent>
    )
  }
}
