#!/usr/bin/env node
// Render the actual ToastHost and stylesheet in an isolated headless Edge profile.
// Uses Node built-ins, existing esbuild, and Python for verified UTF-8 writes; installs nothing.
// Acquire the shared heavy-lock lease before running; the output directory must be new.
// Usage: node scripts/verify-toast-layout.mjs <output-dir> [baseline-ref] [edge-exe]
// Replay evidence: node scripts/verify-toast-layout.mjs --check <measurements.json> [--recovery-caller-update]
// The optional caller update verifies identical recoveryFailed rendering against the measured source snapshot.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? "tmp/toast-layout");
const baselineRef = process.argv[3] ?? "9d693419";
const edgePath = process.argv[4] ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const assets = join(output, "assets");
const profile = join(output, "edge-profile");
const sources = ["src/components/common/ToastHost.tsx", "src/lib/tearout/recoveryNotice.ts", "src/components/workspace/terminalPaneStrings.ts", "src/global.css"];
const manifest = [];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const asciiJson = (value) => JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
function writeUtf8(path, text) {
  execFileSync("python", ["-X", "utf8", "-c", [
    "import json, sys",
    "from pathlib import Path",
    "payload = json.loads(sys.stdin.buffer.read().decode('ascii'))",
    "path = Path(payload['path'])",
    "text = payload['text']",
    "assert '\\ufffd' not in text",
    "path.write_bytes(text.encode('utf-8'))",
    "assert path.read_bytes().decode('utf-8') == text",
  ].join("\n")], { input: asciiJson({ path, text }), windowsHide: true });
}
function verifyMeasurements(summary) {
  const cases = ["recoveryFailed-two-actions", "long-single-action", "plain"];
  for (const [width, height] of [[1200, 800], [800, 600]]) {
    for (const phase of ["before", "after"]) {
      const matches = summary.measurements.filter((run) => run.phase === phase && run.viewport.width === width && run.viewport.height === height);
      if (matches.length !== 1 || JSON.stringify(matches[0].rows.map((row) => row.case)) !== JSON.stringify(cases)) {
        throw new Error(`Incomplete ${phase} evidence at ${width}x${height}`);
      }
    }
  }
  const after = summary.measurements.filter((run) => run.phase === "after");
  if (!summary.plainUnchanged || !after.every((run) => run.rows.every((row) => row.widthPass
    && row.labelsPass && row.viewportPass && row.actionsBelow && (!run.required || row.recoveryLinesPass)))) {
    throw new Error("Toast layout acceptance failed; see measurements.json");
  }
  // Wrapping is allowed when needed; intact buttons need not wrap at a particular width.
  return { requiredCases: 6, additionalCases: after.filter((run) => !run.required).reduce((total, run) => total + run.rows.length, 0), plainUnchanged: true };
}
async function recoveryRenderContract(source) {
  const fixture = `
const state = {
  toasts: [],
  pushToast(message, kind = "error", action, actions, durationMs, category) {
    const id = "fixture-" + (state.toasts.length + 1);
    state.toasts = [...state.toasts, { id, message, kind, labels: (actions ?? (action ? [action] : [])).slice(0, 2).map(item => item.label), durationMs, category }];
    return id;
  },
  dismissToast(id) { state.toasts = state.toasts.filter(toast => toast.id !== id); },
};
export const useToastStore = { getState: () => state };
export const capture = () => state.toasts.map(({ id, ...payload }) => payload);
export const reset = () => { state.toasts = []; };
`;
  const { outputFiles } = await build({
    stdin: { contents: source + '\nexport { capture, reset } from "../../stores/toastStore";\n',
      resolveDir: join(workspace, "src/lib/tearout"), sourcefile: "recovery-render-contract.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node",
    plugins: [{ name: "memory-only-toast-contract", setup(plugin) {
      plugin.onResolve({ filter: /toastStore$/ }, () => ({ path: "toast-contract", namespace: "contract" }));
      plugin.onLoad({ filter: /.*/, namespace: "contract" }, () => ({ contents: fixture, loader: "js" }));
    } }],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
  return ["restore_attachment_timeout", "tearout_attachment_timeout", "tearout_publish_failed"].map(reason => {
    module.reset();
    module.recoveryFailed("M1-clock-3", "\u300cM1-source\u300d\u306e\u5143\u306e\u30bf\u30d6", reason, () => {}, () => {});
    return { reason, toasts: module.capture() };
  });
}
if (process.argv[2] === "--check") {
  const evidenceFile = resolve(process.argv[3]);
  const summary = JSON.parse(await readFile(evidenceFile, "utf8"));
  const result = verifyMeasurements(summary);
  const sourceManifest = JSON.parse(await readFile(join(dirname(evidenceFile), "source-manifest.json"), "utf8"));
  const allowCallerUpdate = process.argv[4] === "--recovery-caller-update";
  if (process.argv[4] && !allowCallerUpdate) throw new Error("Unknown source-replay option");
  const sourceChecks = [];
  for (const item of sourceManifest.filter((item) => item.phase === "after")) {
    const current = await readFile(join(workspace, item.file));
    const currentSha256 = sha256(current);
    const check = { file: item.file, measuredSha256: item.sha256, currentSha256, unchanged: currentSha256 === item.sha256 };
    if (!check.unchanged) {
      if (!allowCallerUpdate || item.file !== "src/lib/tearout/recoveryNotice.ts") throw new Error(`Source changed since measurement: ${item.file}`);
      const measured = await readFile(join(dirname(evidenceFile), "source/after", item.file));
      if (sha256(measured) !== item.sha256) throw new Error("Measured recovery source snapshot changed");
      const before = await recoveryRenderContract(measured.toString("utf8"));
      const after = await recoveryRenderContract(current.toString("utf8"));
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Recovery notice rendering changed; measure again");
      check.singleNoticeRenderingUnchanged = true;
      check.renderContract = after;
    }
    sourceChecks.push(check);
  }
  for (const run of summary.measurements) {
    const screenshot = await readFile(run.screenshot);
    if (sha256(screenshot) !== run.screenshotSha256 || screenshot.readUInt32BE(16) !== run.viewport.width
      || screenshot.readUInt32BE(20) !== run.viewport.height) throw new Error(`Screenshot mismatch: ${run.screenshot}`);
  }
  console.log(`PASS: ${asciiJson({ ...result, sourceChecks, screenshotHashesMatch: summary.measurements.length }).trim()}`);
  process.exit(0);
}
await mkdir(output, { recursive: false });
await mkdir(assets);

const fixtureStore = `
import { create } from "zustand";
let nextId = 0;
export const useToastStore = create((set) => ({
  toasts: [],
  pushToast(message, kind = "error", action, actions) {
    const id = "fixture-" + ++nextId;
    set((state) => ({ toasts: [...state.toasts, { id, message, kind, action, actions, category: "failure", createdAt: 0 }] }));
    return id;
  },
  dismissToast(id) { set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })); },
}));
`;
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import ToastHost from "./src/components/common/ToastHost";
import { recoveryFailed } from "./src/lib/tearout/recoveryNotice";
import { useToastStore } from "./src/stores/toastStore";
import "./src/global.css";
recoveryFailed("M1-clock-3", "\u300cM1-source\u300d\u306e\u5143\u306e\u30bf\u30d6", "restore_attachment_timeout", () => {}, () => {});
useToastStore.getState().pushToast(
  "\u9577\u3044\u8aac\u660e\u306e\u901a\u77e5\u3067\u3059\u3002\u64cd\u4f5c\u306e\u7d50\u679c\u3092\u78ba\u8a8d\u3057\u3066\u304b\u3089\u3001\u5fc5\u8981\u306a\u5834\u5408\u306f\u4e0b\u306e\u30dc\u30bf\u30f3\u3067\u3082\u3046\u4e00\u5ea6\u8a66\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u524d\u306e\u30da\u30a4\u30f3\u3068\u30bb\u30c3\u30b7\u30e7\u30f3\u306f\u4fdd\u6301\u3055\u308c\u3066\u3044\u307e\u3059\u3002\u78ba\u8a8d\u304c\u7d42\u308f\u308b\u307e\u3067\u304a\u5f85\u3061\u304f\u3060\u3055\u3044\u3002",
  "warning", { label: "\u3053\u306e\u64cd\u4f5c\u3092\u3082\u3046\u4e00\u5ea6\u5b9f\u884c\u3059\u308b", run: () => {} });
useToastStore.getState().pushToast("\u64cd\u4f5c\u306e\u306a\u3044\u901a\u5e38\u306e\u901a\u77e5\u3067\u3059\u3002\u30da\u30a4\u30f3\u306e\u72b6\u614b\u3092\u78ba\u8a8d\u3057\u307e\u3057\u305f\u3002", "info");
createRoot(document.getElementById("root")).render(React.createElement(ToastHost));
window.__toastFixture = useToastStore;
`;

for (const phase of ["before", "after"]) {
  const phaseSources = new Map();
  for (const relative of sources) {
    const bytes = phase === "before"
      ? execFileSync("git", ["show", `${baselineRef}:${relative}`], { cwd: workspace, maxBuffer: 8 * 1024 * 1024 })
      : await readFile(join(workspace, relative));
    const source = bytes.toString("utf8");
    if (source.includes("\uFFFD")) throw new Error(`Invalid UTF-8 replacement in ${relative}`);
    phaseSources.set(resolve(workspace, relative), source);
    manifest.push({ phase, file: relative, sha256: sha256(bytes), sourceRef: phase === "before" ? baselineRef : "working-tree" });
    const snapshot = join(output, "source", phase, relative);
    await mkdir(dirname(snapshot), { recursive: true });
    writeUtf8(snapshot, source);
  }
  const bundled = await build({
    stdin: { contents: entry, resolveDir: workspace, sourcefile: "toast-layout-fixture.jsx", loader: "jsx" },
    absWorkingDir: workspace,
    outfile: join(assets, `${phase}.js`),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff": "file" },
    plugins: [{
      name: "isolated-toast-fixture",
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)toastStore$/ }, () => ({ path: "toast-fixture-store", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixtureStore, loader: "js", resolveDir: workspace }));
        builder.onLoad({ filter: /(?:ToastHost\.tsx|recoveryNotice\.ts|terminalPaneStrings\.ts|global\.css)$/ }, (args) => {
          const source = phaseSources.get(resolve(args.path));
          if (source === undefined) return;
          return { contents: source, loader: extname(args.path).slice(1), resolveDir: dirname(args.path) };
        });
      },
    }],
  });
  for (const file of bundled.outputFiles) {
    if (extname(file.path) === ".woff") await writeFile(file.path, file.contents);
    else writeUtf8(file.path, file.text);
  }
}
await writeFile(join(output, "source-manifest.json"), asciiJson(manifest));

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      const phase = url.searchParams.get("phase") === "before" ? "before" : "after";
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${phase}.css"></head><body><div id="root"></div><script type="module" src="/${phase}.js"></script></body></html>`);
      return;
    }
    // Only serve generated fixture assets, never arbitrary workspace or profile files.
    const filename = url.pathname.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", extname(filename) === ".js" ? "text/javascript" : extname(filename) === ".css" ? "text/css" : "font/woff");
    response.end(await readFile(join(assets, filename)));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const serverPort = server.address().port;
let browser;
let page;
let edge;
let processExited = false;
const lifecycle = { startedAt: new Date().toISOString(), profile, serverPort, edgePath };

async function poll(operation, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ""}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("CDP connect timeout")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); fail(new Error("CDP socket error")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.fail(new Error(`${item.method}: ${JSON.stringify(message.error)}`));
    else item.done(message.result ?? {});
  });
  return {
    send(method, params = {}) {
      return new Promise((done, fail) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(id, { done, fail, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

function measure() {
  const rect = (element) => element.getBoundingClientRect().toJSON();
  const number = (value) => Number.parseFloat(value) || 0;
  const within = (bounds) => bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  return [...document.querySelectorAll("[role='alert'], [role='status']")].map((toast, index) => {
    const spans = [...toast.children].filter((child) => child.tagName === "SPAN");
    const message = spans[0];
    const actionRow = spans[1];
    const style = getComputedStyle(toast);
    const bounds = rect(toast);
    const messageBounds = rect(message);
    const close = toast.querySelector(".pane-action-btn");
    const innerWidth = bounds.width - number(style.paddingLeft) - number(style.paddingRight) - number(style.borderLeftWidth) - number(style.borderRightWidth);
    const iconWidth = rect(toast.firstElementChild).width;
    const availableWidth = innerWidth - iconWidth - rect(close).width;
    const gridMessageWidth = innerWidth - number(style.gridTemplateColumns.split(" ")[0]) - rect(close).width - 2 * number(style.columnGap);
    const range = document.createRange();
    range.selectNodeContents(message);
    const lines = new Set([...range.getClientRects()].filter((line) => line.width > 0).map((line) => line.top.toFixed(2))).size;
    const buttons = [...(actionRow?.querySelectorAll("button") ?? [])].map((button) => {
      const label = document.createRange();
      label.selectNodeContents(button);
      const textBounds = label.getBoundingClientRect().toJSON();
      const buttonBounds = rect(button);
      const buttonStyle = getComputedStyle(button);
      const contentLeft = buttonBounds.left + number(buttonStyle.borderLeftWidth) + number(buttonStyle.paddingLeft);
      const contentRight = buttonBounds.right - number(buttonStyle.borderRightWidth) - number(buttonStyle.paddingRight);
      return {
        label: button.textContent, rect: buttonBounds, labelRect: textBounds,
        labelFits: textBounds.left >= contentLeft - 1 && textBounds.right <= contentRight + 1
          && textBounds.top >= buttonBounds.top && textBounds.bottom <= buttonBounds.bottom
          && button.scrollWidth <= button.clientWidth + 1 && within(buttonBounds) && within(textBounds)
          && buttonBounds.left >= bounds.left + number(style.borderLeftWidth) + number(style.paddingLeft) - 1
          && buttonBounds.right <= bounds.right - number(style.borderRightWidth) - number(style.paddingRight) + 1,
        whiteSpace: buttonStyle.whiteSpace,
      };
    });
    return {
      case: ["recoveryFailed-two-actions", "long-single-action", "plain"][index],
      message: message.textContent, toastRect: bounds, messageRect: messageBounds,
      innerWidth, availableWidth, gridMessageWidth, messageWidth: messageBounds.width, widthRatio: messageBounds.width / availableWidth,
      lines, buttons, iconRect: rect(toast.firstElementChild), closeRect: rect(close),
      actionRowRect: actionRow ? rect(actionRow) : null,
      actionsBelow: actionRow ? rect(actionRow).top >= messageBounds.bottom : true,
      widthPass: messageBounds.width >= availableWidth * 0.9,
      recoveryLinesPass: index !== 0 || lines <= 4,
      labelsPass: buttons.every((button) => button.labelFits),
      viewportPass: within(bounds) && within(messageBounds),
      fontFamily: getComputedStyle(message).fontFamily,
    };
  });
}

try {
  await mkdir(profile);
  edge = spawn(edgePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  lifecycle.edgePid = edge.pid;
  edge.once("exit", (code, signal) => { processExited = true; lifecycle.exitCode = code; lifecycle.exitSignal = signal; });
  const browserLogs = [];
  edge.stderr.on("data", (chunk) => browserLogs.push(chunk));
  const activePort = await poll(async () => {
    const lines = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
    return Number(lines[0]) > 0 && lines[1]?.startsWith("/devtools/browser/") ? lines : null;
  });
  lifecycle.cdpPort = Number(activePort[0]);
  browser = await connect(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`);
  const browserVersion = await browser.send("Browser.getVersion");
  const targets = await fetch(`http://127.0.0.1:${activePort[0]}/json/list`).then((response) => response.json());
  page = await connect(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable");
  const measurements = [];
  for (const phase of ["before", "after"]) {
    for (const [width, height] of [[1200, 800], [800, 600], [320, 600]]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await page.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/?phase=${phase}` });
      await poll(async () => await evaluate("document.querySelectorAll('[role=alert], [role=status]').length === 3 && !!window.__toastFixture"));
      await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
      const rows = await evaluate(`(${measure.toString()})()`);
      const viewport = await evaluate("({width:innerWidth,height:innerHeight,devicePixelRatio})");
      if (viewport.width !== width || viewport.height !== height) throw new Error("Unexpected viewport");
      const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const screenshotFile = join(output, `${phase}-${width}x${height}.png`);
      const screenshotBytes = Buffer.from(screenshot.data, "base64");
      await writeFile(screenshotFile, screenshotBytes);
      const required = width !== 320;
      for (const row of rows) {
        row.pass = row.widthPass && row.labelsPass && row.viewportPass && (!required || row.recoveryLinesPass)
          && (phase === "before" || row.actionsBelow);
      }
      measurements.push({ phase, viewport, required, screenshot: screenshotFile, screenshotSha256: sha256(screenshotBytes), rows });
      console.log(`${phase} ${width}x${height}: ${rows.map((row) => `${row.case} width=${row.messageWidth.toFixed(2)} ratio=${(row.widthRatio * 100).toFixed(2)}% lines=${row.lines} labels=${row.labelsPass} viewport=${row.viewportPass}`).join("; ")}`);
    }
  }
  const plainUnchanged = measurements.filter((run) => run.phase === "after").every((after) => {
    const before = measurements.find((run) => run.phase === "before" && run.viewport.width === after.viewport.width);
    const a = after.rows.find((row) => row.case === "plain");
    const b = before.rows.find((row) => row.case === "plain");
    return ["toastRect", "messageRect", "iconRect", "closeRect"].every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
  });
  const afterPass = measurements.filter((run) => run.phase === "after").every((run) => run.rows.every((row) => row.pass));
  const narrow = measurements.find((run) => run.phase === "after" && run.viewport.width === 320).rows[0];
  const buttonsWrap = narrow.buttons[1].rect.top > narrow.buttons[0].rect.top;
  const summary = { baselineRef, browserVersion, fixture: "Actual ToastHost, recoveryFailed and global.css; isolated in-memory store without IPC or persistence", plainUnchanged, buttonsWrap, afterPass, measurements };
  await writeFile(join(output, "measurements.json"), asciiJson(summary));
  writeUtf8(join(output, "edge-stderr.txt"), Buffer.concat(browserLogs).toString("utf8"));
  verifyMeasurements(summary);
  console.log("PASS: all after measurements, unchanged plain toast, and intact labels at 320px");
} finally {
  page?.close();
  if (browser) {
    try { await browser.send("Browser.close"); lifecycle.closedViaCdp = true; } catch { lifecycle.closedViaCdp = false; }
    browser.close();
  }
  if (edge) {
    try { await poll(() => processExited, 5000); }
    catch {
      // Only the PID started above and its child processes; never kill by executable name.
      execFileSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
      lifecycle.stoppedOwnPid = edge.pid;
    }
  }
  await new Promise((done) => server.close(done));
  lifecycle.finishedAt = new Date().toISOString();
  await writeFile(join(output, "lifecycle.json"), asciiJson(lifecycle));
}
