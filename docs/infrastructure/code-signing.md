# Code Signing Guide

ptrcode v0.1.3 ships unsigned binaries. This causes OS security warnings on macOS and Windows. This document explains the current workarounds and the path to proper signing.

---

## Current State

| Platform | Signed | Warning shown | config field |
|----------|--------|---------------|--------------|
| Linux | N/A | None | N/A |
| macOS | ❌ | "Unverified developer" (Gatekeeper) | `bundle.macOS.signingIdentity: null` |
| Windows | ❌ | "Windows protected your PC" (SmartScreen) | `bundle.windows.certificateThumbprint: null` |

---

## User Workarounds (until signing is configured)

### macOS

Option 1 — right-click menu:
1. Right-click `ptrcode.app` → **Open**
2. Click **Open** in the dialog

Option 2 — terminal (removes quarantine flag):
```bash
xattr -d com.apple.quarantine /Applications/ptrcode.app
```

### Windows

1. In the SmartScreen dialog, click **More info**
2. Click **Run anyway**

---

## Signing Setup (when ready)

### macOS

**Requires**: Apple Developer account ($99/yr at developer.apple.com)

Steps:
1. Enroll in Apple Developer Program
2. Create a **Developer ID Application** certificate in Xcode / Certificates portal
3. Install the certificate in Keychain
4. Set in `src-tauri/tauri.conf.json`:
   ```json
   "macOS": {
     "signingIdentity": "Developer ID Application: Your Name (XXXXXXXXXX)"
   }
   ```
5. For notarization (removes the warning entirely), set these env vars in CI:
   - `APPLE_ID` — your Apple ID email
   - `APPLE_PASSWORD` — app-specific password from appleid.apple.com
   - `APPLE_TEAM_ID` — your team ID (from developer.apple.com)
6. Tauri's build process handles notarization automatically when `signingIdentity` is set and env vars are present

**Result**: Gatekeeper will trust the app with no warning.

---

### Windows

**Option A — Authenticode cert** (traditional, ~$200–400/yr):
1. Purchase cert from DigiCert, Sectigo, or similar CA
2. Install cert locally or in CI secrets
3. Set in `src-tauri/tauri.conf.json`:
   ```json
   "windows": {
     "certificateThumbprint": "SHA1_THUMBPRINT_HERE",
     "timestampUrl": "http://timestamp.sectigo.com/"
   }
   ```

**Option B — Microsoft Trusted Signing** (newer, free tier available):
1. Create Azure account + Trusted Signing resource
2. Use `signtool.exe` in CI with the Azure credential
3. Update `tauri.conf.json` accordingly

**Result**: SmartScreen warning disappears after the app has been signed and gains reputation (usually within days of first distribution).

---

## CI/CD Integration

When signing is configured, add secrets to GitHub Actions:

```yaml
# .github/workflows/release.yml
env:
  # macOS
  APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  # Windows
  WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
  WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
```

Tauri's `tauri-action` handles the rest when these env vars and `tauri.conf.json` fields are set.

---

## References

- [Tauri code signing docs](https://tauri.app/distribute/sign/)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Microsoft Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)
