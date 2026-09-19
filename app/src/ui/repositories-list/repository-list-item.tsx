import * as React from 'react'
import * as Path from 'path'

import { Repository } from '../../models/repository'
import { Octicon, iconForRepository } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Repositoryish } from './group-repositories'
import { WorktreeEntry } from '../../models/worktree'
import { SubmoduleEntry } from '../../models/submodule'
import { shortenSHA } from '../../models/commit'
import { HighlightText } from '../lib/highlight-text'
import { IMatches } from '../../lib/fuzzy-find'
import { IAheadBehind } from '../../models/branch'
import classNames from 'classnames'
import { createObservableRef } from '../lib/observable-ref'
import { Tooltip } from '../lib/tooltip'
import { enableAccessibleListToolTips } from '../../lib/feature-flag'
import { TooltippedContent } from '../lib/tooltipped-content'

interface IRepositoryListItemProps {
  readonly id: string
  readonly repository: Repositoryish

  /** Does the repository need to be disambiguated in the list? */
  readonly needsDisambiguation: boolean

  /** The characters in the repository name to highlight */
  readonly matches: IMatches

  /** Number of commits this local repo branch is behind or ahead of its remote branch */
  readonly aheadBehind: IAheadBehind | null

  /** Number of uncommitted changes */
  readonly changedFilesCount: number

  /** The name of the current branch, if it should be displayed */
  readonly branchName: string | null

  /**
   * When set to a linked worktree, this row renders as a worktree nested below
   * its repository instead of as the repository itself.
   */
  readonly worktree: WorktreeEntry | null

  readonly submodule: SubmoduleEntry | null
  readonly submoduleDepth: number
  readonly linkedRepository: Repository | null
  readonly hasChildren: boolean
  readonly isExpanded: boolean

  readonly onToggleExpanded: (id: string) => void
}

/** Renders the branch name badge shown next to a repository or worktree. */
function renderBranchNameBadge(branchName: string | null) {
  if (!branchName) {
    return null
  }

  return (
    <span className="branch-name">
      <Octicon className="branch-icon" symbol={octicons.gitBranch} />
      {branchName}
    </span>
  )
}

/** A repository item. */
export class RepositoryListItem extends React.Component<
  IRepositoryListItemProps,
  {}
> {
  private readonly listItemRef = createObservableRef<HTMLDivElement>()

  public render() {
    const { worktree, submodule, submoduleDepth } = this.props
    if (submodule !== null) {
      return this.renderSubmodule(submodule, submoduleDepth)
    }
    return worktree !== null && worktree.type === 'linked'
      ? this.renderWorktree(worktree)
      : this.renderRepository()
  }

  private renderRepository() {
    const repository = this.props.repository
    const gitHubRepo =
      repository instanceof Repository ? repository.gitHubRepository : null
    const hasChanges = this.props.changedFilesCount > 0

    const alias: string | null =
      repository instanceof Repository ? repository.alias : null

    let prefix: string | null = null
    if (this.props.needsDisambiguation && gitHubRepo) {
      prefix = `${gitHubRepo.owner.login}/`
    }

    const classNameList = classNames('name', {
      alias: alias !== null,
    })

    return (
      <div className="repository-list-item" ref={this.listItemRef}>
        <Tooltip
          target={this.listItemRef}
          disabled={enableAccessibleListToolTips()}
        >
          {this.renderTooltip()}
        </Tooltip>

        {this.renderDisclosure()}

        <Octicon
          className="icon-for-repository"
          symbol={iconForRepository(repository)}
        />

        <div className={classNames(classNameList)}>
          {prefix ? <span className="prefix">{prefix}</span> : null}
          <HighlightText
            text={alias ?? repository.name}
            highlight={this.props.matches.title}
          />
        </div>

        {renderBranchNameBadge(this.props.branchName)}

        {repository instanceof Repository &&
          renderRepoIndicators({
            aheadBehind: this.props.aheadBehind,
            hasChanges: hasChanges,
          })}
      </div>
    )
  }

  private renderWorktree(worktree: WorktreeEntry) {
    return (
      <div
        className="repository-list-item repository-worktree-item"
        ref={this.listItemRef}
      >
        <Tooltip
          target={this.listItemRef}
          disabled={enableAccessibleListToolTips()}
        >
          {this.renderWorktreeTooltip(worktree)}
        </Tooltip>

        <Octicon
          className="icon-for-repository"
          symbol={octicons.fileDirectory}
        />

        <div className="name">
          <HighlightText
            text={Path.basename(worktree.path)}
            highlight={this.props.matches.title}
          />
        </div>

        {renderBranchNameBadge(this.props.branchName)}

        {renderRepoIndicators({
          aheadBehind: this.props.aheadBehind,
          hasChanges: this.props.changedFilesCount > 0,
        })}
      </div>
    )
  }

  private onToggleExpandedClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    this.props.onToggleExpanded(this.props.id)
  }

  private onToggleExpandedKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }

  private renderDisclosure() {
    if (!this.props.hasChildren) {
      return <span className="repository-list-item-disclosure-spacer" />
    }

    return (
      <button
        type="button"
        className="repository-list-item-disclosure"
        aria-expanded={this.props.isExpanded}
        aria-label={this.props.isExpanded ? 'Collapse' : 'Expand'}
        onClick={this.onToggleExpandedClick}
        onKeyDown={this.onToggleExpandedKeyDown}
      >
        <Octicon
          symbol={
            this.props.isExpanded
              ? octicons.triangleDown
              : octicons.triangleRight
          }
        />
      </button>
    )
  }

  private renderSubmodule(submodule: SubmoduleEntry, depth: number) {
    const { linkedRepository, branchName, changedFilesCount } = this.props
    const hasChanges = changedFilesCount > 0

    return (
      <div
        className="repository-list-item repository-submodule-item"
        style={{ '--submodule-depth': depth } as React.CSSProperties}
        ref={this.listItemRef}
      >
        <Tooltip
          target={this.listItemRef}
          disabled={enableAccessibleListToolTips()}
        >
          {this.renderSubmoduleTooltip(submodule)}
        </Tooltip>

        {this.renderDisclosure()}

        <Octicon className="icon-for-repository" symbol={octicons.repo} />

        <div className="name">
          <HighlightText
            text={Path.basename(submodule.path)}
            highlight={this.props.matches.title}
          />
        </div>

        {linkedRepository !== null ? (
          <>
            {renderBranchNameBadge(branchName)}
            {renderRepoIndicators({
              aheadBehind: this.props.aheadBehind,
              hasChanges,
            })}
          </>
        ) : (
          <span className="branch-name">{shortenSHA(submodule.sha)}</span>
        )}
      </div>
    )
  }

  private renderTooltip() {
    const repo = this.props.repository
    const gitHubRepo = repo instanceof Repository ? repo.gitHubRepository : null
    const alias = repo instanceof Repository ? repo.alias : null
    const realName = gitHubRepo ? gitHubRepo.fullName : repo.name

    return (
      <>
        <div>
          <strong>{realName}</strong>
          {alias && <> ({alias})</>}
        </div>
        <div>{repo.path}</div>
        {this.props.branchName && <div>Branch: {this.props.branchName}</div>}
      </>
    )
  }

  private renderWorktreeTooltip(worktree: WorktreeEntry) {
    return (
      <>
        <div>{worktree.path}</div>
        {this.props.branchName && <div>Branch: {this.props.branchName}</div>}
      </>
    )
  }

  private renderSubmoduleTooltip(submodule: SubmoduleEntry) {
    const { linkedRepository, branchName } = this.props
    return (
      <>
        <div>{linkedRepository?.path ?? submodule.path}</div>
        {linkedRepository !== null && branchName ? (
          <div>Branch: {branchName}</div>
        ) : (
          <div>{submodule.describe}</div>
        )}
      </>
    )
  }

  public shouldComponentUpdate(nextProps: IRepositoryListItemProps): boolean {
    if (
      nextProps.repository instanceof Repository &&
      this.props.repository instanceof Repository
    ) {
      return (
        nextProps.repository.id !== this.props.repository.id ||
        nextProps.repository !== this.props.repository ||
        nextProps.matches !== this.props.matches ||
        nextProps.branchName !== this.props.branchName ||
        nextProps.needsDisambiguation !== this.props.needsDisambiguation ||
        nextProps.aheadBehind !== this.props.aheadBehind ||
        nextProps.changedFilesCount !== this.props.changedFilesCount ||
        nextProps.worktree !== this.props.worktree ||
        nextProps.submodule !== this.props.submodule ||
        nextProps.submoduleDepth !== this.props.submoduleDepth ||
        nextProps.linkedRepository !== this.props.linkedRepository ||
        nextProps.hasChildren !== this.props.hasChildren ||
        nextProps.isExpanded !== this.props.isExpanded
      )
    } else {
      return true
    }
  }
}

const renderRepoIndicators: React.FunctionComponent<{
  aheadBehind: IAheadBehind | null
  hasChanges: boolean
}> = props => {
  return (
    <div className="repo-indicators">
      {props.aheadBehind && renderAheadBehindIndicator(props.aheadBehind)}
      {props.hasChanges && renderChangesIndicator()}
    </div>
  )
}

const renderAheadBehindIndicator = (aheadBehind: IAheadBehind) => {
  const { ahead, behind } = aheadBehind
  if (ahead === 0 && behind === 0) {
    return null
  }

  const aheadBehindTooltip =
    'The currently checked out branch is' +
    (behind ? ` ${commitGrammar(behind)} behind ` : '') +
    (behind && ahead ? 'and' : '') +
    (ahead ? ` ${commitGrammar(ahead)} ahead of ` : '') +
    'its tracked branch.'

  return (
    <TooltippedContent
      className="ahead-behind"
      tagName="div"
      tooltip={aheadBehindTooltip}
      disabled={enableAccessibleListToolTips()}
    >
      {ahead > 0 && <Octicon symbol={octicons.arrowUp} />}
      {behind > 0 && <Octicon symbol={octicons.arrowDown} />}
    </TooltippedContent>
  )
}

const renderChangesIndicator = () => {
  return (
    <TooltippedContent
      className="change-indicator-wrapper"
      tooltip="There are uncommitted changes in this repository"
      disabled={enableAccessibleListToolTips()}
    >
      <Octicon symbol={octicons.dotFill} />
    </TooltippedContent>
  )
}

export const commitGrammar = (commitNum: number) =>
  `${commitNum} commit${commitNum > 1 ? 's' : ''}` // english is hard
