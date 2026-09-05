#!/usr/bin/env bash
# Store and read the updater signing key's password in the macOS Keychain.
#
# The Windows box keeps this password in ~/.tauri/mycmux-updater.pass, sealed
# with DPAPI. DPAPI is Windows-only, so a Mac cannot read that file at all --
# which is why builds here have had to skip updater artifacts entirely, leaving
# "Check for updates" dead on macOS.
#
# The Keychain is the same kind of thing DPAPI is: an OS-managed store, tied to
# the login, that never puts the secret on disk in the clear. So the two
# machines use their own platform's vault and neither one holds a plaintext
# password.
#
# The key file itself is copied across as-is. It is already encrypted with this
# password, so it is not a secret on its own -- but it is still the signing key,
# so move it the way you would move any credential, not over chat.
#
# Usage:
#   ./scripts/mac-signing-key.sh set      # prompts, verifies against the key, stores
#   ./scripts/mac-signing-key.sh get      # prints the password (for scripts)
#   ./scripts/mac-signing-key.sh check    # reports what is present, without printing it
#   ./scripts/mac-signing-key.sh remove   # deletes it from the Keychain

set -euo pipefail

SERVICE="mycmux-updater-key"
ACCOUNT="${USER}"
KEY_PATH="${TAURI_SIGNING_KEY_PATH:-$HOME/.tauri/mycmux-updater.key}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

die() { echo "$*" >&2; exit 1; }

read_password() {
  security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null
}

case "${1:-}" in
  set)
    [[ -f "$KEY_PATH" ]] || die "signing key not found at $KEY_PATH
Copy mycmux-updater.key over from the Windows machine first (~/.tauri/ on both)."

    printf 'Password for %s: ' "$KEY_PATH" >&2
    read -r -s password
    echo >&2
    [[ -n "$password" ]] || die "no password entered"

    # Verify before storing. A password that does not match the key would be
    # stored happily and then fail at release time, which is the worst place to
    # find out -- so sign a throwaway file with it here.
    probe=$(mktemp)
    echo "mycmux signing probe" > "$probe"
    cleanup() {
      [[ -f "$probe" ]] && rm "$probe"
      [[ -f "$probe.sig" ]] && rm "$probe.sig"
      return 0
    }
    trap cleanup EXIT

    if ! (cd "$REPO_ROOT" && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$password" \
          npx tauri signer sign -f "$KEY_PATH" "$probe" >/dev/null 2>&1); then
      die "that password does not match $KEY_PATH -- nothing was stored"
    fi

    security add-generic-password -a "$ACCOUNT" -s "$SERVICE" -w "$password" -U
    echo "Stored in the Keychain (service: $SERVICE)."
    ;;

  get)
    password=$(read_password) || die "no password in the Keychain -- run: $0 set"
    printf '%s' "$password"
    ;;

  check)
    if [[ -f "$KEY_PATH" ]]; then
      echo "key:      $KEY_PATH"
    else
      echo "key:      MISSING ($KEY_PATH)"
    fi
    if read_password >/dev/null 2>&1; then
      echo "password: in the Keychain (service: $SERVICE)"
    else
      echo "password: MISSING -- run: $0 set"
    fi
    ;;

  remove)
    security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 \
      && echo "Removed from the Keychain." \
      || echo "Nothing to remove."
    ;;

  *)
    echo "usage: $0 {set|get|check|remove}" >&2
    exit 2
    ;;
esac
