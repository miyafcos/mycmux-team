#!/usr/bin/env bash
# Build Apple Silicon release bundles locally.
#
# By default this deliberately produces an unsigned build, matching CI. A local
# developer with a keychain identity can opt in without editing tauri.conf.json:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Example" ./scripts/build-mac.sh
# Updater artifacts are produced only when TAURI_SIGNING_PRIVATE_KEY is set.
# That key is unrelated to Apple code signing -- it signs the .app.tar.gz the
# updater downloads -- and asking for it unconditionally aborts the build on any
# machine that does not hold it. This one does not: the key lives on the Windows
# box, where its password is sealed with DPAPI and cannot be read here.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

# Expanded as ${arr[@]+"${arr[@]}"} below, not as "${arr[@]}": macOS ships bash
# 3.2, where `set -u` treats an empty array expansion as an unbound variable and
# aborts. Signing therefore failed with "SIGNING_ARGS[@]: unbound variable" in
# exactly the case the array exists to serve -- an identity being present.
SIGNING_ARGS=(--no-sign)
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  SIGNING_ARGS=()
  echo "Using APPLE_SIGNING_IDENTITY from the environment."
else
  echo "APPLE_SIGNING_IDENTITY is unset; building without Apple code signing."
fi

# `--bundles app`, not `app,dmg`. Tauri's dmg bundler shells out to a vendored
# create-dmg, which drives Finder over AppleScript to place the icons. Any
# environment without permission to script Finder -- a CI runner, an SSH
# session, a terminal that has not been granted Automation access -- fails that
# step, and create-dmg turns it into `exit 64` while Tauri reports only
# "failed to run bundle_dmg.sh". The window layout it buys is cosmetic; what
# actually makes a .dmg installable is the Applications symlink, and hdiutil
# lays that down without touching Finder at all.
# Pick the signing key up from ~/.tauri and the Keychain when the caller has
# not supplied one, so a release from this machine does not need the operator to
# export anything by hand. `mac-signing-key.sh set` puts the password there once.
UPDATER_KEY_PATH="${TAURI_SIGNING_KEY_PATH:-$HOME/.tauri/mycmux-updater.key}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$UPDATER_KEY_PATH" ]]; then
  if KEY_PASSWORD=$("$SCRIPT_DIR/mac-signing-key.sh" get 2>/dev/null); then
    export TAURI_SIGNING_PRIVATE_KEY
    TAURI_SIGNING_PRIVATE_KEY=$(cat "$UPDATER_KEY_PATH")
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$KEY_PASSWORD"
    echo "Signing key loaded from $UPDATER_KEY_PATH (password from the Keychain)."
  else
    echo "Found $UPDATER_KEY_PATH but no password in the Keychain."
    echo "Run ./scripts/mac-signing-key.sh set to enable updater artifacts."
  fi
fi

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  UPDATER_ARTIFACTS=true
  echo "Building updater artifacts (.app.tar.gz and its signature)."
else
  UPDATER_ARTIFACTS=false
  echo "No signing key available; skipping updater artifacts."
fi

npm run tauri -- build \
  --target aarch64-apple-darwin \
  --bundles app \
  --config "{\"bundle\":{\"createUpdaterArtifacts\":$UPDATER_ARTIFACTS}}" \
  ${SIGNING_ARGS[@]+"${SIGNING_ARGS[@]}"}

BUNDLE_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle"
APP="$BUNDLE_DIR/macos/mycmux.app"
VERSION=$(node -p "require('./package.json').version")
DMG="$BUNDLE_DIR/dmg/mycmux_${VERSION}_aarch64.dmg"

if [[ ! -d "$APP" ]]; then
  echo "expected $APP to exist after the build" >&2
  exit 1
fi

STAGING=$(mktemp -d)
cleanup() { [[ -n "${STAGING:-}" && -d "$STAGING" ]] && rm -r "$STAGING"; }
trap cleanup EXIT

cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

mkdir -p "$(dirname "$DMG")"
hdiutil create \
  -volname "mycmux" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

echo
echo "Built:"
echo "  $APP"
echo "  $DMG"
if [[ -f "$BUNDLE_DIR/macos/mycmux.app.tar.gz" ]]; then
  echo "  $BUNDLE_DIR/macos/mycmux.app.tar.gz (updater)"
fi
