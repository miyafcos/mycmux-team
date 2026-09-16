# Week 1 Day 1 Performance Baseline

Repo: `C:\Users\miyaz\cmux-for-linux-dev-master`

App:
- Product: `mycmux`
- Tauri identifier: `com.miyazaki.mycmux`
- Installed exe: `C:\Users\miyaz\mycmux-app\mycmux.exe`
- Data file: `C:\Users\miyaz\AppData\Roaming\com.miyazaki.mycmux\data.json`

## Measure

Idle CPU and memory baseline:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\measure-mycmux.ps1" -RepoRoot "C:\Users\miyaz\cmux-for-linux-dev-master" -ExecutablePath "C:\Users\miyaz\mycmux-app\mycmux.exe" -SampleSeconds 10 -OutputPath "C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\results\week1-day1-before-mycmux-idle.json"
```

Ctrl+P and scroll proxy baseline:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\measure-mycmux.ps1" -RepoRoot "C:\Users\miyaz\cmux-for-linux-dev-master" -ExecutablePath "C:\Users\miyaz\mycmux-app\mycmux.exe" -UiProbe -ScrollProbe -OutputPath "C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\results\week1-day1-before-mycmux-ui.json"
```

When multiple instances are running, pass `-Pid <PID>` instead of relying on process-name lookup.

## Behavior Contracts

```powershell
python "C:\Users\miyaz\cmux-for-linux-dev-master\tests\perf\test_week1_day1_behavior_contracts.py"
```

The contract test fixes:
- launcher option and command order.
- Ctrl+P route to CRSM/history palette.
- resume and handoff `MYCMUX_*` environment contract.
- `data.json` storage under the Tauri app data directory.
- Worksets absence in runtime sources.

## Current Recorded Before Values

Saved result:
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\results\week1-day1-before-mycmux-idle.json`
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\results\week1-day1-before-mycmux-ui.json`

Recorded on 2026-05-02:
- PID: `48352`
- Path: `C:\Users\miyaz\mycmux-app\mycmux.exe`
- SHA256: `CA0D8C060B35FE89E97ECACAE4F230CC5FD559932588917B35D8F17ED1461019`
- idle CPU 10s delta: `0.500000s`
- idle CPU one-core percent: `4.996%`
- WorkingSet delta: `561152 bytes`
- Ctrl+P cold proxy elapsed: `1154.726 ms`
- Ctrl+P cold CPU delta: `0.062500s`
- Ctrl+P warm proxy elapsed: `1131.447 ms`
- Ctrl+P warm CPU delta: `0.156250s`
- scroll CPU duration: `10.297s`
- scroll CPU delta: `0.890625s`
- scroll CPU one-core percent: `8.650%`
- scroll keypresses: `33`

Notes:
- The script measures the root app process. The release-manager baseline also records WebView2 and full process-tree CPU separately.
- Ctrl+P UI probe uses SendKeys and a fixed settle window, so treat it as a proxy until a DOM-level timing hook exists.
