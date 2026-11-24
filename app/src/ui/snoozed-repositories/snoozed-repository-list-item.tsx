import * as React from 'react'

import { nameOf, Repository } from '../../models/repository'
import { formatDate } from '../../lib/format-date'
import { Button } from '../lib/button'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'

interface ISnoozedRepositoryListItemProps {
  readonly repository: Repository

  /** When the snooze ends, in milliseconds since the epoch */
  readonly until: number

  readonly onUnsnooze: (repository: Repository) => void
}

export class SnoozedRepositoryListItem extends React.Component<ISnoozedRepositoryListItemProps> {
  private onUnsnoozeClick = () => {
    this.props.onUnsnooze(this.props.repository)
  }

  public render() {
    const name = nameOf(this.props.repository)
    const until = formatDate(new Date(this.props.until))
    const unsnoozeLabel = `Unsnooze "${name}"`

    return (
      <li className="snoozed-repository-list-item">
        <Octicon className="icon" symbol={octicons.repo} />
        <span className="name">{name}</span>
        <span className="until">Until {until}</span>
        <Button
          className="unsnooze-button"
          tooltip={unsnoozeLabel}
          ariaLabel={unsnoozeLabel}
          onClick={this.onUnsnoozeClick}
        >
          Unsnooze
        </Button>
      </li>
    )
  }
}
