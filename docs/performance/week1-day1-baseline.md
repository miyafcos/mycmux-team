# Week 1 Day 1 Performance Baseline

Repo: `C:\Users\miyaz\cmux-for-linux-dev`

App:
- Product: `mycmux-lite`
- Tauri identifier: `com.miyazaki.mycmux-lite`
- Installed exe: `C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe`
- Data file: `C:\Users\miyaz\AppData\Roaming\com.miyazaki.mycmux-lite\data.json`

## Measure

Idle CPU and memory baseline:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\measure-mycmux.ps1" -RepoRoot "C:\Users\miyaz\cmux-for-linux-dev" -ExecutablePath "C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe" -SampleSeconds 10 -OutputPath "C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\results\week1-day1-before-mycmux-lite-idle.json"
```

Ctrl+P and scroll proxy baseline:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\measure-mycmux.ps1" -RepoRoot "C:\Users\miyaz\cmux-for-linux-dev" -ExecutablePath "C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe" -UiProbe -ScrollProbe -OutputPath "C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\results\week1-day1-before-mycmux-lite-ui.json"
```

When multiple instances are running, pass `-Pid <PID>` instead of relying on process-name lookup.

## Behavior Contracts

```powershell
python "C:\Users\miyaz\cmux-for-linux-dev\tests\perf\test_week1_day1_behavior_contracts.py"
```

The contract test fixes:
- launcher option and command order.
- Ctrl+P route to CRSM/history palette.
- resume and handoff `MYCMUX_*` environment contract.
- `data.json` storage under the Tauri app data directory.
- Worksets absence in runtime sources.

## Current Recorded Before Values

Saved result:
- `C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\results\week1-day1-before-mycmux-lite-idle.json`
- `C:\Users\miyaz\cmux-for-linux-dev\scripts\perf\results\week1-day1-before-mycmux-lite-ui.json`

Recorded on 2026-05-02:
- PID: `48344`
- Path: `C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe`
- SHA256: `582CE3F48F6FB263065CB4048CEFF1801298CC505B5A093E45179A5E8E66343C`
- idle CPU 10s delta: `0.078125s`
- idle CPU one-core percent: `0.781%`
- WorkingSet delta: `0 bytes`
- Ctrl+P cold proxy elapsed: `1221.261 ms`
- Ctrl+P cold CPU delta: `0.015625s`
- Ctrl+P warm proxy elapsed: `1122.138 ms`
- Ctrl+P warm CPU delta: `0.000000s`
- scroll CPU duration: `10.085s`
- scroll CPU delta: `0.171875s`
- scroll CPU one-core percent: `1.704%`
- scroll keypresses: `32`

Notes:
- The script measures the root app process. The release-manager baseline also records WebView2 and full process-tree CPU separately.
- Ctrl+P UI probe uses SendKeys and a fixed settle window, so treat it as a proxy until a DOM-level timing hook exists.
