import * as React from 'react'
import { IRemote } from '../../models/remote'
import { TextBox } from '../lib/text-box'
import { DialogContent } from '../dialog'
import { Account } from '../../models/account'
import { AccountPicker } from '../account-picker'
import { Repository } from '../../models/repository'
import { getDotComAPIEndpoint, getEndpointForRepository } from '../../lib/api'

interface IRemoteProps {
  /** The remote being shown. */
  readonly remote: IRemote

  readonly repository: Repository

  readonly account: Account | null

  readonly accounts: ReadonlyArray<Account>

  /** The default branch being shown. */
  readonly defaultBranch: string | undefined

  /** The function to call when the remote URL is changed by the user. */
  readonly onRemoteUrlChanged: (url: string) => void

  /** The function to call when the default branch is changed by the user. */
  readonly onDefaultBranchChanged: (branch: string) => void

  /** The function to call when the account is changed by the user. */
  readonly onSelectedAccountChanged: (account: Account) => void
}

/** The Remote component. */
export class Remote extends React.Component<IRemoteProps, {}> {
  public render() {
    const { remote, defaultBranch } = this.props

    const endpoint = this.props.repository.url
      ? getEndpointForRepository(this.props.repository.url)
      : getDotComAPIEndpoint()
    const noaccount = new Account(
      'no-account',
      endpoint,
      '',
      '',
      0,
      [],
      'No Account',
      -1,
      '',
      'free'
    )

    const account = this.props.account || noaccount

    const accounts: ReadonlyArray<Account> = [
      noaccount,
      ...this.props.accounts.filter(a => a.endpoint === endpoint),
    ]

    return (
      <DialogContent>
        <div className="config-row">
          <TextBox
            placeholder="Repository URL"
            readOnly={true}
            label={__DARWIN__ ? `Repository URL` : `repository URL`}
            value={this.props.repository.url || ''}
          />
        </div>
        <div className="config-row">
          <TextBox
            placeholder="Endpoint"
            readOnly={true}
            label={__DARWIN__ ? `Repository Endpoint` : `repository Endpoint`}
            value={endpoint}
          />
        </div>
        <div className="config-row">
          <TextBox
            placeholder="Remote URL"
            label={
              __DARWIN__
                ? `Primary Remote Repository (${remote.name}) URL`
                : `Primary remote repository (${remote.name}) URL`
            }
            value={remote.url}
            onValueChanged={this.props.onRemoteUrlChanged}
          />
        </div>
        <div className="config-row">
          <p>Override the remote's default branch</p>
          <TextBox
            placeholder="Default branch"
            value={defaultBranch}
            onValueChanged={this.props.onDefaultBranchChanged}
          />
        </div>
        <div className="config-row">
          <AccountPicker
            accounts={accounts}
            openButtonClassName="dialog-preferred-focus"
            selectedAccount={account}
            onSelectedAccountChanged={this.props.onSelectedAccountChanged}
          />
        </div>
      </DialogContent>
    )
  }
}
