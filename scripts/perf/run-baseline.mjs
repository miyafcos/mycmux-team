// One-command CDP benchmark for the isolated Windows release build.
// Run: node scripts/perf/run-baseline.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? resolve(process.argv[index + 1]) : fallback;
};
const exe = option('--exe', join(repo, 'src-tauri', 'target', 'release', 'mycmux.exe'));
const fixtures = join(repo, 'scripts', 'perf', 'fixtures');
const resultsDir = option('--output-dir', join(process.env.USERPROFILE ?? repo, '_work', 'mycmux-perf-260924'));
const outputPath = join(resultsDir, 'baseline-260924.json');
const quote = (value) => JSON.stringify(value);
const now = () => Date.now();
const sleep = (ms) => delay(ms);

function summary(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median: null, p90: null, max: null };
  const percentile = (p) => {
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position);
    return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
  };
  return { count: sorted.length, median: percentile(0.5), p90: percentile(0.9), max: sorted.at(-1) };
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  executable: exe,
  fixtureKind: 'synthetic HTML with an embedded base64 SVG for the heavy case',
  measurements: {},
  errors: [],
  methods: {
    H1: 'CDP mouse activation to frontend artifact.link.click; Rust webpane.child.created, webpane.load.finished and webpane.child.shown; child CDP rAF is the visible-frame upper bound',
    H2: 'frontend pane.select.click to Rust webpane.update.shown and child CDP two-rAF screenshot completion',
    H3: 'main WebView requestAnimationFrame intervals while a heavy preview opens and the shell emits output',
    H4: '30 second mycmux.exe and identified main WebView2 renderer CPU deltas; CDP Performance.TaskDuration is retained as a fallback; stream variants send three echo lines to the existing shell once per second',
    D1: 'CDP pointer release outside the main window to Rust window.child.built, frontend window.visible, workspace.first.frame and terminal.input.painted',
    D2: 'CDP emits the same detached-dock-request event as the native drag detector; request to main frame and child disappearance; native window drag cannot be sustained by CDP mouse events',
    D3: '240 target CDP mouse moves over about two seconds, with actual move frequency and main-window rAF gaps recorded',
    A1: 'Win32_Process CreationDate to frontend window.visible and workspace.first.frame, using test-profile.ps1 -CloneData',
    A2: 'frontend workspace.switch.click to workspace.switch.painted',
    A3: 'frontend terminal.keydown to terminal.input.painted',
    A4: 'scripts/perf/measure-mycmux.ps1 against the isolated process',
  },
};
if ((process.argv.includes('--resume') || process.argv.includes('--probe-h2')
    || process.argv.includes('--probe-d1') || process.argv.includes('--probe-renderer-pid')
    || process.argv.includes('--validate-only')) && existsSync(outputPath)) {
  const previous = JSON.parse(readFileSync(outputPath, 'utf8'));
  Object.assign(report, previous);
  if (process.argv.includes('--resume')) report.resumedAt = new Date().toISOString();
}

const complete = (name, count) => (report.measurements[name]?.samples.length ?? 0) >= count;
function missingMeasurements() {
  const required = {
    A1_startup: 5, A2_workspace_switch: 10, A3_input: 10, A4_idle_cpu_memory: 10,
    H1_small_cold: 1, H1_small_warm: 10,
    H1_medium_cold: 1, H1_medium_warm: 10,
    H1_heavy_cold: 1, H1_heavy_warm: 10,
    H1_small_changed_reopen: 10,
    H2_return_to_html: 10, H3_main_frame_gaps: 10,
    H4_idle_0_webviews: 10, H4_idle_1_webviews: 10, H4_idle_3_webviews: 10,
    H4_stream_1_webviews: 10, H4_stream_3_webviews: 10,
    D1_terminal_detach: 10, D2_return: 10, D3_drag_frames: 10,
    D_html_detach_once: 1, D_web_detach_once: 1,
  };
  return Object.entries(required).filter(([name, count]) => !complete(name, count))
    .map(([name, count]) => ({ name, expected: count,
      observed: report.measurements[name]?.samples.length ?? 0 }));
}
let backupCreated = false;

function save() {
  mkdirSync(resultsDir, { recursive: true });
  if (!backupCreated && existsSync(outputPath)) {
    copyFileSync(outputPath, join(resultsDir, `baseline-260924.backup-${Date.now()}.json`));
    backupCreated = true;
  }
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

function add(name, sample) {
  const item = report.measurements[name] ??= { samples: [], stats: {} };
  delete item.unmeasuredReason;
  item.samples.push(sample);
  const numeric = new Set(item.samples.flatMap((row) =>
    Object.entries(row).filter(([, value]) => typeof value === 'number').map(([key]) => key)));
  for (const key of numeric) item.stats[key] = summary(item.samples.map((row) => row[key]));
  save();
}

function failed(name, error) {
  const reason = error instanceof Error ? error.message : String(error);
  report.errors.push({ name, reason, at: new Date().toISOString() });
  const item = report.measurements[name] ??= { samples: [], stats: {} };
  item.unmeasuredReason = reason;
  save();
  process.stderr.write(`${name}: ${reason}\n`);
}

function ps(script, timeout = 60_000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: repo, timeout, encoding: 'utf8', windowsHide: true,
  }).trim();
}

function processRows() {
  const result = ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'mycmux.exe' -or $_.Name -eq 'msedgewebview2.exe' } | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{Name='CreationDateUtc';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Depth 3");
  if (!result) return [];
  const value = JSON.parse(result);
  return Array.isArray(value) ? value : [value];
}

function testProcess(profile) {
  return processRows().find((row) => row.Name === 'mycmux.exe'
    && row.ExecutablePath?.toLowerCase() === exe.toLowerCase()
    && row.CommandLine?.includes(`--profile ${profile}`));
}

function rendererPids(profile) {
  return processRows().filter((row) => row.Name === 'msedgewebview2.exe'
    && row.CommandLine?.includes(`EBWebView-${profile}`)
    && row.CommandLine?.includes('--type=renderer')).map((row) => row.ProcessId);
}

function cpuSeconds(pid) {
  const value = ps(`[string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:R}', (Get-Process -Id ${pid} -ErrorAction Stop).CPU)`);
  return Number(value);
}

function optionalCpuSeconds(pid) {
  try { return pid ? cpuSeconds(pid) : null; }
  catch { return null; }
}

async function socketCall(profile, cmd, args = {}) {
  const runtime = join(process.env.USERPROFILE, `.mycmux-${profile}`);
  const port = Number(readFileSync(join(runtime, 'mycmux.port'), 'utf8').trim());
  const token = readFileSync(join(runtime, 'mycmux.token'), 'utf8').trim();
  return new Promise((resolveCall, rejectCall) => {
    const conn = createConnection({ host: '127.0.0.1', port });
    let data = '';
    conn.setTimeout(10_000);
    conn.once('connect', () => conn.write(JSON.stringify({ cmd, args, token }) + '\n'));
    conn.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      conn.end();
      try {
        const reply = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (reply.error) rejectCall(new Error(`${cmd}: ${reply.error}`));
        else resolveCall(reply.result);
      } catch (error) { rejectCall(error); }
    });
    conn.once('timeout', () => { conn.destroy(); rejectCall(new Error(`${cmd} socket timeout`)); });
    conn.once('error', rejectCall);
  });
}

async function freePort() {
  for (let port = 9240; port < 9250; port++) {
    const free = await new Promise((resolvePort) => {
      const server = createServer();
      server.once('error', () => resolvePort(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
    });
    if (free) return port;
  }
  throw new Error('No unused CDP port in the 9240 range');
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return (await response.json()).filter((target) => target.type === 'page');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const slot = this.pending.get(message.id);
        if (!slot) return;
        this.pending.delete(message.id);
        if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
        else slot.resolve(message.result ?? {});
      } else if (message.method) {
        const waiters = this.events.get(message.method) ?? [];
        this.events.delete(message.method);
        for (const waiter of waiters) waiter(message.params ?? {});
      }
    });
  }

  static async connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }

  call(method, params = {}, timeout = 30_000) {
    const id = ++this.nextId;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`CDP ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolveCall(result); },
        reject: (error) => { clearTimeout(timer); rejectCall(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  event(method, timeout = 30_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => rejectEvent(new Error(`CDP event ${method} timed out`)), timeout);
      const existing = this.events.get(method) ?? [];
      existing.push((value) => { clearTimeout(timer); resolveEvent(value); });
      this.events.set(method, existing);
    });
  }

  async eval(expression, timeout = 30_000) {
    const result = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, timeout);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async invoke(name, args = {}) {
    return this.eval(`window.__TAURI_INTERNALS__.invoke(${quote(name)}, ${quote(args)})`);
  }

  close() { this.ws.close(); }
}

async function waitUntil(action, timeoutMs, label) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`${label} did not arrive in ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}`);
}

function nativeWindowBounds(pid, width, height) {
  const native = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class PerfWindow {',
    ' [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }',
    ' [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);',
    ' [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);',
    '}',
  ].join(' ');
  const script = `Add-Type -TypeDefinition '${native}'; $handle=(Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle; if ($handle -eq [IntPtr]::Zero) { exit 0 }; $rect=New-Object PerfWindow+Rect; if (-not [PerfWindow]::GetWindowRect($handle,[ref]$rect)) { exit 0 }; ${width ? `[PerfWindow]::MoveWindow($handle,$rect.Left,$rect.Top,${width},${height},$true) | Out-Null;` : ''} @{left=$rect.Left;top=$rect.Top;width=($rect.Right-$rect.Left);height=($rect.Bottom-$rect.Top)} | ConvertTo-Json -Compress`;
  const result = ps(script);
  return result ? JSON.parse(result) : null;
}

async function launch(profile, { clone = false } = {}) {
  if (testProcess(profile)) throw new Error(`Isolated profile is already running: ${profile}`);
  const port = await freePort();
  const dataFolder = join(process.env.LOCALAPPDATA, 'com.miyazaki.mycmux', `EBWebView-${profile}`);
  mkdirSync(dataFolder, { recursive: true });
  const env = { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: dataFolder,
  };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('CLAUDE')) delete env[key];
  const args = ['-NoProfile', '-File',
    join(repo, 'scripts', 'test-profile.ps1'), '-Name', profile, '-ExePath', exe];
  if (clone) args.push('-CloneData');
  const launchedAt = now();
  let launchLog = '';
  await new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn('powershell.exe', args, { cwd: repo, env, windowsHide: true });
    let stderr = '';
    child.stdout.on('data', (chunk) => { launchLog += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectLaunch);
    child.once('exit', (code) => code === 0 ? resolveLaunch() : rejectLaunch(new Error(stderr || `test-profile exited ${code}`)));
  });
  let cdp;
  try {
    const target = await waitUntil(async () => (await targets(port))[0], 45_000, 'main CDP target');
    cdp = await CDP.connect(target);
    cdp.profile = profile;
    const row = await waitUntil(() => testProcess(profile), 10_000, 'test process');
    let bounds;
    try {
      const windowInfo = await cdp.call('Browser.getWindowForTarget', { targetId: target.id });
      bounds = (await cdp.call('Browser.getWindowBounds', { windowId: windowInfo.windowId })).bounds;
      if ((bounds.width ?? 0) < 1440 || (bounds.height ?? 0) < 900) {
        await cdp.call('Browser.setWindowBounds', {
          windowId: windowInfo.windowId,
          bounds: { windowState: 'normal', width: 1440, height: 900 },
        });
      }
    } catch (error) {
      bounds = await waitUntil(() => nativeWindowBounds(row.ProcessId), 10_000, 'test window bounds');
      if (bounds.width < 1440 || bounds.height < 900) nativeWindowBounds(row.ProcessId, 1440, 900);
      report.windowBoundsFallback = String(error);
      save();
    }
    return { profile, port, cdp, pid: row.ProcessId, createdAt: new Date(row.CreationDateUtc).getTime(), launchedAt, originalBounds: bounds, launchLog };
  } catch (error) {
    cdp?.close();
    const row = testProcess(profile);
    if (row) ps(`Stop-Process -Id ${row.ProcessId} -ErrorAction Stop`);
    throw error;
  }
}

async function closeTest(test) {
  test.cdp.close();
  const row = testProcess(test.profile);
  if (!row || row.ProcessId !== test.pid) return;
  ps(`Stop-Process -Id ${test.pid} -ErrorAction Stop`);
  await waitUntil(() => !testProcess(test.profile), 15_000, 'test process exit');
}

async function marks(cdp) {
  const [frontend, rust] = await Promise.all([
    cdp.eval('window.__MYCMUX_PERF__?.read() ?? []'),
    cdp.invoke('perf_timeline_read'),
  ]);
  return [...frontend, ...rust].sort((a, b) => a.atMs - b.atMs);
}

async function markAfter(cdp, name, after, id, timeout = 30_000) {
  return waitUntil(async () => (await marks(cdp)).find((mark) => mark.name === name
    && mark.atMs >= after && (id === undefined || mark.id === id)), timeout, name);
}

async function point(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const node = document.querySelector(${quote(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  if (!rect || !rect.width || !rect.height) throw new Error(`Missing visible selector: ${selector}`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, rect };
}

async function mouse(cdp, type, x, y, extra = {}) {
  return cdp.call('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

async function click(cdp, selector) {
  const { x, y } = await point(cdp, selector);
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
  await mouse(cdp, 'mouseReleased', x, y, { button: 'left', clickCount: 1 });
}

async function ensureShell(cdp) {
  const visibleSession = () => cdp.eval(`(() => {
    const screen = [...document.querySelectorAll('[data-session-id] .xterm-screen')]
      .find(node => { const rect = node.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20
          && node.closest('[data-session-id]')?.querySelector('.xterm-helper-textarea'); });
    return screen?.closest('[data-session-id]')?.dataset.sessionId ?? null;
  })()`);
  const existing = await visibleSession();
  if (!existing) {
    const panes = await socketCall(cdp.profile, 'pane.list_all').catch(() => ({ panes: [] }));
    const shell = panes.panes.flatMap((pane) => pane.tabs.map((tab) => ({ ...tab, paneId: pane.id })))
      .find((tab) => tab.type === 'terminal' || tab.agentId === 'shell-starter');
    if (shell) {
      const pill = `[data-dnd-pane-id="${shell.paneId}"] .pane-tab-pill[data-tab-id="${shell.id}"]`;
      if (await cdp.eval(`Boolean(document.querySelector(${quote(pill)}))`)) await click(cdp, pill);
      else if (shell.label) {
        await click(cdp, `[data-dnd-pane-id="${shell.paneId}"] .pane-tabbar button[aria-expanded]`);
        await click(cdp, `.pane-tab-menu-row[aria-label*="${shell.label}"]`);
      }
      await waitUntil(visibleSession, 15_000, 'existing terminal activation');
    } else {
      const state = await waitUntil(() => socketCall(cdp.profile, 'workspace.list'),
        60_000, 'isolated workspace socket');
      if (state.workspaces.length === 0) {
        const workspace = await socketCall(cdp.profile, 'workspace.new', {
          name: 'Perf shell', cwd: repo, grid: '1x1',
        });
        await socketCall(cdp.profile, 'pane.spawn', {
          workspaceId: workspace.workspaceId, target: 'shell',
          split: true, activate: true, operator: true,
        });
      } else {
        const launcher = await cdp.eval("Boolean(document.querySelector('[data-launcher-pane] button[title=\"Shell\"]'))");
        if (launcher) await click(cdp, '[data-launcher-pane] button[title="Shell"]');
        else if (state.activeWorkspaceId) await socketCall(cdp.profile, 'pane.spawn', {
          workspaceId: state.activeWorkspaceId, target: 'shell', split: true,
          activate: true, operator: true,
        });
      }
    }
  }
  return waitUntil(visibleSession, 45_000, 'terminal');
}

function fixtureHtml(kind) {
  const head = '<!doctype html><meta charset="utf-8"><title>mycmux perf fixture</title><main id="chart"></main>';
  const script = '<script>const root=document.getElementById("chart");for(let i=0;i<600;i++){let p=document.createElement("span");p.textContent="chart "+i+" ";p.style.color=`hsl(${i%360} 60% 45%)`;root.append(p)}</script>';
  if (kind === 'small') return (head + script + '<!--' + '.'.repeat(50_000) + '-->');
  if (kind === 'medium') return (head + script + '<!--' + '.'.repeat(1_000_000) + '-->');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><!--${'.'.repeat(8_000_000)}--><rect width="1200" height="800" fill="blue"/></svg>`;
  return head + script + `<img alt="load" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

function makeFixtures() {
  mkdirSync(fixtures, { recursive: true });
  for (const kind of ['small', 'medium', 'heavy']) {
    const file = join(fixtures, `${kind}.html`);
    if (!existsSync(file)) writeFileSync(file, fixtureHtml(kind), 'utf8');
  }
  report.fixtures = Object.fromEntries(['small', 'medium', 'heavy'].map((kind) => {
    const file = join(fixtures, `${kind}.html`);
    return [kind, { path: file, bytes: readFileSync(file).length }];
  }));
  save();
}

async function startFrames(cdp) {
  await cdp.eval(`(() => {
    const sample = { gaps: [], last: 0, active: true, raf: 0 };
    const tick = (time) => {
      if (sample.last) sample.gaps.push(time - sample.last);
      sample.last = time;
      if (sample.active) sample.raf = requestAnimationFrame(tick);
    };
    sample.raf = requestAnimationFrame(tick);
    window.__mycmuxPerfFrames = sample;
  })()`);
}

async function stopFrames(cdp) {
  return cdp.eval(`(() => {
    const sample = window.__mycmuxPerfFrames;
    if (!sample) return [];
    sample.active = false;
    cancelAnimationFrame(sample.raf);
    delete window.__mycmuxPerfFrames;
    return sample.gaps;
  })()`);
}

async function traceStart(cdp) {
  await cdp.call('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,loading,disabled-by-default-devtools.timeline',
    transferMode: 'ReturnAsStream',
  });
}

async function traceStop(cdp, file) {
  const complete = cdp.event('Tracing.tracingComplete', 60_000);
  await cdp.call('Tracing.end');
  const { stream } = await complete;
  const chunks = [];
  for (;;) {
    const part = await cdp.call('IO.read', { handle: stream });
    chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data));
    if (part.eof) break;
  }
  await cdp.call('IO.close', { handle: stream });
  writeFileSync(file, gzipSync(Buffer.concat(chunks)));
  return file;
}

async function emitPath(test, path) {
  const sessionId = await ensureShell(test.cdp);
  test.shellSessionId = sessionId;
  await test.cdp.invoke('write_to_session', { sessionId, data: `echo '${path}'\r` });
  // Give the asynchronous terminal link provider time to resolve this local file.
  const firstPath = !test.pathEmits;
  test.pathEmits = (test.pathEmits ?? 0) + 1;
  await sleep(firstPath ? 9000 : 800);
  return sessionId;
}

async function activateTerminalLink(test, after, expectedName) {
  const cdp = test.cdp;
  const sessionSelector = `[data-session-id="${test.shellSessionId}"]`;
  const { rect } = await point(cdp, `${sessionSelector} .xterm-screen`);
  const cursor = await cdp.eval(`document.querySelector(${quote(`${sessionSelector} .xterm-helper-textarea`)})?.getBoundingClientRect().toJSON()`);
  if (!cursor) throw new Error('Terminal cursor position is unavailable');
  const candidates = [];
  if (expectedName) {
    const matchingRows = await cdp.eval(`(() => [...document.querySelectorAll(${quote(`${sessionSelector} .xterm-rows > div`)})]
      .filter(node => node.textContent?.includes(${quote(expectedName)}))
      .map(node => node.getBoundingClientRect().toJSON()))()`);
    for (const row of matchingRows.reverse()) {
      for (const xOffset of [160, 240, 320, 100, 400])
        candidates.push({ x: rect.x + xOffset, y: row.y + row.height / 2 });
    }
  }
  // The echoed path is usually two or three terminal rows above the prompt.
  for (const rowsAbove of [2.5, 3.5, 1.5, 4.5, 5.5]) {
    const y = Math.max(rect.y + 12, cursor.y - rowsAbove * cursor.height);
    for (const xOffset of [160, 240, 320, 100, 400]) candidates.push({ x: rect.x + xOffset, y });
  }
  // A fresh shell may print an extra startup line; scan the visible buffer.
  for (let y = rect.y + 12; y < rect.y + rect.height - 12; y += 16) {
    for (const xOffset of [160, 240]) candidates.push({ x: rect.x + xOffset, y });
  }
  for (const { x, y } of candidates) {
    if (x >= rect.x + rect.width - 10) continue;
    await mouse(cdp, 'mouseMoved', x, y);
    await sleep(100);
    const hover = await cdp.eval(`(() => {
      const node = document.elementFromPoint(${x}, ${y});
      return { cursor: node ? getComputedStyle(node).cursor : '',
        classes: document.querySelector(${quote(`${sessionSelector} .xterm`)})?.className ?? '' };
    })()`);
    if (hover.cursor !== 'pointer' && !hover.classes.includes('cursor-pointer')) continue;
    await mouse(cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
    await mouse(cdp, 'mouseReleased', x, y, { button: 'left', clickCount: 1 });
    const mark = await markAfter(cdp, 'artifact.link.click', after, undefined, 1_500).catch(() => null);
    if (mark) return mark;
  }
  throw new Error('Terminal link did not expose a pointer cursor in the visible buffer');
}

async function firstChildFrame(test, file) {
  const name = file.split(/[\\/]/).at(-1);
  const target = await waitUntil(async () =>
    (await targets(test.port)).find((item) => item.url.includes(name)), 30_000, `${name} child CDP target`);
  const cdp = await CDP.connect(target);
  try {
    await cdp.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', 30_000);
    await cdp.call('Page.captureScreenshot', { format: 'png' }, 30_000);
    return now();
  } finally { cdp.close(); }
}

async function runA1() {
  let kept = null;
  for (let index = report.measurements.A1_startup?.samples.length ?? 0; index < 5; index++) {
    const test = await launch(`perf-a1-${index}`, { clone: true });
    try {
      const entries = await marks(test.cdp);
      const visible = entries.find((mark) => mark.name === 'window.visible' && mark.id === 'main');
      const frame = entries.find((mark) => mark.name === 'workspace.first.frame' && mark.id === 'main');
      const terminalPaint = entries.find((mark) => mark.name === 'terminal.first.paint');
      if (!visible || !frame) throw new Error('startup marks missing');
      add('A1_startup', {
        run: index + 1,
        cloneSeeded: Number(test.launchLog.includes('Seeded the layout')),
        processToVisibleMs: visible.atMs - test.createdAt,
        processToFirstFrameMs: frame.atMs - test.createdAt,
        processToTerminalPaintMs: terminalPaint ? terminalPaint.atMs - test.createdAt : null,
        visibleToFrameMs: frame.atMs - visible.atMs,
        initialWidth: test.originalBounds.width,
        initialHeight: test.originalBounds.height,
      });
      if (index === 4) kept = test;
    } finally { if (kept !== test) await closeTest(test); }
  }
  return kept;
}

async function runA2(test) {
  const cdp = test.cdp;
  const ids = await cdp.eval("[...document.querySelectorAll('[data-dnd-workspace-target-id]')].map(node => node.getAttribute('data-dnd-workspace-target-id'))");
  if (ids.length < 2) throw new Error(`CloneData showed ${ids.length} workspace tab(s)`);
  for (let index = report.measurements.A2_workspace_switch?.samples.length ?? 0; index < 10; index++) {
    const active = await cdp.eval("document.querySelector('[data-active-workspace=\"true\"]')?.closest('[data-dnd-workspace-target-id]')?.getAttribute('data-dnd-workspace-target-id')");
    const id = ids.find((candidate) => candidate !== active);
    const after = now();
    await click(cdp, `[data-dnd-workspace-target-id="${id}"]`);
    const start = await markAfter(cdp, 'workspace.switch.click', after, id);
    const end = await markAfter(cdp, 'workspace.switch.painted', start.atMs, id);
    add('A2_workspace_switch', { run: index + 1, elapsedMs: end.atMs - start.atMs });
  }
}

async function runA3(test) {
  const cdp = test.cdp;
  const id = await ensureShell(cdp);
  await click(cdp, '[data-session-id] .xterm-screen');
  for (let index = report.measurements.A3_input?.samples.length ?? 0; index < 10; index++) {
    const after = now();
    const char = String.fromCharCode(97 + index);
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}`,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    });
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
    });
    const start = await markAfter(cdp, 'terminal.keydown', after, id);
    const end = await markAfter(cdp, 'terminal.input.painted', start.atMs, id);
    add('A3_input', { run: index + 1, elapsedMs: end.atMs - start.atMs });
  }
  await cdp.invoke('write_to_session', { sessionId: id, data: '\u0003\r' });
}

async function closePreviewPane(test) {
  const cdp = test.cdp;
  const beforeTargets = (await targets(test.port)).length;
  const selector = '[data-dnd-pane-id]:has([data-html-preview-host]) .pane-tab-pill.is-active';
  const { x, y } = await point(cdp, selector);
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y, { button: 'middle', buttons: 4, clickCount: 1 });
  await mouse(cdp, 'mouseReleased', x, y, { button: 'middle', buttons: 0, clickCount: 1 });
  await waitUntil(() => cdp.eval("!document.querySelector('[data-html-preview-host]')"),
    10_000, 'preview pane closure');
  await waitUntil(async () => (await targets(test.port)).length < beforeTargets,
    10_000, 'preview WebView closure');
}

async function runH1(test, kind) {
  const file = join(fixtures, `${kind}.html`);
  const cdp = test.cdp;
  let traceFile;
  const completed = (report.measurements[`H1_${kind}_cold`]?.samples.length ?? 0)
    + (report.measurements[`H1_${kind}_warm`]?.samples.length ?? 0);
  for (let index = completed; index < 11; index++) {
    if (index) appendFileSync(file, '\n', 'utf8'); // A changed mtime rebuilds the same preview.
    await emitPath(test, file);
    let traced = false;
    if (kind === 'heavy' && index === 1) {
      try { await traceStart(cdp); traced = true; }
      catch (error) { failed('trace_H1_heavy', error); }
    }
    if (kind === 'heavy') {
      await startFrames(cdp);
    }
    const after = now();
    const clickMark = await activateTerminalLink(test, after);
    if (kind === 'heavy') {
      const sessionId = await ensureShell(cdp);
      await cdp.invoke('write_to_session', { sessionId,
        data: 'powershell.exe -NoProfile -Command "1..700 | ForEach-Object { Write-Output $_ }"\r' });
    }
    const queued = await markAfter(cdp, 'webpane.create.queued', clickMark.atMs);
    const created = await markAfter(cdp, 'webpane.child.created', clickMark.atMs, queued.id, 60_000);
    const loaded = await markAfter(cdp, 'webpane.load.finished', clickMark.atMs, queued.id, 60_000);
    const shown = await markAfter(cdp, 'webpane.child.shown', clickMark.atMs, queued.id, 60_000);
    const frame = await firstChildFrame(test, file);
    const bucket = index ? 'warm' : 'cold';
    add(`H1_${kind}_${bucket}`, {
      run: index + 1,
      clickToCreatedMs: created.atMs - clickMark.atMs,
      clickToLoadMs: loaded.atMs - clickMark.atMs,
      clickToShownMs: shown.atMs - clickMark.atMs,
      clickToVisibleProbeMs: frame - clickMark.atMs,
    });
    if (kind === 'heavy') {
      const gaps = await stopFrames(cdp);
      add('H3_main_frame_gaps', {
        run: index + 1,
        gapsMs: gaps,
        maxGapMs: Math.max(0, ...gaps),
        over50Count: gaps.filter((gap) => gap > 50).length,
        frameCount: gaps.length,
      });
    }
    if (traced) {
      try { traceFile = await traceStop(cdp, join(resultsDir, 'trace-H1-heavy.json.gz')); }
      catch (error) { failed('trace_H1_heavy', error); }
    }
    await closePreviewPane(test);
  }
  if (traceFile) report.traceH1Heavy = traceFile;
  save();
}

async function changedPreviewFrame(test, file, marker) {
  const name = file.split(/[\\/]/).at(-1);
  return waitUntil(async () => {
    for (const target of (await targets(test.port)).filter((item) => item.url.includes(name))) {
      const cdp = await CDP.connect(target);
      try {
        if (await cdp.eval("document.querySelector('#perf-marker')?.textContent") !== marker) continue;
        await cdp.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await cdp.call('Page.captureScreenshot', { format: 'png' });
        return { atMs: now(), targetId: target.id };
      } finally { cdp.close(); }
    }
    return null;
  }, 30_000, `changed preview marker ${marker}`);
}

async function runH1Changed(test) {
  const file = join(fixtures, 'reopen.html');
  const html = fixtureHtml('small');
  const writeMarker = (marker) => writeFileSync(file,
    `${html}<p id="perf-marker">${marker}</p>`, 'utf8');
  writeMarker('initial');
  await emitPath(test, file);
  const openedAt = now();
  const opened = await activateTerminalLink(test, openedAt);
  const initial = await markAfter(test.cdp, 'webpane.create.queued', opened.atMs);
  await markAfter(test.cdp, 'webpane.load.finished', opened.atMs, initial.id);
  let currentFrame = await changedPreviewFrame(test, file, 'initial');
  for (let index = report.measurements.H1_small_changed_reopen?.samples.length ?? 0;
    index < 10; index++) {
    const marker = `changed-${index + 1}`;
    writeMarker(marker);
    await emitPath(test, file);
    const clickAfter = now();
    const clickMark = await activateTerminalLink(test, clickAfter);
    const loaded = await markAfter(test.cdp, 'webpane.load.finished', clickMark.atMs, initial.id);
    const frame = await changedPreviewFrame(test, file, marker);
    const created = (await marks(test.cdp)).find((entry) => entry.name === 'webpane.child.created'
      && entry.id === initial.id && entry.atMs >= clickMark.atMs);
    add('H1_small_changed_reopen', {
      run: index + 1,
      clickToLoadMs: loaded.atMs - clickMark.atMs,
      clickToVisibleProbeMs: frame.atMs - clickMark.atMs,
      childCreated: Boolean(created),
      sameTarget: frame.targetId === currentFrame.targetId,
      marker,
    });
    currentFrame = frame;
  }
  await closePreviewPane(test);
}

async function openOtherPreview(test, kind) {
  const file = join(fixtures, `${kind}.html`);
  await emitPath(test, file);
  const after = now();
  const clickMark = await activateTerminalLink(test, after, `${kind}.html`);
  const queued = await markAfter(test.cdp, 'webpane.create.queued', clickMark.atMs);
  await markAfter(test.cdp, 'webpane.child.shown', clickMark.atMs, queued.id, 60_000);
  return queued.id;
}

async function runH2(test) {
  const cdp = test.cdp;
  const panes = (await socketCall(test.profile, 'pane.list_all')).panes;
  const previewPane = panes.find((pane) => pane.tabs.some((tab) => tab.label?.includes('small.html'))
    && pane.tabs.some((tab) => tab.label?.includes('medium.html')));
  const small = previewPane?.tabs.find((tab) => tab.label?.includes('small.html'));
  const medium = previewPane?.tabs.find((tab) => tab.label?.includes('medium.html'));
  if (!small || !medium) throw new Error('Two HTML preview sessions in the same pane were not found');
  const select = async (tab) => {
    const selector = `[data-dnd-pane-id="${previewPane.id}"] .pane-tab-pill[data-tab-id="${tab.id}"]`;
    const visible = await cdp.eval(`Boolean(document.querySelector(${quote(selector)}))`);
    if (visible) await click(cdp, selector);
    else {
      await click(cdp, `[data-dnd-pane-id="${previewPane.id}"] .pane-tabbar button[aria-expanded]`);
      await click(cdp, `.pane-tab-menu-row[aria-label*="${tab.label.includes('small.html') ? 'small.html' : 'medium.html'}"]`);
    }
  };
  for (let index = report.measurements.H2_return_to_html?.samples.length ?? 0; index < 10; index++) {
    await select(medium);
    await waitUntil(async () => (await socketCall(test.profile, 'pane.list_all')).panes
      .some((pane) => pane.id === previewPane.id && pane.activeTabId === medium.id),
    5000, 'medium preview selection');
    const before = now();
    await select(small);
    const start = await markAfter(cdp, 'pane.select.click', before, small.id);
    const shown = await markAfter(cdp, 'webpane.update.shown', start.atMs, small.id);
    const visibleProbeAt = await firstChildFrame(test, join(fixtures, 'small.html'));
    add('H2_return_to_html', {
      run: index + 1,
      showResolvedMs: shown.atMs - start.atMs,
      visibleProbeMs: visibleProbeAt - start.atMs,
    });
  }
}

async function sampleCpu(test, seconds = 30) {
  const cdp = test.cdp;
  await cdp.call('Performance.enable');
  const metric = async () => {
    const { metrics } = await cdp.call('Performance.getMetrics');
    return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
  };
  const before = { cpu: cpuSeconds(test.pid),
    rendererCpu: optionalCpuSeconds(test.mainRendererPid),
    perf: await metric() };
  const startedAt = now();
  await sleep(seconds * 1000);
  const after = { cpu: cpuSeconds(test.pid),
    rendererCpu: optionalCpuSeconds(test.mainRendererPid),
    perf: await metric() };
  const elapsedMs = now() - startedAt;
  const workingSet = Number(ps(`(Get-Process -Id ${test.pid}).WorkingSet64`));
  return {
    elapsedMs,
    mycmuxCpuMs: (after.cpu - before.cpu) * 1000,
    mainRendererCpuMs: before.rendererCpu === null || after.rendererCpu === null
      ? null : (after.rendererCpu - before.rendererCpu) * 1000,
    mainRendererTaskMs: ((after.perf.TaskDuration ?? 0) - (before.perf.TaskDuration ?? 0)) * 1000,
    mycmuxWorkingSetMiB: workingSet / 1048576,
  };
}

async function runH4(test, count, streaming = false) {
  const previews = (await targets(test.port)).filter((target) => target.url.includes('asset.localhost')).length;
  if (previews !== count) throw new Error(`Expected ${count} HTML child WebViews, observed ${previews}`);
  if (count === 0) {
    const pids = rendererPids(test.profile);
    test.mainRendererPid = pids.length === 1 ? pids[0] : null;
    report.mainRendererIdentification = { zeroWebviewRendererPids: pids,
      selectedPid: test.mainRendererPid,
      rule: 'The sole renderer in the isolated WebView2 user-data folder before opening child WebViews' };
    save();
  }
  const name = `H4_${streaming ? 'stream' : 'idle'}_${count}_webviews`;
  const first = report.measurements[name]?.samples.length ?? 0;
  // Relaunch after at most three samples. One baseline WebView2 process exited
  // during a long H4 run; both A and B use the same short isolated runs.
  for (let index = first; index < Math.min(10, first + 3); index++) {
    await test.cdp.eval('window.__MYCMUX_PERF__.setPlacementSampling(true)');
    let sample;
    let placement;
    let outputCommands = 0;
    let outputError = null;
    let keepStreaming = streaming;
    const outputLoop = streaming ? (async () => {
      while (keepStreaming) {
        try {
          await test.cdp.invoke('write_to_session', {
            sessionId: test.streamSessionId,
            data: `echo perf-stream-${index + 1}-${outputCommands + 1}-a; echo perf-stream-b; echo perf-stream-c\r`,
          });
          outputCommands++;
        } catch (error) { outputError = error; break; }
        await sleep(1000);
      }
    })() : null;
    try {
      sample = await sampleCpu(test, 30);
      placement = await test.cdp.eval('window.__MYCMUX_PERF__.readPlacement()', 30_000);
    } finally {
      keepStreaming = false;
      await outputLoop;
      await test.cdp.eval('window.__MYCMUX_PERF__.setPlacementSampling(false)', 30_000);
    }
    if (outputError) throw outputError;
    const outputObserved = streaming ? await test.cdp.eval(`(async () => {
      const frame = await window.__TAURI_INTERNALS__.invoke('get_session_scrollback',
        { sessionId: '${test.streamSessionId}' });
      const scrollback = new TextDecoder().decode(new Uint8Array(frame).subarray(24));
      return scrollback.includes('perf-stream-${index + 1}-');
    })()`) : null;
    if (streaming && (!outputObserved || outputCommands < 20))
      throw new Error(`Streaming shell output was not sustained: ${outputCommands} sends, observed=${outputObserved}`);
    add(name, { run: index + 1, seconds: 30, ...sample,
      ...(streaming ? { outputCommands, outputLines: outputCommands * 3, outputObserved } : {}),
      placementFrames: placement.frames,
      placementTotalMs: placement.totalMs,
      placementMaxMs: placement.maxMs,
      placementHostQueries: placement.hostQueries,
    });
  }
}

async function runA4(test) {
  for (let index = report.measurements.A4_idle_cpu_memory?.samples.length ?? 0; index < 10; index++) {
    const json = ps(`& '${join(repo, 'scripts', 'perf', 'measure-mycmux.ps1')}' -TargetPid ${test.pid} -SampleSeconds 10 -NoOutputFile`, 45_000);
    const reportFromScript = JSON.parse(json.replace(/^\uFEFF/, ''));
    const reading = reportFromScript.measurements[0];
    add('A4_idle_cpu_memory', {
      run: index + 1,
      seconds: reading.duration_seconds,
      cpuMs: reading.cpu_delta_seconds * 1000,
      cpuPercentOneCore: reading.cpu_percent_one_core,
      workingSetMiB: reading.working_set_after_bytes / 1048576,
      privateMiB: reading.private_memory_after_bytes / 1048576,
      raw: reading,
    });
  }
}

async function runD3(test) {
  const cdp = test.cdp;
  const { rect } = await point(cdp, '[data-dnd-pane-id]:has(.xterm) .pane-tabbar');
  let anchor = null;
  for (let y = rect.y + 3; y < rect.y + rect.height; y += 8) {
    for (let x = rect.x + 10; x < rect.x + rect.width - 10; x += 18) {
      const bare = await cdp.eval(`(() => {
        const node = document.elementFromPoint(${x}, ${y});
        return Boolean(node?.closest('.pane-tabbar') && !node.closest('.pane-tab-pill,button,input,textarea,select'));
      })()`);
      if (bare) { anchor = { x, y }; break; }
    }
    if (anchor) break;
  }
  if (!anchor) throw new Error('No pane tab drag handle/background found');
  for (let index = report.measurements.D3_drag_frames?.samples.length ?? 0; index < 10; index++) {
    await startFrames(cdp);
    await mouse(cdp, 'mouseMoved', anchor.x, anchor.y);
    await mouse(cdp, 'mousePressed', anchor.x, anchor.y, { button: 'left', clickCount: 1 });
    const dispatchAt = [];
    const started = performance.now();
    for (let step = 0; step < 240; step++) {
      const targetTime = started + (step + 1) * (1000 / 120);
      if (targetTime > performance.now()) await sleep(targetTime - performance.now());
      await mouse(cdp, 'mouseMoved', anchor.x + 2 + (step % 28), anchor.y + 2,
        { button: 'left', buttons: 1 });
      dispatchAt.push(performance.now());
    }
    await mouse(cdp, 'mouseReleased', anchor.x + 4, anchor.y + 2, { button: 'left', clickCount: 1 });
    const gaps = await stopFrames(cdp);
    const expected = summary(gaps.filter((gap) => gap <= 25)).median ?? 16.67;
    const dropped = gaps.reduce((total, gap) => total + Math.max(0, Math.round(gap / expected) - 1), 0);
    add('D3_drag_frames', {
      run: index + 1,
      gapsMs: gaps,
      targetHz: 120,
      actualMoveHz: dispatchAt.length * 1000 / (dispatchAt.at(-1) - dispatchAt[0]),
      droppedFrames: dropped,
      maxGapMs: Math.max(0, ...gaps),
      frameCount: gaps.length,
    });
  }
}

async function runD1Once(test, run, tryReturn) {
  const cdp = test.cdp;
  const beforeTargets = new Set((await targets(test.port)).map((target) => target.id));
  const { x, y } = await point(cdp, '[data-dnd-pane-id]:has(.xterm) .pane-tab-pill[data-tab-id]');
  const viewport = await cdp.eval('({ width: innerWidth, height: innerHeight })');
  // The browser target sees every renderer. Use it for the diagnostic probe;
  // the ordinary A/B sample keeps the first-stage page-target trace method.
  const browserTrace = process.argv.includes('--probe-browser-trace');
  const traceThisRun = !complete('D1_terminal_detach', 1);
  const browserTarget = browserTrace
    ? await (await fetch(`http://127.0.0.1:${test.port}/json/version`)).json() : null;
  const tracer = browserTarget ? await CDP.connect(browserTarget) : cdp;
  if (traceThisRun) await traceStart(tracer);
  const startAt = now();
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
  for (let step = 1; step <= 30; step++) {
    await mouse(cdp, 'mouseMoved', x + (viewport.width + 80 - x) * step / 30, y + 5,
      { button: 'left', buttons: 1 });
    await sleep(12);
  }
  await mouse(cdp, 'mouseReleased', viewport.width + 80, y + 5, { button: 'left', clickCount: 1 });
  const request = await markAfter(cdp, 'detach.request', startAt, undefined, 30_000);
  const built = await markAfter(cdp, 'window.child.built', startAt, undefined, 30_000);
  const childTarget = await waitUntil(async () =>
    (await targets(test.port)).find((target) => !beforeTargets.has(target.id)), 30_000, 'detached CDP target');
  const child = await CDP.connect(childTarget);
  try {
    const childMarks = await waitUntil(async () => {
      const entries = await child.eval('window.__MYCMUX_PERF__?.read() ?? []');
      return entries.some((entry) => entry.name === 'workspace.first.frame') ? entries : null;
    }, 30_000, 'detached first frame');
    const visible = childMarks.find((mark) => mark.name === 'window.visible');
    const frame = childMarks.find((mark) => mark.name === 'workspace.first.frame');
    const navigation = await child.eval(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav ? { timeOrigin: performance.timeOrigin,
        responseEnd: nav.responseEnd, domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        loadEventEnd: nav.loadEventEnd, duration: nav.duration } : null;
    })()`);
    await waitUntil(() => child.eval("Boolean(document.querySelector('[data-session-id] .xterm-helper-textarea'))"), 20_000, 'detached terminal');
    const terminalId = await child.eval("document.querySelector('[data-session-id]:has(.xterm-helper-textarea)')?.dataset.sessionId");
    const contentPaint = (await marks(child)).find((mark) => mark.name === 'terminal.first.paint' && mark.id === terminalId);
    await click(child, '[data-session-id] .xterm-screen');
    const inputAt = now();
    await child.call('Input.dispatchKeyEvent', { type: 'keyDown', text: 'z', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    await child.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    const inputPaint = await markAfter(child, 'terminal.input.painted', inputAt, terminalId, 10_000);
    const traceFile = traceThisRun ? await traceStop(tracer, join(resultsDir,
      browserTrace ? 'trace-D1-browser.json.gz' : 'trace-D1-child.json.gz')) : null;
    if (browserTarget) tracer.close();
    if (!complete('D1_terminal_detach', 10)) add('D1_terminal_detach', {
      run: (report.measurements.D1_terminal_detach?.samples.length ?? 0) + 1,
      childBuiltMs: built.atMs - request.atMs,
      visibleMs: visible.atMs - request.atMs,
      paintedMs: frame.atMs - request.atMs,
      terminalContentMs: contentPaint ? contentPaint.atMs - request.atMs : null,
      terminalReadyMs: inputPaint.atMs - request.atMs,
      navigation,
      traceFile,
    });

    if (!tryReturn) return true;
    try {
    // CDP mouse events stop while Windows owns a native child-window drag.
    // Trigger the same dock request event that the drag detector emits.
    const returnedAt = now();
    await child.invoke('plugin:event|emit', {
      event: 'mycmux://detached-dock-request',
      payload: { toLabel: 'main', workspaceId: request.id },
    }).catch(() => {});
    const requestMark = await markAfter(child, 'dock.return.request', returnedAt, undefined, 3_000).catch(() => null);
    await waitUntil(async () => !(await targets(test.port)).some((target) => target.id === childTarget.id),
      30_000, 'detached target closure');
    const mainFrame = await markAfter(cdp, 'dock.main.painted', returnedAt, 'main', 10_000).catch(() => null);
    if (!complete('D2_return', 10)) add('D2_return', {
      run: (report.measurements.D2_return?.samples.length ?? 0) + 1,
      trigger: 'detached-dock-request event (native window drag unavailable via CDP)',
      childClosedMs: now() - (requestMark?.atMs ?? returnedAt),
      mainFrameMs: mainFrame ? mainFrame.atMs - (requestMark?.atMs ?? returnedAt) : null,
    });
    } catch (error) {
      const structure = await child.eval(`({detachedShell:document.querySelectorAll('[data-detached-pane-shell]').length,
        paneBars:[...document.querySelectorAll('.pane-tabbar')].map(node=>node.getBoundingClientRect().toJSON()),
        headers:[...document.querySelectorAll('[data-dnd-pane-id]')].map(node=>node.dataset.dndPaneId)})`).catch(() => null);
      failed('D2_return', `${error}; child structure=${JSON.stringify(structure)}`);
    }
    return true;
  } finally { child.close(); }
}

async function detachOnce(test, selector, name) {
  const cdp = test.cdp;
  const prior = new Set((await targets(test.port)).map((target) => target.id));
  const { x, y } = await point(cdp, selector);
  const width = await cdp.eval('innerWidth');
  const started = now();
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
  for (let step = 1; step <= 30; step++) {
    await mouse(cdp, 'mouseMoved', x + (width + 80 - x) * step / 30, y + 4,
      { button: 'left', buttons: 1 });
    await sleep(12);
  }
  await mouse(cdp, 'mouseReleased', width + 80, y + 4, { button: 'left', clickCount: 1 });
  const request = await markAfter(cdp, 'detach.request', started, undefined, 20_000);
  const built = await markAfter(cdp, 'window.child.built', started, undefined, 30_000);
  const target = await waitUntil(async () =>
    (await targets(test.port)).find((item) => !prior.has(item.id) && item.url.includes('tauri')),
    30_000, `${name} child window`);
  const child = await CDP.connect(target);
  try {
    const entries = await waitUntil(async () => {
      const seen = await child.eval('window.__MYCMUX_PERF__?.read() ?? []');
      return seen.some((entry) => entry.name === 'workspace.first.frame') ? seen : null;
    }, 30_000, `${name} child first frame`);
    const visible = entries.find((entry) => entry.name === 'window.visible');
    const frame = entries.find((entry) => entry.name === 'workspace.first.frame');
    const childUrls = (await targets(test.port)).map((item) => item.url);
    add(name, {
      run: 1,
      requestToBuiltMs: built.atMs - request.atMs,
      requestToVisibleMs: visible.atMs - request.atMs,
      requestToFrameMs: frame.atMs - request.atMs,
      childUrls,
    });
  } finally { child.close(); }
}

async function runWebDetach(test) {
  await ensureShell(test.cdp);
  const state = await socketCall(test.profile, 'workspace.list');
  await socketCall(test.profile, 'pane.spawn', {
    workspaceId: state.activeWorkspaceId, target: 'web', preset: 'gemini',
    split: true, activate: false, operator: true,
  });
  const webTabId = await waitUntil(async () => {
    const panes = (await socketCall(test.profile, 'pane.list_all')).panes;
    return panes.flatMap((pane) => pane.tabs)
      .find((tab) => tab.webPresetId === 'gemini' || tab.label?.includes('Gemini'))?.id;
  }, 20_000, 'Gemini Web tab');
  await waitUntil(() => test.cdp.eval(`Boolean(document.querySelector('.pane-tab-pill[data-tab-id="${webTabId}"]'))`),
    20_000, 'Gemini Web tab pill');
  await detachOnce(test, `.pane-tab-pill[data-tab-id="${webTabId}"]`, 'D_web_detach_once');
}

async function attempt(name, fn) {
  try {
    const result = await fn();
    if (report.measurements[name]) delete report.measurements[name].unmeasuredReason;
    save();
    return result;
  }
  catch (error) { failed(name, error); return null; }
}

async function placementSnapshot(cdp, tabId) {
  return cdp.eval(`(() => {
    const host = document.querySelector('[data-web-pane-host-tab-id="${tabId}"]');
    const rect = host?.getBoundingClientRect();
    return { host: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
  })()`);
}

function nativeWindows(pid) {
  return JSON.parse(execFileSync('python',
    [join(repo, 'scripts', 'perf', 'inspect-webview-window.py'), String(pid)],
    { encoding: 'utf8', windowsHide: true }));
}

function nativeViewState(test, host, options = {}) {
  const main = nativeWindows(test.pid).find((window) => window.class === 'Tauri Window'
    && window.clientSize[0] > 500 && window.clientSize[1] > 300
    && (!options.windowHwnd || window.hwnd === options.windowHwnd));
  if (!main) throw new Error('Primary native window was not found');
  const candidates = main.children.filter((window) => window.class === 'WRY_WEBVIEW');
  const expected = host ? [main.clientOrigin[0] + host.x, main.clientOrigin[1] + host.y,
    main.clientOrigin[0] + host.x + host.width, main.clientOrigin[1] + host.y + host.height] : null;
  const errorFor = (window) => expected
    ? Math.max(...window.rect.map((value, index) => Math.abs(value - expected[index]))) : Infinity;
  const viewHwnd = options.viewHwnd === undefined ? test.previewWebviewHwnd : options.viewHwnd;
  const view = viewHwnd
    ? candidates.find((window) => window.hwnd === viewHwnd)
    : candidates.sort((left, right) => errorFor(left) - errorFor(right))[0];
  return { view, expected, maximumErrorPx: view ? errorFor(view) : Infinity };
}

async function verifyPlaced(test, name, tabId, startedAt, visible) {
  let state;
  const deadline = now() + 5000;
  while (now() < deadline) {
    const snapshot = await placementSnapshot(test.cdp, tabId);
    const native = nativeViewState(test, snapshot.host);
    if (native.view && native.view.visible === visible
      && (!visible || snapshot.host && native.maximumErrorPx <= 1)) {
      state = { atMs: now(), host: snapshot.host, native };
      break;
    }
    await sleep(10);
  }
  if (!state) throw new Error(`${name} native placement did not settle in 5000ms`);
  const backendMark = (await marks(test.cdp)).find((mark) => mark.id === tabId
    && mark.atMs >= startedAt - 5
    && mark.name === (visible ? 'webpane.update.shown' : 'webpane.update.enter'));
  const backendMarkMs = backendMark ? backendMark.atMs - startedAt : null;
  return { name, elapsedMs: state.atMs - startedAt,
    backendMarkMs,
    maximumErrorPx: visible ? state.native.maximumErrorPx : 0,
    nativeRect: state.native.view.rect, host: state.host,
    passed: backendMarkMs !== null && backendMarkMs <= 100
      && (!visible || state.native.maximumErrorPx <= 1) };
}

async function installOccluderClock(cdp) {
  await cdp.eval(`(() => {
    const selector = '.cmux-overlay-backdrop,.cmux-popover-panel,[aria-modal="true"],[role="menu"],[data-cmux-native-webview-occluder]';
    window.__PERF_OCCLUDER_EVENTS__ = [];
    let previous = Boolean(document.querySelector(selector));
    new MutationObserver(() => {
      const current = Boolean(document.querySelector(selector));
      if (current !== previous) window.__PERF_OCCLUDER_EVENTS__.push({ visible: current, atMs: Date.now() });
      previous = current;
    }).observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'data-state', 'role', 'aria-modal'] });
  })()`);
}

async function occluderChangedAt(cdp, visible, after) {
  return waitUntil(() => cdp.eval(`window.__PERF_OCCLUDER_EVENTS__?.find(event => event.visible === ${visible}
    && event.atMs >= ${after - 5})?.atMs`), 5000, `occluder ${visible ? 'open' : 'close'}`);
}

async function verifyPlacementE2e() {
  const test = await launch(`perf-e2e-placement-${Date.now()}`);
  const checks = [];
  const addCheck = async (name, run) => {
    try { checks.push(await run()); }
    catch (error) { checks.push({ name, passed: false, error: String(error) }); }
    writeFileSync(join(resultsDir, 'e2e-placement-260924.json'),
      JSON.stringify({ executable: exe, checks }, null, 2) + '\n', 'utf8');
  };
  try {
    await ensureShell(test.cdp);
    await openOtherPreview(test, 'small');
    const tabId = await test.cdp.eval("document.querySelector('[data-web-pane-host-tab-id]')?.dataset.webPaneHostTabId");
    if (!tabId) throw new Error('HTML preview host was not found');
    const initialHost = (await placementSnapshot(test.cdp, tabId)).host;
    const initialNative = nativeViewState(test, initialHost);
    if (!initialNative.view || initialNative.maximumErrorPx > 1)
      throw new Error('Initial native WebView does not match the preview host');
    test.previewWebviewHwnd = initialNative.view.hwnd;
    await installOccluderClock(test.cdp);
    await addCheck('window resize', async () => {
      const target = (await targets(test.port)).find((item) => item.url.includes('tauri'));
      if (!target) throw new Error('Primary target is missing');
      const info = await test.cdp.call('Browser.getWindowForTarget', { targetId: target.id });
      const bounds = (await test.cdp.call('Browser.getWindowBounds', { windowId: info.windowId })).bounds;
      const startedAt = now();
      await test.cdp.call('Browser.setWindowBounds', {
        windowId: info.windowId,
        bounds: { windowState: 'normal', width: bounds.width + 100, height: bounds.height + 50 },
      });
      return verifyPlaced(test, 'window resize', tabId, startedAt, true);
    });
    await addCheck('splitter drag', async () => {
      const sash = await test.cdp.eval(`(() => [...document.querySelectorAll('.sash')]
        .map(node => node.getBoundingClientRect())
        .filter(rect => rect.height > 200 && rect.width < 30 && rect.x > 100)
        .map(rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }))[0] ?? null)()`);
      if (!sash) throw new Error('Vertical splitter was not found');
      const before = (await placementSnapshot(test.cdp, tabId)).host;
      await mouse(test.cdp, 'mouseMoved', sash.x, sash.y);
      await mouse(test.cdp, 'mousePressed', sash.x, sash.y, { button: 'left', clickCount: 1 });
      for (let step = 1; step <= 10; step++)
        await mouse(test.cdp, 'mouseMoved', sash.x + 8 * step, sash.y,
          { button: 'left', buttons: 1 });
      const startedAt = now();
      await mouse(test.cdp, 'mouseReleased', sash.x + 80, sash.y, { button: 'left', clickCount: 1 });
      const result = await verifyPlaced(test, 'splitter drag', tabId, startedAt, true);
      result.passed &&= before && result.host
        && Math.abs(before.width - result.host.width) > 5;
      return result;
    });
    await addCheck('workspace switch and return', async () => {
      const initial = await socketCall(test.profile, 'workspace.list');
      const originalId = initial.activeWorkspaceId;
      const created = await socketCall(test.profile, 'workspace.new', {
        name: 'Perf placement B', cwd: repo, grid: '1x1',
      });
      const secondId = created.workspaceId;
      if (!originalId || !secondId) throw new Error('Workspace IDs are missing');
      await click(test.cdp, `[data-dnd-workspace-target-id="${originalId}"]`);
      await waitUntil(() => test.cdp.eval(`Boolean(document.querySelector('[data-web-pane-host-tab-id="${tabId}"]'))`),
        5000, 'preview workspace activation');
      const leftAt = now();
      await click(test.cdp, `[data-dnd-workspace-target-id="${secondId}"]`);
      const hidden = await verifyPlaced(test, 'workspace switch', tabId, leftAt, false);
      const returnedAt = now();
      await click(test.cdp, `[data-dnd-workspace-target-id="${originalId}"]`);
      const restored = await verifyPlaced(test, 'workspace return', tabId, returnedAt, true);
      return { name: 'workspace switch and return', passed: hidden.passed && restored.passed,
        hidden, restored };
    });
    await addCheck('zoom and restore', async () => {
      const selector = `[data-dnd-pane-id]:has([data-html-preview-host]) .pane-tabbar-zoom`;
      const startedAt = now();
      await click(test.cdp, selector);
      const zoom = await verifyPlaced(test, 'zoom', tabId, startedAt, true);
      const returnedAt = now();
      await click(test.cdp, selector);
      const restored = await verifyPlaced(test, 'zoom restore', tabId, returnedAt, true);
      return { name: 'zoom and restore', passed: zoom.passed && restored.passed, zoom, restored };
    });
    await addCheck('settings modal open and close', async () => {
      const startedAt = now();
      await click(test.cdp, '.cmux-title-btn[title="\u8a2d\u5b9a"]');
      const openedAt = await occluderChangedAt(test.cdp, true, startedAt);
      const hidden = await verifyPlaced(test, 'settings modal open', tabId, openedAt, false);
      const returnedAt = now();
      await test.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await test.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      const closedAt = await occluderChangedAt(test.cdp, false, returnedAt);
      const restored = await verifyPlaced(test, 'settings modal close', tabId, closedAt, true);
      return { name: 'settings modal open and close', passed: hidden.passed && restored.passed, hidden, restored };
    });
    await addCheck('tab menu open and close', async () => {
      const selector = `[data-dnd-pane-id]:has([data-html-preview-host]) .pane-tabbar button[aria-expanded]`;
      const startedAt = now();
      await click(test.cdp, selector);
      const openedAt = await occluderChangedAt(test.cdp, true, startedAt);
      const hidden = await verifyPlaced(test, 'tab menu open', tabId, openedAt, false);
      const returnedAt = now();
      await click(test.cdp, selector);
      const closedAt = await occluderChangedAt(test.cdp, false, returnedAt);
      const restored = await verifyPlaced(test, 'tab menu close', tabId, closedAt, true);
      return { name: 'tab menu open and close', passed: hidden.passed && restored.passed, hidden, restored };
    });
    await addCheck('tearout and return', async () => {
      const priorTargets = new Set((await targets(test.port)).map((target) => target.id));
      const priorWindows = new Set(nativeWindows(test.pid)
        .filter((window) => window.class === 'Tauri Window').map((window) => window.hwnd));
      const selector = `.pane-tab-pill[data-tab-id="${tabId}"]`;
      const { x, y } = await point(test.cdp, selector);
      const viewportWidth = await test.cdp.eval('innerWidth');
      const startedAt = now();
      await mouse(test.cdp, 'mouseMoved', x, y);
      await mouse(test.cdp, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
      for (let step = 1; step <= 30; step++) {
        await mouse(test.cdp, 'mouseMoved', x + (viewportWidth + 80 - x) * step / 30, y + 4,
          { button: 'left', buttons: 1 });
        await sleep(12);
      }
      await mouse(test.cdp, 'mouseReleased', viewportWidth + 80, y + 4,
        { button: 'left', clickCount: 1 });
      const request = await markAfter(test.cdp, 'detach.request', startedAt, undefined, 20_000);
      const built = await markAfter(test.cdp, 'window.child.built', startedAt, undefined, 30_000);
      const childTarget = await waitUntil(async () => (await targets(test.port))
        .find((target) => !priorTargets.has(target.id) && target.url.includes('tauri')),
      30_000, 'detached primary CDP target');
      const child = await CDP.connect(childTarget);
      try {
        const childFrame = await markAfter(child, 'workspace.first.frame', request.atMs,
          undefined, 20_000);
        const childWindow = await waitUntil(() => nativeWindows(test.pid)
          .find((window) => window.class === 'Tauri Window' && !priorWindows.has(window.hwnd)),
        10_000, 'detached native window');
        const childPlacement = await waitUntil(async () => {
          const host = (await placementSnapshot(child, tabId)).host;
          if (!host) return null;
          const native = nativeViewState(test, host,
            { windowHwnd: childWindow.hwnd, viewHwnd: null });
          return native.view?.visible && native.maximumErrorPx <= 1 ? native : null;
        }, 10_000, 'detached preview placement');
        const childMarks = (await marks(child)).filter((mark) => mark.id === tabId
          && mark.atMs >= request.atMs);
        const childShown = childMarks.find((mark) => mark.name === 'webpane.child.shown'
          && mark.id === tabId && mark.atMs >= request.atMs);
        const returnedAt = now();
        await child.invoke('plugin:event|emit', {
          event: 'mycmux://detached-dock-request',
          payload: { toLabel: 'main', workspaceId: request.id },
        });
        await waitUntil(async () => !(await targets(test.port))
          .some((target) => target.id === childTarget.id), 30_000, 'detached target closure');
        const mainFrame = await markAfter(test.cdp, 'dock.main.painted', returnedAt,
          'main', 20_000);
        let returnNativeObservedAt = null;
        const returnedPlacement = await waitUntil(async () => {
          const host = (await placementSnapshot(test.cdp, tabId)).host;
          if (!host) return null;
          const native = nativeViewState(test, host, { viewHwnd: null });
          if (native.view?.visible && native.maximumErrorPx <= 1) {
            returnNativeObservedAt = now();
            return native;
          }
          return null;
        }, 10_000, 'returned preview placement');
        const returnMarks = (await marks(test.cdp)).filter((mark) => mark.id === tabId
          && mark.atMs >= returnedAt);
        const returnedShown = returnMarks.find((mark) => mark.name === 'webpane.update.shown'
          && mark.id === tabId && mark.atMs >= returnedAt);
        const childPlacementAfterFrameMs = childShown ? childShown.atMs - childFrame.atMs : null;
        const returnPlacementAfterFrameMs = returnedShown ? returnedShown.atMs - mainFrame.atMs : null;
        return { name: 'tearout and return',
          passed: childPlacement.maximumErrorPx <= 1 && returnedPlacement.maximumErrorPx <= 1
            && childPlacementAfterFrameMs !== null && childPlacementAfterFrameMs <= 100
            && returnPlacementAfterFrameMs !== null && returnPlacementAfterFrameMs <= 100,
          requestToBuiltMs: built.atMs - request.atMs,
          childPlacementAfterFrameMs,
          returnPlacementAfterFrameMs,
          returnNativeObservedAfterFrameMs: returnNativeObservedAt - mainFrame.atMs,
          childMaximumErrorPx: childPlacement.maximumErrorPx,
          returnedMaximumErrorPx: returnedPlacement.maximumErrorPx,
          childMarks: childMarks.map((mark) => ({ name: mark.name, afterFrameMs: mark.atMs - childFrame.atMs })),
          returnMarks: returnMarks.map((mark) => ({ name: mark.name, afterFrameMs: mark.atMs - mainFrame.atMs })) };
      } finally { child.close(); }
    });
  } finally { await closeTest(test); }
  if (checks.some((check) => !check.passed)) throw new Error('Placement E2E checks failed');
  return checks;
}

async function main() {
  if (!existsSync(exe)) throw new Error(`Build ${exe} with the required memory gate before running the CDP driver`);
  mkdirSync(resultsDir, { recursive: true });
  if (process.argv.includes('--validate-only')) {
    const missing = missingMeasurements();
    report.completeness = { complete: missing.length === 0, missing };
    save();
    if (missing.length) throw new Error(`Incomplete baseline: ${JSON.stringify(missing)}`);
    process.stdout.write(`${outputPath}: complete\n`);
    return;
  }
  makeFixtures();
  if (process.argv.includes('--probe-geometry')) {
    const test = await launch(`perf-probe-geometry-${Date.now()}`);
    try {
      await ensureShell(test.cdp);
      await openOtherPreview(test, 'small');
      const host = await test.cdp.eval(`(() => {
        const rect = document.querySelector('[data-web-pane-host-tab-id]')?.getBoundingClientRect();
        return { rect: rect?.toJSON() ?? null, dpr: devicePixelRatio,
          screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight };
      })()`);
      const native = JSON.parse(execFileSync('python',
        [join(repo, 'scripts', 'perf', 'inspect-webview-window.py'), String(test.pid)],
        { encoding: 'utf8', windowsHide: true }));
      writeFileSync(join(resultsDir, 'probe-geometry.json'),
        JSON.stringify({ host, native }, null, 2) + '\n', 'utf8');
    } finally { await closeTest(test); }
    return;
  }
  if (process.argv.includes('--verify-e2e')) {
    await verifyPlacementE2e();
    return;
  }
  if (process.argv.includes('--probe-web')) {
    const test = await launch(`perf-probe-web-${Date.now()}`);
    try {
      await runWebDetach(test);
    } catch (error) {
      writeFileSync(join(resultsDir, 'probe-web.json'), JSON.stringify({
        error: String(error),
        targets: await targets(test.port).catch(() => []),
        marks: await marks(test.cdp).catch(() => []),
      }, null, 2) + '\n', 'utf8');
      throw error;
    } finally { await closeTest(test); }
    return;
  }
  if (process.argv.includes('--probe-h2')) {
    const test = await launch('perf-probe-h2');
    try {
      await openOtherPreview(test, 'small');
      await openOtherPreview(test, 'medium');
      const structure = await test.cdp.eval(`({tabs:[...document.querySelectorAll('[data-tab-id]')].map(node=>({id:node.dataset.tabId,text:node.textContent,cls:node.className,rect:node.getBoundingClientRect().toJSON()})), bars:[...document.querySelectorAll('.pane-tabbar')].map(node=>node.outerHTML.slice(0,500))})`);
      process.stdout.write(JSON.stringify(structure, null, 2) + '\n');
    } finally { await closeTest(test); }
    return;
  }
  if (process.argv.includes('--probe-d1') || process.argv.includes('--probe-browser-trace')) {
    const test = await launch(process.argv.includes('--probe-browser-trace')
      ? 'perf-probe-browser-d1' : 'perf-probe-d1');
    try {
      await ensureShell(test.cdp);
      const state = await socketCall(test.profile, 'workspace.list');
      await socketCall(test.profile, 'pane.spawn', {
        workspaceId: state.activeWorkspaceId, target: 'shell', split: true,
        activate: false, operator: true,
      });
      await waitUntil(() => test.cdp.eval("document.querySelectorAll('[data-dnd-pane-id]:has(.xterm)').length >= 2"),
        20_000, 'two terminal panes');
      await runD1Once(test, 1, true);
    } finally { await closeTest(test); }
    return;
  }
  if (process.argv.includes('--probe-renderer-pid')) {
    const test = await launch('perf-probe-renderer');
    try {
      await ensureShell(test.cdp);
      const initialPids = rendererPids(test.profile);
      for (const kind of ['small', 'medium', 'heavy']) await openOtherPreview(test, kind);
      await traceStart(test.cdp);
      await sleep(500);
      const file = await traceStop(test.cdp, join(resultsDir, 'trace-pid-probe.json.gz'));
      const events = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')).traceEvents;
      const tracePids = [...new Set(events.filter((event) => event.name === 'thread_name'
        && event.args?.name === 'CrRendererMain').map((event) => event.pid))];
      process.stdout.write(JSON.stringify({ initialPids, currentPids: rendererPids(test.profile), tracePids }) + '\n');
    } finally { await closeTest(test); }
    return;
  }
  let cloned = null;
  try {
    if (!complete('A1_startup', 5) || !complete('A2_workspace_switch', 10)) {
      cloned = complete('A1_startup', 5)
        ? await launch('perf-a2-resume', { clone: true })
        : await attempt('A1_startup', runA1);
      if (cloned && !complete('A2_workspace_switch', 10)) await attempt('A2_workspace_switch', () => runA2(cloned));
    }
  } finally { if (cloned) await closeTest(cloned); }

  if (!complete('A3_input', 10) || !complete('H4_idle_0_webviews', 10)
      || !complete('A4_idle_cpu_memory', 10)) {
    let zero = null;
    try {
      zero = await launch('perf-h-zero');
      if (!complete('A3_input', 10)) await attempt('A3_input', () => runA3(zero));
      else await ensureShell(zero.cdp);
      for (let batch = 0; batch < 8 && !complete('H4_idle_0_webviews', 10); batch++) {
        const before = report.measurements.H4_idle_0_webviews?.samples.length ?? 0;
        await attempt('H4_idle_0_webviews', () => runH4(zero, 0));
        if ((report.measurements.H4_idle_0_webviews?.samples.length ?? 0) === before) break;
      }
      if (!complete('A4_idle_cpu_memory', 10)) await attempt('A4_idle_cpu_memory', () => runA4(zero));
    } finally { if (zero) await closeTest(zero); }
  }

  if (!complete('D3_drag_frames', 10)) {
    let drag = null;
    try {
      drag = await launch('perf-d3-drag');
      await ensureShell(drag.cdp);
      await attempt('D3_drag_frames', () => runD3(drag));
    } finally { if (drag) await closeTest(drag); }
  }

  if (!complete('H1_small_cold', 1)
      || !complete('H1_small_warm', 10) || !complete('H1_small_changed_reopen', 10)
      || !complete('H2_return_to_html', 10)) {
    let small = null;
    try {
      small = await launch('perf-h-small');
      await ensureShell(small.cdp);
      if (!complete('H1_small_cold', 1) || !complete('H1_small_warm', 10))
        await attempt('H1_small', () => runH1(small, 'small'));
      if (!complete('H1_small_changed_reopen', 10))
        await attempt('H1_small_changed_reopen', () => runH1Changed(small));
      if (!complete('H2_return_to_html', 10)) {
        await attempt('H2_setup_small', () => openOtherPreview(small, 'small'));
        await attempt('H2_setup_medium', () => openOtherPreview(small, 'medium'));
        await attempt('H2_return_to_html', () => runH2(small));
      }
    } finally { if (small) await closeTest(small); }
  }

  for (const kind of ['medium', 'heavy']) {
    if (complete(`H1_${kind}_cold`, 1) && complete(`H1_${kind}_warm`, 10)
        && (kind !== 'medium' || complete('D_html_detach_once', 1))) continue;
    let test = null;
    try {
      test = await launch(`perf-h-${kind}`);
      if (!complete(`H1_${kind}_cold`, 1) || !complete(`H1_${kind}_warm`, 10))
        await attempt(`H1_${kind}`, () => runH1(test, kind));
      if (kind === 'medium' && !complete('D_html_detach_once', 1)) {
        await attempt('D_html_setup', () => openOtherPreview(test, 'medium'));
        await attempt('D_html_detach_once', () => detachOnce(test,
          '[data-dnd-pane-id]:has([data-html-preview-host]) .pane-tab-pill[data-tab-id]', 'D_html_detach_once'));
      }
    } finally { if (test) await closeTest(test); }
  }
  let web = null;
  for (let index = 0; index < 15; index++) {
    if (complete('D1_terminal_detach', 10) && complete('D2_return', 10)) break;
    let terminalDetach = null;
    let measured = null;
    try {
      terminalDetach = await launch(`perf-terminal-detach-${index}`);
      await ensureShell(terminalDetach.cdp);
      const state = await socketCall(terminalDetach.profile, 'workspace.list');
      await socketCall(terminalDetach.profile, 'pane.spawn', {
        workspaceId: state.activeWorkspaceId, target: 'shell', split: true,
        activate: false, operator: true,
      });
      measured = await attempt('D1_terminal_detach', () => runD1Once(terminalDetach, index + 1, true));
    } finally { if (terminalDetach) await closeTest(terminalDetach); }
    if (!measured) continue;
  }
  if (!complete('D_web_detach_once', 1)) {
    try {
      web = await launch(`perf-web-detach-${Date.now()}`);
      await attempt('D_web_detach_once', () => runWebDetach(web));
    } finally { if (web) await closeTest(web); }
  }

  for (const count of [1, 3]) {
    for (const streaming of [false, true]) {
      const name = `H4_${streaming ? 'stream' : 'idle'}_${count}_webviews`;
      for (let attemptIndex = 0; attemptIndex < 8 && !complete(name, 10); attemptIndex++) {
        let idle = null;
        try {
          idle = await launch(`perf-h4-${count}-${streaming ? 'stream' : 'idle'}-${Date.now()}`);
          idle.streamSessionId = await ensureShell(idle.cdp);
          const pids = rendererPids(idle.profile);
          idle.mainRendererPid = pids.length === 1 ? pids[0] : null;
          let prepared = true;
          for (const kind of ['small', 'medium', 'heavy'].slice(0, count)) {
            if (!(await attempt(`H4_${count}_setup_${kind}`, () => openOtherPreview(idle, kind)))) {
              prepared = false;
              break;
            }
          }
          if (prepared) await attempt(name, () => runH4(idle, count, streaming));
        } finally { if (idle) await closeTest(idle); }
      }
    }
  }
  const missing = missingMeasurements();
  report.completeness = { complete: missing.length === 0, missing };
  save();
  if (missing.length) throw new Error(`Incomplete baseline: ${JSON.stringify(missing)}`);
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => { failed('driver', error); process.exitCode = 1; });
