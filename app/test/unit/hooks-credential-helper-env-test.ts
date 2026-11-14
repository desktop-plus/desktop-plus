import { describe, it } from 'node:test'
import assert from 'node:assert'
import { chmod, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { exec } from 'dugite'
import { getHookCredentialHelperEnv } from '../../src/lib/hooks/credential-helper-env'
import { parseCredential } from '../../src/lib/git/credential'
import { createTempDirectory } from '../helpers/temp'

describe('getHookCredentialHelperEnv', () => {
  it('returns nothing outside of a trampoline environment', () => {
    assert.deepStrictEqual(
      getHookCredentialHelperEnv({ GIT_EXEC_PATH: '/git-core' }, undefined),
      {}
    )
  })

  it('keeps the existing git parameters', () => {
    const env = getHookCredentialHelperEnv(
      {
        DESKTOP_PORT: '1234',
        DESKTOP_TRAMPOLINE_TOKEN: 'token',
        GIT_EXEC_PATH: '/git-core',
      },
      "'user.name=foo'"
    )

    assert.equal(env.DESKTOP_PORT, '1234')
    assert.equal(env.DESKTOP_TRAMPOLINE_TOKEN, 'token')
    assert.match(
      env.GIT_CONFIG_PARAMETERS ?? '',
      /^'user\.name=foo' 'credential\.helper=' 'credential\.helper=!/
    )
  })

  it(
    'lets git find the helper in a path that needs quoting',
    { skip: process.platform === 'win32' },
    async t => {
      const execPath = join(
        await createTempDirectory(t),
        `it's a "$HOME" \`dir\``
      )
      await mkdir(execPath)
      const helper = join(execPath, 'git-credential-desktop')
      await writeFile(
        helper,
        '#!/bin/sh\necho username=$DESKTOP_PORT\necho password=$DESKTOP_TRAMPOLINE_TOKEN\n'
      )
      await chmod(helper, 0o755)

      const env = getHookCredentialHelperEnv(
        {
          DESKTOP_PORT: '1234',
          DESKTOP_TRAMPOLINE_TOKEN: 'token',
          GIT_EXEC_PATH: execPath,
        },
        undefined
      )

      const { stdout, stderr, exitCode } = await exec(
        ['credential', 'fill'],
        execPath,
        {
          stdin: 'protocol=https\nhost=example.com\n\n',
          env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
        }
      )

      assert.equal(exitCode, 0, stderr.toString())
      const cred = parseCredential(stdout.toString())
      assert.equal(cred.get('username'), '1234')
      assert.equal(cred.get('password'), 'token')
    }
  )
})
