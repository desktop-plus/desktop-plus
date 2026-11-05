import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AppStore } from '../../src/lib/stores/app-store'
import { GitHubRepository, RepoType } from '../../src/models/github-repository'
import { Owner } from '../../src/models/owner'
import {
  Repository,
  RepositoryWithGitHubRepository,
} from '../../src/models/repository'
import { Branch, BranchType } from '../../src/models/branch'
import {
  ForkContributionTarget,
  WorkflowPreferences,
} from '../../src/models/workflow-preferences'
import {
  BitbucketCloudURL,
  CodebergCloudURL,
  GiteaCloudURL,
  GitHubDotComURL,
  GitLabCloudURL,
} from '../../src/lib/api'

// _getPullRequestCreationURL derives the URL exclusively from its arguments,
// so we can invoke it on a bare prototype instance and skip the AppStore
// constructor, which requires the full store graph and IPC wiring.
const appStore = Object.create(AppStore.prototype) as AppStore

const hosts: Record<RepoType, string> = {
  github: GitHubDotComURL,
  bitbucket: BitbucketCloudURL,
  gitlab: GitLabCloudURL,
  forgejo: CodebergCloudURL,
  gitea: GiteaCloudURL,
}

let nextId = 1

function createGitHubRepository(
  type: RepoType,
  owner: string,
  name: string,
  options: { htmlURL?: string | null; parent?: GitHubRepository } = {}
): GitHubRepository {
  const htmlURL =
    options.htmlURL !== undefined
      ? options.htmlURL
      : `${hosts[type]}/${owner}/${name}`

  return new GitHubRepository(
    name,
    type,
    new Owner(owner, hosts[type], nextId++),
    nextId++,
    null,
    htmlURL,
    htmlURL !== null ? `${htmlURL}.git` : null,
    null,
    null,
    null,
    options.parent ?? null
  )
}

function createRepository(
  gitHubRepository: GitHubRepository,
  workflowPreferences: WorkflowPreferences = {}
): RepositoryWithGitHubRepository {
  return new Repository(
    `/repos/${gitHubRepository.name}`,
    nextId++,
    gitHubRepository,
    false,
    null,
    null,
    null,
    workflowPreferences
  ) as RepositoryWithGitHubRepository
}

function createBranch(name: string, upstream: string | null = null): Branch {
  return new Branch(
    name,
    upstream,
    { sha: 'deadbeef', author: { date: new Date() } },
    BranchType.Local,
    `refs/heads/${name}`,
    false
  )
}

function createRemoteBranch(name: string): Branch {
  return new Branch(
    name,
    null,
    { sha: 'deadbeef', author: { date: new Date() } },
    BranchType.Remote,
    `refs/remotes/${name}`,
    false
  )
}

describe('AppStore._getPullRequestCreationURL', () => {
  describe('github', () => {
    it('builds a compare URL without a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(url, 'https://github.com/me/repo/pull/new/feature')
    })

    it('builds a compare URL with a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(url, 'https://github.com/me/repo/pull/new/main...feature')
    })

    it('encodes special characters in branch names', () => {
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature/añadir#1'),
        createBranch('release/1.0')
      )

      assert.equal(
        url,
        'https://github.com/me/repo/pull/new/release%2F1.0...feature%2Fa%C3%B1adir%231'
      )
    })

    it('prefers the upstream name of the compare branch over its local name', () => {
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('local-name', 'origin/remote-name'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://github.com/me/repo/pull/new/main...remote-name'
      )
    })

    it('strips the remote prefix from a remote base branch', () => {
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createRemoteBranch('origin/main')
      )

      assert.equal(url, 'https://github.com/me/repo/pull/new/main...feature')
    })

    it('prefixes both branches with owner:name for a fork contributing to its parent', () => {
      const parent = createGitHubRepository('github', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://github.com/me/fork-repo/pull/new/upstream-owner:repo:main...me:fork-repo:feature'
      )
    })

    it('prefixes only the compare branch when a fork contributing to its parent has no base branch', () => {
      const parent = createGitHubRepository('github', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://github.com/me/fork-repo/pull/new/me:fork-repo:feature'
      )
    })

    it('omits fork prefixes when the fork contributes to itself', () => {
      const parent = createGitHubRepository('github', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('github', 'me', 'fork-repo', { parent }),
        { forkContributionTarget: ForkContributionTarget.Self }
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://github.com/me/fork-repo/pull/new/main...feature'
      )
    })
  })

  describe('bitbucket', () => {
    it('builds a pull request URL with source and dest parameters', () => {
      const repository = createRepository(
        createGitHubRepository('bitbucket', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://bitbucket.org/me/repo/pull-requests/new?source=feature&dest=main'
      )
    })

    it('omits the dest parameter without a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('bitbucket', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://bitbucket.org/me/repo/pull-requests/new?source=feature&'
      )
    })

    it('targets the parent repository via workspace/repo::branch for a fork contributing to its parent', () => {
      const parent = createGitHubRepository(
        'bitbucket',
        'upstream-owner',
        'repo'
      )
      const repository = createRepository(
        createGitHubRepository('bitbucket', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://bitbucket.org/me/fork-repo/pull-requests/new?source=feature&dest=upstream-owner/repo::main'
      )
    })

    it('preselects the parent repository with its default branch when a fork contributing to its parent has no base branch', () => {
      const parent = createGitHubRepository(
        'bitbucket',
        'upstream-owner',
        'repo'
      )
      const repository = createRepository(
        createGitHubRepository('bitbucket', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://bitbucket.org/me/fork-repo/pull-requests/new?source=feature&dest=upstream-owner/repo::'
      )
    })
  })

  describe('gitlab', () => {
    it('builds a merge request URL with source and target parameters', () => {
      const repository = createRepository(
        createGitHubRepository('gitlab', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://gitlab.com/me/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&merge_request%5Btarget_branch%5D=main'
      )
    })

    it('omits the target parameter without a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('gitlab', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://gitlab.com/me/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&'
      )
    })

    it('uses the fork URL and unprefixed branch names for a fork contributing to its parent', () => {
      const parent = createGitHubRepository('gitlab', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('gitlab', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://gitlab.com/me/fork-repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&merge_request%5Btarget_branch%5D=main'
      )
    })

    it('uses the fork URL and unprefixed source branch for a fork contributing to its parent without a base branch', () => {
      const parent = createGitHubRepository('gitlab', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('gitlab', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://gitlab.com/me/fork-repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature&'
      )
    })
  })

  describe('forgejo', () => {
    it('builds a compare URL without a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(url, 'https://codeberg.org/me/repo/compare/feature')
    })

    it('builds a compare URL with a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(url, 'https://codeberg.org/me/repo/compare/main...feature')
    })

    it('targets the parent repository with an owner/name: head for a fork contributing to its parent', () => {
      const parent = createGitHubRepository('forgejo', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://codeberg.org/upstream-owner/repo/compare/main...me/fork-repo:feature'
      )
    })

    it('targets the parent repository with only the head when a fork contributing to its parent has no base branch', () => {
      const parent = createGitHubRepository('forgejo', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://codeberg.org/upstream-owner/repo/compare/me/fork-repo:feature'
      )
    })

    it('falls back to the fork URL when the parent has no html URL', () => {
      const parent = createGitHubRepository(
        'forgejo',
        'upstream-owner',
        'repo',
        { htmlURL: null }
      )
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://codeberg.org/me/fork-repo/compare/main...me/fork-repo:feature'
      )
    })

    it('targets the fork itself when it contributes to itself', () => {
      const parent = createGitHubRepository('forgejo', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('forgejo', 'me', 'fork-repo', { parent }),
        { forkContributionTarget: ForkContributionTarget.Self }
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://codeberg.org/me/fork-repo/compare/main...feature'
      )
    })
  })

  describe('gitea', () => {
    it('builds a compare URL without a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(url, 'https://gitea.com/me/repo/compare/feature')
    })

    it('builds a compare URL with a base branch', () => {
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'repo')
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(url, 'https://gitea.com/me/repo/compare/main...feature')
    })

    it('targets the parent repository with an owner/name: head for a fork contributing to its parent', () => {
      const parent = createGitHubRepository('gitea', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://gitea.com/upstream-owner/repo/compare/main...me/fork-repo:feature'
      )
    })

    it('targets the parent repository with only the head when a fork contributing to its parent has no base branch', () => {
      const parent = createGitHubRepository('gitea', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature')
      )

      assert.equal(
        url,
        'https://gitea.com/upstream-owner/repo/compare/me/fork-repo:feature'
      )
    })

    it('falls back to the fork URL when the parent has no html URL', () => {
      const parent = createGitHubRepository('gitea', 'upstream-owner', 'repo', {
        htmlURL: null,
      })
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'fork-repo', { parent })
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(
        url,
        'https://gitea.com/me/fork-repo/compare/main...me/fork-repo:feature'
      )
    })

    it('targets the fork itself when it contributes to itself', () => {
      const parent = createGitHubRepository('gitea', 'upstream-owner', 'repo')
      const repository = createRepository(
        createGitHubRepository('gitea', 'me', 'fork-repo', { parent }),
        { forkContributionTarget: ForkContributionTarget.Self }
      )

      const url = appStore._getPullRequestCreationURL(
        repository,
        createBranch('feature'),
        createBranch('main')
      )

      assert.equal(url, 'https://gitea.com/me/fork-repo/compare/main...feature')
    })
  })
})
