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

  private get authorEmailSet() {
    return new Set(
      (this.props.authorFilterOptions ?? []).map(a =>
        a.email.trim().toLowerCase()
      )
    )
  }

  public constructor(props: ICommitGraphFilterTextBoxProps) {
    super(props)

    this.state = { value: '' }
  }

  public componentWillUnmount() {
    this.detachScrollListener()
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

    const pendingAuthorValue = getPendingAuthorValue(value)

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
          {renderSegments(value, this.authorEmailSet, this.pendingTokenRef)}
        </div>
        {pendingAuthorValue !== null && (
          <div
            className="commitGraph-filter-autocomplete"
            ref={this.autocompleteRef}
          >
            Hello, world
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
    this.setState({
      value: text,
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

  private onTextBoxRef = (textBox: TextBox | null) => {
    this.detachScrollListener()

    this.inputElement = textBox !== null ? textBox.getInputElement() : null

    if (this.inputElement !== null) {
      this.inputElement.addEventListener('scroll', this.onInputScroll)
    }

    if (this.props.onRef && textBox !== null) {
      this.props.onRef(textBox)
    }
  }

  private detachScrollListener() {
    if (this.inputElement !== null) {
      this.inputElement.removeEventListener('scroll', this.onInputScroll)
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

function getPendingAuthorValue(text: string) {
  const segments = text.split(/(\s+)/).filter(s => s.length > 0)
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : ''
  const match = /^author:(\S*)$/.exec(lastSegment)

  return match === null ? null : match[1]
}

function renderSegments(
  text: string,
  optionSet: ReadonlySet<string>,
  pendingTokenRef: React.RefObject<HTMLSpanElement>
) {
  const segments = text.split(/(\s+)/).filter(s => s.length > 0)

  return segments.map((segment, i) => {
    const match = /^author:(\S+)$/.exec(segment)

    if (match === null) {
      const isBareAuthorToken =
        segment === 'author:' && i === segments.length - 1

      return (
        <span key={i} ref={isBareAuthorToken ? pendingTokenRef : undefined}>
          {segment}
        </span>
      )
    }

    const isLastSegment = i === segments.length - 1
    const tokenRef = isLastSegment ? pendingTokenRef : undefined

    const validEmail = optionSet.has(match[1].toLowerCase())

    const valueClassName = validEmail
      ? 'token-value'
      : isLastSegment
      ? 'token-value-invalid'
      : 'token-value-pending'

    return (
      <span key={i} ref={tokenRef}>
        <span className="token">author:</span>
        <span className={valueClassName}>{match[1]}</span>
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
