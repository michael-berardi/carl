#!/bin/sh
# Carl installer for macOS and Linux:  curl -fsSL https://github.com/michael-berardi/carl/releases/latest/download/install.sh | sh
# Downloads the latest release (a ~0.5 MB source bundle), checks its SHA-256, installs its dependencies, and puts `carl` on
# your PATH. Uses the Node 22.19+ already on this machine, or fetches the official Node into Carl's own folder (nothing global).
# Layout (the same one `carl update` maintains):  $CARL_HOME/app/current -> release-<version>-<commit12>/
# Environment: CARL_HOME (default ~/.carl), CARL_BIN_DIR (default ~/.local/bin), CARL_VERSION (default: latest, e.g. 0.12.2),
# CARL_RELEASE_BASE (override the download base URL, used by tests).
set -eu

REPO="michael-berardi/carl"
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=19
HOME_DIR="${CARL_HOME:-$HOME/.carl}"
APP="$HOME_DIR/app"
BIN_DIR="${CARL_BIN_DIR:-$HOME/.local/bin}"
if [ -n "${CARL_RELEASE_BASE:-}" ]; then BASE="$CARL_RELEASE_BASE"
elif [ -n "${CARL_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${CARL_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'carl install: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1" || die "download failed: $1"; }
else die "needs curl or wget"; fi
command -v tar >/dev/null 2>&1 || die "needs tar"

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "needs sha256sum or shasum"; fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/carl-install.XXXXXX") || die "cannot create a temporary folder"
trap 'rm -rf "$TMP"' EXIT INT TERM

# expect <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name> in the sums file.
expect() {
  want=$(awk -v n="$2" '{ f=$2; sub(/^\*/, "", f); if (f == n) print $1 }' "$3")
  [ -n "$want" ] || die "no checksum for $2 in $(basename "$3")"
  [ "$(sha256 "$1")" = "$want" ] || die "checksum mismatch for $2; nothing was installed"
}

node_ok() { # node_ok <node-binary>
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

say "Downloading Carl..."
fetch "$BASE/carl.tar.gz" "$TMP/carl.tar.gz"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
expect "$TMP/carl.tar.gz" carl.tar.gz "$TMP/SHA256SUMS"
mkdir "$TMP/src"
tar -xzf "$TMP/carl.tar.gz" -C "$TMP/src" || die "cannot unpack the download"
[ -f "$TMP/src/package.json" ] && [ -f "$TMP/src/COMMIT" ] || die "the download is not a Carl release"
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/src/package.json" | head -n 1)
COMMIT=$(tr -d '[:space:]' < "$TMP/src/COMMIT")
[ -n "$VERSION" ] || die "cannot read the release version"
case "$COMMIT" in *[!0-9a-f]*|"") die "bad COMMIT in the release" ;; esac
REL="$APP/release-$VERSION-$(printf '%s' "$COMMIT" | cut -c1-12)"

# Node: the one on PATH when it is new enough, else the official build, kept inside Carl's own folder.
NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN=$(command -v node)
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported system $(uname -s); on Windows use install.ps1" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  say "Node 22.19 or newer not found; fetching the official Node 22 LTS for $os-$arch..."
  nbase="https://nodejs.org/dist/latest-v22.x"
  fetch "$nbase/SHASUMS256.txt" "$TMP/NODESUMS"
  nname=$(awk -v s="-$os-$arch.tar.gz" 'index($2, s) { print $2 }' "$TMP/NODESUMS" | head -n 1)
  [ -n "$nname" ] || die "no official Node build for $os-$arch"
  fetch "$nbase/$nname" "$TMP/$nname"
  expect "$TMP/$nname" "$nname" "$TMP/NODESUMS"
  nver=${nname#node-}; nver=${nver%%-*}
  mkdir -p "$APP/runtime"
  NODE_DIR="$APP/runtime/node-$nver-$os-$arch"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    rm -rf "$NODE_DIR.tmp"; mkdir "$NODE_DIR.tmp"
    tar -xzf "$TMP/$nname" -C "$NODE_DIR.tmp" --strip-components=1 || die "cannot unpack Node"
    rm -rf "$NODE_DIR"; mv "$NODE_DIR.tmp" "$NODE_DIR"
  fi
  NODE_BIN="$NODE_DIR/bin/node"
  node_ok "$NODE_BIN" || die "the downloaded Node does not run on this machine"
fi

mkdir -p "$APP" "$BIN_DIR"
chmod 700 "$HOME_DIR" 2>/dev/null || true
OLD=$(readlink "$APP/current" 2>/dev/null || true)
if [ ! -d "$REL" ]; then
  say "Installing Carl $VERSION..."
  rm -rf "$REL.tmp"; mv "$TMP/src" "$REL.tmp"
  # Only a Node we fetched is linked into the release; a system Node is found on PATH, like a git install.
  case "$NODE_BIN" in "$APP"/runtime/*) ln -s "$NODE_BIN" "$REL.tmp/node" ;; esac
  PATH="$(dirname "$NODE_BIN"):$PATH"; export PATH
  NPM="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM" ] || NPM=npm
  ( cd "$REL.tmp" && npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) || { rm -rf "$REL.tmp"; die "dependencies did not install; nothing was changed"; }
  got=$("$REL.tmp/bin/carl" --version 2>&1) || { rm -rf "$REL.tmp"; die "the new copy does not start: $got"; }
  case "$got" in "$VERSION"*) ;; *) rm -rf "$REL.tmp"; die "the new copy reports '$got', not $VERSION; nothing was changed" ;; esac
  mv "$REL.tmp" "$REL"
else
  say "Carl $VERSION is already unpacked; relinking."
fi

# Atomic link swap: rename a fresh link over the old one (GNU mv -T, BSD/macOS mv -h; never into the directory it points at).
swap_link() { # swap_link <target> <link>
  ln -s "$1" "$2.tmp.$$"
  if mv -fT "$2.tmp.$$" "$2" 2>/dev/null || mv -fh "$2.tmp.$$" "$2" 2>/dev/null; then return 0; fi
  rm -f "$2" && mv "$2.tmp.$$" "$2" || { rm -f "$2.tmp.$$"; die "cannot update the link $2"; }
}
swap_link "$REL" "$APP/current"
# The one previous release stays for `carl update --rollback`.
if [ -n "$OLD" ] && [ "$OLD" != "$REL" ]; then swap_link "$OLD" "$APP/current.previous"; fi
for d in "$APP"/release-*; do # keep only what a link uses
  [ -d "$d" ] || continue
  [ "$d" = "$REL" ] || [ "$d" = "$OLD" ] || rm -rf "$d"
done

# `carl` on PATH: a wrapper, so the running copy always knows it came through <app>/current (self-update relies on it).
cat > "$BIN_DIR/carl.tmp.$$" <<WRAP
#!/bin/sh
exec "$APP/current/bin/carl" "\$@"
WRAP
chmod 755 "$BIN_DIR/carl.tmp.$$"; mv -f "$BIN_DIR/carl.tmp.$$" "$BIN_DIR/carl"

say "Carl $VERSION installed ($BIN_DIR/carl)."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
say "Next: carl setup"
