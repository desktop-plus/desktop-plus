import { promisify } from 'util'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { mkdtemp } from 'fs/promises'

import glob = require('glob')
const globPromise = promisify(glob)

import { mkdir, rename, writeFile } from 'fs/promises'

import { getVersion } from '../app/package-info'
import {
  getDistPath,
  getDistRoot,
  getArchitectureForFileName,
} from './dist-info'
import { overrideHicolorIconName } from './linux-icon'

function getArchitecture() {
  const arch = process.env.npm_config_arch || process.arch
  switch (arch) {
    case 'arm64':
      return 'arm64'
    case 'arm':
      return 'armhf'
    default:
      return 'amd64'
  }
}

const distRoot = getDistRoot()

// Based on the documentation:
// https://github.com/electron-userland/electron-installer-debian/
type DebianOptions = {
  src: string
  dest: string
  rename?: (dest: string, src: string) => string
  name?: string
  productName?: string
  genericName?: string
  description?: string
  productDescription?: string
  version?: string
  revision?: string
  section?: string
  priority?: 'required' | 'important' | 'standard' | 'optional' | 'extra'
  arch?: string
  size?: number
  depends?: Array<string>
  recommends?: Array<string>
  suggests?: Array<string>
  enhances?: Array<string>
  preDepends?: Array<string>
  maintainer?: string
  homepage?: string
  bin?: string
  icon?: string | Record<string, string>
  categories?: Array<string>
  mimeType?: Array<string>
  lintianOverrides?: Array<string>
  scripts?: {
    preinst?: string
    postinst?: string
    prerm?: string
    postrm?: string
  }
  desktopTemplate?: string
  compression?: 'xz' | 'gzip' | 'bzip2' | 'lzma' | 'zstd' | 'none'
}

const options: DebianOptions = {
  src: getDistPath(),
  dest: distRoot,
  arch: getArchitecture(),
  version: getVersion(),
  name: 'desktop-plus',
  description:
    'GitHub Desktop fork with advanced functionality and improvements.',
  productName: 'Desktop Plus',
  productDescription:
    'GitHub Desktop fork with advanced functionality and improvements.',
  genericName: 'Git Client',
  categories: ['Development', 'GitHub'],
  section: 'GNOME;GTK;Development',
  priority: 'extra',
  // The AUR -bin package unpacks 'data.tar.zst' ensure zstd is used instead of the host default.
  compression: 'zstd',
  homepage: 'https://desktop-plus.org',
  depends: [
    // dugite-native dependencies
    'libcurl3 | libcurl4',
    // keytar dependencies
    'libsecret-1-0',
    'gnome-keyring',
  ],
  icon: {
    '32x32': 'app/static/linux/logos/32x32.png',
    '64x64': 'app/static/linux/logos/64x64.png',
    '128x128': 'app/static/linux/logos/128x128.png',
    '256x256': 'app/static/linux/logos/256x256.png',
    '512x512': 'app/static/linux/logos/512x512.png',
    '1024x1024': 'app/static/linux/logos/1024x1024.png',
  },
  scripts: {
    postinst: 'script/resources/deb/postinst.sh',
    postrm: 'script/resources/deb/postrm.sh',
  },
  mimeType: [
    'x-scheme-handler/x-github-client',
    'x-scheme-handler/x-github-desktop-auth',
    // workaround for handling OAuth flow until we figure out what we're doing
    // with the development OAuth details
    //
    // see https://github.com/shiftkey/desktop/issues/72 for more details
    'x-scheme-handler/x-github-desktop-dev-auth',
  ],
  maintainer: 'Pol Rivero <admin@desktop-plus.org>',
  desktopTemplate: 'script/resources/deb/desktop.ejs',
}

export async function packageDebian(): Promise<string> {
  if (process.platform === 'win32') {
    return Promise.reject('Windows is not supported')
  }

  const installer = require('electron-installer-debian')

  const restoreIconName = overrideHicolorIconName(installer.Installer)
  try {
    await installer(options)
  } finally {
    restoreIconName()
  }
  const installersPath = `${distRoot}/desktop-plus*.deb`

  const files = await globPromise(installersPath)

  if (files.length !== 1) {
    return Promise.reject(
      `Expected one file but instead found '${files.join(', ')}' - exiting...`
    )
  }

  const oldPath = files[0]

  const newFileName = `DesktopPlus-v${getVersion()}-linux-${getArchitectureForFileName()}.deb`
  const newPath = join(distRoot, newFileName)
  await rename(oldPath, newPath)

  return Promise.resolve(newPath)
}

export async function packageTransitionalDebian(): Promise<string> {
  if (process.platform === 'win32') {
    return Promise.reject('Windows is not supported')
  }

  const arch = getArchitecture()
  const version = getVersion()

  const stagingDir = await mkdtemp(
    join(tmpdir(), 'github-desktop-plus-transitional-')
  )
  const debianDir = join(stagingDir, 'DEBIAN')
  await mkdir(debianDir, { recursive: true })

  const control =
    [
      `Package: github-desktop-plus`,
      `Version: ${version}`,
      `Architecture: ${arch}`,
      `Maintainer: ${options.maintainer}`,
      `Depends: ${options.name}`,
      `Section: devel`,
      `Priority: optional`,
      `Homepage: ${options.homepage}`,
      `Description: Transitional package for Desktop Plus`,
      ` GitHub Desktop Plus has been renamed to Desktop Plus. This dummy package`,
      ` depends on the new "${options.name}" package and can be safely removed`,
      ` once the migration is complete.`,
    ].join('\n') + '\n'

  await writeFile(join(debianDir, 'control'), control)

  // Use the canonical Debian filename (name_version_arch.deb). Besides being
  // what dpkg-name produces, the "_arch" suffix (vs. the real package's
  // "-x86_64"/"-arm64") keeps this out of the release_aur job's
  // "*-x86_64.deb"/"*-arm64.deb" globs, which expect a single match.
  const newFileName = `github-desktop-plus_${version}_${arch}.deb`
  const newPath = join(distRoot, newFileName)

  execFileSync('fakeroot', ['dpkg-deb', '--build', stagingDir, newPath], {
    stdio: 'inherit',
  })

  return newPath
}
