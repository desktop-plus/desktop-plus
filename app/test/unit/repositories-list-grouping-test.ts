import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import { groupRepositories } from '../../src/ui/repositories-list/group-repositories'
import { Repository, ILocalRepositoryState } from '../../src/models/repository'
import { CloningRepository } from '../../src/models/cloning-repository'
import { SubmoduleEntry } from '../../src/models/submodule'
import { gitHubRepoFixture } from '../helpers/github-repo-builder'

const emptyLocalRepositoryState: ILocalRepositoryState = {
  aheadBehind: null,
  changedFilesCount: 0,
  branchName: null,
  defaultBranchName: null,
  worktrees: [],
  submodules: [],
}

describe('repository list grouping', () => {
  const repositories: Array<Repository | CloningRepository> = [
    new Repository('repo1', 1, null, false),
    new Repository(
      'repo2',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'my-repo2' }),
      false
    ),
    new Repository(
      'repo3',
      3,
      gitHubRepoFixture({
        owner: '',
        name: 'my-repo3',
        endpoint: 'https://github.big-corp.com/api/v3',
      }),
      false
    ),
  ]

  const cache = new Map<number, ILocalRepositoryState>()

  it('groups repositories by owners/Enterprise/Other', () => {
    const grouped = groupRepositories(repositories, cache, [], true)
    assert.equal(grouped.length, 3)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'me')
    assert.equal(grouped[0].items.length, 1)

    let item = grouped[0].items[0]
    assert.equal(item.repository.path, 'repo2')

    assert.equal(grouped[1].identifier.kind, 'enterprise')
    assert.equal(grouped[1].items.length, 1)

    item = grouped[1].items[0]
    assert.equal(item.repository.path, 'repo3')

    assert.equal(grouped[2].identifier.kind, 'other')
    assert.equal(grouped[2].items.length, 1)

    item = grouped[2].items[0]
    assert.equal(item.repository.path, 'repo1')
  })

  it('sorts repositories alphabetically within each group', () => {
    const repoA = new Repository('a', 1, null, false)
    const repoB = new Repository(
      'b',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'b' }),
      false
    )
    const repoC = new Repository('c', 2, null, false)
    const repoD = new Repository(
      'd',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'd' }),
      false
    )
    const repoZ = new Repository('z', 3, null, false)

    const grouped = groupRepositories(
      [repoC, repoB, repoZ, repoD, repoA],
      cache,
      [],
      true
    )
    assert.equal(grouped.length, 2)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'me')
    assert.equal(grouped[0].items.length, 2)

    let items = grouped[0].items
    assert.equal(items[0].repository.path, 'b')
    assert.equal(items[1].repository.path, 'd')

    assert.equal(grouped[1].identifier.kind, 'other')
    assert.equal(grouped[1].items.length, 3)

    items = grouped[1].items
    assert.equal(items[0].repository.path, 'a')
    assert.equal(items[1].repository.path, 'c')
    assert.equal(items[2].repository.path, 'z')
  })

  it('only disambiguates Enterprise repositories', () => {
    const repoA = new Repository(
      'repo',
      1,
      gitHubRepoFixture({ owner: 'user1', name: 'repo' }),
      false
    )
    const repoB = new Repository(
      'repo',
      2,
      gitHubRepoFixture({ owner: 'user2', name: 'repo' }),
      false
    )
    const repoC = new Repository(
      'enterprise-repo',
      3,
      gitHubRepoFixture({
        owner: 'business',
        name: 'enterprise-repo',
        endpoint: 'https://ghe.io/api/v3',
      }),
      false
    )
    const repoD = new Repository(
      'enterprise-repo',
      3,
      gitHubRepoFixture({
        owner: 'silliness',
        name: 'enterprise-repo',
        endpoint: 'https://ghe.io/api/v3',
      }),
      false
    )

    const grouped = groupRepositories(
      [repoA, repoB, repoC, repoD],
      cache,
      [],
      true
    )
    assert.equal(grouped.length, 3)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'user1')
    assert.equal(grouped[0].items.length, 1)

    assert.equal(grouped[1].identifier.kind, 'dotcom')
    assert.equal((grouped[1].identifier as any).owner.login, 'user2')
    assert.equal(grouped[1].items.length, 1)

    assert.equal(grouped[2].identifier.kind, 'enterprise')
    assert.equal(grouped[2].items.length, 2)

    assert.equal(grouped[0].items[0].text[0], 'repo')
    assert(!grouped[0].items[0].needsDisambiguation)

    assert.equal(grouped[1].items[0].text[0], 'repo')
    assert(!grouped[1].items[0].needsDisambiguation)

    assert.equal(grouped[2].items[0].text[0], 'enterprise-repo')
    assert(grouped[2].items[0].needsDisambiguation)

    assert.equal(grouped[2].items[1].text[0], 'enterprise-repo')
    assert(grouped[2].items[1].needsDisambiguation)
  })

  it('nests submodule rows below their repository, in depth-first order', () => {
    const repo = new Repository('repo', 1, null, false)
    const cacheWithSubmodules = new Map<number, ILocalRepositoryState>([
      [
        repo.id,
        {
          ...emptyLocalRepositoryState,
          submodules: [
            new SubmoduleEntry('sha1', 'vendor/a', 'a-describe'),
            new SubmoduleEntry('sha2', 'vendor/a/nested', 'nested-describe'),
            new SubmoduleEntry('sha3', 'vendor/b', 'b-describe'),
          ],
        },
      ],
    ])

    const grouped = groupRepositories([repo], cacheWithSubmodules, [], true)
    assert.equal(grouped.length, 1)

    const items = grouped[0].items
    assert.equal(items.length, 4)

    assert.equal(items[0].repository.path, 'repo')
    assert.equal(items[0].submodule, null)

    assert.equal(items[1].submodule?.path, 'vendor/a')
    assert.equal(items[1].submoduleDepth, 1)

    assert.equal(items[2].submodule?.path, 'vendor/a/nested')
    assert.equal(items[2].submoduleDepth, 2)

    assert.equal(items[3].submodule?.path, 'vendor/b')
    assert.equal(items[3].submoduleDepth, 1)
  })

  it('keeps increasing depth for submodules of a linked submodule repository', () => {
    const repo = new Repository('repo', 1, null, false)
    const linkedSubmoduleRepo = new Repository(
      Path.join('repo', 'vendor', 'a'),
      2,
      null,
      false
    )

    const cache = new Map<number, ILocalRepositoryState>([
      [
        repo.id,
        {
          ...emptyLocalRepositoryState,
          submodules: [new SubmoduleEntry('sha1', 'vendor/a', 'a-describe')],
        },
      ],
      [
        linkedSubmoduleRepo.id,
        {
          ...emptyLocalRepositoryState,
          submodules: [
            new SubmoduleEntry('sha2', 'vendor/nested', 'nested-describe'),
          ],
        },
      ],
    ])

    const grouped = groupRepositories(
      [repo, linkedSubmoduleRepo],
      cache,
      [],
      true
    )
    assert.equal(grouped.length, 1)

    const items = grouped[0].items
    assert.equal(items.length, 3)

    assert.equal(items[0].repository.path, 'repo')
    assert.equal(items[0].submodule, null)

    assert.equal(items[1].submodule?.path, 'vendor/a')
    assert.equal(items[1].submoduleDepth, 1)
    assert.equal(items[1].linkedRepository, linkedSubmoduleRepo)

    assert.equal(items[2].submodule?.path, 'vendor/nested')
    assert.equal(items[2].submoduleDepth, 2)
  })

  it('does not add submodule rows when there are none cached', () => {
    const repo = new Repository('repo', 1, null, false)
    const cacheWithoutSubmodules = new Map<number, ILocalRepositoryState>([
      [repo.id, emptyLocalRepositoryState],
    ])

    const grouped = groupRepositories(
      [repo],
      cacheWithoutSubmodules,
      [],
      true
    )
    assert.equal(grouped[0].items.length, 1)
  })

  it('does not add submodule rows when showSubmodulesInRepoList is false', () => {
    const repo = new Repository('repo', 1, null, false)
    const cacheWithSubmodules = new Map<number, ILocalRepositoryState>([
      [
        repo.id,
        {
          ...emptyLocalRepositoryState,
          submodules: [new SubmoduleEntry('sha1', 'vendor/a', 'a-describe')],
        },
      ],
    ])

    const grouped = groupRepositories([repo], cacheWithSubmodules, [], false)
    assert.equal(grouped[0].items.length, 1)
    assert.equal(grouped[0].items[0].hasChildren, false)
  })
})
