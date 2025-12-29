import * as React from 'react'
import { Account, isDotComAccount } from '../../models/account'
import { IAvatarUser } from '../../models/avatar'
import { lookupPreferredEmail } from '../../lib/email'
import { assertNever } from '../../lib/fatal-error'
import { Button } from '../lib/button'
import { Row } from '../lib/row'
import { DialogContent, DialogPreferredFocusClassName } from '../dialog'
import { Avatar } from '../lib/avatar'
import { CallToAction } from '../lib/call-to-action'
import {
  enableMultipleEnterpriseAccounts,
  enableMultipleLoginAccounts,
  enableBitbucketIntegration,
  enableGitLabIntegration,
} from '../../lib/feature-flag'
import { getHTMLURL } from '../../lib/api'

interface IAccountsProps {
  readonly accounts: ReadonlyArray<Account>

  readonly onDotComSignIn: () => void
  readonly onEnterpriseSignIn: () => void
  readonly onBitbucketSignIn: () => void
  readonly onGitLabSignIn: () => void
  readonly onLogout: (account: Account) => void
}

enum SignInType {
  DotCom,
  Enterprise,
  Bitbucket,
  GitLab,
}

export class Accounts extends React.Component<IAccountsProps, {}> {
  public render() {
    const { accounts } = this.props
    const bitbucketAccount = accounts.find(a => a.apiType === 'bitbucket')
    const gitlabAccount = accounts.find(a => a.apiType === 'gitlab')

    return (
      <DialogContent className="accounts-tab">
        <h2>GitHub.com</h2>
        {enableMultipleLoginAccounts()
          ? this.renderMultipleDotComAccounts()
          : this.renderSingleDotComAccount()}

        <h2>GitHub Enterprise</h2>
        {enableMultipleEnterpriseAccounts()
          ? this.renderMultipleEnterpriseAccounts()
          : this.renderSingleEnterpriseAccount()}

        {enableBitbucketIntegration() && (
          <>
            <h2>Bitbucket</h2>
            {bitbucketAccount
              ? this.renderAccount(bitbucketAccount, SignInType.Bitbucket)
              : this.renderSignIn(SignInType.Bitbucket)}
          </>
        )}

        {enableGitLabIntegration() && (
          <>
            <h2>GitLab</h2>
            {gitlabAccount
              ? this.renderAccount(gitlabAccount, SignInType.GitLab)
              : this.renderSignIn(SignInType.GitLab)}
          </>
        )}
      </DialogContent>
    )
  }

  private renderSingleDotComAccount() {
    const dotComAccount = this.props.accounts.find(isDotComAccount)

    return dotComAccount
      ? this.renderAccount(dotComAccount, SignInType.DotCom)
      : this.renderSignIn(SignInType.DotCom)
  }

  private renderMultipleDotComAccounts() {
    const dotComAccounts = this.props.accounts.filter(isDotComAccount)

    return (
      <>
        {dotComAccounts.map(account => {
          return this.renderAccount(account, SignInType.DotCom)
        })}
        {dotComAccounts.length === 0 ? (
          this.renderSignIn(SignInType.DotCom)
        ) : (
          <Button onClick={this.props.onDotComSignIn}>
            Add GitHub account
          </Button>
        )}
      </>
    )
  }

  private renderSingleEnterpriseAccount() {
    const enterpriseAccount = this.props.accounts.find(
      a => a.apiType === 'enterprise'
    )

    return enterpriseAccount
      ? this.renderAccount(enterpriseAccount, SignInType.Enterprise)
      : this.renderSignIn(SignInType.Enterprise)
  }

  private renderMultipleEnterpriseAccounts() {
    const enterpriseAccounts = this.props.accounts.filter(
      a => a.apiType === 'enterprise'
    )

    return (
      <>
        {enterpriseAccounts.map(account => {
          return this.renderAccount(account, SignInType.Enterprise)
        })}
        {enterpriseAccounts.length === 0 ? (
          this.renderSignIn(SignInType.Enterprise)
        ) : (
          <Button onClick={this.props.onEnterpriseSignIn}>
            Add GitHub Enteprise account
          </Button>
        )}
      </>
    )
  }

  private renderAccount(account: Account, type: SignInType) {
    const avatarUser: IAvatarUser = {
      name: account.name,
      email: lookupPreferredEmail(account),
      avatarURL: account.avatarURL,
      endpoint: account.endpoint,
    }

    // The DotCom account is shown first, so its sign in/out button should be
    // focused initially when the dialog is opened.
    const className =
      type === SignInType.DotCom ? DialogPreferredFocusClassName : undefined

    return (
      <Row className="account-info">
        <div className="user-info-container">
          <Avatar accounts={this.props.accounts} user={avatarUser} />
          <div className="user-info">
            {enableMultipleEnterpriseAccounts() &&
            account.apiType === 'enterprise' ? (
              <>
                <div className="account-title">
                  {account.name === account.login
                    ? `@${account.login}`
                    : `@${account.login} (${account.name})`}
                </div>
                <div className="endpoint">{getHTMLURL(account.endpoint)}</div>
              </>
            ) : (
              <>
                <div className="name">{account.name}</div>
                <div className="login">@{account.login}</div>
              </>
            )}
          </div>
        </div>
        <Button onClick={this.logout(account)} className={className}>
          {__DARWIN__ ? 'Sign Out' : 'Sign out'}
        </Button>
      </Row>
    )
  }

  private onDotComSignIn = () => {
    this.props.onDotComSignIn()
  }

  private onEnterpriseSignIn = () => {
    this.props.onEnterpriseSignIn()
  }

  private onBitbucketSignIn = () => {
    this.props.onBitbucketSignIn()
  }

  private onGitLabSignIn = () => {
    this.props.onGitLabSignIn()
  }

  private renderSignIn(type: SignInType) {
    const signInTitle = __DARWIN__ ? 'Sign Into' : 'Sign into'
    switch (type) {
      case SignInType.DotCom: {
        return (
          <CallToAction
            actionTitle={signInTitle + ' GitHub.com'}
            onAction={this.onDotComSignIn}
            // The DotCom account is shown first, so its sign in/out button should be
            // focused initially when the dialog is opened.
            buttonClassName={DialogPreferredFocusClassName}
          >
            <div>
              Sign in to your GitHub.com account to access your repositories.
            </div>
          </CallToAction>
        )
      }
      case SignInType.Enterprise:
        return (
          <CallToAction
            actionTitle={signInTitle + ' GitHub Enterprise'}
            onAction={this.onEnterpriseSignIn}
          >
            <div>
              If you are using GitHub Enterprise at work, sign in to it to get
              access to your repositories.
            </div>
          </CallToAction>
        )
      case SignInType.Bitbucket:
        return (
          <CallToAction
            actionTitle={signInTitle + ' Bitbucket'}
            onAction={this.onBitbucketSignIn}
          >
            <div>
              Sign in to your Bitbucket account to access your repositories.
            </div>
          </CallToAction>
        )
      case SignInType.GitLab:
        return (
          <CallToAction
            actionTitle={signInTitle + ' GitLab'}
            onAction={this.onGitLabSignIn}
          >
            <div>
              Sign in to your GitLab account to access your repositories.
            </div>
          </CallToAction>
        )
      default:
        return assertNever(type, `Unknown sign in type: ${type}`)
    }
  }

  private logout = (account: Account) => {
    return () => {
      this.props.onLogout(account)
    }
  }
}
