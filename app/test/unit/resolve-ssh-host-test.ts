import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { Account } from '../../src/models/account'
import {
  registerEndpointApiType,
  resetEndpointApiTypeRegistryForTesting,
} from '../../src/lib/endpoint-api-type-registry'

type TExecFileBehavior = (
  file: string,
  args: ReadonlyArray<string>,
  options: unknown
) => Promise<{ stdout: string; stderr: string }>

const defaultExecFileBehavior: TExecFileBehavior = async () => ({
  stdout: '',
  stderr: '',
})
let execFileBehavior = defaultExecFileBehavior
let execFileCalls: Array<ReadonlyArray<string>> = []

mock.module('../../src/lib/exec-file', {
  namedExports: {
    execFile: (file: string, args: ReadonlyArray<string>, options: unknown) => {
      execFileCalls.push(args)
      return execFileBehavior(file, args, options)
    },
  },
})

async function getResolver() {
  return await import('../../src/lib/ssh/resolve-ssh-host')
}

const aliasOutput = `host companyname-server-git
user git
hostname gitlab.companyname.de
port 22
`

describe('resolveSSHRemoteAlias', () => {
  afterEach(async () => {
    execFileBehavior = defaultExecFileBehavior
    execFileCalls = []
    ;(await getResolver()).resetResolvedSSHHostsForTesting()
  })

  it('returns remotes that name no SSH host unchanged without running ssh', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    for (const url of [
      'https://github.com/hubot/repo.git',
      'file:///home/hubot/repo',
      '/home/hubot/repo',
      '../repo',
      'C:\\Users\\hubot\\repo',
      'hubot/repo',
      '',
    ]) {
      assert.equal(await resolveSSHRemoteAlias(url), url)
    }
    assert.equal(execFileCalls.length, 0)
  })

  it('never hands a host that ssh would read as an option to ssh', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    const url = '-oProxyCommand=id:hubot/repo.git'
    assert.equal(await resolveSSHRemoteAlias(url), url)
    assert.equal(execFileCalls.length, 0)
  })

  it('rewrites an aliased scp-like remote to name the real host', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => ({ stdout: aliasOutput, stderr: '' })

    assert.equal(
      await resolveSSHRemoteAlias('companyname-server-git:group/repo.git'),
      'git@gitlab.companyname.de:group/repo.git'
    )
    assert.deepStrictEqual(execFileCalls, [['-G', 'companyname-server-git']])
  })

  it('rewrites an aliased ssh URL to name the real host', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => ({ stdout: aliasOutput, stderr: '' })

    assert.equal(
      await resolveSSHRemoteAlias(
        'ssh://git@companyname-server-git:2222/group/repo.git'
      ),
      'git@gitlab.companyname.de:group/repo.git'
    )
  })

  it('rewrites a user-less remote naming a host that is not an alias', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => ({
      stdout: 'user hubot\nhostname gitlab.example.com\n',
      stderr: '',
    })

    assert.equal(
      await resolveSSHRemoteAlias('gitlab.example.com:group/repo.git'),
      'git@gitlab.example.com:group/repo.git'
    )
  })

  it('runs ssh once for concurrent lookups of the same host', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => ({ stdout: aliasOutput, stderr: '' })

    const results = await Promise.all([
      resolveSSHRemoteAlias('companyname-server-git:group/repo.git'),
      resolveSSHRemoteAlias('companyname-server-git:group/other.git'),
    ])

    assert.deepStrictEqual(results, [
      'git@gitlab.companyname.de:group/repo.git',
      'git@gitlab.companyname.de:group/other.git',
    ])
    assert.equal(execFileCalls.length, 1)
  })

  it('returns the remote unchanged when ssh fails, and does not retry', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => {
      throw new Error('spawn ssh ENOENT')
    }

    const url = 'companyname-server-git:group/repo.git'
    assert.equal(await resolveSSHRemoteAlias(url), url)
    assert.equal(await resolveSSHRemoteAlias(url), url)
    assert.equal(execFileCalls.length, 1)
  })

  it('returns the remote unchanged when ssh prints no hostname', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    execFileBehavior = async () => ({ stdout: 'port 22\n', stderr: '' })

    const url = 'companyname-server-git:group/repo.git'
    assert.equal(await resolveSSHRemoteAlias(url), url)
  })

  it('lets the matching helpers see an alias once it has been resolved', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    const { urlMatchesRemote, repositoryMatchesRemote } = await import(
      '../../src/lib/repository-matching'
    )
    const { gitHubRepoFixture } = await import('../helpers/github-repo-builder')
    execFileBehavior = async () => ({ stdout: aliasOutput, stderr: '' })

    const cloneUrl = 'https://gitlab.companyname.de/group/repo.git'
    const remotes = [
      { name: 'origin', url: 'companyname-server-git:group/repo.git' },
      { name: 'origin', url: 'git@companyname-server-git:group/repo.git' },
    ]
    const otherRemote = {
      name: 'origin',
      url: 'companyname-server-git:group/other.git',
    }
    const ghRepo = gitHubRepoFixture({
      owner: 'group',
      name: 'repo',
      endpoint: 'https://gitlab.companyname.de',
    })

    for (const remote of remotes) {
      assert.equal(urlMatchesRemote(cloneUrl, remote), false)
      assert.equal(repositoryMatchesRemote(ghRepo, remote), false)
    }

    await resolveSSHRemoteAlias(remotes[0].url)

    for (const remote of remotes) {
      assert.equal(urlMatchesRemote(cloneUrl, remote), true)
      assert.equal(repositoryMatchesRemote(ghRepo, remote), true)
    }
    assert.equal(urlMatchesRemote(cloneUrl, otherRemote), false)
  })

  // The way `AppStore` uses the resolver: the remote as written is matched
  // first, and only one that matches no account is retried resolved.
  it('lets an aliased user-less remote match its GitLab account', async () => {
    const { resolveSSHRemoteAlias } = await getResolver()
    const { matchGitHubRepository } = await import(
      '../../src/lib/repository-matching'
    )
    const accounts = [
      new Account(
        'gl-user',
        'https://gitlab.companyname.de/api/v4',
        'gitlab',
        '',
        [],
        '',
        1,
        '',
        'free'
      ),
    ]
    registerEndpointApiType('https://gitlab.companyname.de/api/v4', 'gitlab')
    execFileBehavior = async () => ({ stdout: aliasOutput, stderr: '' })

    try {
      const url = 'companyname-server-git:group/repo.git'
      const repo =
        matchGitHubRepository(accounts, url) ??
        matchGitHubRepository(accounts, await resolveSSHRemoteAlias(url))

      assert(repo !== null)
      assert.equal(repo.account.login, 'gl-user')
      assert.equal(repo.owner, 'group')
      assert.equal(repo.name, 'repo')
    } finally {
      localStorage.removeItem('api-endpoint-types')
      resetEndpointApiTypeRegistryForTesting()
    }
  })
})
