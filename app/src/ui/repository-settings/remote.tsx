import * as React from 'react'
import { IRemote } from '../../models/remote'
import { TextBox } from '../lib/text-box'
import { Repository } from '../../models/repository'
import { getDotComAPIEndpoint, getEndpointForRepository } from '../../lib/api'
import { getDefaultRemoteUrl } from '../../lib/repository-remote-url'

interface IRemoteProps {
  /** The remote being shown. */
  readonly remote: IRemote

  readonly repository: Repository

  /** The default branch being shown. */
  readonly defaultBranch: string | undefined

  /** The function to call when the remote URL is changed by the user. */
  readonly onRemoteUrlChanged: (url: string) => void

  /** The function to call when the default branch is changed by the user. */
  readonly onDefaultBranchChanged: (branch: string) => void
}

/** The Remote component. */
export class Remote extends React.Component<IRemoteProps, {}> {
  public render() {
    const { remote, defaultBranch } = this.props

    const url = getDefaultRemoteUrl(this.props.repository)
    const repoEndpoint = url ? getEndpointForRepository(url) : null
    const endpoint = repoEndpoint ?? getDotComAPIEndpoint()

    return (
      <>
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
          <TextBox
            placeholder="Endpoint"
            readOnly={true}
            label="API Endpoint"
            value={endpoint}
          />
        </div>
      </>
    )
  }
}
