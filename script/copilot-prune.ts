/* eslint-disable no-sync */
import { rmSync } from 'fs'
import { join } from 'path'

/**
 * The standalone runtime only needs `prebuilds/<platform>-<arch>`; everything
 * here exists for the Copilot CLI or for hosting extensions. Desktop Plus
 * creates every session with `availableTools: []` and rejects all permission
 * requests (see `copilot-store.ts`), so no tool ever spawns a search binary or
 * an MCP server, and it registers no extensions. Some entries only ship on
 * certain platforms, hence the unconditional removal.
 */
const unusedCopilotEntries = [
  // Lottie animations played by the CLI's terminal UI.
  'animations',
  // SDK bundle, type declarations and docs, loaded by extension subprocesses.
  'copilot-sdk',
  // Bundled MCP server plugins (computer use), reachable only through tools.
  'plugins',
  // Node loader hooks that bootstrap extension subprocesses.
  'preloads',
  // Search binaries, spawned only by the grep/search tools.
  'ripgrep',
  'tgrep',
  // JSON-RPC schemas published for consumers to generate code from.
  'schemas',
  // Second SDK bundle, also only used by extension subprocesses.
  'sdk',
]

/**
 * Delete the copied Copilot files the app never loads
 */
export function pruneCopilotDependency(destination: string): void {
  for (const entry of unusedCopilotEntries) {
    rmSync(join(destination, entry), { recursive: true, force: true })
  }
}
