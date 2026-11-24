import * as React from 'react'
import classNames from 'classnames'
import { Commit } from '../../models/commit'
import { Branch, BranchType } from '../../models/branch'
import { Emoji } from '../../lib/emoji'
import { formatDate } from '../../lib/format-date'
import { TooltippedContent } from '../lib/tooltipped-content'
import { TooltipDirection } from '../lib/tooltip'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { commitGraph_RowHeight, ICommitGraphRow } from './commit-graph-model'
import { Tokenizer, TokenType } from '../../lib/text-token-parser'
import { ConventionalCommitBadge } from '../lib/conventional-commit-badge'
import { parseConventionalCommit } from '../../lib/conventional-commits'
import { assertNever } from '../../lib/fatal-error'
import { getAvatarUsersForCommit, IAvatarUser } from '../../models/avatar'
import { AvatarStack } from '../lib/avatar-stack'
import { Account } from '../../models/account'
import { GitHubRepository } from '../../models/github-repository'
import { Avatar } from '../lib/avatar'
import { RelativeTime } from '../relative-time'

interface ICommitGraphCommitListItemProps {
  readonly commit: Commit
  readonly commitGraphRow: ICommitGraphRow
  readonly branches: ReadonlyArray<Branch>
  readonly branchColors: Map<string, string>
  readonly emoji: Map<string, Emoji>
  readonly showUnpushedIndicator: boolean
  readonly unpushedIndicatorTitle?: string
  readonly preferAbsoluteDates: boolean
  readonly showConventionalCommitBadges: boolean
  readonly currentBranch: Branch | null
  readonly currentTipSha: string | null
  readonly gitHubRepository: GitHubRepository | null
  readonly accounts: ReadonlyArray<Account>
}

// Graph spacing follows the visible lanes in each row, which keeps commit text
// close to the lane it belongs to while preserving fixed-height virtualization.
const commitGraph_LaneGap = 18
const commitGraph_LeadingPadding = 8
const commitGraph_MessageGap = 16
const commitGraph_DotRadius = 5
const commitGraph_ShortRefLabelLength = 12

interface ICommitGraphSummaryProps {
  readonly className: string
  readonly emoji: Map<string, Emoji>
  readonly text: string
  readonly showConventionalCommitBadges: boolean
}

class CommitGraphSummary extends React.PureComponent<ICommitGraphSummaryProps> {
  public render() {
    const { className, emoji, text, showConventionalCommitBadges } = this.props
    const parsed = showConventionalCommitBadges
      ? parseConventionalCommit(text)
      : null

    return (
      <TooltippedContent
        tagName="span"
        className={className}
        tooltip={text}
        onlyWhenOverflowed={true}
      >
        {parsed?.leftSideText && (
          <span className="conventional-commit-prefix">
            {parsed.leftSideText}
          </span>
        )}
        {parsed && <ConventionalCommitBadge parsed={parsed} />}
        {commitGraph_renderSummaryTokens(
          emoji,
          parsed ? parsed.rightSideText : text
        )}
      </TooltippedContent>
    )
  }
}

export class CommitGraphCommitListItem extends React.PureComponent<ICommitGraphCommitListItemProps> {
  public render() {
    const { commit } = this.props
    const avatarUsers = getAvatarUsersForCommit(
      this.props.gitHubRepository,
      commit
    )
    const commitSummary = commitGraph_getCommitSummary(commit)
    const hasEmptySummary = commit.summary.length === 0
    const commitClassNames = classNames('commit', 'commitGraph-commit', {
      'merge-commit': commit.isMergeCommit,
    })
    const summaryClassNames = classNames('commitGraph-summary', {
      'empty-summary': hasEmptySummary,
    })

    return (
      <div className={commitClassNames}>
        {this.commitGraph_renderGraph()}
        <div className="commitGraph-commit-content">
          <div className="commitGraph-message">
            {this.commitGraph_renderBranchLabels()}
            {this.commitGraph_renderCurrentCommitIndicator()}
            <CommitGraphSummary
              className={summaryClassNames}
              emoji={this.props.emoji}
              text={commitSummary}
              showConventionalCommitBadges={
                this.props.showConventionalCommitBadges
              }
            />
          </div>
          <span className="commitGraph-date">
            {this.commitGraph_renderCommitTime(commit.author.date)}
          </span>
          {this.commitGraph_renderCommitterBadge(avatarUsers)}
          {this.commitGraph_renderUnpushedIndicator()}
        </div>
      </div>
    )
  }

  private commitGraph_renderGraph() {
    const { commitGraphRow, commit } = this.props
    const height = commitGraph_RowHeight
    const width =
      commitGraph_LeadingPadding +
      commitGraphRow.maxColumn * commitGraph_LaneGap +
      commitGraph_MessageGap
    const centerY = height / 2
    const xForColumn = (column: number) =>
      commitGraph_LeadingPadding + column * commitGraph_LaneGap
    const shiftedLaneColumns = new Set(
      commitGraphRow.shifts.map(shift => shift.fromColumn)
    )

    // Build gradient definitions for connections and shifts whose start/end colors
    // differ. SVG gradient IDs are document-scoped, so embed the commit SHA for
    // uniqueness. Prefix "c" = connection, "s" = shift.
    const gradientDefs: JSX.Element[] = []
    for (let i = 0; i < commitGraphRow.connections.length; i++) {
      const conn = commitGraphRow.connections[i]
      if (conn.fromColor === conn.toColor) {
        continue
      }
      const fromX = xForColumn(conn.fromColumn)
      const toX = xForColumn(conn.toColumn)
      gradientDefs.push(
        <linearGradient
          key={`c${i}`}
          id={`cg-c${i}-${commit.sha}`}
          x1={fromX}
          y1={centerY}
          x2={toX}
          y2={height}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={conn.fromColor} />
          <stop offset="100%" stopColor={conn.toColor} />
        </linearGradient>
      )
    }
    for (let i = 0; i < commitGraphRow.shifts.length; i++) {
      const shift = commitGraphRow.shifts[i]
      if (shift.fromColor === shift.toColor) {
        continue
      }
      const fromX = xForColumn(shift.fromColumn)
      const toX = xForColumn(shift.toColumn)
      gradientDefs.push(
        <linearGradient
          key={`s${i}`}
          id={`cg-s${i}-${commit.sha}`}
          x1={fromX}
          y1={centerY}
          x2={toX}
          y2={height}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={shift.fromColor} />
          <stop offset="100%" stopColor={shift.toColor} />
        </linearGradient>
      )
    }

    return (
      <svg
        className="commitGraph-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden={true}
        focusable={false}
      >
        {gradientDefs.length > 0 && <defs>{gradientDefs}</defs>}
        {commitGraphRow.lanes.map(lane => (
          <line
            key={`lane-${lane.column}`}
            className="commitGraph-line"
            x1={xForColumn(lane.column)}
            x2={xForColumn(lane.column)}
            y1={0}
            y2={shiftedLaneColumns.has(lane.column) ? centerY : height}
            stroke={lane.color}
          />
        ))}
        {commitGraphRow.hasTopLine && (
          <line
            className="commitGraph-line"
            x1={xForColumn(commitGraphRow.column)}
            x2={xForColumn(commitGraphRow.column)}
            y1={0}
            y2={centerY - commitGraph_DotRadius}
            stroke={commitGraphRow.color}
          />
        )}
        {commitGraphRow.shifts.map((shift, index) => {
          const fromX = xForColumn(shift.fromColumn)
          const toX = xForColumn(shift.toColumn)
          const path = `M ${fromX} ${centerY} C ${fromX} ${
            centerY + 8
          }, ${toX} ${height - 8}, ${toX} ${height}`
          const stroke =
            shift.fromColor !== shift.toColor
              ? `url(#cg-s${index}-${commit.sha})`
              : shift.toColor

          return (
            <path
              key={`shift-${index}`}
              className="commitGraph-line"
              d={path}
              stroke={stroke}
            />
          )
        })}
        {commitGraphRow.connections.map((connection, index) => {
          const fromX = xForColumn(connection.fromColumn)
          const toX = xForColumn(connection.toColumn)
          const path =
            fromX === toX
              ? `M ${fromX} ${
                  centerY + commitGraph_DotRadius
                } L ${toX} ${height}`
              : `M ${fromX} ${centerY} C ${fromX} ${centerY + 8}, ${toX} ${
                  height - 8
                }, ${toX} ${height}`
          const stroke =
            connection.fromColor !== connection.toColor
              ? `url(#cg-c${index}-${commit.sha})`
              : connection.toColor

          return (
            <path
              key={`connection-${index}`}
              className="commitGraph-line"
              d={path}
              stroke={stroke}
            />
          )
        })}
        <circle
          className="commitGraph-dot"
          cx={xForColumn(commitGraphRow.column)}
          cy={centerY}
          r={commitGraph_DotRadius}
          fill={commitGraphRow.color}
        />
      </svg>
    )
  }

  private commitGraph_renderCurrentCommitIndicator() {
    if (
      this.props.currentBranch !== null ||
      this.props.currentTipSha !== this.props.commit.sha
    ) {
      return null
    }

    return (
      <span
        className="commitGraph-current-commit-indicator"
        aria-label="Currently checked out commit"
        role="img"
      />
    )
  }

  private commitGraph_renderBranchLabels() {
    const tags = this.props.commit.tags
    const labels = this.props.branches.map(branch =>
      this.commitGraph_renderBranchLabel(branch)
    )
    const refNames = [
      ...this.props.branches.map(branch => branch.name),
      ...tags,
    ]
    const className = classNames('commitGraph-ref-labels', {
      compact: commitGraph_isCompactRefLabelGroup(refNames),
    })

    if (labels.length === 0 && tags.length === 0) {
      return null
    }

    return (
      <span className={className}>
        {labels}
        {tags.map(tag => this.commitGraph_renderTagLabel(tag))}
      </span>
    )
  }

  private commitGraph_renderTagLabel(tag: string) {
    const className = classNames(
      'commitGraph-ref-label',
      'commitGraph-ref-tag',
      {
        short: commitGraph_isShortRefLabel(tag),
      }
    )

    return (
      <TooltippedContent
        tagName="span"
        className={className}
        key={tag}
        tooltip={tag}
        direction={TooltipDirection.SOUTH_EAST}
      >
        {tag}
      </TooltippedContent>
    )
  }

  private commitGraph_renderBranchLabel(branch: Branch) {
    const isCurrentBranch = branch.ref === this.props.currentBranch?.ref
    const isRemoteBranch = branch.type !== BranchType.Local
    const isPullRequestLabel = commitGraph_isPullRequestRefLabel(branch.name)
    const color = this.props.branchColors.get(branch.ref)
    const className = classNames('commitGraph-ref-label', {
      current: isCurrentBranch,
      remote: isRemoteBranch,
      'pull-request': isPullRequestLabel,
      short: commitGraph_isShortRefLabel(branch.name),
    })
    const content = (
      <>
        {!isRemoteBranch && color !== undefined ? (
          <span
            className="commitGraph-ref-color-swatch"
            style={{ backgroundColor: color }}
          />
        ) : null}
        {isCurrentBranch ? (
          <span className="commitGraph-ref-current-indicator" />
        ) : null}
        <span className="commitGraph-ref-name">{branch.name}</span>
      </>
    )

    if (!isPullRequestLabel) {
      return (
        <TooltippedContent
          tagName="span"
          className={className}
          key={branch.ref}
          tooltip={branch.name}
          direction={TooltipDirection.SOUTH_EAST}
        >
          {content}
        </TooltippedContent>
      )
    }

    return (
      <TooltippedContent
        tagName="span"
        className={className}
        key={branch.ref}
        tooltip={this.commitGraph_renderPullRequestLabelTooltip(branch.name)}
        tooltipClassName="commitGraph-ref-label-tooltip"
        direction={TooltipDirection.SOUTH_EAST}
      >
        {content}
      </TooltippedContent>
    )
  }

  private commitGraph_renderPullRequestLabelTooltip(label: string) {
    const body = this.props.commit.body.trim()

    return (
      <div className="commitGraph-ref-label-tooltip-content">
        <div className="commitGraph-ref-label-tooltip-label">{label}</div>
        <div className="commitGraph-ref-label-tooltip-summary">
          {commitGraph_getCommitSummary(this.props.commit)}
        </div>
        {body.length > 0 ? (
          <div className="commitGraph-ref-label-tooltip-body">{body}</div>
        ) : null}
      </div>
    )
  }

  private commitGraph_renderCommitterBadge(
    avatarUsers: ReadonlyArray<IAvatarUser>
  ) {
    return (
      <TooltippedContent
        tagName="div"
        className="commitGraph-committer-badge"
        tooltip={this.commitGraph_renderCommitterTooltip(avatarUsers)}
        direction={TooltipDirection.SOUTH_EAST}
      >
        <AvatarStack
          users={avatarUsers}
          accounts={this.props.accounts}
          tooltip={false}
        />
      </TooltippedContent>
    )
  }

  private commitGraph_renderCommitterTooltip(
    avatarUsers: ReadonlyArray<IAvatarUser>
  ) {
    const absoluteDate = formatDate(this.props.commit.author.date)

    return (
      <div className="commit-list-item-tooltip list-item-tooltip">
        {avatarUsers.map((user, i) => (
          <div className="author" key={i}>
            <div className="label">
              <Avatar accounts={this.props.accounts} user={user} title={null} />
            </div>
            <div>{commitGraph_renderExpandedAuthor(user)}</div>
          </div>
        ))}
        <div>
          <div className="label">Date: </div>
          {absoluteDate}
        </div>
        {this.props.showUnpushedIndicator ? (
          <div>
            <div className="label">
              <span className="unpushed-indicator">
                <Octicon symbol={octicons.arrowUp} />
              </span>
            </div>
            <div>{this.props.unpushedIndicatorTitle ?? 'Unpushed commit'}</div>
          </div>
        ) : null}
      </div>
    )
  }

  private commitGraph_renderCommitTime(date: Date) {
    return this.props.preferAbsoluteDates ? (
      commitGraph_formatDate(date)
    ) : (
      <RelativeTime date={date} tooltip={false} />
    )
  }

  private commitGraph_renderUnpushedIndicator() {
    if (!this.props.showUnpushedIndicator) {
      return null
    }

    return (
      <span
        className="commitGraph-unpushed-indicator"
        role="img"
        aria-label={this.props.unpushedIndicatorTitle ?? 'Unpushed commit'}
      >
        <Octicon symbol={octicons.arrowUp} />
      </span>
    )
  }
}

function commitGraph_formatDate(date: Date) {
  const unpaddedTime = formatDate(date, { date: false })
  const dateTime = formatDate(date)

  return dateTime.replace(unpaddedTime, commitGraph_padTimeHour(unpaddedTime))
}

function commitGraph_padTimeHour(time: string) {
  return time.replace(/^(\d)(?=[:.]\d{2})/, '0$1')
}

function commitGraph_getCommitSummary(commit: Commit) {
  return commit.summary.length === 0 ? 'Empty commit message' : commit.summary
}

function commitGraph_renderSummaryTokens(
  emoji: Map<string, Emoji>,
  text: string
) {
  const tokenizer = new Tokenizer(emoji)

  return tokenizer.tokenize(text).map((token, index) => {
    switch (token.kind) {
      case TokenType.Emoji:
        return token.emoji ? (
          <span key={index}>{token.emoji}</span>
        ) : (
          <img
            key={index}
            alt={token.description ?? token.text}
            className="emoji"
            src={token.path}
          />
        )
      case TokenType.Link:
      case TokenType.Text:
        return <span key={index}>{token.text}</span>
      default:
        return assertNever(token, `Unknown token type: ${token}`)
    }
  })
}

function commitGraph_isPullRequestRefLabel(name: string) {
  return /(^|\/)pr[-/]\d+$/i.test(name) || /(^|\/)pull\/\d+\/head$/i.test(name)
}

function commitGraph_isShortRefLabel(name: string) {
  return name.length <= commitGraph_ShortRefLabelLength
}

function commitGraph_isCompactRefLabelGroup(names: ReadonlyArray<string>) {
  return names.length === 1 && commitGraph_isShortRefLabel(names[0]!)
}

function commitGraph_renderExpandedAuthor(
  user: IAvatarUser
): string | JSX.Element {
  if (!user) {
    return 'Unknown user'
  }

  if (user.name) {
    return (
      <>
        <div>{user.name}</div>
        <div>{user.email}</div>
      </>
    )
  }

  return user.email
}
