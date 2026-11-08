import * as URL from 'url'
import { Account, AccountAPIType, UnknownLogin } from '../models/account'
import {
  findRegisteredEndpointForHost,
  getRegisteredApiType,
  getRegisteredEndpoint,
  RegisteredApiType,
  tryGetHost,
} from './endpoint-api-type-registry'
import {
  ICopilotCommitMessage,
  parseCopilotCommitMessage,
} from './copilot-commit-message'

import {
  request,
  parsedResponse,
  HTTPMethod,
  APIError,
  urlWithQueryString,
  getUserAgent,
} from './http'
import { asHost, GitProtocol, parseRemote } from './remote-parsing'
import {
  getEndpointVersion,
  isDotCom,
  isGHE,
  isGHES,
  updateEndpointVersion,
} from './endpoint-capabilities'
import {
  clearCertificateErrorSuppressionFor,
  suppressCertificateErrorFor,
} from './suppress-certificate-error'
import { HttpStatusCode } from './http-status-code'
import { urlWithoutCredentials } from './trampoline/url-without-credentials'
import { CopilotError, parseCopilotPaymentRequiredError } from './copilot-error'
import { BypassReasonType } from '../ui/secret-scanning/bypass-push-protection-dialog'
import { assertNever } from './fatal-error'
import { deriveNumericAccountId } from './derive-numeric-account-id'

const envEndpoint = process.env['DESKTOP_GITHUB_DOTCOM_API_ENDPOINT']
const envHTMLURL = process.env['DESKTOP_GITHUB_DOTCOM_HTML_URL']
const envAdditionalCookies =
  process.env['DESKTOP_GITHUB_DOTCOM_ADDITIONAL_COOKIES']

if (envAdditionalCookies !== undefined) {
  document.cookie += '; ' + envAdditionalCookies
}

export const oauthRedirectUri = __DEV_SECRETS__
  ? 'https://desktop-plus.org/oauth?dev=1'
  : 'https://desktop-plus.org/oauth'

type AffiliationFilter =
  | 'owner'
  | 'collaborator'
  | 'organization_member'
  | 'owner,collaborator'
  | 'owner,organization_member'
  | 'collaborator,organization_member'
  | 'owner,collaborator,organization_member'

/** Response type of GraphQL query of Copilot-related info */
type ViewerCopilotResponse = {
  readonly data: {
    readonly viewer: {
      readonly copilotEndpoints: {
        readonly api: string
      }
      readonly copilotLicenseType: string
      readonly isCopilotDesktopEnabled: boolean
    }
  }
}

/** Copilot-related info relevant to Desktop */
type UserCopilotInfo = {
  readonly isCopilotDesktopEnabled: boolean
  readonly copilotEndpoint: string
  readonly copilotLicenseType: string
}

/** Response type Copilot chat completions response API */
type CopilotChatCompletionResponse = {
  readonly choices: ReadonlyArray<{
    readonly index: number
    readonly message: {
      readonly content: string
    }
  }>
}

/**
 * Optional set of configurable settings for the fetchAll method
 */
interface IFetchAllOptions<T> {
  /**
   * The number of results to ask for on each page when making
   * requests to paged API endpoints.
   */
  perPage?: number

  /**
   * An optional predicate which determines whether or not to
   * continue loading results from the API. This can be used
   * to put a limit on the number of results to return from
   * a paged API resource.
   *
   * As an example, to stop loading results after 500 results:
   *
   * `(results) => results.length < 500`
   *
   * @param results  All results retrieved thus far
   */
  continue?: (results: ReadonlyArray<T>) => boolean | Promise<boolean>

  /**
   * An optional callback which is invoked after each page of results is loaded
   * from the API. This can be used to enable streaming of results.
   *
   * @param page The last fetched page of results
   */
  onPage?: (page: ReadonlyArray<T>) => void

  /**
   * Calculate the next page path given the response.
   *
   * Optional, see `getNextPagePathFromLink` for the default
   * implementation.
   */
  getNextPagePath?: (response: Response) => string | null

  /**
   * Whether or not to silently suppress request errors and
   * return the results retrieved thus far. If this field is
   * `true` the fetchAll method will suppress errors (this is
   * also the default behavior if no value is provided for
   * this field). Setting this field to false will cause the
   * fetchAll method to throw if it encounters an API error
   * on any page.
   */
  suppressErrors?: boolean
}

const ClientID = process.env.TEST_ENV ? '' : __OAUTH_CLIENT_ID__
const ClientSecret = process.env.TEST_ENV ? '' : __OAUTH_SECRET__
const ClientIDBitbucket = process.env.TEST_ENV
  ? ''
  : __OAUTH_CLIENT_ID_BITBUCKET__
const ClientSecretBitbucket = process.env.TEST_ENV
  ? ''
  : __OAUTH_SECRET_BITBUCKET__
const ClientIDGitLab = process.env.TEST_ENV ? '' : __OAUTH_CLIENT_ID_GITLAB__
const ClientSecretGitLab = process.env.TEST_ENV ? '' : __OAUTH_SECRET_GITLAB__
const ClientIDCodeberg = process.env.TEST_ENV
  ? ''
  : __OAUTH_CLIENT_ID_CODEBERG__
const ClientSecretCodeberg = process.env.TEST_ENV
  ? ''
  : __OAUTH_SECRET_CODEBERG__
const ClientIDGitea = process.env.TEST_ENV ? '' : __OAUTH_CLIENT_ID_GITEA__
const ClientSecretGitea = process.env.TEST_ENV ? '' : __OAUTH_SECRET_GITEA__

if (!ClientID || !ClientID.length || !ClientSecret || !ClientSecret.length) {
  log.warn(
    `DESKTOP_OAUTH_CLIENT_ID and/or DESKTOP_OAUTH_CLIENT_SECRET is undefined. You won't be able to authenticate new users.`
  )
}
if (!ClientIDBitbucket?.length || !ClientSecretBitbucket?.length) {
  log.warn(
    `DESKTOP_OAUTH_CLIENT_ID_BITBUCKET and/or DESKTOP_OAUTH_CLIENT_SECRET_BITBUCKET is undefined. You won't be able to authenticate new users.`
  )
}
if (!ClientIDGitLab?.length || !ClientSecretGitLab?.length) {
  log.warn(
    `DESKTOP_OAUTH_CLIENT_ID_GITLAB and/or DESKTOP_OAUTH_CLIENT_SECRET_GITLAB is undefined. You won't be able to authenticate new GitLab users.`
  )
}
if (!ClientIDCodeberg?.length || !ClientSecretCodeberg?.length) {
  log.warn(
    `DESKTOP_OAUTH_CLIENT_ID_CODEBERG and/or DESKTOP_OAUTH_CLIENT_SECRET_CODEBERG is undefined. You won't be able to authenticate new Codeberg users.`
  )
}
if (!ClientIDGitea?.length || !ClientSecretGitea?.length) {
  log.warn(
    `DESKTOP_OAUTH_CLIENT_ID_GITEA and/or DESKTOP_OAUTH_CLIENT_SECRET_GITEA is undefined. You won't be able to authenticate new Gitea users.`
  )
}

const ThirdPartyOAuthApps: Readonly<
  Record<RegisteredApiType, ReadonlyArray<string | undefined>>
> = {
  bitbucket: [ClientIDBitbucket, ClientSecretBitbucket],
  gitlab: [ClientIDGitLab, ClientSecretGitLab],
  forgejo: [ClientIDCodeberg, ClientSecretCodeberg],
  gitea: [ClientIDGitea, ClientSecretGitea],
}

export function getThirdPartyOAuthApp(apiType: RegisteredApiType) {
  const [clientId, clientSecret] = ThirdPartyOAuthApps[apiType]
  return { clientId: clientId ?? '', clientSecret: clientSecret ?? '' }
}

export type GitHubAccountType = 'User' | 'Organization'

/** The OAuth scopes we want to request */
const oauthScopes = ['repo', 'user', 'workflow']

/**
 * Information about a repository as returned by the GitHub API.
 */
export interface IAPIRepository {
  // blank if unknown
  readonly clone_url: string
  readonly ssh_url: string
  readonly html_url: string
  readonly name: string
  readonly owner: IAPIIdentity
  readonly private: boolean | null // null if unknown
  readonly fork: boolean
  readonly default_branch: string
  readonly pushed_at: string
  readonly has_issues: boolean
  readonly archived: boolean
}
export interface IBitbucketAPIRepositorySummary {
  readonly uuid: string
  readonly full_name: string
  readonly name: string // Display name
  readonly links: {
    readonly html: {
      readonly href: string
    }
  }
}
function summaryToIAPIRepositoryFromBitbucket(
  repo: IBitbucketAPIRepositorySummary
): IAPIRepository {
  const [owner, name] = repo.full_name.split('/')
  return {
    clone_url: `https://bitbucket.org/${repo.full_name}.git`,
    ssh_url: `git@bitbucket.org:${repo.full_name}.git`,
    html_url: repo.links.html.href,
    name,
    owner: {
      id: 0,
      login: owner,
      avatar_url: '',
      html_url: '',
      type: 'User',
    },
    private: null,
    fork: false,
    default_branch: '',
    pushed_at: '',
    has_issues: false,
    archived: false,
  }
}

/** Information needed to clone a repository. */
export interface IAPIRepositoryCloneInfo {
  /** Canonical clone URL of the repository. */
  readonly url: string

  /**
   * Default branch of the repository, if any. This is usually either retrieved
   * from the API for GitHub repositories, or undefined for other repositories.
   */
  readonly defaultBranch?: string
}

export interface IAPIFullRepository extends IAPIRepository {
  /**
   * The parent repository of a fork.
   *
   * HACK: BEWARE: This is defined as `parent: IAPIRepository | undefined`
   * rather than `parent?: ...` even though the parent property is actually
   * optional in the API response. So we're lying a bit to the type system
   * here saying that this will be present but the only time the difference
   * between omission and explicit undefined matters is when using constructs
   * like `x in y` or `y.hasOwnProperty('x')` which we do very rarely.
   *
   * Without at least one non-optional type in this interface TypeScript will
   * happily let us pass an IAPIRepository in place of an IAPIFullRepository.
   */
  readonly parent: IAPIRepository | undefined

  /**
   * The high-level permissions that the currently authenticated
   * user enjoys for the repository. Undefined if the API call
   * was made without an authenticated user or if the repository
   * isn't the primarily requested one (i.e. if this is the parent
   * repository of the requested repository)
   *
   * The permissions hash will also be omitted when the repository
   * information is embedded within another object such as a pull
   * request (base.repo or head.repo).
   *
   * In other words, the only time when the permissions property
   * will be present is when explicitly fetching the repository
   * through the `/repos/user/name` endpoint or similar.
   */
  readonly permissions?: IAPIRepositoryPermissions
}
export interface IBitbucketAPIRepository
  extends IBitbucketAPIRepositorySummary {
  readonly slug: string // URL (for API calls)
  readonly owner: IBitbucketAPIIdentity
  readonly is_private: boolean
  readonly parent?: IBitbucketAPIRepository
  readonly has_issues: boolean
  readonly updated_on: string
  readonly mainbranch: {
    readonly name: string
  }
  readonly links: {
    readonly html: {
      readonly href: string
    }
    readonly clone: ReadonlyArray<{
      readonly name: string
      readonly href: string
    }>
  }
}
function toIAPIRepositoryFromBitbucket(
  repo: IBitbucketAPIRepository
): IAPIRepository {
  const sshUrl =
    repo.links.clone.filter(c => c.name === 'ssh')[0]?.href ||
    `git@bitbucket.org:${repo.full_name}.git`
  const httpsLink = repo.links.clone.find(c => c.name === 'https')?.href
  const httpsUrl = httpsLink
    ? urlWithoutCredentials(httpsLink)
    : `https://bitbucket.org/${repo.full_name}.git`
  return {
    clone_url: httpsUrl,
    ssh_url: sshUrl,
    html_url: repo.links.html.href,
    name: repo.slug,
    owner: toIAPIIdentityFromBitbucket(repo.owner),
    private: repo.is_private,
    fork: false,
    default_branch: repo.mainbranch?.name,
    pushed_at: repo.updated_on,
    has_issues: repo.has_issues,
    archived: false,
  }
}
function toIAPIFullRepositoryFromBitbucket(
  repo: IBitbucketAPIRepository
): IAPIFullRepository {
  return {
    ...toIAPIRepositoryFromBitbucket(repo),
    parent: repo.parent
      ? toIAPIRepositoryFromBitbucket(repo.parent)
      : undefined,
    permissions: {
      // Let's be optimistic
      admin: true,
      push: true,
      pull: true,
    },
  }
}

/*
 * Information about how the user is permitted to interact with a repository.
 */
export interface IAPIRepositoryPermissions {
  readonly admin: boolean
  /* aka 'write' */
  readonly push: boolean
  /* aka 'read' */
  readonly pull: boolean
}

/**
 * Information about a commit as returned by the GitHub API.
 */
export interface IAPICommit {
  readonly sha: string
  readonly author: IAPIIdentity | {} | null
}

/**
 * Entity returned by the `/user/orgs` endpoint.
 *
 * Because this is specific to one endpoint it omits the `type` member from
 * `IAPIIdentity` that callers might expect.
 */
export interface IAPIOrganization {
  readonly id: number
  readonly url: string
  readonly login: string
  readonly avatar_url: string
}

/**
 * Minimum subset of an identity returned by the GitHub API
 */
export interface IAPIIdentity {
  readonly id: number
  readonly login: string
  readonly avatar_url: string
  readonly html_url: string
  readonly type: GitHubAccountType
}
export interface IBitbucketAPIIdentity {
  readonly uuid: string
  readonly display_name: string
  readonly username: string
  readonly links: {
    readonly avatar: {
      readonly href: string
    }
    readonly html: {
      readonly href: string
    }
  }
}
function toIAPIIdentityFromBitbucket(
  identity: IBitbucketAPIIdentity
): IAPIIdentity {
  return {
    id: 0,
    login: identity.display_name,
    avatar_url: identity.links.avatar.href,
    html_url: identity.links.html.href,
    type: 'User',
  }
}

/**
 * Complete identity details returned in some situations by the GitHub API.
 *
 * If you are not sure what is returned as part of an API response, you should
 * use `IAPIIdentity` as that contains the known subset of an identity and does
 * not cover scenarios where privacy settings of a user control what information
 * is returned.
 */
interface IAPIFullIdentity {
  readonly id: number
  readonly html_url: string
  readonly login: string
  readonly avatar_url: string

  /**
   * The user's real name or null if the user hasn't provided
   * a real name for their public profile.
   */
  readonly name: string | null

  /**
   * The email address for this user or null if the user has not
   * specified a public email address in their profile.
   */
  readonly email: string | null
  readonly type: GitHubAccountType
  readonly plan?: {
    readonly name: string
  }
}
function toIAPIFullIdentityFromBitbucket(
  identity: IBitbucketAPIIdentity
): IAPIFullIdentity {
  return {
    id: deriveNumericAccountId(identity.username),
    login: identity.username,
    avatar_url: identity.links.avatar.href,
    html_url: identity.links.html.href,
    name: identity.display_name,
    email: null,
    type: 'User',
  }
}

/** The users we get from the mentionables endpoint. */
export interface IAPIMentionableUser {
  /**
   * A url to an avatar image chosen by the user
   */
  readonly avatar_url: string

  /**
   * The user's attributable email address or null if the
   * user doesn't have an email address that they can be
   * attributed by
   */
  readonly email: string | null

  /**
   * The username or "handle" of the user
   */
  readonly login: string

  /**
   * The user's real name (or at least the name that the user
   * has configured to be shown) or null if the user hasn't provided
   * a real name for their public profile.
   */
  readonly name: string | null
}
interface IBitbucketApiWorkspaceMembership {
  user: IBitbucketAPIIdentity
}
function toIAPIMentionableUserFromBitbucket(
  member: IBitbucketApiWorkspaceMembership
): IAPIMentionableUser {
  return {
    avatar_url: member.user.links.avatar.href,
    email: null,
    login: member.user.display_name,
    name: member.user.display_name,
  }
}

/** The response we get from the desktop_internal/features endpoint. */
interface IUserFeaturesResponse {
  readonly features: ReadonlyArray<string>
}

/**
 * Error thrown by `fetchUpdatedPullRequests` when receiving more results than
 * what the `maxResults` parameter allows for.
 */
export class MaxResultsError extends Error {}

/**
 * `null` can be returned by the API for legacy reasons. A non-null value is
 * set for the primary email address currently, but in the future visibility
 * may be defined for each email address.
 */
export type EmailVisibility = 'public' | 'private' | null

/**
 * Information about a user's email as returned by the GitHub API.
 */
export interface IAPIEmail {
  readonly email: string
  readonly verified: boolean
  readonly primary: boolean
  readonly visibility: EmailVisibility
}
export interface IBitbucketAPIEmail {
  readonly email: string
  readonly is_primary: boolean
  readonly is_confirmed: boolean
}
function toIAPIEmailFromBitbucket(email: IBitbucketAPIEmail): IAPIEmail {
  return {
    email: email.email,
    verified: email.is_confirmed,
    primary: email.is_primary,
    visibility: 'public',
  }
}

/** Information about an issue as returned by the GitHub API. */
export interface IAPIIssue {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly updated_at: string
}

/** The combined state of a ref. */
export type APIRefState = 'failure' | 'pending' | 'success' | 'error'
export type BitbucketAPIRefState =
  | 'FAILED'
  | 'INPROGRESS'
  | 'STOPPED'
  | 'SUCCESSFUL'
export type GitLabAPIPipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled'

/** The overall status of a check run */
export enum APICheckStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
}

/** The conclusion of a completed check run */
export enum APICheckConclusion {
  ActionRequired = 'action_required',
  Canceled = 'cancelled',
  TimedOut = 'timed_out',
  Failure = 'failure',
  Neutral = 'neutral',
  Success = 'success',
  Skipped = 'skipped',
  Stale = 'stale',
}

/**
 * The API response for a combined view of a commit
 * status for a given ref
 */
export interface IAPIRefStatusItem {
  readonly state: APIRefState
  readonly target_url: string | null
  readonly description: string
  readonly context: string
  readonly id: number
}
export interface IBitbucketAPICommitStatus {
  readonly state: BitbucketAPIRefState
  readonly url: string
  readonly description: string
  readonly name: string
}
function toIAPIRefStatusItemFromBitbucket(
  id: number,
  status: IBitbucketAPICommitStatus
): IAPIRefStatusItem {
  return {
    state: mapRefStateFromBitbucket(status.state),
    target_url: status.url,
    description: status.description,
    context: status.name,
    id,
  }
}
function mapRefStateFromBitbucket(state: BitbucketAPIRefState): APIRefState {
  switch (state) {
    case 'FAILED':
      return 'failure'
    case 'INPROGRESS':
      return 'pending'
    case 'STOPPED':
      return 'error'
    case 'SUCCESSFUL':
      return 'success'
  }
}

/** The API response to a ref status request. */
export interface IAPIRefStatus {
  readonly state: APIRefState
  readonly total_count: number
  readonly statuses: ReadonlyArray<IAPIRefStatusItem>
}

export interface IAPIRefCheckRun {
  readonly id: number
  readonly url: string
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly name: string
  readonly check_suite: IAPIRefCheckRunCheckSuite
  readonly app: IAPIRefCheckRunApp
  readonly completed_at: string
  readonly started_at: string
  readonly html_url: string
  readonly pull_requests: ReadonlyArray<IAPIPullRequest>
}
export interface IGitLabAPIPipelineStatus {
  readonly status: GitLabAPIPipelineStatus
  readonly web_url: string
  readonly id: number
  readonly iid: number
  readonly source: string
  readonly sha: string
  readonly ref: string
  readonly created_at: string
  readonly updated_at: string
}
function toIAPIRefCheckRunFromGitLab(
  pipelineStatus: IGitLabAPIPipelineStatus
): IAPIRefCheckRun {
  return {
    id: pipelineStatus.id,
    url: pipelineStatus.web_url,
    status: toAPICheckStatusFromGitLab(pipelineStatus.status),
    conclusion: toAPICheckConclusionFromGitLab(pipelineStatus.status),
    name: `${pipelineStatus.source}: ${pipelineStatus.ref}`,
    check_suite: {
      id: pipelineStatus.id,
    },
    app: {
      name: 'Pipelines',
    },
    completed_at: pipelineStatus.updated_at,
    started_at: pipelineStatus.created_at,
    html_url: pipelineStatus.web_url,
    pull_requests: [],
  }
}
function toAPICheckStatusFromGitLab(
  status: GitLabAPIPipelineStatus
): APICheckStatus {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
      return APICheckStatus.Queued
    case 'running':
      return APICheckStatus.InProgress
    case 'manual':
    case 'success':
    case 'failed':
    case 'canceled':
    case 'skipped':
      return APICheckStatus.Completed
  }
}
function toAPICheckConclusionFromGitLab(
  status: GitLabAPIPipelineStatus
): APICheckConclusion | null {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'running':
      return null
    case 'manual':
      return APICheckConclusion.ActionRequired
    case 'success':
      return APICheckConclusion.Success
    case 'failed':
      return APICheckConclusion.Failure
    case 'canceled':
      return APICheckConclusion.Canceled
    case 'skipped':
      return APICheckConclusion.Skipped
  }
}

// NB. Only partially mapped
export interface IAPIRefCheckRunApp {
  readonly name: string
}

// NB. Only partially mapped
export interface IAPIRefCheckRunOutput {
  readonly title: string | null
  readonly summary: string | null
  readonly text: string | null
}

export interface IAPIRefCheckRunCheckSuite {
  readonly id: number
}

export interface IAPICheckSuite {
  readonly id: number
  readonly rerequestable: boolean
  readonly runs_rerequestable: boolean
  readonly status: APICheckStatus
  readonly created_at: string
}

export interface IAPIRefCheckRuns {
  readonly total_count: number
  readonly check_runs: IAPIRefCheckRun[]
}

interface IAPIWorkflowRuns {
  readonly total_count: number
  readonly workflow_runs: ReadonlyArray<IAPIWorkflowRun>
}
// NB. Only partially mapped
export interface IAPIWorkflowRun {
  readonly id: number
  /**
   * The workflow_id is the id of the workflow not the individual run.
   **/
  readonly workflow_id: number
  readonly cancel_url: string
  readonly created_at: string
  readonly logs_url: string
  readonly name: string
  readonly rerun_url: string
  readonly check_suite_id: number
  readonly event: string
}

export interface IAPIWorkflowJobs {
  readonly total_count: number
  readonly jobs: IAPIWorkflowJob[]
}

// NB. Only partially mapped
export interface IAPIWorkflowJob {
  readonly id: number
  readonly name: string
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly completed_at: string
  readonly started_at: string
  readonly steps: ReadonlyArray<IAPIWorkflowJobStep>
  readonly html_url: string
}

export interface IAPIWorkflowJobStep {
  readonly name: string
  readonly number: number
  readonly status: APICheckStatus
  readonly conclusion: APICheckConclusion | null
  readonly completed_at: string
  readonly started_at: string
  readonly log: string
}

/** Protected branch information returned by the GitHub API */
export interface IAPIPushControl {
  /**
   * What status checks are required before merging?
   *
   * Empty array if user is admin and branch is not admin-enforced
   */
  required_status_checks: Array<string>

  /**
   * How many reviews are required before merging?
   *
   * 0 if user is admin and branch is not admin-enforced
   */
  required_approving_review_count: number

  /**
   * Is user permitted?
   *
   * Always `true` for admins.
   * `true` if `Restrict who can push` is not enabled.
   * `true` if `Restrict who can push` is enabled and user is in list.
   * `false` if `Restrict who can push` is enabled and user is not in list.
   */
  allow_actor: boolean

  /**
   * Currently unused properties
   */
  pattern: string | null
  required_signatures: boolean
  required_linear_history: boolean
  allow_deletions: boolean
  allow_force_pushes: boolean
}

/** Branch information returned by the GitHub API */
export interface IAPIBranch {
  /**
   * The name of the branch stored on the remote.
   *
   * NOTE: this is NOT a fully-qualified ref (i.e. `refs/heads/main`)
   */
  readonly name: string
  /**
   * Branch protection settings:
   *
   *  - `true` indicates that the branch is protected in some way
   *  - `false` indicates no branch protection set
   */
  readonly protected: boolean
}

interface IForgejoAPIBranch {
  readonly name: string
  readonly protected: boolean
}

/** Repository rule information returned by the GitHub API */
export interface IAPIRepoRule {
  /**
   * The ID of the ruleset this rule is configured in.
   */
  readonly ruleset_id: number

  /**
   * The type of the rule.
   */
  readonly type: APIRepoRuleType

  /**
   * The parameters that apply to the rule if it is a metadata rule.
   * Other rule types may have parameters, but they are not used in
   * this app so they are ignored. Do not attempt to use this field
   * unless you know `type` matches a metadata rule type.
   */
  readonly parameters?: IAPIRepoRuleMetadataParameters
}

/**
 * A non-exhaustive list of rules that can be configured. Only the rule
 * types used by this app are included.
 */
export enum APIRepoRuleType {
  Creation = 'creation',
  Update = 'update',
  RequiredDeployments = 'required_deployments',
  RequiredSignatures = 'required_signatures',
  RequiredStatusChecks = 'required_status_checks',
  PullRequest = 'pull_request',
  CommitMessagePattern = 'commit_message_pattern',
  CommitAuthorEmailPattern = 'commit_author_email_pattern',
  CommitterEmailPattern = 'committer_email_pattern',
  BranchNamePattern = 'branch_name_pattern',
}

/**
 * A ruleset returned from the GitHub API's "get all rulesets for a repo" endpoint.
 * This endpoint returns a slimmed-down version of the full ruleset object, though
 * only the ID is used.
 */
export interface IAPISlimRepoRuleset {
  readonly id: number
}

/**
 * A ruleset returned from the GitHub API's "get a ruleset for a repo" endpoint.
 */
export interface IAPIRepoRuleset extends IAPISlimRepoRuleset {
  /**
   * Whether the user making the API request can bypass the ruleset.
   */
  readonly current_user_can_bypass: 'always' | 'pull_requests_only' | 'never'
}

/**
 * Metadata parameters for a repo rule metadata rule.
 */
export interface IAPIRepoRuleMetadataParameters {
  /**
   * User-supplied name/description of the rule
   */
  name: string

  /**
   * Whether the operator is negated. For example, if `true`
   * and `operator` is `starts_with`, then the rule
   * will be negated to 'does not start with'.
   */
  negate: boolean

  /**
   * The pattern to match against. If the operator is 'regex', then
   * this is a regex string match. Otherwise, it is a raw string match
   * of the type specified by `operator` with no additional parsing.
   */
  pattern: string

  /**
   * The type of match to use for the pattern. For example, `starts_with`
   * means `pattern` must be at the start of the string.
   */
  operator: APIRepoRuleMetadataOperator
}

export enum APIRepoRuleMetadataOperator {
  StartsWith = 'starts_with',
  EndsWith = 'ends_with',
  Contains = 'contains',
  RegexMatch = 'regex',
}

interface IAPIPullRequestRef {
  readonly ref: string
  readonly sha: string

  /**
   * The repository in which this ref lives. It could be null if the repository
   * has been deleted since the PR was opened.
   */
  readonly repo: IAPIRepository | null
}
interface IBitbucketAPIPullRequestRef {
  readonly branch: {
    readonly name: string
  }
  readonly commit: {
    readonly hash: string
  } | null
  readonly repository: IBitbucketAPIRepositorySummary
}
function toIAPIPullRequestRefFromBitbucket(
  ref: IBitbucketAPIPullRequestRef
): IAPIPullRequestRef {
  return {
    ref: ref.branch.name,
    sha: ref.commit?.hash ?? '',
    repo: summaryToIAPIRepositoryFromBitbucket(ref.repository),
  }
}

/** Information about a pull request as returned by the GitHub API. */
export interface IAPIPullRequest {
  readonly number: number
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly user: IAPIIdentity
  readonly head: IAPIPullRequestRef
  readonly base: IAPIPullRequestRef
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly draft?: boolean
}
interface IBitbucketAPIPullRequest {
  readonly id: number
  readonly title: string
  readonly created_on: string
  readonly updated_on: string
  readonly author: IBitbucketAPIIdentity
  readonly source: IBitbucketAPIPullRequestRef
  readonly destination: IBitbucketAPIPullRequestRef
  readonly description: string
  readonly state: 'OPEN' | 'MERGED' | 'DECLINED'
  readonly type: 'pullrequest'
}
function toIAPIPullRequestFromBitbucket(
  pr: IBitbucketAPIPullRequest
): IAPIPullRequest {
  return {
    number: pr.id,
    title: pr.title,
    created_at: pr.created_on,
    updated_at: pr.updated_on,
    user: toIAPIIdentityFromBitbucket(pr.author),
    head: toIAPIPullRequestRefFromBitbucket(pr.source),
    base: toIAPIPullRequestRefFromBitbucket(pr.destination),
    body: pr.description,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
  }
}

// GitLab API Interfaces
export interface IGitLabAPIIdentity {
  readonly id: number
  readonly username: string
  readonly name: string
  readonly avatar_url: string
  readonly web_url: string
}
function toIAPIIdentityFromGitLab(identity: IGitLabAPIIdentity): IAPIIdentity {
  return {
    id: identity.id,
    login: identity.username,
    avatar_url: identity.avatar_url,
    html_url: identity.web_url,
    type: 'User',
  }
}
function toIAPIFullIdentityFromGitLab(
  identity: IGitLabAPIIdentity
): IAPIFullIdentity {
  return {
    id: identity.id,
    login: identity.username,
    avatar_url: identity.avatar_url,
    html_url: identity.web_url,
    name: identity.name,
    email: null,
    type: 'User',
  }
}

export interface IGitLabAPIEmail {
  readonly email: string
  readonly confirmed_at: string | null
}
function toIAPIEmailFromGitLab(
  email: IGitLabAPIEmail,
  index: number
): IAPIEmail {
  return {
    email: email.email,
    verified: email.confirmed_at !== null,
    primary: index === 0,
    visibility: 'public',
  }
}

export interface IGitLabAPIRepository {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly path_with_namespace: string
  readonly web_url: string
  readonly ssh_url_to_repo: string
  readonly http_url_to_repo: string
  readonly namespace: {
    readonly kind: string
    readonly path: string
    readonly full_path: string
  }
  readonly owner?: IGitLabAPIIdentity
  readonly visibility: 'private' | 'internal' | 'public'
  readonly default_branch: string
  readonly last_activity_at: string
  readonly issues_enabled: boolean
  readonly archived: boolean
  readonly forked_from_project?: IGitLabAPIRepository
}
function toIAPIRepositoryFromGitLab(
  repo: IGitLabAPIRepository
): IAPIRepository {
  const ownerLogin = repo.path_with_namespace.split('/').slice(0, -1).join('/')
  return {
    clone_url: repo.http_url_to_repo,
    ssh_url: repo.ssh_url_to_repo,
    html_url: repo.web_url,
    name: repo.path,
    owner: {
      id: repo.owner?.id ?? 0,
      login: ownerLogin,
      avatar_url: repo.owner?.avatar_url ?? '',
      html_url: repo.owner?.web_url ?? '',
      type: 'User',
    },
    private: repo.visibility === 'private',
    fork: !!repo.forked_from_project,
    default_branch: repo.default_branch,
    pushed_at: repo.last_activity_at,
    has_issues: repo.issues_enabled,
    archived: repo.archived,
  }
}
function toIAPIFullRepositoryFromGitLab(
  repo: IGitLabAPIRepository
): IAPIFullRepository {
  return {
    ...toIAPIRepositoryFromGitLab(repo),
    parent: repo.forked_from_project
      ? toIAPIRepositoryFromGitLab(repo.forked_from_project)
      : undefined,
    permissions: {
      admin: true,
      push: true,
      pull: true,
    },
  }
}

interface IGitLabAPIMergeRequest {
  readonly iid: number
  readonly title: string
  readonly description: string
  readonly state: 'opened' | 'closed' | 'locked' | 'merged'
  readonly created_at: string
  readonly updated_at: string
  readonly author: IGitLabAPIIdentity
  readonly source_branch: string
  readonly target_branch: string
  readonly source_project_id: number
  readonly target_project_id: number
  readonly sha: string
  readonly draft: boolean
  readonly web_url: string
}
function toIAPIPullRequestFromGitLab(
  mr: IGitLabAPIMergeRequest,
  sourceRepo: IGitLabAPIRepository | null,
  targetRepo: IGitLabAPIRepository | null
): IAPIPullRequest {
  return {
    number: mr.iid,
    title: mr.title,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    user: toIAPIIdentityFromGitLab(mr.author),
    head: {
      ref: mr.source_branch,
      sha: mr.sha,
      repo: sourceRepo ? toIAPIFullRepositoryFromGitLab(sourceRepo) : null,
    },
    base: {
      ref: mr.target_branch,
      sha: mr.sha,
      repo: targetRepo ? toIAPIFullRepositoryFromGitLab(targetRepo) : null,
    },
    body: mr.description,
    state: mr.state === 'opened' ? 'open' : 'closed',
    draft: mr.draft,
  }
}

export interface IGitLabAPIIssue {
  readonly iid: number
  readonly title: string
  readonly state: 'opened' | 'closed'
  readonly updated_at: string
}
function toIAPIIssueFromGitLab(issue: IGitLabAPIIssue): IAPIIssue {
  return {
    number: issue.iid,
    title: issue.title,
    state: issue.state === 'opened' ? 'open' : 'closed',
    updated_at: issue.updated_at,
  }
}

export interface IGitLabAPIProjectMember {
  readonly id: number
  readonly username: string
  readonly name: string
  readonly avatar_url: string
  readonly web_url: string
}
function toIAPIMentionableUserFromGitLab(
  member: IGitLabAPIProjectMember
): IAPIMentionableUser {
  return {
    avatar_url: member.avatar_url,
    email: null,
    login: member.username,
    name: member.name,
  }
}

interface IForgejoAPIIdentity {
  readonly id: number
  readonly login: string
  readonly full_name: string
  readonly avatar_url: string
  readonly html_url: string
  readonly email: string
}
function toIAPIIdentityFromForgejo(
  identity: IForgejoAPIIdentity
): IAPIIdentity {
  return {
    id: identity.id,
    login: identity.login,
    avatar_url: identity.avatar_url,
    html_url: identity.html_url,
    type: 'User',
  }
}
function toIAPIFullIdentityFromForgejo(
  identity: IForgejoAPIIdentity
): IAPIFullIdentity {
  return {
    id: identity.id,
    login: identity.login,
    avatar_url: identity.avatar_url,
    html_url: identity.html_url,
    name: identity.full_name || null,
    email: identity.email || null,
    type: 'User',
  }
}

interface IForgejoAPIEmail {
  readonly email: string
  readonly verified: boolean
  readonly primary: boolean
}
function toIAPIEmailFromForgejo(email: IForgejoAPIEmail): IAPIEmail {
  return {
    email: email.email,
    verified: email.verified,
    primary: email.primary,
    visibility: 'public',
  }
}

interface IForgejoAPIOrganization {
  readonly id: number
  readonly name: string
  readonly username: string
  readonly avatar_url: string
}
function toIAPIOrganizationFromForgejo(
  org: IForgejoAPIOrganization
): IAPIOrganization {
  return {
    id: org.id,
    url: '',
    login: org.username || org.name,
    avatar_url: org.avatar_url,
  }
}

interface IForgejoAPIRepository {
  readonly name: string
  readonly html_url: string
  readonly ssh_url: string
  readonly clone_url: string
  readonly owner: IForgejoAPIIdentity
  readonly private: boolean
  readonly fork: boolean
  readonly default_branch: string
  readonly updated_at: string
  readonly has_issues: boolean
  readonly archived: boolean
  readonly parent: IForgejoAPIRepository | null
  readonly permissions?: {
    readonly admin: boolean
    readonly push: boolean
    readonly pull: boolean
  }
}
function toIAPIRepositoryFromForgejo(
  repo: IForgejoAPIRepository
): IAPIRepository {
  return {
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    html_url: repo.html_url,
    name: repo.name,
    owner: toIAPIIdentityFromForgejo(repo.owner),
    private: repo.private,
    fork: repo.fork,
    default_branch: repo.default_branch,
    pushed_at: repo.updated_at,
    has_issues: repo.has_issues,
    archived: repo.archived,
  }
}
function toIAPIFullRepositoryFromForgejo(
  repo: IForgejoAPIRepository
): IAPIFullRepository {
  return {
    ...toIAPIRepositoryFromForgejo(repo),
    parent: repo.parent ? toIAPIRepositoryFromForgejo(repo.parent) : undefined,
    permissions: repo.permissions ?? { admin: true, push: true, pull: true },
  }
}

interface IForgejoAPIPullRequestRef {
  readonly ref: string
  readonly sha: string
  readonly repo: IForgejoAPIRepository | null
}
function toIAPIPullRequestRefFromForgejo(
  ref: IForgejoAPIPullRequestRef
): IAPIPullRequestRef {
  return {
    ref: ref.ref,
    sha: ref.sha,
    repo: ref.repo ? toIAPIRepositoryFromForgejo(ref.repo) : null,
  }
}
interface IForgejoAPIPullRequest {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly created_at: string
  readonly updated_at: string
  readonly user: IForgejoAPIIdentity
  readonly head: IForgejoAPIPullRequestRef
  readonly base: IForgejoAPIPullRequestRef
  readonly draft: boolean
}
function toIAPIPullRequestFromForgejo(
  pr: IForgejoAPIPullRequest
): IAPIPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    user: toIAPIIdentityFromForgejo(pr.user),
    head: toIAPIPullRequestRefFromForgejo(pr.head),
    base: toIAPIPullRequestRefFromForgejo(pr.base),
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
  }
}

interface IForgejoAPIIssue {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly updated_at: string
}
function toIAPIIssueFromForgejo(issue: IForgejoAPIIssue): IAPIIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    updated_at: issue.updated_at,
  }
}

type ForgejoAPIStatusState =
  | 'pending'
  | 'success'
  | 'error'
  | 'failure'
  | 'warning'
interface IForgejoAPICommitStatus {
  readonly id: number
  readonly status: ForgejoAPIStatusState
  readonly target_url: string | null
  readonly description: string
  readonly context: string
  readonly created_at: string
  readonly updated_at: string
}
interface IForgejoAPICombinedStatus {
  readonly state: ForgejoAPIStatusState
  readonly total_count: number
  readonly statuses: ReadonlyArray<IForgejoAPICommitStatus> | null
}
function toIAPIRefStatusItemFromForgejo(
  status: IForgejoAPICommitStatus,
  endpoint: string
): IAPIRefStatusItem {
  return {
    state: mapRefStateFromForgejo(status.status),
    target_url: toForgejoAbsoluteURL(status.target_url, endpoint),
    description: status.description,
    context: status.context,
    id: status.id,
  }
}
function mapRefStateFromForgejo(state: ForgejoAPIStatusState): APIRefState {
  switch (state) {
    case 'pending':
      return 'pending'
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'failure':
      return 'failure'
    case 'warning':
      return 'success'
    default:
      return 'pending'
  }
}
function toForgejoAbsoluteURL(
  url: string | null,
  endpoint: string
): string | null {
  if (!url) {
    return null
  }
  try {
    // Statuses reported by Forgejo Actions use a target_url that is relative
    // to the instance root (e.g. /owner/repo/actions/runs/123)
    const host = new window.URL(endpoint).host
    return new window.URL(url, `https://${host}`).toString()
  } catch {
    return null
  }
}

/** Information about a pull request review as returned by the GitHub API. */
export interface IAPIPullRequestReview {
  readonly id: number
  readonly user: IAPIIdentity
  readonly body: string
  readonly html_url: string
  readonly submitted_at: string
  readonly state:
    | 'APPROVED'
    | 'DISMISSED'
    | 'PENDING'
    | 'COMMENTED'
    | 'CHANGES_REQUESTED'
}

/** Represents both issue comments and PR review comments */
export interface IAPIComment {
  readonly id: number
  readonly body: string
  readonly html_url: string
  readonly user: IAPIIdentity
  readonly created_at: string
}

/** The response we receive from fetching mentionables. */
interface IAPIMentionablesResponse {
  readonly etag: string | undefined
  readonly users: ReadonlyArray<IAPIMentionableUser>
}

/**
 * Parses the Link header from GitHub and returns the 'next' path
 * if one is present.
 *
 * If no link rel next header is found this method returns null.
 */
function getNextPagePathFromLink(response: Response): string | null {
  const linkHeader = response.headers.get('Link')

  if (!linkHeader) {
    return null
  }

  for (const part of linkHeader.split(',')) {
    // https://github.com/philschatz/octokat.js/blob/5658abe442e8bf405cfda1c72629526a37554613/src/plugins/pagination.js#L17
    const match = part.match(/<([^>]+)>; rel="([^"]+)"/)

    if (match && match[2] === 'next') {
      const nextURL = URL.parse(match[1])
      return nextURL.path || null
    }
  }

  return null
}

/**
 * Parses the 'next' Link header from GitHub using
 * `getNextPagePathFromLink`. Unlike `getNextPagePathFromLink`
 * this method will attempt to double the page size when
 * the current page index and the page size allows for it
 * leading to a ramp up in page size.
 *
 * This might sound confusing, and it is, but the primary use
 * case for this is when retrieving updated PRs. By specifying
 * an initial page size of, for example, 10 this method will
 * increase the page size to 20 once the second page has been
 * loaded. See the table below for an example. The ramp-up
 * will stop at a page size of 100 since that's the maximum
 * that the GitHub API supports.
 *
 * ```
 * |-----------|------|-----------|-----------------|
 * | Request # | Page | Page size | Retrieved items |
 * |-----------|------|-----------|-----------------|
 * | 1         | 1    | 10        | 10              |
 * | 2         | 2    | 10        | 20              |
 * | 3         | 2    | 20        | 40              |
 * | 4         | 2    | 40        | 80              |
 * | 5         | 2    | 80        | 160             |
 * | 6         | 3    | 80        | 240             |
 * | 7         | 4    | 80        | 320             |
 * | 8         | 5    | 80        | 400             |
 * | 9         | 5    | 100       | 500             |
 * |-----------|------|-----------|-----------------|
 * ```
 * This algorithm means we can have the best of both worlds.
 * If there's a small number of changed pull requests since
 * our last update we'll do small requests that use minimal
 * bandwidth but if we encounter a repository where a lot
 * of PRs have changed since our last fetch (like a very
 * active repository or one we haven't fetched in a long time)
 * we'll spool up our page size in just a few requests and load
 * in bulk.
 *
 * As an example I used a very active internal repository and
 * asked for all PRs updated in the last 24 hours which was 320.
 * With the previous regime of fetching with a page size of 10
 * that obviously took 32 requests. With this new regime it
 * would take 7.
 */
export function getNextPagePathWithIncreasingPageSize(
  response: Response,
  perPageParamName: string,
  pageParamName: string,
  maxResults: number
) {
  const nextPath = getNextPagePathFromLink(response)

  if (!nextPath) {
    return null
  }

  const { pathname, query } = URL.parse(nextPath, true)
  const { [perPageParamName]: perPage, [pageParamName]: page } = query

  const pageSize = typeof perPage === 'string' ? parseInt(perPage, 10) : NaN
  const pageNumber = typeof page === 'string' ? parseInt(page, 10) : NaN

  if (!pageSize || !pageNumber) {
    return nextPath
  }

  // Confusing, but we're looking at the _next_ page path here
  // so the current is whatever came before it.
  const currentPage = pageNumber - 1

  // Number of received items thus far
  const received = currentPage * pageSize

  // Can't go above maxResults, that's the max the API will allow.
  const nextPageSize = Math.min(maxResults, pageSize * 2)

  // Have we received exactly the amount of items
  // such that doubling the page size and loading the
  // second page would seamlessly fit? No sense going
  // above 100 since that's the max the API supports
  if (pageSize !== nextPageSize && received % nextPageSize === 0) {
    query[perPageParamName] = `${nextPageSize}`
    query[pageParamName] = `${received / nextPageSize + 1}`
    return URL.format({ pathname, query })
  }

  return nextPath
}

/**
 * Returns an ISO 8601 time string with second resolution instead of
 * the standard javascript toISOString which returns millisecond
 * resolution. The GitHub API doesn't return dates with milliseconds
 * so we won't send any back either.
 */
function toGitHubIsoDateString(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface IAPIAliveSignedChannel {
  readonly channel_name: string
  readonly signed_channel: string
}

interface IAPIAliveWebSocket {
  readonly url: string
}

type TokenInvalidatedCallback = (endpoint: string, token: string) => void

export interface IAPICreatePushProtectionBypassResponse {
  reason: BypassReasonType
  expire_at: string
  token_type: string
}

interface IBitbucketAPIWorkspaceAccess {
  administrator: boolean
  workspace: IBitbucketAPIWorkspace
}
interface IBitbucketAPIWorkspace {
  uuid: string
  name: string
}

/**
 * An object for making authenticated requests to the GitHub API
 */
export class API {
  private static tokenProvider:
    | ((
        endpoint: string,
        token: string,
        login: string | UnknownLogin
      ) => Promise<string>)
    | undefined
  private static readonly tokenInvalidatedListeners =
    new Set<TokenInvalidatedCallback>()

  /** Install the renderer's shared credential authority. Returns a cleanup function. */
  public static setTokenProvider(
    provider: (
      endpoint: string,
      token: string,
      login: string | UnknownLogin
    ) => Promise<string>
  ) {
    const previous = this.tokenProvider
    this.tokenProvider = provider
    return () => {
      this.tokenProvider = previous
    }
  }

  public static onTokenInvalidated(callback: TokenInvalidatedCallback) {
    this.tokenInvalidatedListeners.add(callback)
    return () => this.tokenInvalidatedListeners.delete(callback)
  }

  private static emitTokenInvalidated(endpoint: string, token: string) {
    this.tokenInvalidatedListeners.forEach(callback =>
      callback(endpoint, token)
    )
  }

  /** Create a new API client from the given account. */
  public static fromAccount(account: Account): API {
    // Public-repository fallback must not inherit an unrelated account's sign-in state.
    return instantiateAPI(
      account.apiType,
      account.endpoint,
      account.token,
      account.login,
      account.copilotEndpoint,
      account.id !== -1
    )
  }

  protected endpoint: string
  protected token: string
  protected login: string | UnknownLogin
  private copilotEndpoint?: string

  /** Create a new API client for the endpoint, authenticated with the token. */
  public constructor(
    endpoint: string,
    token: string,
    login: string | UnknownLogin,
    copilotEndpoint?: string,
    /**
     * Use the account store to resolve/refresh tokens and handle rejected tokens.
     * Disable for new sign-in tokens and the anonymous public-repository fallback:
     * those must use the supplied token, not another signed-in account's token.
     */
    private readonly manageAccountToken = true
  ) {
    this.endpoint = endpoint
    this.token = token
    this.login = login
    this.copilotEndpoint = copilotEndpoint
  }

  protected get maxPerPage() {
    return 100
  }
  protected get perPageParamName() {
    return 'per_page'
  }
  protected get pageParamName() {
    return 'page'
  }
  protected get paginatorNextPage() {
    return ''
  }
  protected get paginatorValues() {
    return ''
  }

  /**
   * Retrieves the name of the Alive channel used by Desktop to receive
   * high-signal notifications.
   */
  public async getAliveDesktopChannel(): Promise<IAPIAliveSignedChannel | null> {
    try {
      const res = await this.ghRequest('GET', '/desktop_internal/alive-channel')
      const signedChannel = await parsedResponse<IAPIAliveSignedChannel>(res)
      return signedChannel
    } catch (e) {
      log.warn(`Alive channel request failed: ${e}`)
      return null
    }
  }

  /**
   * Retrieves the URL for the Alive websocket.
   *
   * @returns The websocket URL if the request succeeded, null if the request
   * failed with 404, otherwise it will throw an error.
   *
   * This behavior is expected by the AliveSession class constructor, to prevent
   * it from hitting the endpoint many times if it's disabled.
   */
  public async getAliveWebSocketURL(): Promise<string | null> {
    try {
      const res = await this.ghRequest('GET', '/alive_internal/websocket-url')
      if (res.status === HttpStatusCode.NotFound) {
        return null
      }
      const websocket = await parsedResponse<IAPIAliveWebSocket>(res)
      return websocket.url
    } catch (e) {
      log.warn(`Alive web socket request failed: ${e}`)
      throw e
    }
  }

  /**
   * Fetch an issue comment (i.e. a comment on an issue or pull request).
   *
   * @param owner The owner of the repository
   * @param name The name of the repository
   * @param commentId The ID of the comment
   *
   * @returns The comment if it was found, null if it wasn't, or an error
   * occurred.
   */
  public async fetchIssueComment(
    owner: string,
    name: string,
    commentId: string
  ): Promise<IAPIComment | null> {
    try {
      const response = await this.ghRequest(
        'GET',
        `repos/${owner}/${name}/issues/comments/${commentId}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(
          `fetchIssueComment: '${owner}/${name}/issues/comments/${commentId}' returned a 404`
        )
        return null
      }
      return await parsedResponse<IAPIComment>(response)
    } catch (e) {
      log.warn(
        `fetchIssueComment: an error occurred for '${owner}/${name}/issues/comments/${commentId}'`,
        e
      )
      return null
    }
  }

  /**
   * Fetch a pull request review comment (i.e. a comment that was posted as part
   * of a review of a pull request).
   *
   * @param owner The owner of the repository
   * @param name The name of the repository
   * @param commentId The ID of the comment
   *
   * @returns The comment if it was found, null if it wasn't, or an error
   * occurred.
   */
  public async fetchPullRequestReviewComment(
    owner: string,
    name: string,
    commentId: string
  ): Promise<IAPIComment | null> {
    try {
      const response = await this.ghRequest(
        'GET',
        `repos/${owner}/${name}/pulls/comments/${commentId}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(
          `fetchPullRequestReviewComment: '${owner}/${name}/pulls/comments/${commentId}' returned a 404`
        )
        return null
      }
      return await parsedResponse<IAPIComment>(response)
    } catch (e) {
      log.warn(
        `fetchPullRequestReviewComment: an error occurred for '${owner}/${name}/pulls/comments/${commentId}'`,
        e
      )
      return null
    }
  }

  /** Fetch a repo by its owner and name. */
  public async fetchRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    try {
      const response = await this.ghRequest('GET', `repos/${owner}/${name}`)
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchRepository: '${owner}/${name}' returned a 404`)
        return null
      }
      return await parsedResponse<IAPIFullRepository>(response)
    } catch (e) {
      log.warn(`fetchRepository: an error occurred for '${owner}/${name}'`, e)
      return null
    }
  }

  /**
   * Fetch a repo by its owner and name to find out whether the account can
   * access it.
   *
   * Resolves to null when the repository isn't visible to the account (404).
   * Unlike `fetchRepository`, any other failure (network errors, rate limits,
   * server errors) is thrown so that it isn't mistaken for a lack of access.
   */
  public async fetchRepositoryIfAccessible(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    const response = await this.ghRequest('GET', `repos/${owner}/${name}`)
    if (response.status === HttpStatusCode.NotFound) {
      return null
    }
    return parsedResponse<IAPIFullRepository>(response)
  }

  /**
   * Fetch info needed to clone a repository. That includes:
   *  - The canonical clone URL for a repository, respecting the protocol
   *    preference if provided.
   *  - The default branch of the repository, in case the repository is empty.
   *    Only available for GitHub repositories.
   *
   * Returns null if the request returned a 404 (NotFound). NotFound doesn't
   * necessarily mean that the repository doesn't exist, it could exist and
   * the current user just doesn't have the permissions to see it. GitHub.com
   * doesn't differentiate between not found and permission denied for private
   * repositories as that would leak the existence of a private repository.
   *
   * Note that unlike `fetchRepository` this method will throw for all errors
   * except 404 NotFound responses.
   *
   * @param owner    The repository owner (nodejs in https://github.com/nodejs/node)
   * @param name     The repository name (node in https://github.com/nodejs/node)
   * @param protocol The preferred Git protocol (https or ssh)
   */
  public async fetchRepositoryCloneInfo(
    owner: string,
    name: string,
    protocol: GitProtocol | undefined
  ): Promise<IAPIRepositoryCloneInfo | null> {
    const response = await this.ghRequest('GET', `repos/${owner}/${name}`, {
      // Make sure we don't run into cache issues when fetching the repositories,
      // specially after repositories have been renamed.
      reloadCache: true,
    })

    if (response.status === HttpStatusCode.NotFound) {
      return null
    }

    const repo = await parsedResponse<IAPIRepository>(response)
    return {
      url: protocol === 'ssh' ? repo.ssh_url : repo.clone_url,
      defaultBranch: repo.default_branch,
    }
  }

  /**
   * Fetch all repos a user has access to in a streaming fashion. The callback
   * will be called for each new page fetched from the API.
   */
  public async streamUserRepositories(
    callback: (repos: ReadonlyArray<IAPIRepository>) => void,
    affiliation?: AffiliationFilter,
    options?: IFetchAllOptions<IAPIRepository>
  ) {
    try {
      const base = 'user/repos'
      const path = affiliation ? `${base}?affiliation=${affiliation}` : base

      await this.fetchAll<IAPIRepository>(path, {
        ...options,
        // "But wait, repositories can't have a null owner" you say.
        // Ordinarily you'd be correct but turns out there's super
        // rare circumstances where a user has been deleted but the
        // repository hasn't. Such cases are usually addressed swiftly
        // but in some cases like GitHub Enterprise instances
        // they can linger for longer than we'd like so we'll make
        // sure to exclude any such dangling repository, chances are
        // they won't be cloneable anyway.
        onPage: page => {
          callback(page.filter(x => x.owner !== null))
          options?.onPage?.(page)
        },
      })
    } catch (error) {
      log.warn(
        `streamUserRepositories: failed with endpoint ${this.endpoint}`,
        error
      )
    }
  }

  /** Fetch the logged in account. */
  public async fetchAccount(): Promise<IAPIFullIdentity> {
    try {
      const response = await this.ghRequest('GET', 'user')
      const result = await parsedResponse<IAPIFullIdentity>(response)
      return result
    } catch (e) {
      log.warn(`fetchAccount: failed with endpoint ${this.endpoint}`, e)
      throw e
    }
  }

  /** Fetch the current user's emails. */
  public async fetchEmails(): Promise<ReadonlyArray<IAPIEmail>> {
    try {
      const response = await this.ghRequest('GET', 'user/emails')
      const result = await parsedResponse<ReadonlyArray<IAPIEmail>>(response)

      return Array.isArray(result) ? result : []
    } catch (e) {
      log.warn(`fetchEmails: failed with endpoint ${this.endpoint}`, e)
      return []
    }
  }

  /** Fetch all the orgs to which the user belongs. */
  public async fetchOrgs(): Promise<ReadonlyArray<IAPIOrganization>> {
    try {
      return await this.fetchAll<IAPIOrganization>('user/orgs')
    } catch (e) {
      log.warn(`fetchOrgs: failed with endpoint ${this.endpoint}`, e)
      return []
    }
  }

  /** Create a new GitHub repository with the given properties. */
  public async createRepository(
    org: IAPIOrganization | null,
    name: string,
    description: string,
    private_: boolean
  ): Promise<IAPIFullRepository> {
    try {
      const apiPath = org ? `orgs/${org.login}/repos` : 'user/repos'
      const response = await this.ghRequest('POST', apiPath, {
        body: {
          name,
          description,
          private: private_,
        },
      })

      return await parsedResponse<IAPIFullRepository>(response)
    } catch (e) {
      if (e instanceof APIError) {
        if (org !== null) {
          throw new Error(
            `Unable to create repository for organization '${org.login}'. Verify that the repository does not already exist and that you have permission to create a repository there.`
          )
        }
        throw e
      }

      log.error(`createRepository: failed with endpoint ${this.endpoint}`, e)
      throw new Error(
        `Unable to publish repository. Please check if you have an internet connection and try again.`
      )
    }
  }

  /** Create a new GitHub fork of this repository (owner and name) */
  public async forkRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository> {
    try {
      const apiPath = `/repos/${owner}/${name}/forks`
      const response = await this.ghRequest('POST', apiPath)
      return await parsedResponse<IAPIFullRepository>(response)
    } catch (e) {
      log.error(
        `forkRepository: failed to fork ${owner}/${name} at endpoint: ${this.endpoint}`,
        e
      )
      throw e
    }
  }

  /**
   * Fetch the issues with the given state that have been created or updated
   * since the given date.
   */
  public async fetchIssues(
    owner: string,
    name: string,
    state: 'open' | 'closed' | 'all',
    since: Date | null
  ): Promise<ReadonlyArray<IAPIIssue>> {
    const params: { [key: string]: string } = {
      state,
    }
    if (since && !isNaN(since.getTime())) {
      params.since = toGitHubIsoDateString(since)
    }

    const url = urlWithQueryString(`repos/${owner}/${name}/issues`, params)
    try {
      const issues = await this.fetchAll<IAPIIssue>(url)

      // PRs are issues! But we only want Really Seriously Issues.
      return issues.filter((i: any) => !i.pullRequest)
    } catch (e) {
      log.warn(`fetchIssues: failed for repository ${owner}/${name}`, e)
      throw e
    }
  }

  /** Fetch all open pull requests in the given repository. */
  public async fetchAllOpenPullRequests(owner: string, name: string) {
    const url = urlWithQueryString(`repos/${owner}/${name}/pulls`, {
      state: 'open',
    })
    try {
      return await this.fetchAll<IAPIPullRequest>(url)
    } catch (e) {
      log.warn(`failed fetching open PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  /**
   * Fetch all pull requests in the given repository that have been
   * updated on or after the provided date.
   *
   * Note: The GitHub API doesn't support providing a last-updated
   * limitation for PRs like it does for issues so we're emulating
   * the issues API by sorting PRs descending by last updated and
   * only grab as many pages as we need to until we no longer receive
   * PRs that have been update more recently than the `since`
   * parameter.
   *
   * If there's more than `maxResults` updated PRs since the last time
   * we fetched this method will throw an error such that we can abort
   * this strategy and commence loading all open PRs instead.
   */
  public async fetchUpdatedPullRequests(
    owner: string,
    name: string,
    since: Date,
    // 320 is chosen because with a ramp-up page size starting with
    // a page size of 10 we'll reach 320 in exactly 7 pages. See
    // getNextPagePathWithIncreasingPageSize
    maxResults = 320
  ) {
    const sinceTime = since.getTime()
    const url = urlWithQueryString(`repos/${owner}/${name}/pulls`, {
      state: 'all',
      sort: 'updated',
      direction: 'desc',
    })

    try {
      const prs = await this.fetchAll<IAPIPullRequest>(url, {
        // We use a page size smaller than our default 100 here because we
        // expect that the majority use case will return much less than
        // 100 results. Given that as long as _any_ PR has changed we'll
        // get the full list back (PRs doesn't support ?since=) we want
        // to keep this number fairly conservative in order to not use
        // up bandwidth needlessly while balancing it such that we don't
        // have to use a lot of requests to update our database. We then
        // ramp up the page size (see getNextPagePathWithIncreasingPageSize)
        // if it turns out there's a lot of updated PRs.
        perPage: 10,
        getNextPagePath: response =>
          getNextPagePathWithIncreasingPageSize(
            response,
            this.perPageParamName,
            this.pageParamName,
            this.maxPerPage
          ),
        continue(results) {
          if (results.length >= maxResults) {
            throw new MaxResultsError('got max pull requests, aborting')
          }

          // Given that we sort the results in descending order by their
          // updated_at field we can safely say that if the last item
          // is modified after our sinceTime then haven't reached the
          // end of updated PRs.
          const last = results.at(-1)
          return last !== undefined && Date.parse(last.updated_at) > sinceTime
        },
        // We can't ignore errors here as that might mean that we haven't
        // retrieved enough pages to fully capture the changes since the
        // last time we updated. Ignoring errors here would mean that we'd
        // store an incorrect lastUpdated field in the database.
        suppressErrors: false,
      })
      return prs.filter(pr => Date.parse(pr.updated_at) >= sinceTime)
    } catch (e) {
      log.warn(`failed fetching updated PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  /**
   * Fetch a single pull request in the given repository
   */
  public async fetchPullRequest(owner: string, name: string, prNumber: string) {
    try {
      const path = `/repos/${owner}/${name}/pulls/${prNumber}`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIPullRequest>(response)
    } catch (e) {
      log.warn(`failed fetching PR for ${owner}/${name}/pulls/${prNumber}`, e)
      throw e
    }
  }

  /**
   * Fetch a single pull request review in the given repository
   */
  public async fetchPullRequestReview(
    owner: string,
    name: string,
    prNumber: string,
    reviewId: string
  ) {
    try {
      const path = `/repos/${owner}/${name}/pulls/${prNumber}/reviews/${reviewId}`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIPullRequestReview>(response)
    } catch (e) {
      log.debug(
        `failed fetching PR review ${reviewId} for ${owner}/${name}/pulls/${prNumber}`,
        e
      )
      return null
    }
  }

  /** Fetches all reviews from a given pull request. */
  public async fetchPullRequestReviews(
    owner: string,
    name: string,
    prNumber: string
  ) {
    try {
      const path = `/repos/${owner}/${name}/pulls/${prNumber}/reviews`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIPullRequestReview[]>(response)
    } catch (e) {
      log.debug(
        `failed fetching PR reviews for ${owner}/${name}/pulls/${prNumber}`,
        e
      )
      return []
    }
  }

  /** Fetches all review comments from a given pull request. */
  public async fetchPullRequestReviewComments(
    owner: string,
    name: string,
    prNumber: string,
    reviewId: string
  ) {
    try {
      const path = `/repos/${owner}/${name}/pulls/${prNumber}/reviews/${reviewId}/comments`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIComment[]>(response)
    } catch (e) {
      log.debug(
        `failed fetching PR review comments for ${owner}/${name}/pulls/${prNumber}`,
        e
      )
      return []
    }
  }

  /** Fetches all review comments from a given pull request. */
  public async fetchPullRequestComments(
    owner: string,
    name: string,
    prNumber: string
  ) {
    try {
      const path = `/repos/${owner}/${name}/pulls/${prNumber}/comments`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIComment[]>(response)
    } catch (e) {
      log.debug(
        `failed fetching PR comments for ${owner}/${name}/pulls/${prNumber}`,
        e
      )
      return []
    }
  }

  /** Fetches all comments from a given issue. */
  public async fetchIssueComments(
    owner: string,
    name: string,
    issueNumber: string
  ) {
    try {
      const path = `/repos/${owner}/${name}/issues/${issueNumber}/comments`
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIComment[]>(response)
    } catch (e) {
      log.debug(
        `failed fetching issue comments for ${owner}/${name}/issues/${issueNumber}`,
        e
      )
      return []
    }
  }

  /**
   * Get the combined status for the given ref.
   */
  public async fetchCombinedRefStatus(
    owner: string,
    name: string,
    ref: string,
    reloadCache: boolean = false
  ): Promise<IAPIRefStatus | null> {
    const safeRef = encodeURIComponent(ref)
    const path = `repos/${owner}/${name}/commits/${safeRef}/status?per_page=100`
    const response = await this.ghRequest('GET', path, {
      reloadCache,
    })

    try {
      return await parsedResponse<IAPIRefStatus>(response)
    } catch (err) {
      log.debug(
        `Failed fetching check runs for ref ${ref} (${owner}/${name})`,
        err
      )
      return null
    }
  }

  /**
   * Get any check run results for the given ref.
   */
  public async fetchRefCheckRuns(
    owner: string,
    name: string,
    ref: string,
    reloadCache: boolean = false
  ): Promise<IAPIRefCheckRuns | null> {
    const safeRef = encodeURIComponent(ref)
    const path = `repos/${owner}/${name}/commits/${safeRef}/check-runs?per_page=100`
    const headers = {
      Accept: 'application/vnd.github.antiope-preview+json',
    }

    const response = await this.ghRequest('GET', path, {
      customHeaders: headers,
      reloadCache,
    })

    try {
      return await parsedResponse<IAPIRefCheckRuns>(response)
    } catch (err) {
      log.debug(
        `Failed fetching check runs for ref ${ref} (${owner}/${name})`,
        err
      )
      return null
    }
  }

  /**
   * List workflow runs for a repository filtered by branch and event type of
   * pull_request
   */
  public async fetchPRWorkflowRunsByBranchName(
    owner: string,
    name: string,
    branchName: string
  ): Promise<IAPIWorkflowRuns | null> {
    const path = `repos/${owner}/${name}/actions/runs?event=pull_request&branch=${encodeURIComponent(
      branchName
    )}`
    const customHeaders = {
      Accept: 'application/vnd.github.antiope-preview+json',
    }
    const response = await this.ghRequest('GET', path, { customHeaders })
    try {
      return await parsedResponse<IAPIWorkflowRuns>(response)
    } catch {
      log.debug(
        `Failed fetching workflow runs for ${branchName} (${owner}/${name})`
      )
    }
    return null
  }

  /**
   * Return the workflow run for a given check_suite_id.
   *
   * A check suite is a reference for a set check runs.
   * A workflow run is a reference for set a of workflows for the GitHub Actions
   * check runner.
   *
   * If a check suite is comprised of check runs ran by actions, there will be
   * one workflow run that represents that check suite. Thus, if this api should
   * either return an empty array indicating there are no actions runs for that
   * check_suite_id (so check suite was not ran by actions) or an array with a
   * single element.
   */
  public async fetchPRActionWorkflowRunByCheckSuiteId(
    owner: string,
    name: string,
    checkSuiteId: number
  ): Promise<IAPIWorkflowRun | null> {
    const path = `repos/${owner}/${name}/actions/runs?event=pull_request&check_suite_id=${checkSuiteId}`
    const customHeaders = {
      Accept: 'application/vnd.github.antiope-preview+json',
    }
    const response = await this.ghRequest('GET', path, { customHeaders })
    try {
      const apiWorkflowRuns = await parsedResponse<IAPIWorkflowRuns>(response)

      if (apiWorkflowRuns.workflow_runs.length > 0) {
        return apiWorkflowRuns.workflow_runs[0]
      }
    } catch {
      log.debug(
        `Failed fetching workflow runs for ${checkSuiteId} (${owner}/${name})`
      )
    }
    return null
  }

  /**
   * List workflow run jobs for a given workflow run
   */
  public async fetchWorkflowRunJobs(
    owner: string,
    name: string,
    workflowRunId: number
  ): Promise<IAPIWorkflowJobs | null> {
    const path = `repos/${owner}/${name}/actions/runs/${workflowRunId}/jobs`
    const customHeaders = {
      Accept: 'application/vnd.github.antiope-preview+json',
    }
    const response = await this.ghRequest('GET', path, {
      customHeaders,
    })
    try {
      return await parsedResponse<IAPIWorkflowJobs>(response)
    } catch {
      log.debug(
        `Failed fetching workflow jobs (${owner}/${name}) workflow run: ${workflowRunId}`
      )
    }
    return null
  }

  /**
   * Triggers GitHub to rerequest an existing check suite, without pushing new
   * code to a repository.
   */
  public async rerequestCheckSuite(
    owner: string,
    name: string,
    checkSuiteId: number
  ): Promise<boolean> {
    const path = `/repos/${owner}/${name}/check-suites/${checkSuiteId}/rerequest`

    return this.ghRequest('POST', path)
      .then(x => x.ok)
      .catch(err => {
        log.debug(
          `Failed retry check suite id ${checkSuiteId} (${owner}/${name})`,
          err
        )
        return false
      })
  }

  /**
   * Re-run all of the failed jobs and their dependent jobs in a workflow run
   * using the id of the workflow run.
   */
  public async rerunFailedJobs(
    owner: string,
    name: string,
    workflowRunId: number
  ): Promise<boolean> {
    const path = `/repos/${owner}/${name}/actions/runs/${workflowRunId}/rerun-failed-jobs`

    return this.ghRequest('POST', path)
      .then(x => x.ok)
      .catch(err => {
        log.debug(
          `Failed to rerun failed workflow jobs for (${owner}/${name}): ${workflowRunId}`,
          err
        )
        return false
      })
  }

  /**
   * Re-run a job and its dependent jobs in a workflow run.
   */
  public async rerunJob(
    owner: string,
    name: string,
    jobId: number
  ): Promise<boolean> {
    const path = `/repos/${owner}/${name}/actions/jobs/${jobId}/rerun`

    return this.ghRequest('POST', path)
      .then(x => x.ok)
      .catch(err => {
        log.debug(
          `Failed to rerun workflow job (${owner}/${name}): ${jobId}`,
          err
        )
        return false
      })
  }

  public async getAvatarToken() {
    return this.ghRequest('GET', `/desktop/avatar-token`)
      .then(x => x.json())
      .then((x: unknown) =>
        x &&
        typeof x === 'object' &&
        'avatar_token' in x &&
        typeof x.avatar_token === 'string'
          ? x.avatar_token
          : null
      )
      .catch(err => {
        log.debug(`Failed to load avatar token`, err)
        return null
      })
  }

  /**
   * Gets a single check suite using its id
   */
  public async fetchCheckSuite(
    owner: string,
    name: string,
    checkSuiteId: number
  ): Promise<IAPICheckSuite | null> {
    const path = `/repos/${owner}/${name}/check-suites/${checkSuiteId}`
    const response = await this.ghRequest('GET', path)

    try {
      return await parsedResponse<IAPICheckSuite>(response)
    } catch {
      log.debug(
        `[fetchCheckSuite] Failed fetch check suite id ${checkSuiteId} (${owner}/${name})`
      )
    }

    return null
  }

  /**
   * Get branch protection info to determine if a user can push to a given branch.
   *
   * Note: if request fails, the default returned value assumes full access for the user
   */
  public async fetchPushControl(
    owner: string,
    name: string,
    branch: string
  ): Promise<IAPIPushControl> {
    const path = `repos/${owner}/${name}/branches/${encodeURIComponent(
      branch
    )}/push_control`

    const headers: any = {
      Accept: 'application/vnd.github.phandalin-preview',
    }

    try {
      const response = await this.ghRequest('GET', path, {
        customHeaders: headers,
      })
      return await parsedResponse<IAPIPushControl>(response)
    } catch (err) {
      log.info(
        `[fetchPushControl] unable to check if branch is potentially pushable`,
        err
      )
      return {
        pattern: null,
        required_signatures: false,
        required_status_checks: [],
        required_approving_review_count: 0,
        required_linear_history: false,
        allow_actor: true,
        allow_deletions: true,
        allow_force_pushes: true,
      }
    }
  }

  /**
   * Fetch the repository's protected branches.
   *
   * Returns an empty array when the request succeeds and no protected branches
   * exist, or null when the protected branch list could not be refreshed.
   */
  public async fetchProtectedBranches(
    owner: string,
    name: string
  ): Promise<ReadonlyArray<IAPIBranch> | null> {
    const path = `repos/${owner}/${name}/branches?protected=true`
    try {
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIBranch[]>(response)
    } catch (err) {
      log.info(
        `[fetchProtectedBranches] unable to list protected branches`,
        err
      )
      return null
    }
  }

  /**
   * Fetches all repository rules that apply to the provided branch.
   */
  public async fetchRepoRulesForBranch(
    owner: string,
    name: string,
    branch: string
  ): Promise<ReadonlyArray<IAPIRepoRule>> {
    const path = `repos/${owner}/${name}/rules/branches/${encodeURIComponent(
      branch
    )}`
    try {
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIRepoRule[]>(response)
    } catch (err) {
      // If the repository isn't owned by the current user there's no way for us
      // to preemptively check whether rulesets are enabled so we give it a shot
      // but there's no need to log if it fails. Same with 404s, i.e the user
      // doesn't have access to the repo any more or it's been deleted.
      if (!isRulesetsNotEnabledError(err) && !isNotFoundApiError(err)) {
        log.info(
          `[fetchRepoRulesForBranch] unable to fetch repo rules for branch: ${branch} | ${path}`,
          err
        )
      }
      return new Array<IAPIRepoRule>()
    }
  }

  /**
   * Fetches slim versions of all repo rulesets for the given repository. Utilize the cache
   * in IAppState instead of querying this if possible.
   */
  public async fetchAllRepoRulesets(
    owner: string,
    name: string
  ): Promise<ReadonlyArray<IAPISlimRepoRuleset> | null> {
    const path = `repos/${owner}/${name}/rulesets`
    try {
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<ReadonlyArray<IAPISlimRepoRuleset>>(response)
    } catch (err) {
      // If the repository isn't owned by the current user there's no way for us
      // to preemptively check whether rulesets are enabled so we give it a shot
      // but there's no need to log if it fails. Same with 404s, i.e the user
      // doesn't have access to the repo any more or it's been deleted.
      if (!isRulesetsNotEnabledError(err) && !isNotFoundApiError(err)) {
        log.info(
          `[fetchAllRepoRulesets] unable to fetch all repo rulesets | ${path}`,
          err
        )
      }
      return null
    }
  }

  /**
   * Fetches the repo ruleset with the given ID. Utilize the cache in IAppState
   * instead of querying this if possible.
   */
  public async fetchRepoRuleset(
    owner: string,
    name: string,
    id: number
  ): Promise<IAPIRepoRuleset | null> {
    const path = `repos/${owner}/${name}/rulesets/${id}`
    try {
      const response = await this.ghRequest('GET', path)
      return await parsedResponse<IAPIRepoRuleset>(response)
    } catch (err) {
      log.info(
        `[fetchRepoRuleset] unable to fetch repo ruleset for ID: ${id} | ${path}`,
        err
      )
      return null
    }
  }

  /**
   * Authenticated requests to a paginating resource such as issues.
   *
   * Follows the GitHub API hypermedia links to get the subsequent
   * pages when available, buffers all items and returns them in
   * one array when done.
   */
  protected async fetchAll<T>(path: string, options?: IFetchAllOptions<T>) {
    const buf = new Array<T>()
    const opts: IFetchAllOptions<T> = { perPage: this.maxPerPage, ...options }
    const params = { [this.perPageParamName]: `${opts.perPage}` }

    let nextPath: string | null = urlWithQueryString(path, params)
    do {
      const response: Response = await this.ghRequest('GET', nextPath)
      if (opts.suppressErrors !== false && !response.ok) {
        log.warn(`fetchAll: '${path}' returned a ${response.status}`)
        return buf
      }

      const responseObject = await parsedResponse(response)
      const { paginatorNext, page } = this.parsePaginator<T>(responseObject)
      if (page) {
        buf.push(...page)
        opts.onPage?.(page)
      }

      if (paginatorNext !== false) {
        nextPath = paginatorNext
      } else {
        nextPath = opts.getNextPagePath
          ? opts.getNextPagePath(response)
          : getNextPagePathFromLink(response)
      }
    } while (nextPath && (!opts.continue || (await opts.continue(buf))))

    return buf
  }

  protected parsePaginator<T>(responseObject: unknown): {
    paginatorNext: string | null | false
    page: ReadonlyArray<T>
  } {
    if (Array.isArray(responseObject)) {
      return {
        paginatorNext: false,
        page: responseObject,
      }
    }
    if (this.isPaginatorResponse(responseObject)) {
      return {
        paginatorNext:
          (responseObject[this.paginatorNextPage] as string | undefined) ||
          null,
        page: (responseObject[this.paginatorValues] as ReadonlyArray<T>) || [],
      }
    }
    console.warn(
      "Response object doesn't match expected paginator format, falling back to Link header parsing.",
      responseObject
    )
    return {
      paginatorNext: false,
      page: [],
    }
  }

  private isPaginatorResponse(responseObject: unknown): responseObject is {
    [key: string]: unknown
  } {
    return (
      responseObject !== null &&
      typeof responseObject === 'object' &&
      this.paginatorValues in responseObject
    )
  }

  /** Make an authenticated request to the client's endpoint with its token. */
  protected async request(
    endpoint: string,
    method: HTTPMethod,
    path: string,
    options: {
      body?: object
      customHeaders?: object
      reloadCache?: boolean
    } = {},
    resolvedToken?: string
  ): Promise<Response> {
    const token =
      resolvedToken ??
      (API.tokenProvider && this.manageAccountToken
        ? await API.tokenProvider(this.endpoint, this.token, this.login)
        : this.token)
    return await request(
      endpoint,
      token,
      method,
      path,
      options.body,
      options.customHeaders,
      options.reloadCache
    )
  }

  /**
   * Make an authenticated request to the client's endpoint with its token.
   * Used for GitHub API requests.
   */
  private async ghRequest(
    method: HTTPMethod,
    path: string,
    options: {
      body?: object
      customHeaders?: object
      reloadCache?: boolean
    } = {}
  ): Promise<Response> {
    const token =
      API.tokenProvider && this.manageAccountToken
        ? await API.tokenProvider(this.endpoint, this.token, this.login)
        : this.token
    const response = await this.request(
      this.endpoint,
      method,
      path,
      options,
      token
    )

    // Only consider invalid token when the status is 401 and the response has
    // the X-GitHub-Request-Id header, meaning it comes from GH(E) and not from
    // any kind of proxy/gateway. For more info see #12943
    // We're also not considering a token has been invalidated when the reason
    // behind a 401 is the fact that any kind of 2 factor auth is required.
    if (
      this.manageAccountToken &&
      response.status === HttpStatusCode.Unauthorized &&
      response.headers.has('X-GitHub-Request-Id') &&
      !response.headers.has('X-GitHub-OTP')
    ) {
      API.emitTokenInvalidated(this.endpoint, token)
    }
    if (this.manageAccountToken && this.isThirdPartyTokenRejected(response)) {
      API.emitTokenInvalidated(this.endpoint, token)
    }

    tryUpdateEndpointVersionFromResponse(this.endpoint, response)

    return response
  }

  protected isThirdPartyTokenRejected(response: Response) {
    return false
  }

  /**
   * Make an authenticated request to the client's Copilot endpoint with its
   * token. Used for Copilot API requests.
   */
  private async copilotRequest(
    path: string,
    message: string
  ): Promise<CopilotChatCompletionResponse> {
    if (!this.copilotEndpoint) {
      throw new Error('No Copilot endpoint available')
    }

    const response = await this.request(this.copilotEndpoint, 'POST', path, {
      body: {
        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
        stream: false,
        response_format: {
          type: 'json_object',
        },
      },
      customHeaders: {
        'X-Initiator': 'user',
        'X-Interaction-ID': crypto.randomUUID(),
        'X-Interaction-Type': 'generateCommitMessage',
      },
    })

    if (response.status === HttpStatusCode.TooManyRequests) {
      const retryAfter = response.headers.get('Retry-After')
      if (retryAfter) {
        throw new CopilotError(
          `Rate limited, retry after ${retryAfter} seconds.`,
          response.status
        )
      } else {
        throw new CopilotError(
          'Rate limited, try again in a few minutes.',
          response.status
        )
      }
    } else if (response.status === HttpStatusCode.PaymentRequired) {
      throw parseCopilotPaymentRequiredError(
        await response.text(),
        response.headers.get('Retry-After')
      )
    } else if (response.status === HttpStatusCode.Unauthorized) {
      throw new CopilotError(
        'Unauthorized: error with authentication.',
        response.status
      )
    } else if (response.status === HttpStatusCode.Forbidden) {
      const body = await response.text()
      if (body.includes('unauthorized: not licensed to use Copilot')) {
        throw new CopilotError(
          'Unauthorized: not licensed to use Copilot.',
          response.status
        )
      } else if (
        body.includes(
          'unauthorized: not authorized to use this Copilot feature'
        )
      ) {
        throw new CopilotError(
          'Unauthorized: not authorized to use this Copilot feature.',
          response.status
        )
      } else if (
        body.includes('integration does not have GitHub chat enabled')
      ) {
        throw new CopilotError(
          'Integration does not have GitHub chat enabled.',
          response.status
        )
      } else {
        throw new CopilotError('Unauthorized: unknown.', response.status)
      }
    } else if (response.status === 466) {
      throw new CopilotError(
        'Client issue: unsupported API version.',
        response.status
      )
    } else if (response.status >= HttpStatusCode.BadRequest) {
      const internalError = `Internal server error, code: ${
        response.status
      }, request ID: ${response.headers.get('X-Github-Request-Id')}.`
      console.error(
        `Copilot request failed with status ${response.status}: ${internalError}`
      )
      throw new CopilotError(
        'Something went wrong. Please, try again later.',
        response.status
      )
    }

    const text = await response.text()

    // Responses include multiple lines starting with "data: " followed by
    // a JSON object. We're only interested in the JSON object of the first line.
    const lines = text.split('\n')
    const DataLinePrefix = 'data: '

    for (const line of lines) {
      if (line.startsWith(DataLinePrefix)) {
        const json = JSON.parse(line.substring(DataLinePrefix.length))
        return json as CopilotChatCompletionResponse
      }
    }

    throw new Error('No data line found in response')
  }

  /**
   * Leverages Copilot to generate the commit details (title and description)
   * for a given diff.
   *
   * @param diff Diff of changes to be committed, in git format
   * @returns Commit details (title and description) generated by Copilot
   */
  public async getDiffChangesCommitMessage(
    diff: string
  ): Promise<ICopilotCommitMessage> {
    try {
      const response = await this.copilotRequest(
        '/agents/github-desktop-commit-message-generation',
        diff
      )

      const choice = response.choices.at(0)

      if (!choice) {
        throw new Error('No choice found in response')
      }

      const message = choice.message.content
      if (!message) {
        throw new Error('No message found in response')
      }

      return parseCopilotCommitMessage(message)
    } catch (e) {
      log.warn(
        `getDiffChangesCommitMessage: failed with endpoint ${this.endpoint}`,
        e
      )
      throw e
    }
  }

  /**
   * Get the allowed poll interval for fetching. If an error occurs it will
   * return null.
   */
  public async getFetchPollInterval(
    owner: string,
    name: string
  ): Promise<number | null> {
    const path = `repos/${owner}/${name}/git`
    try {
      const response = await this.ghRequest('HEAD', path)
      const interval = response.headers.get('x-poll-interval')
      if (interval) {
        const parsed = parseInt(interval, 10)
        return isNaN(parsed) ? null : parsed
      }
      return null
    } catch (e) {
      log.warn(`getFetchPollInterval: failed for ${owner}/${name}`, e)
      return null
    }
  }

  /** Fetch the mentionable users for the repository. */
  public async fetchMentionables(
    owner: string,
    name: string,
    etag: string | undefined
  ): Promise<IAPIMentionablesResponse | null> {
    // NB: this custom `Accept` is required for the `mentionables` endpoint.
    const headers: any = {
      Accept: 'application/vnd.github.jerry-maguire-preview',
    }

    if (etag !== undefined) {
      headers['If-None-Match'] = etag
    }

    try {
      const path = `repos/${owner}/${name}/mentionables/users`
      const response = await this.ghRequest('GET', path, {
        customHeaders: headers,
      })

      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchMentionables: '${path}' returned a 404`)
        return null
      }

      if (response.status === HttpStatusCode.NotModified) {
        return null
      }
      const users = await parsedResponse<ReadonlyArray<IAPIMentionableUser>>(
        response
      )
      const etag = response.headers.get('etag') || undefined
      return { users, etag }
    } catch (e) {
      log.warn(`fetchMentionables: failed for ${owner}/${name}`, e)
      return null
    }
  }

  /**
   * Retrieve the public profile information of a user with
   * a given username.
   */
  public async fetchUser(login: string): Promise<IAPIFullIdentity | null> {
    try {
      const response = await this.ghRequest(
        'GET',
        `users/${encodeURIComponent(login)}`
      )

      if (response.status === HttpStatusCode.NotFound) {
        return null
      }

      return await parsedResponse<IAPIFullIdentity>(response)
    } catch (e) {
      log.warn(`fetchUser: failed with endpoint ${this.endpoint}`, e)
      throw e
    }
  }

  /**
   * Fetches the Desktop-specific features that are enabled for the user.
   *
   * @returns An array of strings with the feature flags enabled for the user.
   */
  public async fetchFeatureFlags(): Promise<ReadonlyArray<string> | undefined> {
    try {
      const response = await this.ghRequest('GET', '/desktop_internal/features')
      const featuresResponse = await parsedResponse<IUserFeaturesResponse>(
        response
      )
      return featuresResponse.features
    } catch (e) {
      log.warn(`fetchFeatureFlags: failed with endpoint ${this.endpoint}`, e)
      return undefined
    }
  }

  /**
   * Fetches the Copilot info related to the user (license and API endpoint).
   *
   * @returns Copilot license and API endpoint.
   */
  public async fetchUserCopilotInfo(): Promise<UserCopilotInfo | undefined> {
    // Copilot is not available on GHES
    if (!isDotCom(this.endpoint) && !isGHE(this.endpoint)) {
      return undefined
    }

    const graphql = `
    {
      viewer {
        copilotEndpoints {
          api
        }

        copilotLicenseType
        isCopilotDesktopEnabled
      }
    }
    `

    try {
      const response = await this.ghRequest('POST', '/graphql', {
        body: { query: graphql },
        customHeaders: {
          'GraphQL-Features': 'copilot_iap_max_sku',
        },
      })
      if (response === null) {
        return undefined
      }

      const json: ViewerCopilotResponse =
        (await response.json()) as ViewerCopilotResponse
      const { viewer } = json.data
      return {
        copilotEndpoint: viewer.copilotEndpoints.api,
        isCopilotDesktopEnabled: viewer.isCopilotDesktopEnabled,
        copilotLicenseType: viewer.copilotLicenseType,
      }
    } catch (e) {
      log.warn(`fetchUserCopilotInfo: failed with endpoint ${this.endpoint}`, e)
      return undefined
    }
  }

  /**
   * Creates a push protection bypass for a repository.
   *
   * This method sends a POST request to the GitHub API to create a bypass
   * for push protection in a specified repository. The bypass is associated
   * with a reason and a placeholder ID.
   *
   * @param owner - The owner of the repository.
   * @param name - The name of the repository.
   * @param reason - The reason for creating the bypass - false_positive, used_in_tests, will_fix_later.
   * @param placeholderId - The placeholder ID associated with the bypass.
   * @param bypassURL - The URL to retry the bypass creation on Github.com in case of failure.
   * @returns A promise that resolves to the response of the bypass creation.
   * @throws An error if the bypass creation fails, including a warning log.
   */
  public async createPushProtectionBypass(
    owner: string,
    name: string,
    reason: BypassReasonType,
    placeholderId: string,
    bypassURL: string
  ): Promise<IAPICreatePushProtectionBypassResponse> {
    const path = `repos/${owner}/${name}/secret-scanning/push-protection-bypasses`
    const body = {
      reason,
      placeholder_id: placeholderId,
    }

    try {
      const response = await this.ghRequest('POST', path, { body })
      return await parsedResponse<IAPICreatePushProtectionBypassResponse>(
        response
      )
    } catch (e) {
      const msg = `Unable to create push protection bypass.

    Repository: ${owner}/${name}
    Reason: ${reason}
    Placeholder Id: ${placeholderId}.

    Try again at: ${bypassURL}`

      log.error(msg, e)
      throw new Error(msg)
    }
  }
}

/** Revoke a token, optionally allowing the caller to cancel the request. */
export async function deleteToken(
  account: Pick<Account, 'endpoint' | 'token'>,
  signal?: AbortSignal
) {
  try {
    const creds = Buffer.from(`${ClientID}:${ClientSecret}`).toString('base64')
    const response = await request(
      account.endpoint,
      null,
      'DELETE',
      `applications/${ClientID}/token`,
      { access_token: account.token },
      { Authorization: `Basic ${creds}` },
      false,
      signal
    )

    return response.status === 204
  } catch (e) {
    log.error(`deleteToken: failed with endpoint ${account.endpoint}`, e)
    return false
  }
}

/** Fetch the user authenticated by the token. */
export async function fetchUser(
  endpoint: string,
  apiType: AccountAPIType,
  token: string,
  login: string | UnknownLogin
): Promise<Account> {
  // A token being signed in is not installed yet: use it as-is.
  const api = instantiateAPI(
    apiType,
    endpoint,
    token,
    login,
    undefined,
    login !== UnknownLogin.InitialAuthFetch
  )
  try {
    const [user, emails, copilotInfo, features] = await Promise.all([
      api.fetchAccount(),
      api.fetchEmails(),
      api.fetchUserCopilotInfo(),
      api.fetchFeatureFlags(),
    ])

    return new Account(
      user.login,
      endpoint,
      apiType,
      token,
      emails,
      user.avatar_url,
      user.id,
      user.name || user.login,
      user.plan?.name,
      copilotInfo?.copilotEndpoint,
      copilotInfo?.isCopilotDesktopEnabled,
      features,
      copilotInfo?.copilotLicenseType
    )
  } catch (e) {
    log.warn(`fetchUser: failed with endpoint ${endpoint}`, e)
    throw e
  }
}

/**
 * Map a repository's URL to the endpoint associated with it. For example:
 *
 * https://github.com/desktop/desktop -> https://api.github.com
 * http://github.mycompany.com/my-team/my-project -> http://github.mycompany.com/api
 */
export function getEndpointForRepository(url: string): string | null {
  const parsed = parseRemote(url)
  if (!parsed) {
    log.warn(`getEndpointForRepository: failed to parse url ${url}`)
    return null
  }
  if (parsed.hostname === GitHubDotComDomain) {
    return getDotComAPIEndpoint()
  } else if (parsed.hostname === BitbucketCloudDomain) {
    return BitbucketCloudAPIEndpoint
  } else if (parsed.hostname === GitLabCloudDomain) {
    return GitLabCloudAPIEndpoint
  } else if (parsed.hostname === CodebergCloudDomain) {
    return CodebergCloudAPIEndpoint
  } else if (parsed.hostname === GiteaCloudDomain) {
    return GiteaCloudAPIEndpoint
  } else {
    const host = asHost(parsed)
    const registered = findRegisteredEndpointForHost(host)
    if (registered !== undefined) {
      return registered.endpoint
    }
    return `${parsed.protocol}://${host}/api`
  }
}

/**
 * Get the URL for the HTML site. For example:
 *
 * https://api.github.com -> https://github.com
 * http://github.mycompany.com/api -> http://github.mycompany.com
 * https://github.mycompany.com:8443/api/v3 -> https://github.mycompany.com:8443
 */
export function getHTMLURL(endpoint: string): string {
  if (envHTMLURL !== undefined) {
    return envHTMLURL
  }

  // In the case of GitHub.com, the HTML site lives on the parent domain.
  //  E.g., https://api.github.com -> https://github.com
  //
  // Whereas with Enterprise, it lives on the same domain but without the
  // API path:
  //  E.g., https://github.mycompany.com/api/v3 -> https://github.mycompany.com
  //
  // We need to normalize them.
  if (endpoint === getDotComAPIEndpoint() && !envEndpoint) {
    return GitHubDotComURL
  } else if (endpoint === BitbucketCloudAPIEndpoint) {
    return BitbucketCloudURL
  } else if (endpoint === GitLabCloudAPIEndpoint) {
    return GitLabCloudURL
  } else if (endpoint === CodebergCloudAPIEndpoint) {
    return CodebergCloudURL
  } else if (endpoint === GiteaCloudAPIEndpoint) {
    return GiteaCloudURL
  } else {
    const registered = getRegisteredEndpoint(endpoint)
    if (registered !== undefined) {
      return registered.webBaseUrl
    }

    if (isGHE(endpoint)) {
      const url = new URL.URL(endpoint)

      url.pathname = '/'

      if (url.hostname.startsWith('api.')) {
        url.hostname = url.hostname.replace(/^api\./, '')
      }

      return url.toString()
    }

    // Use the origin rather than the hostname so that GitHub Enterprise
    // Server instances running on a non-default port retain their port.
    return new URL.URL(endpoint).origin
  }
}

/**
 * Get the API URL for an HTML URL. For example:
 *
 * http://github.mycompany.com -> https://github.mycompany.com/api/v3
 */
export function getEnterpriseAPIURL(endpoint: string): string {
  const { host } = new window.URL(endpoint)

  return isGHE(endpoint) ? `https://api.${host}/` : `https://${host}/api/v3`
}

/**
 * The API endpoint of the third-party cloud instance served from the given
 * host, if any.
 */
const getThirdPartyCloudAPIEndpointForHost = (host: string | undefined) => {
  switch (host) {
    case BitbucketCloudDomain:
    case BitbucketCloudAPIDomain:
      return BitbucketCloudAPIEndpoint
    case GitLabCloudDomain:
      return GitLabCloudAPIEndpoint
    case CodebergCloudDomain:
      return CodebergCloudAPIEndpoint
    case GiteaCloudDomain:
      return GiteaCloudAPIEndpoint
    default:
      return undefined
  }
}

/**
 * Get the API endpoint of the instance a URL points at. The URL can be the
 * instance's web URL, one of its remote URLs, or its API endpoint.
 **/
export const getAPIEndpoint = (url: string) => {
  if (isDotCom(url)) {
    return getDotComAPIEndpoint()
  }
  const parsed = parseRemote(url)
  const host = parsed !== null ? asHost(parsed) : tryGetHost(url)
  return (
    getThirdPartyCloudAPIEndpointForHost(host) ??
    findRegisteredEndpointForHost(host)?.endpoint ??
    getEnterpriseAPIURL(url)
  )
}

/** Get github.com's API endpoint. */
export function getDotComAPIEndpoint(): string {
  // NOTE:
  // `DESKTOP_GITHUB_DOTCOM_API_ENDPOINT` only needs to be set if you are
  // developing against a local version of GitHub the Website, and need to debug
  // the server-side interaction. For all other cases you should leave this
  // unset.
  if (envEndpoint && envEndpoint.length > 0) {
    return envEndpoint
  }

  return 'https://api.github.com'
}

export const GitHubDotComDomain = 'github.com'
export const GitHubDotComURL = `https://${GitHubDotComDomain}`

export const BitbucketCloudDomain = 'bitbucket.org'
export const BitbucketCloudURL = `https://${BitbucketCloudDomain}`
export const BitbucketCloudAPIDomain = `api.${BitbucketCloudDomain}`
export const BitbucketCloudAPIEndpoint = `https://${BitbucketCloudAPIDomain}/2.0`

export const GitLabCloudDomain = 'gitlab.com'
export const GitLabCloudURL = `https://${GitLabCloudDomain}`
export const GitLabApiPath = '/api/v4'
export const GitLabCloudAPIEndpoint = GitLabCloudURL + GitLabApiPath
export const GitLabRequiredScopes = [
  'read_user',
  'read_api',
  'write_repository',
]

export const CodebergCloudDomain = 'codeberg.org'
export const CodebergCloudURL = `https://${CodebergCloudDomain}`
export const ForgejoApiPath = '/api/v1'
export const CodebergCloudAPIEndpoint = CodebergCloudURL + ForgejoApiPath
export const ForgejoRequiredScopes = [
  'read:user',
  'write:repository',
  'read:issue',
]

export const GiteaCloudDomain = 'gitea.com'
export const GiteaCloudURL = `https://${GiteaCloudDomain}`
export const GiteaApiPath = '/api/v1'
export const GiteaCloudAPIEndpoint = GiteaCloudURL + GiteaApiPath
export const GiteaRequiredScopes = [
  'read:user',
  'write:repository',
  'read:issue',
]

export function deriveApiType<T>(
  endpoint: string,
  defaultValue?: T
): AccountAPIType | T {
  if (endpoint === getDotComAPIEndpoint()) {
    return 'dotcom'
  } else if (endpoint === BitbucketCloudAPIEndpoint) {
    return 'bitbucket'
  } else if (endpoint === GitLabCloudAPIEndpoint) {
    return 'gitlab'
  } else if (endpoint === CodebergCloudAPIEndpoint) {
    return 'forgejo'
  } else if (endpoint === GiteaCloudAPIEndpoint) {
    return 'gitea'
  } else {
    return getRegisteredApiType(endpoint) ?? defaultValue ?? 'enterprise'
  }
}

function pkceChallengeParams(codeChallenge: string): string {
  return `code_challenge=${codeChallenge}&code_challenge_method=S256`
}

/**
 * Build an OAuth authorization URL.
 *
 * Supplying a login requests that account and disables sign-up. The caller
 * must still verify the identity returned by OAuth.
 */
export function getOAuthAuthorizationURL(
  endpoint: string,
  state: string,
  codeChallenge: string,
  login: string | undefined,
  shortLived: boolean
): string {
  const urlBase = getHTMLURL(endpoint)
  const scope = encodeURIComponent(
    (shortLived && !isGHES(endpoint)
      ? [...oauthScopes, 'offline_access']
      : oauthScopes
    ).join(' ')
  )
  const pkceParams = pkceChallengeParams(codeChallenge)
  // Without a specific login, let the user pick which of their browser's
  // GitHub sessions to sign in with rather than silently using the active one.
  const accountParameters =
    login === undefined
      ? '&prompt=select_account'
      : `&login=${encodeURIComponent(login)}&allow_signup=false`

  return new window.URL(
    `/login/oauth/authorize?client_id=${ClientID}&scope=${scope}&state=${state}&${pkceParams}${accountParameters}`,
    urlBase
  ).toString()
}

export function getBitbucketOAuthAuthorizationURL(
  state: string,
  codeChallenge: string
): string {
  const pkceParams = pkceChallengeParams(codeChallenge)
  return `${BitbucketCloudURL}/site/oauth2/authorize?client_id=${ClientIDBitbucket}&response_type=code&state=${state}&${pkceParams}`
}

export function getGitLabOAuthAuthorizationURL(
  state: string,
  codeChallenge: string
): string {
  const scope = encodeURIComponent(GitLabRequiredScopes.join(' '))
  const encodedRedirectUri = encodeURIComponent(oauthRedirectUri)
  const pkceParams = pkceChallengeParams(codeChallenge)
  return `${GitLabCloudURL}/oauth/authorize?client_id=${ClientIDGitLab}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=${scope}&state=${state}&${pkceParams}`
}

export function getCodebergOAuthAuthorizationURL(
  state: string,
  codeChallenge: string
): string {
  const scope = encodeURIComponent(ForgejoRequiredScopes.join(' '))
  const encodedRedirectUri = encodeURIComponent(oauthRedirectUri)
  const pkceParams = pkceChallengeParams(codeChallenge)
  return `${CodebergCloudURL}/login/oauth/authorize?client_id=${ClientIDCodeberg}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=${scope}&state=${state}&${pkceParams}`
}

export function getGiteaOAuthAuthorizationURL(
  state: string,
  codeChallenge: string
): string {
  const scope = encodeURIComponent(GiteaRequiredScopes.join(' '))
  const encodedRedirectUri = encodeURIComponent(oauthRedirectUri)
  const pkceParams = pkceChallengeParams(codeChallenge)
  return `${GiteaCloudURL}/login/oauth/authorize?client_id=${ClientIDGitea}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=${scope}&state=${state}&${pkceParams}`
}

function tryUpdateEndpointVersionFromResponse(
  endpoint: string,
  response: Response
) {
  const gheVersion = response.headers.get('x-github-enterprise-version')
  if (gheVersion !== null) {
    updateEndpointVersion(endpoint, gheVersion)
  }
}

function getCombinedRefStatus(
  checkRuns: ReadonlyArray<IAPIRefStatusItem>
): APIRefState {
  // https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#get-the-combined-status-for-a-specific-reference
  if (checkRuns.some(cr => cr.state === 'failure' || cr.state === 'error')) {
    return 'failure'
  }
  if (checkRuns.length === 0 || checkRuns.some(cr => cr.state === 'pending')) {
    return 'pending'
  }
  return 'success'
}

const knownThirdPartyHosts = new Set([
  'dev.azure.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'amazonaws.com',
  'visualstudio.com',
])

const isKnownThirdPartyHost = (hostname: string) => {
  if (knownThirdPartyHosts.has(hostname)) {
    return true
  }

  for (const knownHost of knownThirdPartyHosts) {
    if (hostname.endsWith(`.${knownHost}`)) {
      return true
    }
  }

  return false
}

/**
 * Attempts to determine whether or not the url belongs to a GitHub host.
 *
 * This is a best-effort attempt and may return `undefined` if encountering
 * an error making the discovery request
 */
export async function isGitHubHost(url: string) {
  const { hostname } = new window.URL(url)

  const endpoint =
    hostname === 'github.com' || hostname === 'api.github.com'
      ? getDotComAPIEndpoint()
      : getEnterpriseAPIURL(url)

  if (isDotCom(endpoint) || isGHE(endpoint)) {
    return true
  }

  if (isKnownThirdPartyHost(hostname)) {
    return false
  }

  // github.example.com,
  if (/(^|\.)(github)\./.test(hostname)) {
    return true
  }

  // bitbucket.example.com, etc
  if (/(^|\.)(bitbucket|gitlab|codeberg|forgejo|gitea)\./.test(hostname)) {
    return false
  }

  if (getEndpointVersion(endpoint) !== null) {
    return true
  }

  // Add a unique identifier to the URL to make sure our certificate error
  // supression only catches this request
  const metaUrl = `${endpoint}/meta?ghd=${crypto.randomUUID()}`

  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), 2000)
  suppressCertificateErrorFor(metaUrl)
  try {
    const response = await fetch(metaUrl, {
      headers: { 'user-agent': getUserAgent() },
      signal: ac.signal,
      credentials: 'omit',
      method: 'HEAD',
      redirect: 'error',
    })

    tryUpdateEndpointVersionFromResponse(endpoint, response)

    return response.headers.has('x-github-request-id')
  } catch (e) {
    log.debug(`isGitHubHost: failed with endpoint ${endpoint}`, e)
    return undefined
  } finally {
    clearTimeout(timeoutId)
    clearCertificateErrorSuppressionFor(metaUrl)
  }
}

const isRulesetsNotEnabledError = (error: any) =>
  error instanceof APIError &&
  error.responseStatus === 403 &&
  /upgrade.*to enable this feature.*/i.test(error.apiError?.message ?? '')

const isNotFoundApiError = (error: any) =>
  error instanceof APIError && error.responseStatus === 404

export class BitbucketAPI extends API {
  public constructor(
    endpoint: string,
    token: string,
    login: string | UnknownLogin,
    manageAccountToken = true
  ) {
    super(endpoint, token, login, undefined, manageAccountToken)
  }

  // https://developer.atlassian.com/cloud/bitbucket/rest/intro/#pagination
  protected override get maxPerPage() {
    return 100
  }
  protected override get perPageParamName() {
    return 'pagelen'
  }
  protected override get pageParamName() {
    return 'page'
  }
  protected override get paginatorNextPage() {
    return 'next'
  }
  protected override get paginatorValues() {
    return 'values'
  }

  protected override isThirdPartyTokenRejected(response: Response) {
    return response.status === HttpStatusCode.Unauthorized
  }

  public override async fetchAllOpenPullRequests(
    owner: string,
    name: string
  ): Promise<IAPIPullRequest[]> {
    const url = urlWithQueryString(
      `repositories/${owner}/${name}/pullrequests`,
      {
        state: 'OPEN',
      }
    )
    try {
      const prs = await this.fetchAll<IBitbucketAPIPullRequest>(url, {
        perPage: 50,
      })
      return prs.map(toIAPIPullRequestFromBitbucket)
    } catch (e) {
      log.warn(`failed fetching open PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchUpdatedPullRequests(
    owner: string,
    name: string,
    since: Date,
    maxResults = 320
  ) {
    const sinceTime = since.getTime()
    const url = urlWithQueryString(
      `repositories/${owner}/${name}/pullrequests`,
      {
        state: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'],
        sort: '-updated_on',
      }
    )

    try {
      const prs = await this.fetchAll<IBitbucketAPIPullRequest>(url, {
        // See explaination for perPage=10 in API.fetchUpdatedPullRequests
        // Max page in Bitbucket API for PRs is 50: https://jira.atlassian.com/browse/BCLOUD-9659
        perPage: 10,
        getNextPagePath: response =>
          getNextPagePathWithIncreasingPageSize(
            response,
            this.perPageParamName,
            this.pageParamName,
            50
          ),
        continue(results) {
          if (results.length >= maxResults) {
            throw new MaxResultsError('got max pull requests, aborting')
          }

          // Given that we sort the results in descending order by their
          // updated_at field we can safely say that if the last item
          // is modified after our sinceTime then haven't reached the
          // end of updated PRs.
          const last = results.at(-1)
          return last !== undefined && Date.parse(last.updated_on) > sinceTime
        },
        // We can't ignore errors here as that might mean that we haven't
        // retrieved enough pages to fully capture the changes since the
        // last time we updated. Ignoring errors here would mean that we'd
        // store an incorrect lastUpdated field in the database.
        suppressErrors: false,
      })
      return prs
        .filter(pr => Date.parse(pr.updated_on) >= sinceTime)
        .map(toIAPIPullRequestFromBitbucket)
    } catch (e) {
      log.warn(`failed fetching updated PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchAccount(): Promise<IAPIFullIdentity> {
    const response = await this.request(this.endpoint, 'GET', 'user')
    return toIAPIFullIdentityFromBitbucket(
      await parsedResponse<IBitbucketAPIIdentity>(response)
    )
  }

  public override async fetchEmails(): Promise<ReadonlyArray<IAPIEmail>> {
    const emails = await this.fetchAll<IBitbucketAPIEmail>('user/emails')
    return emails.map(toIAPIEmailFromBitbucket)
  }

  public async fetchMentionables(
    owner: string,
    name: string
  ): Promise<IAPIMentionablesResponse | null> {
    try {
      const response = await this.fetchAll<IBitbucketApiWorkspaceMembership>(
        `workspaces/${owner}/members`
      )
      return {
        etag: undefined,
        users: response.map(member =>
          toIAPIMentionableUserFromBitbucket(member)
        ),
      }
    } catch (e) {
      log.warn(`fetchMentionables: failed for ${owner}/${name}`, e)
      return null
    }
  }

  public override async fetchRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    try {
      const response = await this.request(
        this.endpoint,
        'GET',
        `repositories/${owner}/${name}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchRepository: '${owner}/${name}' returned a 404`)
        return null
      }
      const repo = await parsedResponse<IBitbucketAPIRepository>(response)
      return toIAPIFullRepositoryFromBitbucket(repo)
    } catch (e) {
      log.warn(`fetchRepository: an error occurred for '${owner}/${name}'`, e)
      return null
    }
  }

  public override async fetchRepositoryIfAccessible(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    const response = await this.request(
      this.endpoint,
      'GET',
      `repositories/${owner}/${name}`
    )
    if (
      response.status === HttpStatusCode.NotFound ||
      response.status === HttpStatusCode.Forbidden
    ) {
      return null
    }
    return toIAPIFullRepositoryFromBitbucket(
      await parsedResponse<IBitbucketAPIRepository>(response)
    )
  }

  public override async fetchProtectedBranches() {
    // This could be implemented with GET /repositories/{workspace}/{repo_slug}/branch-restrictions,
    // but it would require increasing the OAuth scope to admin:repository, and currently this is
    // only being used for metrics collection, so it's not necessary.
    return []
  }

  public async fetchPushControl(): Promise<IAPIPushControl> {
    return {
      pattern: null,
      required_signatures: false,
      required_status_checks: [],
      required_approving_review_count: 0,
      required_linear_history: false,
      allow_actor: true,
      allow_deletions: true,
      allow_force_pushes: true,
    }
  }

  public override async getFetchPollInterval(): Promise<number | null> {
    return null
  }

  public override async fetchIssues(): Promise<ReadonlyArray<IAPIIssue>> {
    // The Bitbucket issue tracker has been deprecated and the API doesn't seem to support fetching Jira issues.
    // https://community.atlassian.com/forums/Bitbucket-articles/Announcing-sunset-of-Bitbucket-Issues-and-Wikis/ba-p/3193882
    return []
  }

  public override async fetchCombinedRefStatus(
    owner: string,
    name: string,
    ref: string
  ): Promise<IAPIRefStatus | null> {
    const match = ref.match(/refs\/pull\/(\d+)\/head/)
    if (!match) {
      log.warn(`unexpected ref format for Bitbucket PR check runs: ${ref}`)
      return null
    }
    const path = `repositories/${owner}/${name}/pullrequests/${match[1]}/statuses`

    try {
      const statuses = await this.fetchAll<IBitbucketAPICommitStatus>(path)
      const checkRuns = statuses.map((status, index) =>
        toIAPIRefStatusItemFromBitbucket(index, status)
      )
      return {
        state: getCombinedRefStatus(checkRuns),
        total_count: checkRuns.length,
        statuses: checkRuns,
      }
    } catch (err) {
      log.debug(
        `Failed fetching check runs for ref ${ref} (${owner}/${name})`,
        err
      )
      return null
    }
  }

  public override async fetchRepositoryCloneInfo(
    owner: string,
    name: string,
    protocol: GitProtocol | undefined
  ): Promise<IAPIRepositoryCloneInfo | null> {
    const response = await this.request(
      this.endpoint,
      'GET',
      `repositories/${owner}/${name}`
    )

    if (response.status === HttpStatusCode.NotFound) {
      return null
    }

    const bitbucketRepo = await parsedResponse<IBitbucketAPIRepository>(
      response
    )
    const repo = toIAPIRepositoryFromBitbucket(bitbucketRepo)
    return {
      url: protocol === 'ssh' ? repo.ssh_url : repo.clone_url,
      defaultBranch: repo.default_branch,
    }
  }

  public override async streamUserRepositories(
    callback: (repos: ReadonlyArray<IAPIRepository>) => void
  ) {
    try {
      const workspaceAccessList = await this.getAllWorkspaces()
      for (const workspaceAccess of workspaceAccessList) {
        const path = `repositories/${workspaceAccess.workspace.uuid}`
        const repos = await this.fetchAll<IBitbucketAPIRepository>(path)
        callback(repos.map(toIAPIRepositoryFromBitbucket))
      }
    } catch (error) {
      log.warn(
        `streamUserRepositories: failed with endpoint ${this.endpoint}`,
        error
      )
    }
  }

  public override async fetchRefCheckRuns(): Promise<IAPIRefCheckRuns | null> {
    return null
  }

  public override async fetchUserCopilotInfo(): Promise<undefined> {
    return undefined
  }

  public override async fetchFeatureFlags(): Promise<undefined> {
    return undefined
  }

  private async getAllWorkspaces(): Promise<IBitbucketAPIWorkspaceAccess[]> {
    try {
      const path = 'user/workspaces'
      return await this.fetchAll<IBitbucketAPIWorkspaceAccess>(path)
    } catch (err) {
      log.debug(`Failed fetching workspaces`, err)
      return []
    }
  }
}

export class GitLabAPI extends API {
  public constructor(
    endpoint: string,
    token: string,
    login: string | UnknownLogin,
    manageAccountToken = true
  ) {
    super(endpoint, token, login, undefined, manageAccountToken)
  }

  // https://docs.gitlab.com/api/rest/#offset-based-pagination
  protected override get maxPerPage() {
    return 100
  }
  protected override get perPageParamName() {
    return 'per_page'
  }
  protected override get pageParamName() {
    return 'page'
  }
  protected override get paginatorNextPage() {
    return ''
  }
  protected override get paginatorValues() {
    return ''
  }

  protected override isThirdPartyTokenRejected(response: Response) {
    return response.status === HttpStatusCode.Unauthorized
  }

  public override async fetchAllOpenPullRequests(
    owner: string,
    name: string
  ): Promise<IAPIPullRequest[]> {
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const url = `projects/${projectPath}/merge_requests?state=opened`
    try {
      const mrs = await this.fetchAll<IGitLabAPIMergeRequest>(url)
      return await this.fetchReposAndMapMergeRequests(mrs)
    } catch (e) {
      log.warn(`failed fetching open MRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  private async fetchReposAndMapMergeRequests(mrs: IGitLabAPIMergeRequest[]) {
    const projectIdsToFetch = new Set<number>()
    for (const mr of mrs) {
      projectIdsToFetch.add(mr.source_project_id)
      projectIdsToFetch.add(mr.target_project_id)
    }
    const projects = await Promise.all(
      Array.from(projectIdsToFetch).map(id => this.fetchRepositoryById(id))
    )
    return mrs.map(mr =>
      toIAPIPullRequestFromGitLab(
        mr,
        projects.find(p => p?.id === mr.source_project_id) ?? null,
        projects.find(p => p?.id === mr.target_project_id) ?? null
      )
    )
  }

  public override async fetchUpdatedPullRequests(
    owner: string,
    name: string,
    since: Date,
    maxResults = 320
  ) {
    const sinceTime = since.getTime()
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const sinceISO = since.toISOString()
    const url = `projects/${projectPath}/merge_requests?updated_after=${sinceISO}&order_by=updated_at&sort=desc`

    try {
      const mrs = await this.fetchAll<IGitLabAPIMergeRequest>(url, {
        perPage: 10,
        getNextPagePath: response =>
          getNextPagePathWithIncreasingPageSize(
            response,
            this.perPageParamName,
            this.pageParamName,
            this.maxPerPage
          ),
        continue(results) {
          if (results.length >= maxResults) {
            throw new MaxResultsError('got max merge requests, aborting')
          }

          const last = results.at(-1)
          return last !== undefined && Date.parse(last.updated_at) > sinceTime
        },
        suppressErrors: false,
      })
      const filteredMrs = mrs.filter(
        mr => Date.parse(mr.updated_at) >= sinceTime
      )
      return await this.fetchReposAndMapMergeRequests(filteredMrs)
    } catch (e) {
      log.warn(`failed fetching updated MRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchAccount(): Promise<IAPIFullIdentity> {
    const response = await this.request(this.endpoint, 'GET', 'user')
    return toIAPIFullIdentityFromGitLab(
      await parsedResponse<IGitLabAPIIdentity>(response)
    )
  }

  public override async fetchEmails(): Promise<ReadonlyArray<IAPIEmail>> {
    const emails = await this.fetchAll<IGitLabAPIEmail>('user/emails')
    return emails.map((email, index) => toIAPIEmailFromGitLab(email, index))
  }

  public async fetchMentionables(
    owner: string,
    name: string
  ): Promise<IAPIMentionablesResponse | null> {
    try {
      const projectPath = encodeURIComponent(`${owner}/${name}`)
      const response = await this.fetchAll<IGitLabAPIProjectMember>(
        `projects/${projectPath}/members`
      )
      return {
        etag: undefined,
        users: response.map(member => toIAPIMentionableUserFromGitLab(member)),
      }
    } catch (e) {
      log.warn(`fetchMentionables: failed for ${owner}/${name}`, e)
      return null
    }
  }

  public override async fetchRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    try {
      const projectPath = encodeURIComponent(`${owner}/${name}`)
      const response = await this.request(
        this.endpoint,
        'GET',
        `projects/${projectPath}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchRepository: '${owner}/${name}' returned a 404`)
        return null
      }
      const repo = await parsedResponse<IGitLabAPIRepository>(response)
      return toIAPIFullRepositoryFromGitLab(repo)
    } catch (e) {
      log.warn(`fetchRepository: an error occurred for '${owner}/${name}'`, e)
      return null
    }
  }

  public override async fetchRepositoryIfAccessible(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const response = await this.request(
      this.endpoint,
      'GET',
      `projects/${projectPath}`
    )
    if (response.status === HttpStatusCode.NotFound) {
      return null
    }
    return toIAPIFullRepositoryFromGitLab(
      await parsedResponse<IGitLabAPIRepository>(response)
    )
  }

  private async fetchRepositoryById(
    id: number
  ): Promise<IGitLabAPIRepository | null> {
    try {
      const response = await this.request(
        this.endpoint,
        'GET',
        `projects/${id}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchRepositoryById: '${id}' returned a 404`)
        return null
      }
      return await parsedResponse<IGitLabAPIRepository>(response)
    } catch (e) {
      log.warn(`fetchRepositoryById: an error occurred for '${id}'`, e)
      return null
    }
  }

  public override async fetchProtectedBranches() {
    return []
  }

  public async fetchPushControl(): Promise<IAPIPushControl> {
    return {
      pattern: null,
      required_signatures: false,
      required_status_checks: [],
      required_approving_review_count: 0,
      required_linear_history: false,
      allow_actor: true,
      allow_deletions: true,
      allow_force_pushes: true,
    }
  }

  public override async getFetchPollInterval(): Promise<number | null> {
    return null
  }

  public override async fetchIssues(
    owner: string,
    name: string,
    state: 'open' | 'closed' | 'all',
    _since: Date | null
  ): Promise<ReadonlyArray<IAPIIssue>> {
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const stateParam = {
      open: '&state=opened',
      closed: '&state=closed',
      all: '',
    }[state]
    const url = `projects/${projectPath}/issues?scope=all${stateParam}`
    try {
      const issues = await this.fetchAll<IGitLabAPIIssue>(url)
      return issues.map(toIAPIIssueFromGitLab)
    } catch (e) {
      log.warn(`fetchIssues: failed for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchCombinedRefStatus(): Promise<IAPIRefStatus | null> {
    return null
  }

  public override async fetchRefCheckRuns(
    owner: string,
    name: string,
    ref: string,
    reloadCache: boolean = false
  ): Promise<IAPIRefCheckRuns | null> {
    const match = ref.match(/refs\/pull\/(\d+)\/head/)
    if (!match) {
      log.warn(`unexpected ref format for GitLab MR pipeline check: ${ref}`)
      return null
    }
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const path = `projects/${projectPath}/merge_requests/${match[1]}/pipelines`

    try {
      const statuses = await this.fetchAll<IGitLabAPIPipelineStatus>(path)
      return {
        total_count: statuses.length,
        check_runs: statuses.map(toIAPIRefCheckRunFromGitLab),
      }
    } catch (err) {
      log.debug(
        `Failed fetching check runs for ref ${ref} (${owner}/${name})`,
        err
      )
      return null
    }
  }

  public override async fetchRepositoryCloneInfo(
    owner: string,
    name: string,
    protocol: GitProtocol | undefined
  ): Promise<IAPIRepositoryCloneInfo | null> {
    const projectPath = encodeURIComponent(`${owner}/${name}`)
    const response = await this.request(
      this.endpoint,
      'GET',
      `projects/${projectPath}`
    )

    if (response.status === HttpStatusCode.NotFound) {
      return null
    }

    const gitLabRepo = await parsedResponse<IGitLabAPIRepository>(response)
    const repo = toIAPIRepositoryFromGitLab(gitLabRepo)
    return {
      url: protocol === 'ssh' ? repo.ssh_url : repo.clone_url,
      defaultBranch: repo.default_branch,
    }
  }

  public override async streamUserRepositories(
    callback: (repos: ReadonlyArray<IAPIRepository>) => void
  ) {
    try {
      const path = `projects?membership=true`
      const repos = await this.fetchAll<IGitLabAPIRepository>(path)
      callback(repos.map(toIAPIRepositoryFromGitLab))
    } catch (error) {
      log.warn(
        `streamUserRepositories: failed with endpoint ${this.endpoint}`,
        error
      )
    }
  }

  public override async fetchPRWorkflowRunsByBranchName(): Promise<IAPIWorkflowRuns | null> {
    return null
  }

  public override async fetchWorkflowRunJobs(): Promise<IAPIWorkflowJobs | null> {
    return null
  }

  public override async fetchUserCopilotInfo(): Promise<undefined> {
    return undefined
  }

  public override async fetchFeatureFlags(): Promise<undefined> {
    return undefined
  }
}

export class ForgejoAPI extends API {
  public constructor(
    endpoint: string,
    token: string,
    login: string | UnknownLogin,
    manageAccountToken = true
  ) {
    super(endpoint, token, login, undefined, manageAccountToken)
  }

  protected get apiType(): RegisteredApiType {
    return 'forgejo'
  }

  // https://forgejo.org/docs/latest/user/api-usage/
  protected override get maxPerPage() {
    return 50
  }
  protected override get perPageParamName() {
    return 'limit'
  }
  protected override get pageParamName() {
    return 'page'
  }
  protected override get paginatorNextPage() {
    return ''
  }
  protected override get paginatorValues() {
    return ''
  }

  protected override isThirdPartyTokenRejected(response: Response) {
    return response.status === HttpStatusCode.Unauthorized
  }

  public override async fetchAccount(): Promise<IAPIFullIdentity> {
    const response = await this.request(this.endpoint, 'GET', 'user')
    return toIAPIFullIdentityFromForgejo(
      await parsedResponse<IForgejoAPIIdentity>(response)
    )
  }

  public override async fetchEmails(): Promise<ReadonlyArray<IAPIEmail>> {
    try {
      const emails = await this.fetchAll<IForgejoAPIEmail>('user/emails')
      return emails.map(toIAPIEmailFromForgejo)
    } catch (e) {
      if (
        e instanceof APIError &&
        (e.responseStatus === HttpStatusCode.NotFound ||
          e.responseStatus === HttpStatusCode.Forbidden)
      ) {
        log.warn(
          `${this.apiType} user/emails unavailable, continuing without emails`
        )
        return []
      }

      throw e
    }
  }

  public override async fetchMentionables(
    owner: string,
    name: string
  ): Promise<IAPIMentionablesResponse | null> {
    try {
      const users = await this.fetchAll<IForgejoAPIIdentity>(
        `repos/${owner}/${name}/assignees`
      )
      return {
        etag: undefined,
        users: users.map(user => ({
          avatar_url: user.avatar_url,
          email: user.email || null,
          login: user.login,
          name: user.full_name || null,
        })),
      }
    } catch (e) {
      log.warn(`fetchMentionables: failed for ${owner}/${name}`, e)
      return null
    }
  }

  public override async fetchRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    try {
      const response = await this.request(
        this.endpoint,
        'GET',
        `repos/${owner}/${name}`
      )
      if (response.status === HttpStatusCode.NotFound) {
        log.warn(`fetchRepository: '${owner}/${name}' returned a 404`)
        return null
      }
      const repo = await parsedResponse<IForgejoAPIRepository>(response)
      return toIAPIFullRepositoryFromForgejo(repo)
    } catch (e) {
      log.warn(`fetchRepository: an error occurred for '${owner}/${name}'`, e)
      return null
    }
  }

  public override async fetchRepositoryIfAccessible(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository | null> {
    const response = await this.request(
      this.endpoint,
      'GET',
      `repos/${owner}/${name}`
    )
    if (response.status === HttpStatusCode.NotFound) {
      return null
    }
    return toIAPIFullRepositoryFromForgejo(
      await parsedResponse<IForgejoAPIRepository>(response)
    )
  }

  public override async fetchAllOpenPullRequests(
    owner: string,
    name: string
  ): Promise<IAPIPullRequest[]> {
    const url = urlWithQueryString(`repos/${owner}/${name}/pulls`, {
      state: 'open',
    })
    try {
      const prs = await this.fetchAll<IForgejoAPIPullRequest>(url)
      return prs.map(toIAPIPullRequestFromForgejo)
    } catch (e) {
      log.warn(`failed fetching open PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchUpdatedPullRequests(
    owner: string,
    name: string,
    since: Date,
    maxResults = 320
  ) {
    const sinceTime = since.getTime()
    const url = urlWithQueryString(`repos/${owner}/${name}/pulls`, {
      state: 'all',
      sort: 'recentupdate',
    })

    try {
      const prs = await this.fetchAll<IForgejoAPIPullRequest>(url, {
        // See explanation for perPage=10 in API.fetchUpdatedPullRequests
        perPage: 10,
        getNextPagePath: response =>
          getNextPagePathWithIncreasingPageSize(
            response,
            this.perPageParamName,
            this.pageParamName,
            this.maxPerPage
          ),
        continue(results) {
          if (results.length >= maxResults) {
            throw new MaxResultsError('got max pull requests, aborting')
          }

          const last = results.at(-1)
          return last !== undefined && Date.parse(last.updated_at) > sinceTime
        },
        suppressErrors: false,
      })
      return prs
        .filter(pr => Date.parse(pr.updated_at) >= sinceTime)
        .map(toIAPIPullRequestFromForgejo)
    } catch (e) {
      log.warn(`failed fetching updated PRs for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchIssues(
    owner: string,
    name: string,
    state: 'open' | 'closed' | 'all',
    since: Date | null
  ): Promise<ReadonlyArray<IAPIIssue>> {
    const params: { [key: string]: string } = { state, type: 'issues' }
    if (since && !Number.isNaN(since.getTime())) {
      params.since = toGitHubIsoDateString(since)
    }

    const url = urlWithQueryString(`repos/${owner}/${name}/issues`, params)
    try {
      const issues = await this.fetchAll<IForgejoAPIIssue>(url)
      return issues.map(toIAPIIssueFromForgejo)
    } catch (e) {
      log.warn(`fetchIssues: failed for repository ${owner}/${name}`, e)
      throw e
    }
  }

  public override async fetchCombinedRefStatus(
    owner: string,
    name: string,
    ref: string
  ): Promise<IAPIRefStatus | null> {
    try {
      const commitRef = await this.ensureCommitRef(owner, name, ref)
      // Use the combined status endpoint (rather than the plain statuses
      // list) because it only returns the latest status for each context
      const path = `repos/${owner}/${name}/commits/${commitRef}/status?limit=${this.maxPerPage}`
      const response = await this.request(this.endpoint, 'GET', path)
      const combined = await parsedResponse<IForgejoAPICombinedStatus>(response)
      const statuses = (combined.statuses ?? []).map(status =>
        toIAPIRefStatusItemFromForgejo(status, this.endpoint)
      )
      return {
        state: mapRefStateFromForgejo(combined.state),
        total_count: statuses.length,
        statuses,
      }
    } catch (err) {
      log.debug(
        `Failed fetching combined status for ref ${ref} (${owner}/${name})`,
        err
      )
      return null
    }
  }

  public override async fetchRefCheckRuns(): Promise<IAPIRefCheckRuns | null> {
    // Don't call /statuses, otherwise checks will appear twice in the PR view.
    return null
  }

  private async ensureCommitRef(
    owner: string,
    name: string,
    ref: string
  ): Promise<string> {
    // The ref can be a branch name or a commit SHA, but also the synthetic
    // refs/pull/{n}/head ref produced by getRefForPullRequest, which
    // Forgejo's commit status endpoint can't resolve. Look up the pull
    // request's head SHA in that case.
    const prMatch = /^refs\/pull\/(\d+)\/head$/.exec(ref)
    if (!prMatch) {
      return ref
    }
    const prNumber = prMatch[1]
    const headSha = await this.fetchPullRequestHeadSha(owner, name, prNumber)
    if (!headSha) {
      throw new Error(
        `Unable to resolve head SHA for PR ${prNumber} (${owner}/${name})`
      )
    }
    return encodeURIComponent(headSha)
  }

  public override async fetchRepositoryCloneInfo(
    owner: string,
    name: string,
    protocol: GitProtocol | undefined
  ): Promise<IAPIRepositoryCloneInfo | null> {
    const response = await this.request(
      this.endpoint,
      'GET',
      `repos/${owner}/${name}`
    )

    if (response.status === HttpStatusCode.NotFound) {
      return null
    }

    const forgejoRepo = await parsedResponse<IForgejoAPIRepository>(response)
    const repo = toIAPIRepositoryFromForgejo(forgejoRepo)
    return {
      url: protocol === 'ssh' ? repo.ssh_url : repo.clone_url,
      defaultBranch: repo.default_branch,
    }
  }

  public override async streamUserRepositories(
    callback: (repos: ReadonlyArray<IAPIRepository>) => void
  ) {
    try {
      const repos = await this.fetchAll<IForgejoAPIRepository>('user/repos')
      callback(repos.map(toIAPIRepositoryFromForgejo))
    } catch (error) {
      log.warn(
        `streamUserRepositories: failed with endpoint ${this.endpoint}`,
        error
      )
    }
  }

  public override async fetchProtectedBranches(
    owner: string,
    name: string
  ): Promise<ReadonlyArray<IAPIBranch>> {
    try {
      const branches = await this.fetchAll<IForgejoAPIBranch>(
        `repos/${owner}/${name}/branches`
      )
      return branches.filter(branch => branch.protected)
    } catch (err) {
      log.info(
        `[fetchProtectedBranches] unable to list protected branches`,
        err
      )
      return []
    }
  }

  public override async fetchPRWorkflowRunsByBranchName(): Promise<IAPIWorkflowRuns | null> {
    return null
  }

  public override async fetchWorkflowRunJobs(): Promise<IAPIWorkflowJobs | null> {
    return null
  }

  public override async fetchOrgs(): Promise<ReadonlyArray<IAPIOrganization>> {
    try {
      const orgs = await this.fetchAll<IForgejoAPIOrganization>('user/orgs')
      return orgs.map(toIAPIOrganizationFromForgejo)
    } catch (e) {
      log.warn(`fetchOrgs: failed with endpoint ${this.endpoint}`, e)
      return []
    }
  }

  public override async createRepository(
    org: IAPIOrganization | null,
    name: string,
    description: string,
    private_: boolean
  ): Promise<IAPIFullRepository> {
    try {
      const apiPath = org ? `orgs/${org.login}/repos` : 'user/repos'
      const response = await this.request(this.endpoint, 'POST', apiPath, {
        body: {
          name,
          description,
          private: private_,
        },
      })
      const repo = await parsedResponse<IForgejoAPIRepository>(response)
      return toIAPIFullRepositoryFromForgejo(repo)
    } catch (e) {
      if (e instanceof APIError) {
        if (org !== null) {
          throw new Error(
            `Unable to create repository for organization '${org.login}'. Verify that the repository does not already exist and that you have permission to create a repository there.`
          )
        }
        throw e
      }

      log.error(`createRepository: failed with endpoint ${this.endpoint}`, e)
      throw new Error(
        `Unable to publish repository. Please check if you have an internet connection and try again.`
      )
    }
  }

  public override async forkRepository(
    owner: string,
    name: string
  ): Promise<IAPIFullRepository> {
    try {
      const response = await this.request(
        this.endpoint,
        'POST',
        `repos/${owner}/${name}/forks`,
        // Forgejo requires a JSON body (CreateForkOption) even if empty
        { body: {} }
      )
      const repo = await parsedResponse<IForgejoAPIRepository>(response)
      return toIAPIFullRepositoryFromForgejo(repo)
    } catch (e) {
      log.error(
        `forkRepository: failed to fork ${owner}/${name} at endpoint: ${this.endpoint}`,
        e
      )
      throw e
    }
  }

  public async fetchPushControl(): Promise<IAPIPushControl> {
    return {
      pattern: null,
      required_signatures: false,
      required_status_checks: [],
      required_approving_review_count: 0,
      required_linear_history: false,
      allow_actor: true,
      allow_deletions: true,
      allow_force_pushes: true,
    }
  }

  public override async getFetchPollInterval(): Promise<number | null> {
    return null
  }

  private async fetchPullRequestHeadSha(
    owner: string,
    name: string,
    prNumber: string
  ): Promise<string | null> {
    const response = await this.request(
      this.endpoint,
      'GET',
      `repos/${owner}/${name}/pulls/${prNumber}`
    )
    if (!response.ok) {
      return null
    }
    const pr = await parsedResponse<IForgejoAPIPullRequest>(response)
    return pr.head.sha || null
  }

  public override async fetchUserCopilotInfo(): Promise<undefined> {
    return undefined
  }

  public override async fetchFeatureFlags(): Promise<undefined> {
    return undefined
  }
}

/**
 * Gitea's REST API is identical to Forgejo's for everything we use,
 * only the provider identity differs.
 */
export class GiteaAPI extends ForgejoAPI {
  protected override get apiType(): RegisteredApiType {
    return 'gitea'
  }
}

function instantiateAPI(
  apiType: AccountAPIType,
  endpoint: string,
  token: string,
  login: string | UnknownLogin,
  copilotEndpoint: string | undefined,
  manageAccountToken = true
): API {
  switch (apiType) {
    case 'bitbucket':
      return new BitbucketAPI(endpoint, token, login, manageAccountToken)
    case 'gitlab':
      return new GitLabAPI(endpoint, token, login, manageAccountToken)
    case 'forgejo':
      return new ForgejoAPI(endpoint, token, login, manageAccountToken)
    case 'gitea':
      return new GiteaAPI(endpoint, token, login, manageAccountToken)
    case 'dotcom':
    case 'enterprise':
      return new API(
        endpoint,
        token,
        login,
        copilotEndpoint,
        manageAccountToken
      )
    default:
      assertNever(apiType, `Unknown API type ${apiType}`)
  }
}
