import { describe, it } from 'node:test'
import assert from 'node:assert'
import { rewriteWindowsReleasesFile } from './windows-releases'
import { getWindowsReleaseNugetPackageName } from './dist-info'

const sha = '0123456789abcdef0123456789ABCDEF01234567'
const url =
  'https://github.com/desktop-plus/desktop-plus/releases/download/v3.6.8.1/DesktopPlus-x64-3.6.8-r1-full.nupkg'
const newNames = new Map([['DesktopPlus-3.6.8-r1-full.nupkg', url]])

/** Mirrors how Squirrel.Windows parses a version from a RELEASES entry. */
function parseSquirrelVersion(fileNameOrUrl: string) {
  const fileName = fileNameOrUrl.substring(fileNameOrUrl.lastIndexOf('/') + 1)
  const name = fileName.replace(/(-full|-delta)?\.nupkg$/, '')
  return /\d+(\.\d+){0,3}(-[A-Za-z][0-9A-Za-z-]*)?$/.exec(name)?.[0]
}

describe('rewriteWindowsReleasesFile', () => {
  it('replaces the package name and keeps SHA1 and size', () => {
    const contents = `${sha} DesktopPlus-3.6.8-r1-full.nupkg 123456`
    assert.equal(
      rewriteWindowsReleasesFile(contents, newNames),
      `${sha} ${url} 123456`
    )
  })

  it('keeps byte order mark, line endings and unknown entries', () => {
    const contents =
      `﻿${sha} DesktopPlus-3.6.7-r2-full.nupkg 1\r\n` +
      `${sha} DesktopPlus-3.6.8-r1-full.nupkg 2\r\n`
    assert.equal(
      rewriteWindowsReleasesFile(contents, newNames),
      `﻿${sha} DesktopPlus-3.6.7-r2-full.nupkg 1\r\n` + `${sha} ${url} 2\r\n`
    )
  })

  it('produces entries whose version Squirrel.Windows can parse', () => {
    const previous = process.env.SEMVER_COMPATIBLE_VERSION
    process.env.SEMVER_COMPATIBLE_VERSION = '3.6.8-r1'
    try {
      for (const arch of ['x64', 'arm64']) {
        const name = getWindowsReleaseNugetPackageName(arch, 'full')
        assert.equal(name, `DesktopPlus-${arch}-3.6.8-r1-full.nupkg`)
        assert.equal(parseSquirrelVersion(name), '3.6.8-r1')
      }
      assert.equal(parseSquirrelVersion(url), '3.6.8-r1')
    } finally {
      if (previous === undefined) {
        delete process.env.SEMVER_COMPATIBLE_VERSION
      } else {
        process.env.SEMVER_COMPATIBLE_VERSION = previous
      }
    }
  })
})
