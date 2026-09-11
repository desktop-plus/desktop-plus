import { execFileSync } from 'child_process'
import { join } from 'path'
import { chmod, copyFile, cp, mkdir, rm, symlink, writeFile } from 'fs/promises'

import { description, productName } from '../app/package.json'
import { getVersion } from '../app/package-info'
import { LINUX_ICON_NAME } from './linux-icon'
import {
  getArchitectureForFileName,
  getDistArchitecture,
  getDistPath,
  getDistRoot,
  getExecutableName,
} from './dist-info'

const APPIMAGETOOL_VERSION = '1.9.1'

/** Icon sizes available in `app/static/linux/logos`, smallest first. */
const ICON_SIZES = [32, 64, 128, 256, 512, 1024]

const MIME_TYPES = [
  'x-scheme-handler/x-github-client',
  'x-scheme-handler/x-github-desktop-auth',
  'x-scheme-handler/x-github-desktop-dev-auth',
]

function getAppImageArchitecture() {
  return getDistArchitecture() === 'arm64' ? 'aarch64' : 'x86_64'
}

function getAppRunScript(executableName: string) {
  return `#!/bin/bash
set -e

if [ -z "\${APPDIR}" ] ; then
  APPDIR="$(dirname "$(readlink -f "\${0}")")"
fi

export PATH="\${APPDIR}:\${APPDIR}/usr/sbin\${PATH:+:\${PATH}}"
export XDG_DATA_DIRS="\${APPDIR}/usr/share/\${XDG_DATA_DIRS:+:\${XDG_DATA_DIRS}}:/usr/share/gnome/:/usr/local/share/:/usr/share/"
export LD_LIBRARY_PATH="\${APPDIR}/usr/lib\${LD_LIBRARY_PATH:+:\${LD_LIBRARY_PATH}}"
export GSETTINGS_SCHEMA_DIR="\${APPDIR}/usr/share/glib-2.0/schemas\${GSETTINGS_SCHEMA_DIR:+:\${GSETTINGS_SCHEMA_DIR}}"

exec "\${APPDIR}/${executableName}" "$@"
`
}

function getDesktopEntry() {
  return `[Desktop Entry]
Name=${productName}
Exec=AppRun --no-sandbox %U
Terminal=false
Type=Application
Icon=${LINUX_ICON_NAME}
StartupWMClass=${productName}
X-AppImage-Version=${getVersion()}
Comment=${description}
MimeType=${MIME_TYPES.map(type => `${type};`).join('')}
Categories=GNOME;GTK;Development;
`
}

async function downloadAppImageTool(destination: string) {
  const hostArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const url = `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-${hostArch}.AppImage`

  console.log(`Downloading ${url}…`)
  execFileSync('curl', ['--fail', '--location', '--output', destination, url], {
    stdio: 'inherit',
  })
  await chmod(destination, 0o755)
}

async function createAppDir(appDir: string, executableName: string) {
  await rm(appDir, { recursive: true, force: true })
  await cp(getDistPath(), appDir, { recursive: true })
  await chmod(appDir, 0o755)

  const appRunPath = join(appDir, 'AppRun')
  await writeFile(appRunPath, getAppRunScript(executableName))
  await chmod(appRunPath, 0o755)

  await writeFile(join(appDir, `${executableName}.desktop`), getDesktopEntry())

  const iconsDir = join(appDir, 'usr', 'share', 'icons', 'hicolor')
  for (const size of ICON_SIZES) {
    const appsDir = join(iconsDir, `${size}x${size}`, 'apps')
    await mkdir(appsDir, { recursive: true })
    await copyFile(
      join(
        __dirname,
        '..',
        'app',
        'static',
        'linux',
        'logos',
        `${size}x${size}.png`
      ),
      join(appsDir, `${LINUX_ICON_NAME}.png`)
    )
  }

  // The AppImage spec looks for the icon at the root of the AppDir, and the
  // thumbnailers look for `.DirIcon`.
  const largestSize = ICON_SIZES[ICON_SIZES.length - 1]
  const iconTarget = join(
    'usr',
    'share',
    'icons',
    'hicolor',
    `${largestSize}x${largestSize}`,
    'apps',
    `${LINUX_ICON_NAME}.png`
  )
  await symlink(iconTarget, join(appDir, `${LINUX_ICON_NAME}.png`))
  await symlink(iconTarget, join(appDir, '.DirIcon'))
}

export async function packageAppImage(): Promise<string> {
  const distRoot = getDistRoot()
  const executableName = getExecutableName()
  const architecture = getArchitectureForFileName()

  const appDir = join(distRoot, `${executableName}.AppDir`)
  const appImageTool = join(distRoot, 'appimagetool')

  const fileName = `DesktopPlus-v${getVersion()}-linux-${architecture}.AppImage`

  // https://github.com/AppImage/AppImageSpec/blob/master/draft.md#release-name-values
  const updateInfo = `gh-releases-zsync|desktop-plus|desktop-plus|latest|DesktopPlus-*-linux-${architecture}.AppImage.zsync`

  try {
    console.log('Creating AppDir…')
    await createAppDir(appDir, executableName)

    await downloadAppImageTool(appImageTool)

    console.log('Packaging AppImage…')
    execFileSync(appImageTool, ['-u', updateInfo, appDir, fileName], {
      cwd: distRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ARCH: getAppImageArchitecture(),
        APPIMAGE_EXTRACT_AND_RUN: '1',
      },
    })
  } finally {
    await rm(appDir, { recursive: true, force: true })
    await rm(appImageTool, { force: true })
  }

  return join(distRoot, fileName)
}
