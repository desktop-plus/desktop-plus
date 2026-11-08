/**
 * Derive a stable, positive numeric id from a case-insensitive login
 */
export function deriveNumericAccountId(login: string): number {
  // 32-bit FNV-1a hash
  let hash = 0x811c9dc5
  for (const char of login.toLowerCase()) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193)
  }
  return hash >>> 0 || 1
}
