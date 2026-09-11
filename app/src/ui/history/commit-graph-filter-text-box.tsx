import * as React from 'react'
import { FancyTextBox, IFancyTextBoxProps } from '../lib/fancy-text-box'
import { TextBox } from '../lib/text-box'
import classNames from 'classnames'
import memoizeOne from 'memoize-one'
import { TAuthorFilterOption } from '../../lib/app-state'
import { findNextSelectableRow, List } from '../lib/list'
import {
  Popover,
  PopoverAnchorPosition,
  PopoverDecoration,
} from '../lib/popover'

interface ICommitGraphFilterTextBoxProps
  extends Omit<IFancyTextBoxProps, 'value' | 'onValueChanged'> {
  readonly authorFilterOptions: ReadonlyArray<TAuthorFilterOption> | null
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

type TAuthorTokenState = 'valid' | 'invalid' | 'pending'

type TFilterToken =
  | { kind: 'query'; value: string; start: number; end: number }
  | {
      kind: 'author'
      name: string
      delimiter: string
      value: string
      start: number
      end: number
      state: TAuthorTokenState
      isEdited: boolean
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

  private readonly getAutocompleteItems = memoizeOne(
    (
      options: ICommitGraphFilterTextBoxProps['authorFilterOptions'],
      partial: string
    ): ReadonlyArray<TAuthorFilterOption> => {
      if (options === null) {
        return []
      }

      const searchToken = partial.trim().toLowerCase()

      return options.filter(({ email }) =>
        email.toLowerCase().includes(searchToken)
      )
    }
  )

  private readonly getEmailSet = memoizeOne(
    (
      options: ICommitGraphFilterTextBoxProps['authorFilterOptions']
    ): ReadonlySet<string> => {
      const opts = options ?? []
      const emails = opts.map(o => o.email.trim().toLowerCase())
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
    return this.getEmailSet(this.props.authorFilterOptions)
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

  private get autocompleteItems() {
    const editedAuthorToken = this.editedAuthorToken

    return editedAuthorToken === undefined
      ? []
      : this.getAutocompleteItems(
          this.props.authorFilterOptions,
          editedAuthorToken.value
        )
  }

  private get isAutocompleteVisible() {
    return (
      !this.state.isAutocompleteDismissed &&
      this.state.autocompleteAnchorElement !== null &&
      this.autocompleteItems.length > 0
    )
  }

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

      // Make sure the TextBox won't restore the stale position on a
      // subsequent re-render (e.g. when the author filter options arrive
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
            onEnterPressed={this.onEnterPressed}
            onRef={this.onTextBoxRef}
          />
        </div>
        {showAutocomplete && this.renderAutocompletePopover()}
      </>
    )
  }

  private renderAutocompletePopover = () => {
    const editedAuthorToken = this.editedAuthorToken
    return (
      <Popover
        anchor={this.state.autocompleteAnchorElement}
        anchorPosition={PopoverAnchorPosition.BottomLeft}
        anchorOffset={2}
        decoration={PopoverDecoration.None}
        trapFocus={false}
        isDialog={false}
        className="autocompletion-popup filter"
        maxHeight={Math.min(
          DefaultPopupHeight,
          RowHeight * this.autocompleteItems.length
        )}
        minHeight={RowHeight * Math.min(this.autocompleteItems.length, 3)}
      >
        <List
          rowCount={this.autocompleteItems.length}
          rowHeight={RowHeight}
          rowRenderer={this.renderAutocompleteRow}
          selectedRows={
            this.state.selectedAutocompleteRow === null
              ? []
              : [this.state.selectedAutocompleteRow]
          }
          scrollToRow={this.state.selectedAutocompleteRow ?? undefined}
          onRowClick={this.onAutocompleteRowClicked}
          invalidationProps={editedAuthorToken?.value ?? undefined}
          shouldDisableTabFocus={true}
        />
      </Popover>
    )
  }

  private onValueChanged = (text: string) => {
    this.setState({
      value: text,
      caretOffset: this.inputElement?.selectionEnd ?? null,
      isAutocompleteDismissed: false,
      selectedAutocompleteRow: null,
    })

    if (text === '') {
      this.submitSearch()
    }
  }

  private renderAutocompleteRow = (row: number) => {
    const item = this.autocompleteItems[row]

    if (item === undefined) {
      return null
    }

    return (
      <div className="autocompletion-item">
        <div className="author-filter">
          <span className="name">{item.name}</span>
          <span className="email">{item.email}</span>
        </div>
      </div>
    )
  }

  private onEnterPressed = () => {
    this.submitSearch(this.filterTokens)
  }

  private submitSearch = (tokens: ReadonlyArray<TFilterToken> = []) => {
    const { query, validEmailSet } = buildSearchResult(
      tokens,
      this.authorEmailSet
    )

    this.props.onSearchSubmitted(query, validEmailSet)
  }

  private onInputKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.isComposing) {
      return
    }

    if (!this.isAutocompleteVisible) {
      return
    }

    const { selectedAutocompleteRow } = this.state

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Prevent the input caret from being moved to the start/end of the
      // text (which would hide the autocomplete) and make sure the TextBox
      // never sees the key.
      event.preventDefault()
      event.stopPropagation()

      const nextRow = findNextSelectableRow(this.autocompleteItems.length, {
        direction: event.key === 'ArrowDown' ? 'down' : 'up',
        row: selectedAutocompleteRow ?? -1,
      })

      this.setState({ selectedAutocompleteRow: nextRow })
    } else if (event.key === 'Enter') {
      if (selectedAutocompleteRow !== null) {
        event.preventDefault()
        event.stopPropagation()

        this.insertCompletion(selectedAutocompleteRow)
      }

      // With no keyboard-selected row the event is left untouched so that
      // the TextBox can submit the search.
    } else if (event.key === 'Escape') {
      // Close the autocomplete without clearing the input text (the TextBox
      // would do so otherwise as it is a search input).
      event.preventDefault()
      event.stopPropagation()

      this.setState({
        isAutocompleteDismissed: true,
        selectedAutocompleteRow: null,
      })
    }
  }

  private insertCompletion(row: number) {
    const item = this.autocompleteItems[row]

    if (item === undefined) {
      return
    }

    const editedAuthorToken = this.editedAuthorToken

    if (editedAuthorToken === undefined) {
      return
    }

    const inserted = `author:${item.email} `

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
  }

  private onAutocompleteRowClicked = (row: number) => {
    this.insertCompletion(row)
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

const authorTokenRegExp = /(?:^|\s)author:(\S*)/

const RowHeight = 29

const DefaultPopupHeight = 200

const tokenValueClassNames: Record<TAuthorTokenState, string> = {
  valid: 'token-value',
  invalid: 'token-value-invalid',
  pending: 'token-value-pending',
}

function parseFilterTokens(
  text: string,
  emailSet: ReadonlySet<string>,
  caretOffset: number | null
): ReadonlyArray<TFilterToken> {
  const tokens: Array<TFilterToken> = []

  const regex = new RegExp(authorTokenRegExp.source, 'g')

  let cursor = 0
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(text)) !== null) {
    const tokenEnd = match.index + match[0].length
    const tokenStart = tokenEnd - match[1].length - 'author:'.length

    if (tokenStart > cursor) {
      tokens.push({
        kind: 'query',
        value: text.substring(cursor, tokenStart),
        start: cursor,
        end: tokenStart,
      })
    }

    const value = match[1]
    const isEdited = caretOffset !== null && tokenEnd === caretOffset
    const isLastToken = regex.lastIndex === text.length

    let state: TAuthorTokenState

    if (isEdited && !isLastToken) {
      state = 'pending'
    } else if (emailSet.has(value.toLowerCase())) {
      state = 'valid'
    } else if (isLastToken) {
      state = 'pending'
    } else {
      state = 'invalid'
    }

    tokens.push({
      kind: 'author',
      name: 'author',
      delimiter: ':',
      value,
      start: tokenStart,
      end: tokenEnd,
      state,
      isEdited,
    })

    cursor = tokenEnd
  }

  if (cursor < text.length) {
    tokens.push({
      kind: 'query',
      value: text.substring(cursor),
      start: cursor,
      end: text.length,
    })
  }

  return tokens
}

function buildSearchResult(
  tokens: ReadonlyArray<TFilterToken>,
  emailSet: ReadonlySet<string>
) {
  const validEmailSet = new Set<string>()

  const queryParts: Array<string> = []

  for (const token of tokens) {
    if (token.kind === 'query') {
      queryParts.push(token.value)
    } else if (token.value === '') {
      // A bare `author:` with no email is not a complete filter token so it
      // remains part of the search query, just like it did before the
      // token-based submit.
      queryParts.push(token.name + token.delimiter)
    } else if (emailSet.has(token.value.toLowerCase())) {
      validEmailSet.add(token.value.toLowerCase())
    }
  }

  const query = queryParts.join(' ').replace(/\s+/g, ' ').trim()

  return { query, validEmailSet }
}
