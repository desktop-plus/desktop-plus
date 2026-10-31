import { ReleaseSummary } from '../../models/release-notes'

export const UpstreamReleaseNotesUri =
  __RELEASE_CHANNEL__ === 'beta'
    ? 'https://desktop.github.com/release-notes/?env=beta'
    : 'https://desktop.github.com/release-notes/'

export const DesktopPlusReleaseNotesUri =
  'https://github.com/desktop-plus/desktop-plus/releases/'

/**
 * Desktop Plus doesn't parse its release notes, so the update banner links to
 * the GitHub releases page instead of showing the release notes dialog.
 */
export async function generateReleaseSummary(): Promise<ReadonlyArray<ReleaseSummary> | null> {
  return null
}
