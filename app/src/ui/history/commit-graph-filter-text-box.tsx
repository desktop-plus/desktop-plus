import * as React from 'react'
import { FancyTextBox, IFancyTextBoxProps } from '../lib/fancy-text-box'
import { TextBox } from '../lib/text-box'
import classNames from 'classnames'
import { TAuthorFilterOption } from '../../lib/app-state'

interface ICommitGraphFilterTextBoxProps
  extends Omit<IFancyTextBoxProps, 'value' | 'onValueChanged'> {
  readonly authorFilterOptions: ReadonlyArray<TAuthorFilterOption> | null
  readonly onSearchSubmitted: (text: string, emailSet: Set<string>) => void
}

interface ICommitGraphFilterTextBoxState {
  readonly value: string
  readonly autocompleteAnchorOffset: number | null
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
  private wrapperRef = React.createRef<HTMLDivElement>()
  private pendingTokenRef = React.createRef<HTMLSpanElement>()
  private autocompleteRef = React.createRef<HTMLDivElement>()
  private inputElement: HTMLInputElement | null = null
  private textBox: TextBox | null = null

  private get authorEmailSet() {
    return new Set(
      (this.props.authorFilterOptions ?? []).map(a =>
        a.email.trim().toLowerCase()
      )
    )
  }

  public constructor(props: ICommitGraphFilterTextBoxProps) {
    super(props)

    this.state = { value: '', autocompleteAnchorOffset: null }
  }

  public componentWillUnmount() {
    this.detachInputListeners()
  }

  public componentDidUpdate() {
    this.syncBackdropScroll()
    this.positionAutocomplete()
  }

  public render() {
    const value = this.state.value

    const hasClearButton =
      value !== '' &&
      (this.props.type === 'search' || this.props.displayClearButton === true)

    const tokens = parseFilterTokens(
      value,
      this.authorEmailSet,
      this.state.autocompleteAnchorOffset
    )

    return (
      <div
        className={classNames('commitGraph-filter-text-box', {
          'with-clear-button': hasClearButton,
        })}
        ref={this.wrapperRef}
      >
        <div
          className="commitGraph-filter-text-box-backdrop"
          aria-hidden="true"
          ref={this.backdropRef}
        >
          {renderTokens(tokens, this.pendingTokenRef)}
        </div>
        {this.state.autocompleteAnchorOffset !== null && (
          <div
            className="commitGraph-filter-autocomplete"
            ref={this.autocompleteRef}
            role="listbox"
          >
            {renderAutocompleteItems()}
          </div>
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
    const caretOffset = this.inputElement?.selectionEnd ?? null

    const autocompleteAnchorOffset =
      caretOffset !== null && isCaretAtEndOfAuthorToken(text, caretOffset)
        ? caretOffset
        : null

    this.setState({
      value: text,
      autocompleteAnchorOffset,
    })

    if (text === '') {
      this.submitSearch('')
    }
  }

  private onEnterPressed = (text: string) => {
    this.submitSearch(text)
  }

  private submitSearch = (text: string) => {
    const { query, validEmailSet } = parseSearchQuery(text, this.authorEmailSet)

    this.props.onSearchSubmitted(query, validEmailSet)
  }

  private onInputScroll = () => {
    this.syncBackdropScroll()
    this.positionAutocomplete()
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
      this.setState({ autocompleteAnchorOffset: null })
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

  private positionAutocomplete = () => {
    const autocomplete = this.autocompleteRef.current
    const wrapper = this.wrapperRef.current
    const pendingToken = this.pendingTokenRef.current

    if (autocomplete === null || wrapper === null) {
      return
    }

    let left = 0

    if (pendingToken !== null) {
      left =
        pendingToken.getBoundingClientRect().left -
        wrapper.getBoundingClientRect().left

      const maxLeft = wrapper.offsetWidth - autocomplete.offsetWidth
      left = Math.max(0, Math.min(left, maxLeft))
    }

    autocomplete.style.left = `${left}px`
  }
}

const authorTokenRegExp = /(?:^|\s)author:(\S*)/g

const dummyAutocompleteItems: ReadonlyArray<TAuthorFilterOption> = [
  { name: 'Ashfaq Naseem', email: 'ashfaqnaseem1@gmail.com' },
  { name: 'Jane Doe', email: 'jane.doe@example.com' },
  { name: 'John Smith', email: 'john.smith@example.com' },
]

function renderAutocompleteItems() {
  return dummyAutocompleteItems.map((item, i) => (
    <div
      key={item.email}
      className={classNames('commitGraph-filter-autocomplete-item', {
        selected: i === 0,
      })}
      role="option"
      aria-selected={i === 0}
    >
      <span className="name">{item.name}</span>
      <span className="email">{item.email}</span>
    </div>
  ))
}

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
