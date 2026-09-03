import * as React from 'react'
import { FancyTextBox, IFancyTextBoxProps } from '../lib/fancy-text-box'
import { TextBox } from '../lib/text-box'
import classNames from 'classnames'
import { TAuthorFilterOption } from '../../lib/app-state'
import {
  Popover,
  PopoverAnchorPosition,
  PopoverDecoration,
} from '../lib/popover'
import { List, findNextSelectableRow } from '../lib/list'

interface ICommitGraphFilterTextBoxProps
  extends Omit<IFancyTextBoxProps, 'value' | 'onValueChanged'> {
  readonly authorFilterOptions: ReadonlyArray<TAuthorFilterOption> | null
  readonly onSearchSubmitted: (text: string, emailSet: Set<string>) => void
}

interface ICommitGraphFilterTextBoxState {
  readonly value: string
  readonly autocompleteAnchorOffset: number | null
  readonly autocompleteAnchorElement: HTMLSpanElement | null
  readonly tokens: ReadonlyArray<TFilterToken>
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
  private pendingTokenRef = React.createRef<HTMLSpanElement>()
  private inputElement: HTMLInputElement | null = null
  private textBox: TextBox | null = null

  private autocompleteItems: ReadonlyArray<TAuthorFilterOption> = []

  private pendingCaretOffset: number | null = null

  private get authorEmailSet() {
    return new Set(
      (this.props.authorFilterOptions ?? []).map(a =>
        a.email.trim().toLowerCase()
      )
    )
  }

  public constructor(props: ICommitGraphFilterTextBoxProps) {
    super(props)

    this.state = {
      value: '',
      autocompleteAnchorOffset: null,
      autocompleteAnchorElement: null,
      tokens: [],
      selectedAutocompleteRow: null,
    }
  }

  public componentWillUnmount() {
    this.detachInputListeners()
  }

  public componentDidUpdate() {
    this.syncBackdropScroll()

    // The pending token element ref is only assigned during the commit phase
    // (after render) so the anchor element for the autocomplete popover is
    // settled here. Rendering the popover before the anchor is available
    // would briefly display it unpositioned.
    if (this.state.autocompleteAnchorOffset !== null) {
      const anchorElement = this.pendingTokenRef.current

      if (this.state.autocompleteAnchorElement !== anchorElement) {
        this.setState({ autocompleteAnchorElement: anchorElement })
      }
    } else if (this.state.autocompleteAnchorElement !== null) {
      this.setState({ autocompleteAnchorElement: null })
    }

    if (this.pendingCaretOffset !== null && this.inputElement !== null) {
      // This component updates after the TextBox (children update first) so
      // this runs after the TextBox has restored its (now stale) cursor
      // position, overriding it with the caret position the completion
      // insert warrants.
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

  public render() {
    const value = this.state.value

    const hasClearButton =
      value !== '' &&
      (this.props.type === 'search' || this.props.displayClearButton === true)

    const editedAuthorToken = this.state.tokens.find(
      (token): token is Extract<TFilterToken, { kind: 'author' }> =>
        token.kind === 'author' && token.isEdited
    )

    this.autocompleteItems = []

    if (
      editedAuthorToken !== undefined &&
      this.props.authorFilterOptions !== null
    ) {
      const searchToken = editedAuthorToken.value.trim().toLowerCase()
      this.autocompleteItems = this.props.authorFilterOptions.filter(
        ({ email }) => email.toLowerCase().includes(searchToken)
      )
    }

    const showAutocomplete =
      this.state.autocompleteAnchorElement !== null &&
      this.autocompleteItems.length > 0

    return (
      <div
        className={classNames('commitGraph-filter-text-box', {
          'with-clear-button': hasClearButton,
        })}
      >
        <div
          className="commitGraph-filter-text-box-backdrop"
          aria-hidden="true"
          ref={this.backdropRef}
        >
          {renderTokens(this.state.tokens, this.pendingTokenRef)}
        </div>
        {showAutocomplete && (
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
        )}
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
    )
  }

  private onValueChanged = (text: string) => {
    this.setState({ value: text })

    const caretOffset = this.inputElement?.selectionEnd ?? null

    const autocompleteAnchorOffset =
      caretOffset !== null && isCaretAtEndOfAuthorToken(text, caretOffset)
        ? caretOffset
        : null

    const tokens = parseFilterTokens(
      text,
      this.authorEmailSet,
      autocompleteAnchorOffset
    )

    this.setState({
      autocompleteAnchorOffset,
      tokens,
      selectedAutocompleteRow: null,
    })

    if (text === '') {
      this.submitSearch('')
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

  private onEnterPressed = (text: string) => {
    this.submitSearch(text)
  }

  private submitSearch = (text: string) => {
    const { query, validEmailSet } = parseSearchQuery(text, this.authorEmailSet)

    this.props.onSearchSubmitted(query, validEmailSet)
  }

  private onInputKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return
    }

    const isAutocompleteVisible =
      this.state.autocompleteAnchorElement !== null &&
      this.autocompleteItems.length > 0

    if (!isAutocompleteVisible) {
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
        autocompleteAnchorOffset: null,
        autocompleteAnchorElement: null,
        selectedAutocompleteRow: null,
        tokens: parseFilterTokens(this.state.value, this.authorEmailSet, null),
      })
    }
  }

  private insertCompletion(row: number) {
    const item = this.autocompleteItems[row]

    if (item === undefined) {
      return
    }

    const editedAuthorToken = this.state.tokens.find(
      (token): token is Extract<TFilterToken, { kind: 'author' }> =>
        token.kind === 'author' && token.isEdited
    )

    if (editedAuthorToken === undefined) {
      return
    }

    const inserted = `author:${item.email} `

    const newValue =
      this.state.value.substring(0, editedAuthorToken.start) +
      inserted +
      this.state.value.substring(editedAuthorToken.end)

    this.pendingCaretOffset = editedAuthorToken.start + inserted.length

    this.setState({
      value: newValue,
      tokens: parseFilterTokens(newValue, this.authorEmailSet, null),
      autocompleteAnchorOffset: null,
      autocompleteAnchorElement: null,
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

    const { autocompleteAnchorOffset } = this.state

    if (autocompleteAnchorOffset === null) {
      return
    }

    const input = this.inputElement

    const isCollapsedCaretAtAnchor =
      input !== null &&
      input.selectionStart === input.selectionEnd &&
      input.selectionEnd === autocompleteAnchorOffset

    if (!isCollapsedCaretAtAnchor) {
      this.setState({
        autocompleteAnchorOffset: null,
        selectedAutocompleteRow: null,
      })
    }
  }

  private onTextBoxRef = (textBox: TextBox | null) => {
    this.detachInputListeners()

    this.textBox = textBox
    this.inputElement = textBox !== null ? textBox.getInputElement() : null

    if (this.inputElement !== null) {
      this.inputElement.addEventListener('scroll', this.onInputScroll)
      this.inputElement.addEventListener('keyup', this.onCaretMoved)
      this.inputElement.addEventListener('mouseup', this.onCaretMoved)
      this.inputElement.addEventListener('select', this.onCaretMoved)
      this.inputElement.addEventListener(
        'keydown',
        this.onInputKeyDown,
        // The keydown listener is registered in the capture phase so that it
        // gets a chance to intercept keys (Enter, Escape, arrows) bound for
        // the autocomplete before the TextBox handles them.
        true
      )
    }

    if (this.props.onRef && textBox !== null) {
      this.props.onRef(textBox)
    }
  }

  private detachInputListeners() {
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
    const backdrop = this.backdropRef.current

    if (backdrop === null || this.inputElement === null) {
      return
    }

    backdrop.scrollLeft = this.inputElement.scrollLeft
  }
}

const authorTokenRegExp = /(?:^|\s)author:(\S*)/

const RowHeight = 29

const DefaultPopupHeight = 100

function isCaretAtEndOfAuthorToken(text: string, caretOffset: number) {
  const regex = new RegExp(authorTokenRegExp.source, 'g')

  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    if (match.index + match[0].length === caretOffset) {
      return true
    }
  }

  return false
}

function parseFilterTokens(
  text: string,
  emailSet: ReadonlySet<string>,
  anchorOffset: number | null
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
    const isEdited = anchorOffset !== null && tokenEnd === anchorOffset
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

function renderTokens(
  tokens: ReadonlyArray<TFilterToken>,
  pendingTokenRef: React.RefObject<HTMLSpanElement>
) {
  return tokens.map((token, i) => {
    if (token.kind === 'query') {
      return <span key={i}>{token.value}</span>
    }

    const valueClassName =
      token.state === 'valid'
        ? 'token-value'
        : token.state === 'invalid'
        ? 'token-value-invalid'
        : 'token-value-pending'

    return (
      <span key={i} ref={token.isEdited ? pendingTokenRef : undefined}>
        <span className="token">
          {token.name}
          {token.delimiter}
        </span>
        <span className={valueClassName}>{token.value}</span>
      </span>
    )
  })
}

function parseSearchQuery(
  searchQuery: string,
  authorEmailSet: ReadonlySet<string>
) {
  const validEmailSet = new Set<string>()
  const query = searchQuery
    .replace(/(?:^|\s)author:(\S+)/g, (_match, email: string) => {
      if (authorEmailSet.has(email.toLowerCase())) {
        validEmailSet.add(email.toLowerCase())
      }
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()

  return { validEmailSet, query }
}
