import * as React from 'react'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { Dispatcher } from '../dispatcher'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Account } from '../../models/account'
import { getHTMLURL } from '../../lib/api'
import {
  isCodebergCloud,
  isGitLabCloud,
  isGiteaCloud,
} from '../../lib/endpoint-capabilities'
import { Ref } from '../lib/ref'
import { assertNever } from '../../lib/fatal-error'

interface IInvalidatedTokenProps {
  readonly dispatcher: Pick<
    Dispatcher,
    | 'showAccountSignInDialog'
    | 'showBitbucketSignInDialog'
    | 'showGitLabSignInDialog'
    | 'showCodebergSignInDialog'
    | 'showGiteaSignInDialog'
    | 'showSelfHostedSignInDialog'
  >
  readonly account: Account
  readonly onDismissed: () => void
}

/**
 * Dialog that alerts user that their GitHub (Enterprise) account token is not
 * valid and they need to sign in again.
 */
export class InvalidatedToken extends React.Component<IInvalidatedTokenProps> {
  public render() {
    const { account } = this.props

    return (
      <Dialog
        id="invalidated-token"
        type="warning"
        title={
          __DARWIN__ ? 'Invalidated Account Token' : 'Invalidated account token'
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
      >
        <DialogContent>
          Your account token is no longer valid and you have been signed out
          from your <Ref>{account.login}</Ref> account on{' '}
          <Ref>{account.friendlyEndpoint}</Ref>. Do you want to sign in again?
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup okButtonText="Yes" cancelButtonText="No" />
        </DialogFooter>
      </Dialog>
    )
  }

  private onSubmit = () => {
    const { dispatcher, onDismissed, account } = this.props

    onDismissed()

    switch (account.apiType) {
      case 'dotcom':
      case 'enterprise':
        // Other accounts may still be signed in to the same endpoint, so sign
        // back in to this specific account rather than any account.
        dispatcher.showAccountSignInDialog(account.endpoint, account.login)
        break
      case 'bitbucket':
        dispatcher.showBitbucketSignInDialog()
        break
      case 'gitlab':
        if (isGitLabCloud(account.endpoint)) {
          dispatcher.showGitLabSignInDialog()
        } else {
          dispatcher.showSelfHostedSignInDialog(
            'gitlab',
            getHTMLURL(account.endpoint)
          )
        }
        break
      case 'forgejo':
        if (isCodebergCloud(account.endpoint)) {
          dispatcher.showCodebergSignInDialog()
        } else {
          dispatcher.showSelfHostedSignInDialog(
            'forgejo',
            getHTMLURL(account.endpoint)
          )
        }
        break
      case 'gitea':
        if (isGiteaCloud(account.endpoint)) {
          dispatcher.showGiteaSignInDialog()
        } else {
          dispatcher.showSelfHostedSignInDialog(
            'gitea',
            getHTMLURL(account.endpoint)
          )
        }
        break
      default:
        console.error('Unknown sign-in dialog for account:', account)
        assertNever(account.apiType, 'Unknown sign-in dialog for account')
    }
  }
}
