# Maintainer: Pol Rivero <aur AT polrivero DOT com>
# Contributor: Caleb Maclennan <caleb AT alerque DOT com>
# Contributor: Ian MacKay <immackay0 AT gmail DOT com>
# Contributor: Mikel Pintado <mikelaitornube2010 AT gmail DOT com>
# Contributor: Igor Petrov
# Contributor: Jiawen Geng

_pkgname='desktop-plus'
pkgname="${_pkgname}-git"
pkgver=0
pkgrel=1
pkgdesc="GitHub Desktop fork with extra features and improvements (git version)."
arch=('x86_64' 'aarch64')
url="https://github.com/desktop-plus/desktop-plus"
license=('MIT')
provides=(${_pkgname})
conflicts=(${_pkgname})
depends=(curl
         git
         gtk3
         libnotify
         libsecret
         libxss
         nspr
         nss
         org.freedesktop.secrets
         unzip)
optdepends=('github-cli: CLI interface for GitHub'
            'hub: CLI interface for GitHub')
makedepends=(python-setuptools
             'nodejs-lts-[[NODE_CODENAME]]'
             npm
             util-linux
             xorg-server-xvfb
             yarn)
source=("$pkgname::git+https://github.com/desktop-plus/desktop-plus.git"
        'git+https://github.com/github/gemoji.git'
        'git+https://github.com/github/gitignore.git'
        'git+https://github.com/github/choosealicense.com.git'
        'launch-app.sh'
        "${_pkgname}.desktop")
sha256sums=('SKIP'
            'SKIP'
            'SKIP'
            'SKIP'
            '[[LAUNCH_SCRIPT_SHA256]]'
            '[[DESKTOP_FILE_SHA256]]')

pkgver() {
    cd "$srcdir/$pkgname"
    echo "$(date +%Y%m%d).$(git rev-parse --short HEAD)"
}

_deobfuscate() {
    echo "$1" | rev | tr -d '@'
}

prepare() {
    cd "$pkgname"
    git submodule init
    git config submodule."gemoji".url "$srcdir/gemoji"
    git config submodule."app/static/common/gitignore".url "$srcdir/gitignore"
    git config submodule."app/static/common/choosealicense.com".url "$srcdir/choosealicense.com"
    git -c protocol.file.allow=always submodule update
    # https://github.com/shiftkey/desktop/issues/809#issuecomment-1348815685
    sed -e '/compile:prod/s/4096/4096 --openssl-legacy-provider/' -i package.json
}

build() {
    export APP_VERSION="$(pkgver)"
    cd "$pkgname"
    # https://github.com/nodejs/node/issues/48444
    export UV_USE_IO_URING=0
    xvfb-run yarn install

    # These can be extracted trivially from the app, so there is no point in trying to hide them.
    # Obfuscate them slightly in the PKGBUILD to prevent bots from easily scraping them.    
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_BITBUCKET_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_BITBUCKET]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_BITBUCKET_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_BITBUCKET]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_GITLAB_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_GITLAB]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_GITLAB_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_GITLAB]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_CODEBERG_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_CODEBERG]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_CODEBERG_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_CODEBERG]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_GITEA_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_ID_GITEA]]")"
    export "$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_GITEA_NAME]]")"="$(_deobfuscate "[[DESKTOP_OAUTH_CLIENT_SECRET_GITEA]]")"
    xvfb-run yarn build:prod
}

package() {
    INSTALL_DIR="$pkgdir/opt/${_pkgname}"

    cd "$pkgname"
    install -d "$INSTALL_DIR"
    case "$CARCH" in
        x86_64) suffix="x64" ;;
        aarch64) suffix="arm64" ;;
        *) echo "Unsupported architecture: $CARCH"; exit 1 ;;
    esac
    cp -r --preserve=mode "dist/desktop-plus-linux-$suffix/"* "$INSTALL_DIR/"

    cd "$INSTALL_DIR/resources/app/static/logos"
    # Icon is named "gh-desktop-plus" rather than "desktop-plus" to avoid the freedesktop dash-stripping fallback
    # ('desktop' exists in many icon themes, so that icon would be used instead of ours).
    install -Dm0644 "1024x1024.png" "$pkgdir/usr/share/icons/hicolor/1024x1024/apps/gh-desktop-plus.png"
    install -Dm0644 "512x512.png" "$pkgdir/usr/share/icons/hicolor/512x512/apps/gh-desktop-plus.png"
    install -Dm0644 "256x256.png" "$pkgdir/usr/share/icons/hicolor/256x256/apps/gh-desktop-plus.png"

    install -Dm755 "$srcdir/launch-app.sh" "$pkgdir/usr/bin/${_pkgname}"

    chmod +x "$INSTALL_DIR/resources/app/static/desktop-plus-cli"
    ln -s "/opt/${_pkgname}/resources/app/static/desktop-plus-cli" "$pkgdir/usr/bin/desktop-plus-cli"

    install -Dm0644 "$srcdir/${_pkgname}.desktop" "$pkgdir/usr/share/applications/${_pkgname}.desktop"
}
