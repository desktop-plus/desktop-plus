import * as React from 'react'
import { Octicon, OcticonSymbol } from '../octicons'
import { TextBox, ITextBoxProps } from './text-box'
import classNames from 'classnames'

export interface IFancyTextBoxProps extends ITextBoxProps {
  /** Icon to render */
  readonly symbol: OcticonSymbol

  readonly symbolClassName?: string

  /** Callback used to get a reference to internal TextBox */
  readonly onRef?: (textbox: TextBox) => void
}

interface IFancyTextBoxState {
  readonly isFocused: boolean
}

export class FancyTextBox extends React.Component<
  IFancyTextBoxProps,
  IFancyTextBoxState
> {
  public constructor(props: IFancyTextBoxProps) {
    super(props)

    this.state = { isFocused: false }
  }

  public render() {
    const componentCSS = classNames(
      'fancy-text-box-component',
      this.props.className,
      { disabled: this.props.disabled },
      { focused: this.state.isFocused }
    )

    return (
      <div className={componentCSS}>
        <div className="fancy-octicon">
          <Octicon
            className={this.props.symbolClassName}
            symbol={this.props.symbol}
          />
        </div>
        <TextBox
          ariaLabel={this.props.ariaLabel}
          value={this.props.value}
          onFocus={this.onFocus}
          onBlur={this.onBlur}
          autoFocus={this.props.autoFocus}
          disabled={this.props.disabled}
          type={this.props.type}
          placeholder={this.props.placeholder}
          displayClearButton={this.props.displayClearButton}
          onKeyDown={this.props.onKeyDown}
          onEnterPressed={this.props.onEnterPressed}
          onValueChanged={this.props.onValueChanged}
          onSearchCleared={this.props.onSearchCleared}
          tabIndex={this.props.tabIndex}
          ref={this.props.onRef}
        />
      </div>
    )
  }

  private onFocus = () => {
    if (this.props.onFocus !== undefined) {
      this.props.onFocus()
    }

    this.setState({ isFocused: true })
  }

  private onBlur = (value: string) => {
    if (this.props.onBlur !== undefined) {
      this.props.onBlur(value)
    }

    this.setState({ isFocused: false })
  }
}
