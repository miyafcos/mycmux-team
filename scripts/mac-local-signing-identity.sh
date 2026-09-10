#!/usr/bin/env bash
# A local code-signing identity for macOS builds, and the signing step itself.
#
# This is about TCC, not Gatekeeper. A self-signed leaf never satisfies
# Gatekeeper and this script does not pretend otherwise; what it buys is a
# stable signature.
#
# Tauri's --no-sign leaves the ad-hoc, linker-generated signature the toolchain
# produces by default. That signature carries no certificate, so macOS has
# nothing durable to identify the app by and records the raw cdhash of the exact
# binary it prompted for. Every rebuild changes that hash and silently
# invalidates every privacy grant. Measured on the Mac on 2026-09-10: the TCC
# rows for com.miyazaki.mycmux held a requirement of
# `cdhash H"aca9b6.." or cdhash H"f940f4.."`, neither of which matched the
# installed build -- which is why Desktop, Documents, Downloads and network
# volumes were re-requested after each update, and why grants also lapsed
# mid-session as child processes touched protected directories.
#
# Signing with a real leaf, even an untrusted self-signed one, makes TCC store a
# certificate-based requirement instead:
#   designated => identifier "com.miyazaki.mycmux" and certificate root = H"..."
# That holds across rebuilds, so a grant is given once and kept.
#
# The identity lives in its own keychain rather than the login one: an SSH
# session cannot unlock the login keychain (security reports "User interaction
# is not allowed"), and a dedicated keychain can be unlocked non-interactively
# from a release script.
#
# Usage:
#   mac-local-signing-identity.sh ensure        create the identity if absent
#   mac-local-signing-identity.sh sign <path>   sign a bundle with it
#   mac-local-signing-identity.sh status        report what exists
set -euo pipefail

CN="mycmux Local Signing"
KC_NAME="mycmux-signing.keychain"
KC_PATH="$HOME/Library/Keychains/${KC_NAME}-db"
PASS_FILE="$HOME/.tauri/mycmux-signing-keychain.pass"

have_identity() {
  security find-identity -p codesigning "$KC_NAME" 2>/dev/null | grep -q "$CN"
}

unlock_keychain() {
  [[ -f "$PASS_FILE" ]] || return 1
  security unlock-keychain -p "$(cat "$PASS_FILE")" "$KC_NAME" 2>/dev/null
}

create_identity() {
  local work
  work=$(mktemp -d)
  trap 'rm -rf "$work"' RETURN

  mkdir -p "$HOME/.tauri"
  local kc_pass
  if [[ -f "$PASS_FILE" ]]; then
    kc_pass=$(cat "$PASS_FILE")
  else
    # `tr -dc < /dev/urandom | head -c` dies on SIGPIPE under `set -o pipefail`.
    kc_pass=$(openssl rand -hex 24)
    (umask 077; printf '%s' "$kc_pass" > "$PASS_FILE")
  fi

  cat > "$work/ext.cnf" << 'CNF'
[ req ]
distinguished_name = dn
prompt = no
[ dn ]
CN = mycmux Local Signing
O  = Edu Planning
[ v3 ]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF

  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$work/key.pem" -out "$work/cert.pem" \
    -config "$work/ext.cnf" -extensions v3 2>/dev/null
  openssl pkcs12 -export -legacy -out "$work/bundle.p12" \
    -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$CN" -passout pass:mycmux 2>/dev/null

  [[ -f "$KC_PATH" ]] || security create-keychain -p "$kc_pass" "$KC_NAME"
  # -lut with a long timeout so a build does not trip over a relocked keychain.
  security set-keychain-settings -lut 100000 "$KC_NAME"
  security unlock-keychain -p "$kc_pass" "$KC_NAME"

  # Keep the login keychain first; append ours so codesign can find the identity.
  local existing
  existing=$(security list-keychains -d user | tr -d '" ' | tr '\n' ' ')
  case "$existing" in
    *mycmux-signing*) ;;
    *) security list-keychains -d user -s $existing "$KC_NAME" ;;
  esac

  security import "$work/bundle.p12" -k "$KC_NAME" -P mycmux -A -T /usr/bin/codesign
  # Without this the private key is guarded by an ACL that prompts, and codesign
  # fails with errSecInternalComponent in a non-interactive session.
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$KC_NAME" >/dev/null 2>&1
}

cmd_ensure() {
  if have_identity; then
    echo "identity present: $CN"
    return 0
  fi
  create_identity
  if have_identity; then
    echo "identity created: $CN"
  else
    echo "failed to create the signing identity" >&2
    return 1
  fi
}

cmd_sign() {
  local target="${1:-}"
  if [[ -z "$target" || ! -e "$target" ]]; then
    echo "usage: $(basename "$0") sign <path-to-bundle>" >&2
    return 2
  fi
  cmd_ensure >/dev/null
  unlock_keychain || {
    echo "cannot unlock $KC_NAME (no password file at $PASS_FILE)" >&2
    return 1
  }
  # --keychain is required: without it codesign searches the login keychain
  # first and fails with errSecInternalComponent when that one is locked.
  codesign --force --sign "$CN" --keychain "$KC_NAME" --timestamp=none "$target"
  echo "signed: $target"
  codesign -d -r- "$target" 2>&1 | grep "^designated" || true
}

cmd_status() {
  echo "keychain:  $KC_PATH $([[ -f "$KC_PATH" ]] && echo present || echo absent)"
  echo "password:  $PASS_FILE $([[ -f "$PASS_FILE" ]] && echo present || echo absent)"
  echo -n "identity:  "
  if have_identity; then
    security find-identity -p codesigning "$KC_NAME" | grep "$CN" | sed 's/^ *//'
  else
    echo "absent"
  fi
}

case "${1:-}" in
  ensure) cmd_ensure ;;
  sign)   shift; cmd_sign "$@" ;;
  status) cmd_status ;;
  *)
    echo "usage: $(basename "$0") {ensure|sign <path>|status}" >&2
    exit 2
    ;;
esac
