import { join } from 'path'

type Env = Record<string, string | undefined>

const shellDoubleQuote = (value: string) =>
  `"${value.replace(/["\\$`]/g, '\\$&')}"`

const gitConfigParameter = (value: string) =>
  `'${value.replace(/'/g, "'\\''")}'`

/**
 * Get the environment variables that let Git commands spawned by a hook
 * authenticate through Desktop's credential helper.
 */
export function getHookCredentialHelperEnv(
  proxyEnv: Env,
  gitParameters: string | undefined
): Env {
  const { DESKTOP_PORT, DESKTOP_TRAMPOLINE_TOKEN, GIT_EXEC_PATH } = proxyEnv

  if (!DESKTOP_PORT || !DESKTOP_TRAMPOLINE_TOKEN || !GIT_EXEC_PATH) {
    return {}
  }

  const helperPath = join(
    GIT_EXEC_PATH,
    `git-credential-desktop${__WIN32__ ? '.exe' : ''}`
  )
  // Git runs the helper through sh, also on Windows
  const helper = `!${shellDoubleQuote(helperPath.replace(/\\/g, '/'))}`
  const prefix = gitParameters ? `${gitParameters} ` : ''

  return {
    DESKTOP_PORT,
    DESKTOP_TRAMPOLINE_TOKEN,
    GIT_CONFIG_PARAMETERS: `${prefix}'credential.helper=' ${gitConfigParameter(
      `credential.helper=${helper}`
    )}`,
  }
}
