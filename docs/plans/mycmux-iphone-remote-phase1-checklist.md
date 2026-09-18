# mycmux iPhone Remote Phase 1 Checklist

Created: 2026-05-03

Scope: verify the currently installed app at `C:\Users\miyaz\mycmux-app\mycmux.exe` before changing code.

Do not rebuild for Phase 1. Use the current executable and record only PASS/FAIL, token suffix, and symptoms. Do not paste the full remote token into chat, Git, or issue text.

## Confirmed Local Facts

- Canonical repo: `C:\Users\miyaz\cmux-for-linux-dev-master`
- Installed app: `C:\Users\miyaz\mycmux-app\mycmux.exe`
- Remote port file: `C:\Users\miyaz\.mycmux\remote.port`
- Current port: `7681`
- Master remote token file: `C:\Users\miyaz\.mycmux\remote-token`
- Master remote token length: `64`
- Master remote token suffix observed during setup: `62bd`
- Lite remote token file exists separately: `C:\Users\miyaz\.mycmux-lite\remote-token`
- Important: master code reads `C:\Users\miyaz\.mycmux\remote-token`, not `C:\Users\miyaz\.mycmux-lite\remote-token`.
- Current QR URL format in code: `http://<ip>:<port>/#token=<token>`

## PC Preflight

Run these from PowerShell on the PC.

```powershell
Get-Item -LiteralPath "C:\Users\miyaz\mycmux-app\mycmux.exe" |
  Select-Object FullName,Length,LastWriteTime
```

```powershell
Get-Process -Name "mycmux" -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,Path,StartTime
```

```powershell
Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote.port" -Raw
```

```powershell
$token = (Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote-token" -Raw).Trim()
"token length=$($token.Length) suffix=$($token.Substring($token.Length - 4))"
```

```powershell
Get-NetTCPConnection -LocalPort 7681 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

If `OwningProcess` is present, confirm it is mycmux.

```powershell
$owningProcessId = (Get-NetTCPConnection -LocalPort 7681 -State Listen).OwningProcess | Select-Object -First 1
Get-Process -Id $owningProcessId | Select-Object Id,ProcessName,Path
```

Confirm the embedded client is responding locally.

```powershell
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:7681/manifest.json" |
  Select-Object StatusCode,Content
```

Confirm the authenticated dashboard API returns JSON.

```powershell
$token = (Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote-token" -Raw).Trim()
Invoke-RestMethod "http://127.0.0.1:7681/api/state?token=$token" |
  ConvertTo-Json -Depth 8
```

## Connection URL

Prefer the Tailscale IP for the iPhone test.

Expected PC Tailscale IP from the current plan: `100.103.126.82`

Use this command only locally. It prints the full tokenized URL.

```powershell
$ip = "100.103.126.82"
$port = (Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote.port" -Raw).Trim()
$token = (Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote-token" -Raw).Trim()
"http://$ip`:$port/#token=$token"
```

Notes:

- Use `#token=`, not `?token=`, for the launch URL. The client stores the token in Safari local storage and then moves to `#/dashboard`.
- `http://127.0.0.1:7681/qr` can be opened on the PC, but verify the QR resolves to `100.103.126.82`. If it shows a LAN IP such as `192.168.x.x`, do not use it for the 4G/5G test.
- Record only the token suffix, for example `62bd`.

## Phase 1 Test Matrix

### 1. iPhone Tailscale Connection

Goal: iPhone and PC are in the same tailnet and can route to `100.103.126.82`.

Steps:

1. On PC, run `tailscale status`.
2. Confirm the iPhone appears in the same tailnet, or confirm the iPhone Tailscale app shows connected.
3. On iPhone Safari, open `http://100.103.126.82:7681/manifest.json`.

Expected:

- PC and iPhone are both connected to Tailscale.
- Safari shows JSON for `manifest.json`, or downloads/displays a small manifest response.

Fail evidence:

- Tailscale status does not show iPhone.
- Safari cannot open `manifest.json`.
- Record whether the iPhone is on Wi-Fi or 4G/5G.

### 2. QR / URL Acquisition

Goal: the connection URL can be obtained without rebuilding.

Steps:

1. Generate the URL with the PowerShell command in "Connection URL".
2. Open the URL in iPhone Safari.
3. If using QR, open `http://127.0.0.1:7681/qr` on the PC and scan only if the decoded URL uses `100.103.126.82`.

Expected:

- Safari opens the mycmux Remote dashboard.
- URL token is stored, and the visible URL becomes `http://100.103.126.82:7681/#/dashboard` or equivalent.

Fail evidence:

- `No token` appears.
- HTTP 401 or Unauthorized appears.
- QR points to the wrong IP.

### 3. iPhone Safari to PWA

Goal: the remote client can be launched from the iPhone home screen.

Steps:

1. In Safari, open the tokenized URL.
2. Tap Share.
3. Tap "Add to Home Screen".
4. Launch the new `mycmux` icon from the home screen.

Expected:

- App launches full screen without Safari address bar.
- Dashboard reloads without re-entering the token.

Fail evidence:

- App opens as a normal Safari tab.
- Dashboard shows `No token` after launching from the home screen.
- xterm assets fail to load. If this happens, mark Phase 2-5 as required.

### 4. Dashboard Pane List

Goal: iPhone can see the PC workspaces and panes.

Steps:

1. On the PC mycmux app, make sure at least one terminal pane is running.
2. On iPhone, open the dashboard.
3. Tap refresh if needed.

Expected:

- Workspace card appears.
- Pane row appears.
- `Connect` button appears for the pane.
- `cwd`, branch, or process metadata appears when available.

Fail evidence:

- `No workspaces running` appears even though PC has active panes.
- `/api/state` works locally but iPhone dashboard fails.
- Record the JSON from the local authenticated `/api/state` command.

### 5. Bridge Attach, Bidirectional I/O

Goal: iPhone attaches to an existing PC pane and terminal I/O is shared.

Steps:

1. On iPhone dashboard, tap `Connect` for a running pane.
2. On the PC pane, run:

```bash
echo PC_TO_IPHONE_20260503
```

3. Confirm the same output appears on iPhone.
4. On iPhone, type:

```bash
echo IPHONE_TO_PC_20260503
```

5. Tap `Enter`.
6. Confirm the command and output appear in the PC pane.

Expected:

- PC output appears on iPhone quickly.
- iPhone input reaches the PC pane.
- Connection indicator becomes connected.

Fail evidence:

- iPhone can see scrollback but cannot send input.
- iPhone input works but PC output does not update.
- Connection drops when tapping `Connect`.

### 6. Background and Resume

Goal: iOS backgrounding does not lose the session.

Steps:

1. Stay connected to a terminal pane on iPhone.
2. Run a visible marker:

```bash
echo BEFORE_BACKGROUND_20260503
```

3. Press the iPhone side button or switch to another app for 30 seconds.
4. Return to the `mycmux` PWA.
5. Wait up to 10 seconds.
6. Run:

```bash
echo AFTER_BACKGROUND_20260503
```

Expected:

- Either the connection remains alive, or a `Reconnecting` toast appears and recovers.
- Scrollback still contains `BEFORE_BACKGROUND_20260503`.
- New input after resume works.

Fail evidence:

- Full overlay remains `Disconnected`.
- Scrollback is lost.
- Input after resume is ignored.

### 7. Wi-Fi to 4G/5G Switch

Goal: Tailscale route survives network change.

Steps:

1. Connect the iPhone PWA while on Wi-Fi.
2. Confirm terminal input/output works.
3. Disable Wi-Fi on iPhone and stay on 4G/5G.
4. Wait 10 to 30 seconds.
5. Return to the PWA and run:

```bash
echo CELLULAR_ROUTE_20260503
```

Expected:

- Connection remains usable, or reconnects automatically.
- The command reaches the PC pane.

Fail evidence:

- Safari cannot reach `100.103.126.82:7681`.
- Tailscale iPhone app shows disconnected.
- PWA reconnect loop continues beyond 60 seconds.

## Failure Log Collection

Use these commands only when a test fails.

```powershell
Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\launcher-debug.log" -Tail 200
```

```powershell
Get-NetTCPConnection -LocalPort 7681 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess
```

```powershell
$token = (Get-Content -LiteralPath "C:\Users\miyaz\.mycmux\remote-token" -Raw).Trim()
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:7681/api/state?token=$token" |
  Select-Object StatusCode,Content
```

```powershell
tailscale status
```

## Result Template

Record results in `C:\Users\miyaz\.claude\projects\C--Users-miyaz\memory\project_mycmux_remote.md`.

```markdown
## Phase 1実機検証結果 (2026-05-03)

- 対象exe: `C:\Users\miyaz\mycmux-app\mycmux.exe`
- 正本リポジトリ: `C:\Users\miyaz\cmux-for-linux-dev-master`
- commit: `bebe3aa fix(app): stabilize restore persistence and CRSM`
- remote port: `7681`
- Tailscale IP: `100.103.126.82`
- token file: `C:\Users\miyaz\.mycmux\remote-token`
- token suffix: `62bd`
- iPhone network: Wi-Fi / 4G / 5G

| # | 項目 | 結果 | メモ |
|---|------|------|------|
| 1 | iPhone Tailscale接続 | PASS/FAIL |  |
| 2 | QR/URL取得 | PASS/FAIL |  |
| 3 | Safari PWA化 | PASS/FAIL |  |
| 4 | Dashboardペイン一覧 | PASS/FAIL |  |
| 5 | bridge attach双方向 | PASS/FAIL |  |
| 6 | バックグラウンド復帰 | PASS/FAIL |  |
| 7 | 4G/5G切替 | PASS/FAIL |  |

### Phase 2へ追加する修正対象

- なし / あり:
```
