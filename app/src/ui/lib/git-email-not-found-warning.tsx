import * as React from 'react'
import { Account } from '../../models/account'
import { LinkButton } from './link-button'
import { isAttributableEmailFor } from '../../lib/email'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { AriaLiveContainer } from '../accessibility/aria-live-container'
import { assertNever } from '../../lib/fatal-error'

interface IGitEmailNotFoundWarningProps {
  /** The account the commit should be attributed to. */
  readonly accounts: ReadonlyArray<Account>

  /** The email address used in the commit author info. */
  readonly email: string
}

/**
 * A component which just displays a warning to the user if their git config
 * email doesn't match any of the emails in their GitHub (Enterprise) account.
 */
export class GitEmailNotFoundWarning extends React.Component<IGitEmailNotFoundWarningProps> {
  private buildMessage(isAttributableEmail: boolean) {
    const indicatorIcon = !isAttributableEmail ? (
      <span className="warning-icon">⚠️</span>
    ) : (
      <span className="green-circle">
        <Octicon className="check-icon" symbol={octicons.check} />
      </span>
    )

    const learnMore = !isAttributableEmail ? (
      <LinkButton
        ariaLabel="Learn more about commit attribution"
        uri="https://docs.github.com/en/github/committing-changes-to-your-project/why-are-my-commits-linked-to-the-wrong-user"
      >
        Learn more.
      </LinkButton>
    ) : null

    return (
      <>
        {indicatorIcon}
        {this.buildScreenReaderMessage(isAttributableEmail)}
        {learnMore}
      </>
    )
  }

  private buildScreenReaderMessage(isAttributableEmail: boolean) {
    const verb = !isAttributableEmail ? 'does not match' : 'matches'
    const info = !isAttributableEmail
      ? 'Your commits will be wrongly attributed. '
      : ''
    return `This email address ${verb} ${this.getAccountTypeDescription()}. ${info}`
  }

  public render() {
    const { accounts, email } = this.props

    if (accounts.length === 0 || email.trim().length === 0) {
      return null
    }

    const isAttributableEmail = accounts.some(account =>
      isAttributableEmailFor(account, email)
    )

    /**
     * Here we put the message in the top div for visual users immediately  and
     * in the bottom div for screen readers. The screen reader content is
     * debounced to avoid frequent updates from typing in the email field.
     */
    return (
      <>
        <div className="git-email-not-found-warning">
          {this.buildMessage(isAttributableEmail)}
        </div>

        <AriaLiveContainer
          id="git-email-not-found-warning-for-screen-readers"
          trackedUserInput={this.props.email}
          message={this.buildScreenReaderMessage(isAttributableEmail)}
        />
      </>
    )
  }

  private getAccountTypeDescription() {
    if (this.props.accounts.length === 1) {
      return `your ${this.getAccountType(this.props.accounts[0])} account`
    }
    return 'either of your accounts'
  }

  private getAccountType(account: Account) {
    switch (account.apiType) {
      case 'dotcom':
        return 'GitHub'
      case 'enterprise':
        return 'GitHub Enterprise'
      case 'bitbucket':
        return 'Bitbucket'
      case 'gitlab':
        return 'GitLab'
      default:
        assertNever(account.apiType, 'Unknown account apiType')
    }
  }
}
