import * as React from 'react'
import {
  Account,
  isDotComAccount,
  isEnterpriseAccount,
} from '../../models/account'
import { IAvatarUser } from '../../models/avatar'
import { lookupPreferredEmail } from '../../lib/email'
import { assertNever } from '../../lib/fatal-error'
import { Button } from '../lib/button'
import { Row } from '../lib/row'
import { DialogContent, DialogPreferredFocusClassName } from '../dialog'
import { Avatar } from '../lib/avatar'
import { CallToAction } from '../lib/call-to-action'
import { LinkButton } from '../lib/link-button'
import {
  isCodebergCloud,
  isGitLabCloud,
  isGiteaCloud,
} from '../../lib/endpoint-capabilities'
import { SelfHostedApiType } from '../../lib/stores/sign-in-store'
import { groupAccountsByHost } from '../../lib/group-accounts-by-host'

interface IAccountsProps {
  readonly accounts: ReadonlyArray<Account>

  readonly onDotComSignIn: () => void
  readonly onEnterpriseSignIn: () => void
  readonly onBitbucketSignIn: () => void
  readonly onGitLabSignIn: () => void
  readonly onCodebergSignIn: () => void
  readonly onGiteaSignIn: () => void
  readonly onSelfHostedSignIn: (apiType: SelfHostedApiType) => void
  readonly onLogout: (account: Account) => void
}

enum SignInType {
  DotCom,
  Enterprise,
  Bitbucket,
  GitLab,
  Forgejo,
  Gitea,
}

const isSelfHostedAccount = (account: Account) =>
  (account.apiType === 'gitlab' && !isGitLabCloud(account.endpoint)) ||
  (account.apiType === 'forgejo' && !isCodebergCloud(account.endpoint)) ||
  (account.apiType === 'gitea' && !isGiteaCloud(account.endpoint))

/** The provider a section can add a self-hosted instance of, if any. */
const selfHostedApiTypeFor = (
  type: SignInType
): SelfHostedApiType | undefined => {
  switch (type) {
    case SignInType.GitLab:
      return 'gitlab'
    case SignInType.Forgejo:
      return 'forgejo'
    case SignInType.Gitea:
      return 'gitea'
    default:
      return undefined
  }
}

export class Accounts extends React.Component<IAccountsProps, {}> {
  public render() {
    const { accounts } = this.props
    const dotComAccounts = accounts.filter(isDotComAccount)

    return (
      <DialogContent className="accounts-tab">
        <div className="accounts-section">
          <h2>GitHub.com</h2>
          {dotComAccounts.map(account =>
            this.renderAccount(account, SignInType.DotCom)
          )}
          {dotComAccounts.length === 0 ? (
            this.renderSignIn(SignInType.DotCom)
          ) : (
            <Button onClick={this.props.onDotComSignIn}>
              Add GitHub.com account
            </Button>
          )}
        </div>

        <div className="accounts-section">
          <h2>GitHub Enterprise</h2>
          {this.renderMultipleEnterpriseAccounts()}
        </div>

        <div className="accounts-section">
          <h2>Bitbucket</h2>
          {this.renderMultipleBitbucketAccounts()}
        </div>

        <div className="accounts-section">
          <h2>GitLab</h2>
          {this.renderMultipleGitLabAccounts()}
        </div>

        <div className="accounts-section">
          <h2>Codeberg / Forgejo</h2>
          {this.renderMultipleForgejoAccounts()}
        </div>

        <div className="accounts-section">
          <h2>Gitea</h2>
          {this.renderMultipleGiteaAccounts()}
        </div>
      </DialogContent>
    )
  }

  private renderMultipleEnterpriseAccounts() {
    const enterpriseAccounts = this.props.accounts.filter(isEnterpriseAccount)

    if (enterpriseAccounts.length === 0) {
      return this.renderSignIn(SignInType.Enterprise)
    }

    return (
      <>
        {this.renderAccountsByHost(enterpriseAccounts, SignInType.Enterprise)}
        <Button onClick={this.props.onEnterpriseSignIn}>
          Add GitHub Enterprise account
        </Button>
      </>
    )
  }

  /** Render the given accounts under a heading per host. */
  private renderAccountsByHost(
    accounts: ReadonlyArray<Account>,
    type: SignInType
  ) {
    return groupAccountsByHost(accounts).map(([host, hostAccounts]) => {
      const headingId = `${SignInType[type].toLowerCase()}-accounts-${host}`
      return (
        <section
          key={host}
          className="enterprise-host"
          aria-labelledby={headingId}
        >
          <h3 id={headingId}>{host}</h3>
          {hostAccounts.map(account => this.renderAccount(account, type))}
        </section>
      )
    })
  }

  private renderMultipleBitbucketAccounts() {
    const bitbucketAccounts = this.props.accounts.filter(
      a => a.apiType === 'bitbucket'
    )
    return this.renderMultipleAccounts(
      bitbucketAccounts,
      SignInType.Bitbucket,
      'Add Bitbucket account',
      this.props.onBitbucketSignIn
    )
  }

  private renderMultipleGitLabAccounts() {
    const gitlabAccounts = this.props.accounts.filter(
      a => a.apiType === 'gitlab'
    )
    return this.renderMultipleAccounts(
      gitlabAccounts,
      SignInType.GitLab,
      'Add GitLab account',
      this.props.onGitLabSignIn
    )
  }

  private renderMultipleForgejoAccounts() {
    const forgejoAccounts = this.props.accounts.filter(
      a => a.apiType === 'forgejo'
    )
    return this.renderMultipleAccounts(
      forgejoAccounts,
      SignInType.Forgejo,
      'Add Codeberg account',
      this.props.onCodebergSignIn
    )
  }

  private renderMultipleGiteaAccounts() {
    const giteaAccounts = this.props.accounts.filter(a => a.apiType === 'gitea')
    return this.renderMultipleAccounts(
      giteaAccounts,
      SignInType.Gitea,
      'Add Gitea account',
      this.props.onGiteaSignIn
    )
  }

  private renderMultipleAccounts(
    accounts: ReadonlyArray<Account>,
    type: SignInType,
    buttonText: string,
    onSignIn: () => void
  ) {
    const cloudAccounts = accounts.filter(a => !isSelfHostedAccount(a))
    const selfHostedAccounts = accounts.filter(isSelfHostedAccount)

    return (
      <>
        {cloudAccounts.map(account => this.renderAccount(account, type))}
        {this.renderAccountsByHost(selfHostedAccounts, type)}
        {accounts.length === 0 ? (
          this.renderSignIn(type)
        ) : (
          <div className="add-account-button-row">
            <Button onClick={onSignIn}>{buttonText}</Button>
          </div>
        )}
        {this.renderSelfHostedSignIn(type)}
      </>
    )
  }

  private renderSelfHostedSignIn(type: SignInType) {
    const apiType = selfHostedApiTypeFor(type)

    return apiType === undefined ? null : (
      <Row>
        <LinkButton onClick={this.getOnSelfHostedSignIn(apiType)}>
          Add self-hosted instance…
        </LinkButton>
      </Row>
    )
  }

  private getOnSelfHostedSignIn = (apiType: SelfHostedApiType) => {
    return () => {
      this.props.onSelfHostedSignIn(apiType)
    }
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
      <Row
        key={JSON.stringify([
          account.endpoint.toLowerCase(),
          account.login.toLowerCase(),
        ])}
        className="account-info"
      >
        <div className="user-info-container">
          <Avatar accounts={this.props.accounts} user={avatarUser} />
          <div className="user-info">
            <div className="name">{account.name}</div>
            <div className="login">@{account.login}</div>
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

  private onCodebergSignIn = () => {
    this.props.onCodebergSignIn()
  }

  private onGiteaSignIn = () => {
    this.props.onGiteaSignIn()
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
      case SignInType.Forgejo:
        return (
          <CallToAction
            actionTitle={signInTitle + ' Codeberg'}
            onAction={this.onCodebergSignIn}
          >
            <div>
              Sign in to your Codeberg account to access your repositories.
            </div>
          </CallToAction>
        )
      case SignInType.Gitea:
        return (
          <CallToAction
            actionTitle={signInTitle + ' Gitea'}
            onAction={this.onGiteaSignIn}
          >
            <div>
              Sign in to your Gitea account to access your repositories.
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
