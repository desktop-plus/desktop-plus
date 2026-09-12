import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import * as React from 'react'
import { Account } from '../../models/account'
import { IAvatarUser } from '../../models/avatar'
import { Avatar } from '../lib/avatar'
import { FancyTextBox, IFancyTextBoxProps } from '../lib/fancy-text-box'
import { findNextSelectableRow, List } from '../lib/list'
import {
  Popover,
  PopoverAnchorPosition,
  PopoverDecoration,
} from '../lib/popover'
import { TextBox } from '../lib/text-box'
import { debounce } from 'lodash'
import {
  TFilterToken,
  tokenValueClassNames,
  parseFilterTokens,
  buildSearchResult,
} from './commit-graph-filter-tokens'

const ROW_HEIGHT = 45
const DEFAULT_POPUP_HEIGHT = 250

interface ICommitGraphFilterTextBoxProps
  extends Omit<IFancyTextBoxProps, 'value' | 'onValueChanged'> {
  readonly accounts: ReadonlyArray<Account>
  readonly filterAuthorsList: ReadonlyArray<IAvatarUser> | null
  readonly onSearchSubmitted: (text: string, emailSet: Set<string>) => void
}

interface ICommitGraphFilterTextBoxState {
  readonly value: string

  readonly caretOffset: number | null

  /**
   * Whether the autocomplete has been dismissed. Set when the caret is
   * moved away from the token being edited or when the user dismisses the
   * popup (Escape) and reset whenever the user edits the text.
   *
   * This is the single bit of memory which distinguishes "the caret is at
   * the end of an author token because the user just edited it"
   */
  readonly isAutocompleteDismissed: boolean

  readonly autocompleteAnchorElement: HTMLSpanElement | null
  readonly selectedAutocompleteRow: number | null
}

export class CommitGraphFilterTextBox extends React.Component<
  ICommitGraphFilterTextBoxProps,
  ICommitGraphFilterTextBoxState
> {
  private backdropRef = React.createRef<HTMLDivElement>()
  private inputElement: HTMLInputElement | null = null
  private textBox: TextBox | null = null

  private pendingCaretOffset: number | null = null

  private readonly getFilterTokens = memoizeOne(
    (
      value: string,
      emailSet: ReadonlySet<string>,
      caretOffset: number | null
    ): ReadonlyArray<TFilterToken> =>
      parseFilterTokens(value, emailSet, caretOffset)
  )

  private readonly getAutocompleteAuthors = memoizeOne(
    (
      authors: ICommitGraphFilterTextBoxProps['filterAuthorsList'],
      partial: string
    ): ReadonlyArray<IAvatarUser> => {
      if (authors === null) {
        return []
      }

      const searchToken = partial.trim().toLowerCase()

      return authors.filter(({ email }) =>
        email.toLowerCase().includes(searchToken)
      )
    }
  )

  private readonly getEmailSet = memoizeOne(
    (
      authors: ICommitGraphFilterTextBoxProps['filterAuthorsList']
    ): ReadonlySet<string> => {
      const emails = (authors ?? []).map(o => o.email.trim().toLowerCase())
      return new Set(emails)
    }
  )

  private get hasClearButton() {
    return (
      this.state.value !== '' &&
      (this.props.type === 'search' || this.props.displayClearButton === true)
    )
  }

  private get authorEmailSet() {
    return this.getEmailSet(this.props.filterAuthorsList)
  }

  private get filterTokens() {
    return this.getFilterTokens(
      this.state.value,
      this.authorEmailSet,
      this.state.caretOffset
    )
  }

  private get editedAuthorToken() {
    return this.filterTokens.find(
      (token): token is Extract<TFilterToken, { kind: 'author' }> =>
        token.kind === 'author' && token.isEdited
    )
  }

  private get autocompleteAuthors() {
    const editedAuthorToken = this.editedAuthorToken

    return editedAuthorToken === undefined
      ? []
      : this.getAutocompleteAuthors(
          this.props.filterAuthorsList,
          editedAuthorToken.value
        )
  }

  private get isAutocompleteVisible() {
    return (
      !this.state.isAutocompleteDismissed &&
      this.state.autocompleteAnchorElement !== null &&
      this.autocompleteAuthors.length > 0
    )
  }

  private submitSearch = debounce(
    (tokens: ReadonlyArray<TFilterToken> = []) => {
      const { query, authorEmails } = buildSearchResult(tokens)

      this.props.onSearchSubmitted(query, authorEmails)
    },
    250
  )

  public constructor(props: ICommitGraphFilterTextBoxProps) {
    super(props)

    this.state = {
      value: '',
      caretOffset: null,
      isAutocompleteDismissed: false,
      autocompleteAnchorElement: null,
      selectedAutocompleteRow: null,
    }
  }

  public componentWillUnmount() {
    this.detachInputListeners()
  }

  public componentDidUpdate() {
    this.syncBackdropScroll()

    if (this.pendingCaretOffset !== null && this.inputElement !== null) {
      // This component updates after TextBox component updates so
      // this runs after TextBox has restored its (now stale) caret
      // position, overriding it with the current caret position
      this.inputElement.setSelectionRange(
        this.pendingCaretOffset,
        this.pendingCaretOffset
      )

      // setSelectionRange doesn't scroll single-line inputs to show the caret.
      // Force scroll so the newly inserted autocomplete text is visible.
      this.inputElement.scrollLeft = this.inputElement.scrollWidth

      // Make sure the TextBox won't restore the stale position on a
      // subsequent re-render (e.g. when the filter authors arrive
      // asynchronously).
      this.textBox?.syncCursorPosition()

      this.pendingCaretOffset = null
    }
  }

  /**
   * Callback ref for the span of the author token currently being edited.
   * Callback refs run during the commit phase so state updates from here
   * are flushed synchronously, before paint, which keeps the popover from
   * ever being rendered without its anchor element.
   */
  private onPendingTokenRef = (element: HTMLSpanElement | null) => {
    if (this.state.autocompleteAnchorElement !== element) {
      this.setState({ autocompleteAnchorElement: element })
    }
  }

  private renderTokens = () => {
    return this.filterTokens.map((token, tokenIdx) => {
      if (token.kind === 'query') {
        return <span key={tokenIdx}>{token.value}</span>
      }

      return (
        <span
          key={tokenIdx}
          ref={token.isEdited ? this.onPendingTokenRef : null}
        >
          <span className="token">
            {token.name}
            {token.delimiter}
          </span>
          <span className={tokenValueClassNames[token.state]}>
            {token.value}
          </span>
        </span>
      )
    })
  }

  public render() {
    const showAutocomplete = this.isAutocompleteVisible

    return (
      <>
        <div
          className={classNames('commitGraph-filter-text-box', {
            'with-clear-button': this.hasClearButton,
          })}
        >
          <div
            className="commitGraph-filter-text-box-backdrop"
            aria-hidden="true"
            ref={this.backdropRef}
          >
            {this.renderTokens()}
          </div>
          <FancyTextBox
            ariaLabel={this.props.ariaLabel}
            type={this.props.type}
            symbol={this.props.symbol}
            symbolClassName={this.props.symbolClassName}
            placeholder={this.props.placeholder}
            value={this.state.value}
            onValueChanged={this.onValueChanged}
            onRef={this.onTextBoxRef}
          />
        </div>
        {showAutocomplete && this.renderAutocompletePopover()}
      </>
    )
  }

  private renderAutocompletePopover = () => {
    const editedAuthorToken = this.editedAuthorToken
    const maxHeight = Math.min(
      DEFAULT_POPUP_HEIGHT,
      ROW_HEIGHT * this.autocompleteAuthors.length
    )

    const minHeight = ROW_HEIGHT * Math.min(this.autocompleteAuthors.length, 3)
    return (
      <Popover
        anchor={this.state.autocompleteAnchorElement}
        anchorPosition={PopoverAnchorPosition.BottomLeft}
        anchorOffset={2}
        decoration={PopoverDecoration.None}
        trapFocus={false}
        isDialog={false}
        className="autocompletion-popup filter"
        maxHeight={maxHeight}
        minHeight={minHeight}
      >
        <List
          rowCount={this.autocompleteAuthors.length}
          rowHeight={ROW_HEIGHT}
          rowRenderer={this.renderAutocompleteRow}
          selectedRows={
            this.state.selectedAutocompleteRow === null
              ? []
              : [this.state.selectedAutocompleteRow]
          }
          scrollToRow={this.state.selectedAutocompleteRow ?? undefined}
          onRowMouseDown={this.onAutocompleteRowMouseDown}
          invalidationProps={editedAuthorToken?.value ?? undefined}
          shouldDisableTabFocus={true}
        />
      </Popover>
    )
  }

  private onValueChanged = (text: string) => {
    const caretOffset = this.inputElement?.selectionEnd ?? null

    // The same memoized call render() makes with the same arguments so
    // this adds no extra parsing, the following render hits the cache.
    const tokens = this.getFilterTokens(text, this.authorEmailSet, caretOffset)

    this.setState({
      value: text,
      caretOffset,
      isAutocompleteDismissed: false,
      selectedAutocompleteRow: null,
    })

    // Hold off on submitting while the user is in the middle of typing an
    // author email. Submitting a half-finished token would search
    // for something the user hasn't finished writing.
    const isTypingAuthorEmail = tokens.some(
      token => token.kind === 'author' && token.isEdited
    )

    if (!isTypingAuthorEmail) {
      this.submitSearch(tokens)
    }
  }

  private renderAutocompleteRow = (row: number) => {
    const author = this.autocompleteAuthors[row]

    if (author === undefined) {
      return null
    }

    return (
      <div className="autocompletion-item">
        <div className="author-filter">
          <Avatar user={author} accounts={this.props.accounts} />
          <div className="author-filter-text">
            <span className="name">{author.name}</span>
            <span className="email">{author.email}</span>
          </div>
        </div>
      </div>
    )
  }

  private onInputKeyDown = (event: Event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      event.isComposing ||
      !this.isAutocompleteVisible
    ) {
      return
    }

    const { selectedAutocompleteRow } = this.state

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Prevent the input caret from being moved twice by underlying textbox event
      // and make sure the TextBox never sees the key.
      event.preventDefault()
      event.stopPropagation()

      const nextRow = findNextSelectableRow(this.autocompleteAuthors.length, {
        direction: event.key === 'ArrowDown' ? 'down' : 'up',
        row: selectedAutocompleteRow ?? -1,
      })

      this.setState({ selectedAutocompleteRow: nextRow })
    } else if (event.key === 'Enter' && selectedAutocompleteRow !== null) {
      event.preventDefault()
      event.stopPropagation()

      this.insertCompletion(selectedAutocompleteRow)
    } else if (event.key === 'Escape') {
      // Close the autocomplete without clearing the input text (the TextBox
      // would do so otherwise as it is a search input).
      event.preventDefault()
      event.stopPropagation()

      this.setState({
        isAutocompleteDismissed: true,
        selectedAutocompleteRow: null,
      })

      this.submitSearch(this.filterTokens)
    }
  }

  private insertCompletion(row: number) {
    const author = this.autocompleteAuthors[row]

    if (author === undefined) {
      return
    }

    const editedAuthorToken = this.editedAuthorToken

    if (editedAuthorToken === undefined) {
      return
    }

    const inserted = `author:${author.email} `

    const newValue =
      this.state.value.substring(0, editedAuthorToken.start) +
      inserted +
      this.state.value.substring(editedAuthorToken.end)

    const newCaretOffset = editedAuthorToken.start + inserted.length

    this.pendingCaretOffset = newCaretOffset

    this.setState({
      value: newValue,
      caretOffset: newCaretOffset,
      isAutocompleteDismissed: true,
      selectedAutocompleteRow: null,
    })

    // Programmatic value changes don't fire onValueChanged so picking an
    // author has to submit explicitly.
    this.submitSearch(
      this.getFilterTokens(newValue, this.authorEmailSet, newCaretOffset)
    )
  }

  private onAutocompleteRowMouseDown = (row: number) => {
    this.insertCompletion(row)

    window.setTimeout(() => {
      this.inputElement?.focus()
    }, 0)
  }

  private onInputScroll = () => {
    this.syncBackdropScroll()
  }

  private onCaretMoved = () => {
    this.textBox?.syncCursorPosition()

    if (
      this.state.isAutocompleteDismissed ||
      this.editedAuthorToken === undefined
    ) {
      return
    }

    const isCollapsedCaretAtTokenEnd =
      this.inputElement !== null &&
      this.inputElement.selectionStart === this.inputElement.selectionEnd &&
      this.inputElement.selectionEnd === this.editedAuthorToken.end

    if (!isCollapsedCaretAtTokenEnd) {
      this.setState({
        isAutocompleteDismissed: true,
        selectedAutocompleteRow: null,
      })

      this.submitSearch(this.filterTokens)
    }
  }

  private onTextBoxRef = (textBox: TextBox | null) => {
    this.detachInputListeners()

    this.textBox = textBox
    this.inputElement = textBox !== null ? textBox.getInputElement() : null

    this.attachInputListeners()

    if (this.props.onRef && textBox !== null) {
      this.props.onRef(textBox)
    }
  }

  private attachInputListeners = () => {
    if (this.inputElement !== null) {
      this.inputElement.addEventListener('scroll', this.onInputScroll)
      this.inputElement.addEventListener('keyup', this.onCaretMoved)
      this.inputElement.addEventListener('mouseup', this.onCaretMoved)
      this.inputElement.addEventListener('select', this.onCaretMoved)
      this.inputElement.addEventListener('keydown', this.onInputKeyDown, true)
    }
  }

  private detachInputListeners = () => {
    this.textBox = null

    if (this.inputElement !== null) {
      this.inputElement.removeEventListener('scroll', this.onInputScroll)
      this.inputElement.removeEventListener('keyup', this.onCaretMoved)
      this.inputElement.removeEventListener('mouseup', this.onCaretMoved)
      this.inputElement.removeEventListener('select', this.onCaretMoved)
      this.inputElement.removeEventListener(
        'keydown',
        this.onInputKeyDown,
        true
      )
      this.inputElement = null
    }
  }

  private syncBackdropScroll = () => {
    if (this.backdropRef.current === null || this.inputElement === null) {
      return
    }

    this.backdropRef.current.scrollLeft = this.inputElement.scrollLeft
  }
}
