import * as React from 'react'

import { TextBox } from '../lib/text-box'
import { Tooltip, TooltipDirection } from '../lib/tooltip'
import { createObservableRef } from '../lib/observable-ref'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { FileTreeViewToggle } from '../lib/file-tree-folder'

const FilterLabel = 'Filter changed files'

interface IChangedFilesHeaderProps {
  /** The total number of files changed in the selected commit(s) */
  readonly fileCount: number

  /** The current text used to filter the list of changed files */
  readonly filterText: string

  /** Called on every keystroke in the filter text box */
  readonly onFilterTextChanged: (text: string) => void

  /** Whether the list of changed files is shown as a tree */
  readonly treeView: boolean

  /** Called when the user switches between the list and tree views */
  readonly onTreeViewChanged: (treeView: boolean) => void

  /** Whether the list/tree view mode switch is shown */
  readonly showViewModeSwitches: boolean
}

interface IChangedFilesHeaderState {
  /** Whether the filter text box is shown instead of the file count label */
  readonly isSearching: boolean

  /** Whether the filter text box should grab focus when it's shown. */
  readonly focusOnOpen: boolean
}

export class ChangedFilesHeader extends React.Component<
  IChangedFilesHeaderProps,
  IChangedFilesHeaderState
> {
  private readonly buttonRef = createObservableRef<HTMLButtonElement>()
  private focusButtonOnClose = false
  private lastEmittedText = this.props.filterText

  public constructor(props: IChangedFilesHeaderProps) {
    super(props)
    this.state = {
      isSearching: props.filterText !== '',
      focusOnOpen: false,
    }
  }

  public componentDidUpdate(prevProps: IChangedFilesHeaderProps) {
    // The filter was cleared from outside rather than by the user: close the text box.
    if (
      this.state.isSearching &&
      prevProps.filterText !== '' &&
      this.props.filterText === '' &&
      this.lastEmittedText !== ''
    ) {
      this.lastEmittedText = ''
      this.setState({ isSearching: false })
    }

    if (!this.state.isSearching && this.focusButtonOnClose) {
      this.focusButtonOnClose = false
      this.buttonRef.current?.focus()
    }
  }

  public render() {
    const { isSearching } = this.state
    return (
      <div className="file-list-header">
        {isSearching ? this.renderFilterTextBox() : this.renderLabel()}
        {this.renderTreeViewToggle()}
      </div>
    )
  }

  private renderTreeViewToggle() {
    if (!this.props.showViewModeSwitches) {
      return null
    }

    return (
      <FileTreeViewToggle
        treeView={this.props.treeView}
        onChange={this.props.onTreeViewChanged}
        ariaLabel="Changed files view mode"
      />
    )
  }

  private get changedFilesText() {
    const { fileCount } = this.props
    return `${fileCount} changed ${fileCount === 1 ? 'file' : 'files'}`
  }

  private renderLabel() {
    return (
      <>
        <button
          className="file-list-filter-button"
          aria-label={FilterLabel}
          onClick={this.onOpenFilter}
          ref={this.buttonRef}
          type="button"
        >
          <Tooltip
            target={this.buttonRef}
            direction={TooltipDirection.NORTH}
            applyAriaDescribedBy={false}
          >
            {FilterLabel}
          </Tooltip>
          <Octicon symbol={octicons.search} />
        </button>
        <span className="file-list-header-label">{this.changedFilesText}</span>
      </>
    )
  }

  private renderFilterTextBox() {
    return (
      <TextBox
        className="file-list-filter"
        autoFocus={this.state.focusOnOpen}
        displayClearButton={true}
        placeholder={`Filter ${this.changedFilesText}`}
        value={this.props.filterText}
        onValueChanged={this.onFilterTextChanged}
        onKeyDown={this.onKeyDown}
        onBlur={this.onBlur}
        ariaLabel={FilterLabel}
      />
    )
  }

  private onFilterTextChanged = (text: string) => {
    this.lastEmittedText = text
    this.props.onFilterTextChanged(text)
  }

  private onOpenFilter = () => {
    this.setState({ isSearching: true, focusOnOpen: true })
  }

  private onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      this.focusButtonOnClose = true
      this.onFilterTextChanged('')
      this.setState({ isSearching: false })
    }
  }

  private onBlur = (value: string) => {
    if (value === '') {
      this.setState({ isSearching: false })
    }
  }
}
