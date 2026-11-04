/**
 * Test-only handles for scripted end-to-end checks (`e2e.eval`, see
 * src-tauri/src/e2e.rs). Installed only in bundles built with VITE_E2E=1; the
 * guard is a build-time constant, so every other bundle drops this module.
 *
 * Scripts reach the app through the same functions the UI calls — the drop
 * commit the drag loop runs, the stores the components read — so a check
 * exercises the shipped code path rather than a test double.
 */
import { tearOutWorkspaceToNewWindow } from "./workspaceTearOut";
import { tearoutTab, tearoutPane, tearoutWorkspace, regrabTearoutWindow, isTearoutChild } from "./tearout/runtime";
import { activeTearoutRecords } from "./tearout/record";
import { useSettingsStore } from "../stores/settingsStore";
import { readPaneTail, readPaneScreenBuffer, handleSocketCommand } from "../components/layout/socketCommands";
import { commitPaneDragDrop } from "../hooks/usePaneDragSource";
import { getTearOutDiagnosticEvents } from "./tearOutDiagnostics";
import { isMainWindow, windowLabel } from "./windowContext";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useUiStore } from "../stores/uiStore";
import { useToastStore } from "../stores/toastStore";
import { recordPerf } from "./perfTimeline";
import { liveTerms, termCache, terminalWriteCounters } from "../components/terminal/terminalCache";
import { previewArtifactUriForSessionV2 } from "./ipc";
import { Window as TauriWindow } from "@tauri-apps/api/window";
import { captureTerminalScreen, canvasBlob, copyWebglTerminalGrid, pngCaptureImage, terminalCaptureDiagnostics, type PaneCaptureResult, type CaptureScale } from "../components/terminal/terminalCapture";
import { terminalScreenThemeFor } from "../components/terminal/terminalScreenState";

/** Installed only in e2e bundles. Timer stacks are captured at registration,
 * not on every tick; native timers preserve their arguments and receiver. */
function installMacProbe() {
  // This lane is driven in the background on a working Mac. The shipped
  // child reveal requests OS focus; suppress only that request in e2e builds.
  // DOM focus and the original show/restore/render paths remain measurable.
  TauriWindow.prototype.setFocus = async function () {
    recordPerf("mac.e2e.focus.suppressed", this.label);
  };
  const timers = new Map<string, { registered: number; fired: number; totalMs: number }>();
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeInterval = window.setInterval.bind(window);
  let collecting = false;
  for (const [kind, native] of [["timeout", nativeTimeout], ["interval", nativeInterval]] as const) {
    const wrapped = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof handler !== "function") return native(handler, delay, ...args);
      const stack = (new Error().stack ?? "unknown").split("\n").slice(2, 7).join("\n");
      const key = `${kind}:${delay ?? 0}:${stack}`;
      let row = timers.get(key);
      if (!row && timers.size < 1024) {
        row = { registered: 0, fired: 0, totalMs: 0 };
        timers.set(key, row);
      }
      if (row && collecting) row.registered++;
      return native(function (this: unknown, ...values: unknown[]) {
        const active = collecting;
        const start = active ? performance.now() : 0;
        try { return Reflect.apply(handler, this, values); }
        finally { if (row && active) { row.fired++; row.totalMs += performance.now() - start; } }
      }, delay, ...args);
    }) as typeof window.setTimeout;
    if (kind === "timeout") window.setTimeout = wrapped;
    else window.setInterval = wrapped;
  }
  let frame = 0;
  let last = 0;
  let started = 0;
  let frames = 0;
  let maxGapMs = 0;
  let dropped = 0;
  let gaps: number[] = [];
  let longtasks: { atMs: number; durationMs: number }[] = [];
  const visibility: { atMs: number; state: string }[] = [];
  const tick = (now: number) => {
    if (!collecting) return;
    if (last) {
      const gap = now - last;
      maxGapMs = Math.max(maxGapMs, gap);
      dropped += Math.max(0, Math.round(gap / (1000 / 60)) - 1);
      if (gaps.length < 20000) gaps.push(gap);
    }
    last = now;
    frames++;
    frame = requestAnimationFrame(tick);
  };
  const longtaskSupported = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
  if (longtaskSupported) new PerformanceObserver((list) => {
    if (collecting) for (const entry of list.getEntries()) {
      if (longtasks.length < 10000) longtasks.push({ atMs: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
    }
  }).observe({ entryTypes: ["longtask"] });
  document.addEventListener("visibilitychange", () => {
    if (visibility.length < 2000) visibility.push({ atMs: Date.now(), state: document.visibilityState });
    recordPerf("mac.visibility." + document.visibilityState, windowLabel());
  });
  const contexts = { requested: 0, succeeded: 0, distinctSuccessfulCanvases: 0, lost: 0, restored: 0 };
  const nativeContext = HTMLCanvasElement.prototype.getContext;
  const seen = new WeakSet<HTMLCanvasElement>();
  const successful = new WeakSet<HTMLCanvasElement>();
  HTMLCanvasElement.prototype.getContext = (function (this: HTMLCanvasElement, ...args: unknown[]) {
    const result = Reflect.apply(nativeContext, this, args);
    if (String(args[0]).includes("webgl")) {
      contexts.requested++;
      if (result) {
        contexts.succeeded++;
        if (!successful.has(this)) { successful.add(this); contexts.distinctSuccessfulCanvases++; }
      }
      if (!seen.has(this)) {
        seen.add(this);
        this.addEventListener("webglcontextlost", () => { contexts.lost++; });
        this.addEventListener("webglcontextrestored", () => { contexts.restored++; });
      }
    }
    return result;
  }) as typeof nativeContext;
  return {
    start: () => {
      cancelAnimationFrame(frame);
      for (const row of timers.values()) { row.registered = 0; row.fired = 0; row.totalMs = 0; }
      frames = 0; last = 0; maxGapMs = 0; dropped = 0; gaps = []; longtasks = [];
      started = performance.now(); collecting = true; frame = requestAnimationFrame(tick);
      return { atMs: performance.timeOrigin + started, visibility: document.visibilityState };
    },
    read: (stop = false) => {
      const now = performance.now();
      const elapsedMs = now - started;
      const openGapMs = last ? now - last : elapsedMs;
      if (stop) { collecting = false; cancelAnimationFrame(frame); }
      return { elapsedMs, frames, framesPerSecond: frames / (elapsedMs / 1000), maxGapMs, dropped,
        openGapMs, maxGapOrSilenceMs: Math.max(maxGapMs, openGapMs), noFrames: frames === 0,
        gaps, longtaskSupported, longtasks, visibility: document.visibilityState,
        visibilityChanges: visibility.slice(), timers: Object.fromEntries(timers),
        contexts: { ...contexts, connectedSuccessfulCanvases: [...document.querySelectorAll("canvas")].filter((canvas) => successful.has(canvas)).length },
        heap: (performance as Performance & { memory?: unknown }).memory ?? null };
    },
    delay: (ms: number) => new Promise<void>((resolve) => nativeTimeout(resolve, ms)),
  };
}

/** Read-only capture evidence. Only the probe's disposable synthetic PTYs are
 * serialized by its caller; no image or screen enters the performance log.
 */
async function measureSizedCapture(sessionId: string, cols: number, rows: number, scale: CaptureScale) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 500) {
    throw new Error("capture probe invalid dimensions");
  }
  const source = await readPaneScreenBuffer(sessionId, 0);
  // This read-only probe varies the fixture's empty margins; cells, theme and
  // cursor stay the same. It never resizes a PTY, changes reader caches, or
  // claims this synthetic geometry is the pane.capture socket's screen.
  if (source.lines.slice(rows).some(line => line.length > 0)
    || source.lines.some(line => line.some(run => run[0] + [...run[2]].length * run[1] > cols))
    || (source.cursor && (source.cursor.row >= rows || source.cursor.col >= cols))) {
    throw new Error("capture probe fixture exceeds dimensions");
  }
  const screen = { ...source, sessionId, cols, rows, lines: Array.from({ length: rows }, (_, row) => source.lines[row] ?? []) };
  return captureTerminalScreen(async () => screen, scale);
}

const captureProbe = {
  measure: measureSizedCapture,
  state: terminalCaptureDiagnostics,
  live: async (sessionId: string) => {
    const term = liveTerms.get(sessionId);
    if (!term) throw new Error("capture probe terminal is not mounted");
    const theme = terminalScreenThemeFor(term, term.options.theme);
    const screen = term.element?.querySelector(".xterm-screen");
    const rect = screen?.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const { canvas, renderPath } = await copyWebglTerminalGrid(term, theme.background);
    try {
      return { image: await pngCaptureImage(canvas, { scale: Math.round(dpr * 100) / 100, native: true }), renderPath, dpr,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        options: { fontFamily: term.options.fontFamily, fontSize: term.options.fontSize,
          lineHeight: term.options.lineHeight, fontWeight: term.options.fontWeight,
          fontWeightBold: term.options.fontWeightBold, minimumContrastRatio: term.options.minimumContrastRatio,
          background: theme.background, allowTransparency: term.options.allowTransparency } };
    } finally { canvas.width = 0; canvas.height = 0; }
  },
  encodings: async (sessionId: string, scale: CaptureScale, cols?: number, rows?: number) => {
    const capture = cols !== undefined && rows !== undefined
      ? await measureSizedCapture(sessionId, cols, rows, scale)
      : await handleSocketCommand("pane.capture", { sessionId, scale }) as PaneCaptureResult;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error("capture probe PNG decode failed"));
      image.src = "data:image/png;base64," + capture.image.data;
    });
    const canvas = document.createElement("canvas");
    canvas.width = capture.image.width; canvas.height = capture.image.height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("capture probe canvas unavailable");
      context.drawImage(image, 0, 0);
      const webp = await canvasBlob(canvas, "image/webp");
      return { pngBytes: atob(capture.image.data).length, webpType: webp.type,
        webpBytes: webp.type === "image/webp" ? webp.size : null };
    } finally { canvas.width = 0; canvas.height = 0; image.src = ""; }
  },
};

declare global {
  interface Window {
    __mycmuxE2E?: Record<string, unknown>;
  }
}

/** Drop the given tab outside the window, exactly as a drag release would. */
function detachTab(
  workspaceId: string,
  paneId: string,
  tabId: string,
  screenX: number,
  screenY: number,
): void {
  commitPaneDragDrop(
    { kind: "tab", workspaceId, paneId, tabId, label: "" },
    { kind: "new-window", screenX, screenY },
  );
}

export function installE2eHooks(): void {
  if (import.meta.env.VITE_E2E !== "1") return;
  const bootAt = performance.now();
  recordPerf("mac.e2e.hooks.ready", windowLabel());
  const macProbe = installMacProbe();
  window.__mycmuxE2E = {
    macProbe,
    captureProbe,
    terminals: { live: liveTerms, cached: termCache, writes: terminalWriteCounters },
    previewArtifactUriForSessionV2,
    bootAt,
    bootEpochMs: Date.now() - bootAt,
    windowLabel,
    isMainWindow,
    detachTab,
    legacyDrop: commitPaneDragDrop,
    tearOutWorkspaceToNewWindow,
    readPaneTail,
    handleSocketCommand,
    nativeTearout: { tearoutTab, tearoutPane, tearoutWorkspace, regrabTearoutWindow, isTearoutChild, records: activeTearoutRecords },
    tearOutEvents: getTearOutDiagnosticEvents,
    stores: {
      settings: useSettingsStore,
      workspaceList: useWorkspaceListStore,
      layout: useWorkspaceLayoutStore,
      paneMetadata: usePaneMetadataStore,
      ui: useUiStore,
      toast: useToastStore,
    },
  };
}
