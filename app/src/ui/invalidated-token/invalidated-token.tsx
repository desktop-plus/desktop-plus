import * as React from 'react'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { Dispatcher } from '../dispatcher'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Account } from '../../models/account'
import { getHTMLURL } from '../../lib/api'
import { Ref } from '../lib/ref'
import { assertNever } from '../../lib/fatal-error'

interface IInvalidatedTokenProps {
  readonly dispatcher: Dispatcher
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
          Your account token has been invalidated and you have been signed out
          from your <Ref>{account.friendlyEndpoint}</Ref> account. Do you want
          to sign in again?
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
        dispatcher.showDotComSignInDialog()
        break
      case 'enterprise':
        dispatcher.showEnterpriseSignInDialog(
          getHTMLURL(this.props.account.endpoint)
        )
        break
      case 'bitbucket':
        dispatcher.showBitbucketSignInDialog()
        break
      case 'gitlab':
        dispatcher.showGitLabSignInDialog()
        break
      default:
        console.error('Unknown sign-in dialog for account:', account)
        assertNever(account.apiType, 'Unknown sign-in dialog for account')
    }
  }
}
