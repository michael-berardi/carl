#!/bin/sh
# Builds the download assets for the current commit into <out> (default dist/release):
#   carl.tar.gz   the source bundle (git archive of HEAD plus a COMMIT file), unpacked and installed by install.sh and `carl update`
#   install.sh, install.ps1   the installers
#   SHA256SUMS    checksums of the three files above
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag)
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist/release}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
commit=$(git rev-parse HEAD)
rm -rf "$OUT"; mkdir -p "$OUT"
stage=$(mktemp -d "${TMPDIR:-/tmp}/carl-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
git archive --format=tar HEAD | tar -x -C "$stage"
rm -rf "$stage/test" "$stage/.gitleaksignore"
printf '%s\n' "$commit" > "$stage/COMMIT"
# Deterministic: sorted names, fixed owner and times.
( cd "$stage" && find . -mindepth 1 | LC_ALL=C sort | sed 's|^\./||' > "$stage.list" )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -czf "$OUT/carl.tar.gz" -T "$stage.list"
else
  COPYFILE_DISABLE=1 tar -C "$stage" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -czf "$OUT/carl.tar.gz" -T "$stage.list"
fi
rm -f "$stage.list"
cp scripts/install.sh scripts/install.ps1 "$OUT/"
( cd "$OUT" && { command -v sha256sum >/dev/null 2>&1 && sha256sum carl.tar.gz install.sh install.ps1 || shasum -a 256 carl.tar.gz install.sh install.ps1; } > SHA256SUMS )
echo "built $OUT for $commit"; ls -l "$OUT"
