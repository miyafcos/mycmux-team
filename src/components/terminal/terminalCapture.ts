import { Terminal, type IDisposable, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { readLiveTerminalAppearance } from "../../stores/compositionStore";
import { resolveEffectiveTerminalRenderer } from "../../stores/settingsMigration";
import { liveTerms, termCache } from "./terminalCache";
import { buildTerminalOptions, resolveTerminalTheme } from "./terminalOptions";
import { ANSI_KEYS } from "./terminalThemeColors";
import { snapshotTerminalScreen, type ScreenColor, type ScreenRun, type TerminalScreenSnapshot } from "./terminalScreenSnapshot";
import { resetTerminalScreenState, terminalScreenCursorVisible, trackTerminalScreenState } from "./terminalScreenState";

const CSI = "\x1b[";
export const CAPTURE_TIMEOUT_MS = 400;
export const CAPTURE_IDLE_MS = 60_000;
const UNAVAILABLE = "pane.capture unavailable";
const LIFETIME_CHANGED = "pane read lifetime changed";
export type CaptureScale = "native" | 1 | 2;
export interface ResolvedCaptureScale { scale: number; native: boolean; renderDpr: number }
export type CaptureRenderPath = "sync" | "onRender";
export type CaptureScalePath = "dpr" | "font";
export type PaneCaptureScreen = TerminalScreenSnapshot & { sessionId: string };
export interface CaptureImage {
  type: "image/png";
  scale: number;
  native: boolean;
  width: number;
  height: number;
  data: string;
}
export interface PaneCaptureResult {
  sessionId: string;
  screen: PaneCaptureScreen;
  image: CaptureImage;
  renderer: "webgl";
  elapsedMs: number;
}

export function validateCaptureScale(value: unknown): CaptureScale {
  if (value === undefined) return "native";
  if (value === "native" || value === 1 || value === 2) return value;
  throw new Error("pane.capture scale must be native, 1 or 2");
}

export function resolveCaptureScale(value: unknown, dpr: number): ResolvedCaptureScale {
  const request = validateCaptureScale(value);
  if (!Number.isFinite(dpr) || dpr <= 0) throw new Error(UNAVAILABLE);
  // Chromium exposes float32-derived DPRs. Rounding before rasterization can
  // move a floored cell width across a pixel boundary (for example at 115%).
  const renderDpr = request === "native" ? dpr : request;
  return { scale: Math.round(renderDpr * 100) / 100, native: renderDpr === dpr, renderDpr };
}

function colorSgr(color: ScreenColor, foreground: boolean): string {
  if (color === null) return "";
  const prefix = foreground ? 38 : 48;
  if (typeof color === "number") return `;${prefix};5;${color}`;
  const value = parseInt(color.slice(1), 16);
  return `;${prefix};2;${value >> 16 & 255};${value >> 8 & 255};${value & 255}`;
}

function runSgr(run: ScreenRun): string {
  const codes = [0];
  for (const [flag, sgr] of [[1, 1], [2, 3], [4, 4], [8, 2], [16, 7], [32, 9]]) {
    if (run[5] & flag) codes.push(sgr);
  }
  return CSI + codes.join(";") + colorSgr(run[3], true) + colorSgr(run[4], false) + "m";
}

/** Physical cells only: CUP prevents implicit wraps or blank-row trimming.
 * The input is a trusted pane.screen snapshot, never raw client-supplied VT.
 */
export function serializeCaptureScreen(screen: TerminalScreenSnapshot): string {
  let text = CSI + "?7l" + (screen.alternateScreen ? CSI + "?1049h" : "") + " " + CSI + "2J" + CSI + "H";
  for (let row = 0; row < screen.rows; row++) {
    for (const run of screen.lines[row]) {
      text += CSI + `${row + 1};${run[0] + 1}H` + runSgr(run) + run[2];
    }
  }
  // One extra buffer row reproduces a scrolled viewport, including an offscreen
  // cursor, without needing the original scrollback contents.
  const scrolled = !screen.atBottom && !screen.alternateScreen;
  if (scrolled) text += CSI + "0m" + CSI + `${screen.rows};1H\r\n`;
  const cursor = screen.cursor;
  const row = cursor ? cursor.row + 1 - Number(scrolled) : screen.rows;
  text += CSI + `${row};${(cursor?.col ?? 0) + 1}H`;
  return text + CSI + "0m" + CSI + `?25${cursor?.visible ? "h" : "l"}`;
}

/** Fail closed before painting if a future xterm parser changes the replay. */
export function verifyCaptureScreen(term: Terminal, screen: TerminalScreenSnapshot): void {
  const actual = snapshotTerminalScreen(term, screen.theme, {
    cursorVisible: terminalScreenCursorVisible(term),
  });
  if (JSON.stringify(actual.lines) !== JSON.stringify(screen.lines)
    || JSON.stringify(actual.cursor) !== JSON.stringify(screen.cursor)
    || actual.alternateScreen !== screen.alternateScreen || actual.atBottom !== screen.atBottom) {
    throw new Error(UNAVAILABLE);
  }
}

/** Same builder and live values, including per-terminal font overrides.
 * The screen's OSC-aware RGB palette is authoritative; v1 paints it opaquely.
 */
export function captureTerminalOptions(sessionId: string, screen: TerminalScreenSnapshot): ITerminalOptions {
  const source = (liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term)?.options;
  const state = useThemeStore.getState();
  const appearance = readLiveTerminalAppearance();
  const theme: ITheme = {
    ...resolveTerminalTheme(source?.theme ?? state.theme.terminal, appearance.terminalOpacity, appearance.mediaActive),
    foreground: screen.theme.foreground, background: screen.theme.background, cursor: screen.theme.cursor,
  };
  ANSI_KEYS.forEach((key, index) => { (theme as Record<string, unknown>)[key] = screen.theme.palette[index]; });
  return {
    ...buildTerminalOptions({
      fontSize: source?.fontSize ?? state.fontSize,
      fontFamily: source?.fontFamily ?? state.fontFamily,
      lineHeight: source?.lineHeight ?? state.lineHeight,
      theme,
      minimumContrastRatio: source?.minimumContrastRatio ?? appearance.minimumContrastRatio,
      cursorBlink: false,
    }),
    // Preserve per-terminal overrides as well as the shared builder defaults.
    ...Object.fromEntries((["fontWeight", "fontWeightBold", "letterSpacing", "cursorStyle", "customGlyphs",
      "rescaleOverlappingGlyphs", "allowTransparency", "windowsPty"] as const)
      .filter(key => source?.[key] !== undefined).map(key => [key, source![key]])),
    disableStdin: true, cursorInactiveStyle: "outline", logLevel: "off",
  };
}

/** The body-level host does not inherit #root's macOS CoreText policy. The
 * WebGL atlas attaches its scratch canvas to the terminal and DOES inherit
 * these CSS text properties. Copy them before any glyph is rasterized.
 */
export function applyCaptureTypography(host: HTMLElement, sessionId: string): void {
  const source = (liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term)?.element;
  const element = source?.isConnected ? source : document.getElementById("root") ?? document.body;
  const style = getComputedStyle(element);
  for (const property of ["-webkit-font-smoothing", "-moz-osx-font-smoothing", "text-rendering",
    "font-feature-settings", "font-variant-ligatures", "font-kerning", "font-variation-settings", "font-optical-sizing"]) {
    host.style.setProperty(property, style.getPropertyValue(property));
  }
}

interface CaptureCore {
  writeSync?: (text: string) => void;
  _coreBrowserService?: { readonly dpr: number };
  _renderService?: {
    _renderRows?: (start: number, end: number) => void;
    handleDevicePixelRatioChange?: () => void;
    _renderer?: { value?: {
      _canvas?: HTMLCanvasElement; _gl?: WebGL2RenderingContext;
      handleResize?: (cols: number, rows: number) => void;
      dimensions?: { device: { canvas: { width: number; height: number } } };
    } };
  };
  _charSizeService?: { measure: () => void; hasValidSize: boolean };
}
function captureCore(term: Terminal): CaptureCore {
  return (term as unknown as { _core: CaptureCore })._core;
}

/** xterm 6.0.0 reads DPR through this instance's browser service. Shadow its
 * getter, never Window.devicePixelRatio or the shared prototype. Window DPR
 * notifications still call the normal handler and therefore keep this value.
 */
export function setCaptureDpr(term: Terminal, scale: number): boolean {
  const core = captureCore(term);
  const browser = core?._coreBrowserService;
  const service = core?._renderService;
  if (!browser || typeof browser.dpr !== "number" || typeof service?.handleDevicePixelRatioChange !== "function") return false;
  const previous = Object.getOwnPropertyDescriptor(browser, "dpr");
  try {
    Object.defineProperty(browser, "dpr", { configurable: true, get: () => scale });
  } catch { return false; }
  try {
    service.handleDevicePixelRatioChange();
  } catch {
    if (previous) Object.defineProperty(browser, "dpr", previous);
    else Reflect.deleteProperty(browser, "dpr");
    throw new Error(UNAVAILABLE);
  }
  return true;
}

/** If a later xterm removes the instance DPR entry, rasterize new glyphs at
 * the requested size instead. This fallback may round cell sizes differently;
 * it still never rescales a bitmap. Called only on the capture terminal.
 */
export function applyCaptureScale(term: Terminal, options: ITerminalOptions, scale: number): CaptureScalePath {
  if (setCaptureDpr(term, scale)) { term.options = options; return "dpr"; }
  const ratio = scale / window.devicePixelRatio;
  term.options = { ...options, fontSize: options.fontSize! * ratio, letterSpacing: (options.letterSpacing ?? 0) * ratio };
  return "font";
}

/** Font failures use the browser's ordinary fallback stack, just like live
 * xterm. A pending load is awaited inside the service's 400 ms deadline.
 */
export async function loadCaptureFonts(options: ITerminalOptions): Promise<void> {
  await Promise.all([options.fontWeight ?? 500, options.fontWeightBold ?? 700].map(async weight => {
    try { await document.fonts?.load(`${weight} ${options.fontSize}px ${options.fontFamily}`); }
    catch { /* Missing/unusable fonts fall through to the same system fonts. */ }
  }));
}

/** The capture terminal has only synchronous CSI observers and trusted cells.
 * xterm's ordinary write queue uses setTimeout, which WebKit throttles in an
 * occluded window. Guard the pinned synchronous entry and verify the result
 * before rendering; use the public queue if a later xterm removes the entry.
 */
export async function writeCaptureScreen(term: Terminal, screen: TerminalScreenSnapshot): Promise<"sync" | "async"> {
  const core = captureCore(term);
  const text = serializeCaptureScreen(screen);
  if (typeof core?.writeSync === "function") {
    core.writeSync(text);
    return "sync";
  }
  await new Promise<void>(resolve => term.write(text, resolve));
  return "async";
}

/** Also used by the e2e-only live reference hook. Copy INSIDE the render task,
 * before preserveDrawingBuffer=false is cleared. Never await between the two.
 * DPR/typography have already been configured on the capture terminal. Always
 * copy backing pixels 1:1, including fractional DPR's rounded cell dimensions.
 */
export async function copyWebglTerminalGrid(
  term: Terminal, background: string,
): Promise<{ canvas: HTMLCanvasElement; renderPath: CaptureRenderPath }> {
  const service = captureCore(term)?._renderService;
  const copy = (): HTMLCanvasElement => {
    const renderer = service?._renderer?.value;
    const source = renderer?._canvas;
    if (!source || !renderer?._gl || renderer._gl.isContextLost() || !source.width || !source.height) {
      throw new Error(UNAVAILABLE);
    }
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || !canvas.width || !canvas.height) throw new Error(UNAVAILABLE);
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    return canvas;
  };
  // xterm 6.0.0: bypass both rAF and IntersectionObserver's pause bit.
  if (typeof service?._renderRows === "function") {
    service._renderRows(0, term.rows - 1);
    return { canvas: copy(), renderPath: "sync" };
  }
  let listener: IDisposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("pane.capture timeout")), CAPTURE_TIMEOUT_MS);
      listener = term.onRender(() => {
        try { resolve({ canvas: copy(), renderPath: "onRender" }); }
        catch { reject(new Error(UNAVAILABLE)); }
        finally { listener?.dispose(); }
      });
      term.refresh(0, term.rows - 1);
    });
  } finally { listener?.dispose(); clearTimeout(timer); }
}

export function canvasBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error(UNAVAILABLE));
  }, type));
}

export async function pngCaptureImage(canvas: HTMLCanvasElement, target: Pick<ResolvedCaptureScale, "scale" | "native">): Promise<CaptureImage> {
  // Chromium may defer toBlob's background encoding task past an accelerated
  // timer (headless virtual time) or an occluded window's deadline. Encode the
  // copied 2D canvas synchronously; the caller checks wall time immediately
  // afterwards. This also avoids Blob -> bytes -> binary -> base64 duplicates.
  const prefix = "data:image/png;base64,";
  const url = canvas.toDataURL("image/png");
  if (!url.startsWith(prefix) || url.length === prefix.length) throw new Error(UNAVAILABLE);
  return { type: "image/png", scale: target.scale, native: target.native,
    width: canvas.width, height: canvas.height, data: url.slice(prefix.length) };
}

export interface CaptureRenderer {
  diagnostics?(): { stage: string; stageDurationMs: number; stageMs: Record<string, number>; scalePath?: CaptureScalePath };
  render(screen: PaneCaptureScreen, target: ResolvedCaptureScale, check: () => void): Promise<{ image: CaptureImage; renderPath: CaptureRenderPath }>;
  dispose(): void;
}
interface CaptureTerminal {
  term: Terminal; host: HTMLDivElement; lost: boolean; addon?: WebglAddon; rendererSetting: string;
  grid?: { cols: number; rows: number; dpr: number; width: number; height: number; metrics: string };
}

export class BrowserCaptureRenderer implements CaptureRenderer {
  private terminal?: CaptureTerminal;
  private measurement = { stage: "idle", at: performance.now(), stageMs: {} as Record<string, number> };
  private scalePath?: CaptureScalePath;

  diagnostics() {
    return { stage: this.measurement.stage, stageDurationMs: performance.now() - this.measurement.at,
      stageMs: { ...this.measurement.stageMs }, scalePath: this.scalePath };
  }

  dispose(): void {
    const resource = this.terminal;
    this.terminal = undefined;
    if (!resource) return;
    // Activation can fail after the addon owns a renderer but before it is
    // installed on RenderService. Retain that context for cleanup as well.
    const gl = captureCore(resource.term)?._renderService?._renderer?.value?._gl
      ?? (resource.addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext } } | undefined)?._renderer?._gl;
    try { resource.term.dispose(); }
    finally {
      try { resource.addon?.dispose(); }
      finally {
        try { resource.host.remove(); }
        // WebglAddon releases objects but does not explicitly return its context.
        finally { gl?.getExtension("WEBGL_lose_context")?.loseContext(); }
      }
    }
  }

  private getTerminal(options: ITerminalOptions, cols: number, rows: number, sessionId: string): CaptureTerminal {
    const rendererSetting = useSettingsStore.getState().terminalRenderer;
    const appearance = readLiveTerminalAppearance();
    if (resolveEffectiveTerminalRenderer(rendererSetting, appearance.mediaActive, appearance.terminalOpacity) !== "webgl") {
      this.dispose(); throw new Error(UNAVAILABLE);
    }
    if (this.terminal?.lost || (this.terminal && this.terminal.rendererSetting !== rendererSetting)) this.dispose();
    if (this.terminal) {
      const previousStyle = this.terminal.host.style.cssText;
      applyCaptureTypography(this.terminal.host, sessionId);
      // CSS text policy is not part of xterm's atlas cache key. Release our
      // old terminal so it cannot keep glyphs baked with the previous policy.
      if (previousStyle === this.terminal.host.style.cssText) return this.terminal;
      this.dispose();
    }
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true"); host.inert = true;
    Object.assign(host.style, {
      position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh",
      opacity: "0", pointerEvents: "none", zIndex: "-2147483648", contain: "strict",
    });
    document.body.append(host);
    applyCaptureTypography(host, sessionId);
    const term = new Terminal({ ...options, cols, rows });
    const resource: CaptureTerminal = { term, host, lost: false, rendererSetting };
    this.terminal = resource;
    try {
      trackTerminalScreenState(term, () => term.options.theme);
      term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11";
      term.open(host);
      return resource;
    } catch { this.dispose(); throw new Error(UNAVAILABLE); }
  }

  async render(screen: PaneCaptureScreen, target: ResolvedCaptureScale, check: () => void) {
    const measurement = { stage: "options", at: performance.now(), stageMs: {} as Record<string, number> };
    this.measurement = measurement;
    const phase = (stage: string) => {
      const now = performance.now();
      measurement.stageMs[measurement.stage] = now - measurement.at;
      measurement.stage = stage; measurement.at = now;
    };
    const options = captureTerminalOptions(screen.sessionId, screen);
    phase("fonts");
    // Font loading is asynchronous, but does not rely on rAF.
    await loadCaptureFonts(options);
    check();
    phase("initialize");
    const resource = this.getTerminal(options, screen.cols, screen.rows, screen.sessionId);
    const { term } = resource;
    let canvas: HTMLCanvasElement | undefined;
    try {
      this.scalePath = applyCaptureScale(term, options, target.renderDpr);
      if (this.scalePath === "font") { await loadCaptureFonts(term.options); check(); }
      term.reset(); resetTerminalScreenState(term);
      term.resize(screen.cols, screen.rows);
      captureCore(term)._charSizeService?.measure();
      if (!captureCore(term)._charSizeService?.hasValidSize) throw new Error(UNAVAILABLE);
      if (!resource.addon) {
        const addon = new WebglAddon(false);
        resource.addon = addon;
        term.loadAddon(addon);
        addon.onContextLoss(() => { resource.lost = true; });
      }
      // RenderService may defer resizes in occluded windows. The WebGL
      // ResizeObserver may also have applied the *window's* physical DPR.
      // Correct those changes before painting, but leave an unchanged backing
      // alone: handleResize reallocates it and reuploads the glyph atlas.
      const renderer = captureCore(term)._renderService?._renderer?.value;
      const backing = renderer?._canvas, expected = renderer?.dimensions?.device.canvas;
      const previous = resource.grid;
      // Option-driven resizes can also be deferred while hidden, before the
      // renderer's dimensions have caught up (notably lineHeight changes).
      const metrics = JSON.stringify([term.options.fontFamily, term.options.fontSize, term.options.lineHeight,
        term.options.letterSpacing, term.options.fontWeight, term.options.fontWeightBold]);
      if (!backing) throw new Error(UNAVAILABLE);
      if (!previous || previous.cols !== screen.cols || previous.rows !== screen.rows || previous.dpr !== target.renderDpr
        || previous.metrics !== metrics
        || previous.width !== backing.width || previous.height !== backing.height
        || (expected && (backing.width !== expected.width || backing.height !== expected.height))) {
        renderer?.handleResize?.(screen.cols, screen.rows);
      }
      resource.grid = { cols: screen.cols, rows: screen.rows, dpr: target.renderDpr,
        width: backing.width, height: backing.height, metrics };
      phase("write");
      await writeCaptureScreen(term, screen);
      check();
      if (resource.lost) throw new Error(UNAVAILABLE);
      if (!screen.atBottom && !screen.alternateScreen) term.scrollToTop();
      phase("verify");
      verifyCaptureScreen(term, screen);
      check();
      phase("render");
      const copy = await copyWebglTerminalGrid(term, screen.theme.background);
      canvas = copy.canvas;
      check();
      phase("encode");
      const image = await pngCaptureImage(canvas, target);
      check();
      if (resource.lost) throw new Error(UNAVAILABLE);
      phase("complete");
      return { image, renderPath: copy.renderPath };
    } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }
}

/** One owner per window. Acquisition is serialized too, but the 400 ms clock
 * starts after pane.screen has been read. Timed-out completions cannot publish
 * or touch a subsequent capture's terminal. Nothing here logs screen contents.
 */
export class TerminalCaptureService {
  private active?: object;
  private idle?: ReturnType<typeof setTimeout>;
  private captures = 0;
  private lastRenderPath: CaptureRenderPath | null = null;
  private allocated = false;

  constructor(private readonly renderer: CaptureRenderer) {}

  diagnostics() {
    return { busy: !!this.active, allocated: this.allocated, captures: this.captures, renderPath: this.lastRenderPath, render: this.renderer.diagnostics?.() };
  }

  dispose(): void {
    clearTimeout(this.idle); this.idle = undefined;
    try { this.renderer.dispose(); }
    catch { /* Cleanup must not escape an idle callback or replace a wire error. */ }
    finally { this.allocated = false; }
  }

  async capture(read: () => Promise<PaneCaptureScreen>, value?: unknown, isCurrent = () => true): Promise<PaneCaptureResult> {
    const request = validateCaptureScale(value);
    if (this.active) throw new Error("pane.capture busy");
    const ticket = {};
    this.active = ticket;
    clearTimeout(this.idle);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let started: number | undefined;
    const check = () => {
      if (this.active !== ticket || (started !== undefined && performance.now() - started >= CAPTURE_TIMEOUT_MS)) {
        throw new Error("pane.capture timeout");
      }
      if (!isCurrent()) throw new Error(LIFETIME_CHANGED);
    };
    try {
      check();
      const screen = await read();
      check();
      const target = resolveCaptureScale(request, window.devicePixelRatio);
      started = performance.now();
      this.allocated = true;
      const rendered = await Promise.race([
        this.renderer.render(screen, target, check),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("pane.capture timeout")), CAPTURE_TIMEOUT_MS);
        }),
      ]);
      check();
      const elapsedMs = performance.now() - started;
      this.captures++; this.lastRenderPath = rendered.renderPath;
      return { sessionId: screen.sessionId, screen, image: rendered.image, renderer: "webgl", elapsedMs };
    } catch (error) {
      if (started === undefined) throw error;
      const failure = error instanceof Error && [LIFETIME_CHANGED, "pane.capture timeout", UNAVAILABLE].includes(error.message)
        ? error : new Error(UNAVAILABLE);
      // A slow cold frame should warm the next attempt, rather than cause an
      // endless cold-start/timeout loop. Ticket checks discard late results.
      if (failure.message === UNAVAILABLE) this.dispose();
      throw failure;
    } finally {
      clearTimeout(timeout);
      if (this.active === ticket) this.active = undefined;
      this.idle = setTimeout(() => this.dispose(), CAPTURE_IDLE_MS);
    }
  }
}

const service = new TerminalCaptureService(new BrowserCaptureRenderer());
export const captureTerminalScreen = service.capture.bind(service);
export const terminalCaptureDiagnostics = service.diagnostics.bind(service);
