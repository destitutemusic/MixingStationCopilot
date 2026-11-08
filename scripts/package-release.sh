#!/usr/bin/env bash
# Build the downloadable release zips (no models, no llama binaries).
# Usage: bash scripts/package-release.sh [target ...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="${NODE_VERSION:-v22.23.4}"
NODE_DIST="https://nodejs.org/dist/${NODE_VERSION}"
DIST="$ROOT/dist"
CACHE="$ROOT/.release-cache"
STAGE_ROOT="$DIST/.stage"
mkdir -p "$DIST" "$CACHE"

ALL_TARGETS=(win-x64 win-arm64 mac-arm64 mac-x64 linux-x64 linux-arm64)
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL_TARGETS[@]}")

# target | Node dist suffix | archive kind | node path in archive
node_archive() {
	case "$1" in
		win-x64)    echo "node-${NODE_VERSION}-win-x64.zip zip" ;;
		win-arm64)  echo "node-${NODE_VERSION}-win-arm64.zip zip" ;;
		mac-arm64)  echo "node-${NODE_VERSION}-darwin-arm64.tar.gz tar.gz" ;;
		mac-x64)    echo "node-${NODE_VERSION}-darwin-x64.tar.gz tar.gz" ;;
		linux-x64)  echo "node-${NODE_VERSION}-linux-x64.tar.gz tar.gz" ;;
		linux-arm64) echo "node-${NODE_VERSION}-linux-arm64.tar.gz tar.gz" ;;
		*) return 1 ;;
	esac
}

# One SHASUMS file for the pinned Node release, verified once.
if [ ! -f "$CACHE/SHASUMS256.txt" ]; then
	curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
fi

for target in "${TARGETS[@]}"; do
	read -r archive kind < <(node_archive "$target") || { echo "unknown target: $target" >&2; exit 1; }
	cached="$CACHE/$archive"
	if [ ! -f "$cached" ]; then
		echo "== downloading Node $NODE_VERSION for $target"
		curl -fsSL "$NODE_DIST/$archive" -o "$cached"
	fi
	expected="$(awk -v f="$archive" '$2 == f {print $1}' "$CACHE/SHASUMS256.txt")"
	[ -n "$expected" ] || { echo "no checksum for $archive" >&2; exit 1; }
	actual="$(sha256sum "$cached" | awk '{print $1}')"
	[ "$actual" = "$expected" ] || { echo "checksum mismatch for $archive" >&2; exit 1; }

	name="mixing-station-copilot-${VERSION}-${target}"
	stage="$STAGE_ROOT/$name"
	rm -rf "$stage"
	mkdir -p "$stage/runtime"

	echo "== staging $name"
	cp -R server public vendor docs "$stage/"
	cp package.json package-lock.json config.json README.md LICENSE NOTICE THIRD-PARTY.md \
		start.sh start.command start.bat "$stage/"
	cp -R node_modules "$stage/node_modules"

	tmp="$(mktemp -d)"
	case "$kind" in
		zip)    unzip -q -o "$cached" -d "$tmp" ;;
		tar.gz) tar -xzf "$cached" -C "$tmp" ;;
	esac
	base="$(basename "$archive")"
	base="${base%.zip}"; base="${base%.tar.gz}"
	if [ "$kind" = "zip" ]; then
		cp "$tmp/$base/node.exe" "$stage/runtime/node.exe"
	else
		cp "$tmp/$base/bin/node" "$stage/runtime/node"
	fi
	cp "$tmp/$base/LICENSE" "$stage/runtime/LICENSE"
	rm -rf "$tmp"

	chmod 755 "$stage/runtime/node" 2>/dev/null || true
	chmod 755 "$stage/start.sh" "$stage/start.command"
	# Never ship downloaded binaries or models inside the zip.
	rm -rf "$stage/bin" "$stage/models" "$stage/dist" "$stage/.release-cache"

	( cd "$stage" && zip -q -r -X "$DIST/$name.zip" . )
	ls -lh "$DIST/$name.zip"
	unzip -l "$DIST/$name.zip" | awk 'NR<=12 || /runtime\/|start\.|LICENSE|NOTICE|THIRD-PARTY|README|config.json/ {print}' | head -30
	echo
	rm -rf "$stage"
done

rmdir "$STAGE_ROOT" 2>/dev/null || true
echo "Zips are in $DIST (not committed, not published)."
