const releaseEntryRegex = /^(﻿?[0-9a-fA-F]{40}\s+)(\S+)(\s+\d+\r?)$/

/**
 * Rewrite the package file names in a Squirrel.Windows RELEASES file, keeping
 * their SHA1 and size. Entries not present in `newNames` are left untouched.
 *
 * @param newNames Maps the original package file name to its new name or URL.
 */
export function rewriteWindowsReleasesFile(
  contents: string,
  newNames: ReadonlyMap<string, string>
) {
  return contents
    .split('\n')
    .map(line => {
      const match = releaseEntryRegex.exec(line)
      const newName = match ? newNames.get(match[2]) : undefined
      return match && newName ? `${match[1]}${newName}${match[3]}` : line
    })
    .join('\n')
}
