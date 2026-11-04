// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The published ESM file has no adjacent declarations.
import { Terminal as PublishedTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";
import {
  CAPTURE_IDLE_MS, CAPTURE_TIMEOUT_MS, TerminalCaptureService, captureTerminalOptions, applyCaptureTypography,
  applyCaptureScale, setCaptureDpr, loadCaptureFonts, pngCaptureImage,
  copyWebglTerminalGrid, serializeCaptureScreen, validateCaptureScale, resolveCaptureScale, verifyCaptureScreen, writeCaptureScreen,
  type CaptureRenderer, type PaneCaptureScreen,
} from "../../src/components/terminal/terminalCapture";
import { buildTerminalOptions, resolveTerminalTheme } from "../../src/components/terminal/terminalOptions";
import { snapshotTerminalScreen, terminalScreenTheme } from "../../src/components/terminal/terminalScreenSnapshot";
import { trackTerminalScreenState, terminalScreenCursorVisible } from "../../src/components/terminal/terminalScreenState";
import { useThemeStore } from "../../src/stores/themeStore";
import { setEffectiveMediaActive, readLiveTerminalAppearance } from "../../src/stores/compositionStore";
import { liveTerms, termCache } from "../../src/components/terminal/terminalCache";

const Headless = PublishedTerminal as typeof import("@xterm/headless").Terminal;
const terms: InstanceType<typeof Headless>[] = [];
function terminal(cols = 62, rows = 48) {
  const term = new Headless({ cols, rows, scrollback: 5000, allowProposedApi: true, logLevel: "off" });
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11";
  trackTerminalScreenState(term); terms.push(term); return term;
}
const write = (term: InstanceType<typeof Headless>, text: string) => new Promise<void>(resolve => term.write(text, resolve));
const theme = terminalScreenTheme({ foreground: "#e0e0e0", background: "#101010", cursor: "#ffffff" });
const snapshot = (term: InstanceType<typeof Headless>) => snapshotTerminalScreen(term, theme, { cursorVisible: terminalScreenCursorVisible(term) });
const fixture = "\x1b[2J\x1b[H┌──────────────────────────────────────┐\r\n"
  + "│ サンプル企画  北斗学院 🧪 e\u0301         │\r\n"
  + "└──────────────────────────────────────┘\r\n\r\n"
  + "    indentation and a blank row above\r\n"
  + "\x1b[1mBOLD\x1b[0m \x1b[2mDIM\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDERLINE\x1b[0m\r\n"
  + "\x1b[7mINVERSE\x1b[0m \x1b[9mSTRIKE\x1b[0m \x1b[1;2;3;4;7;9mALL\x1b[0m\r\n"
  + "\x1b[38;5;201m256 COLOR\x1b[0m \x1b[38;2;23;170;230mRGB\x1b[0m DEFAULT\r\n"
  + "\x1b[48;5;25m          \x1b[0m\r\n\x1b[31m- removed\x1b[0m\r\n\x1b[32m+ added\x1b[0m\r\n"
  + "\x1b[8mconcealed 日本\x1b[0m end\r\n"
  + "\x1b[38;5;16;48;2;4;5;6m日本😀\x1b[0m\r\n";

beforeEach(() => {
  liveTerms.clear(); termCache.clear(); setEffectiveMediaActive(false);
  useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", fontSize: 14, lineHeight: 1.35, themeTweaks: undefined });
});
afterEach(() => {
  terms.splice(0).forEach(term => term.dispose()); liveTerms.clear(); termCache.clear();
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("capture physical screen replay", () => {
  it.each([[120, 40], [62, 48], [20, 8]])("round trips all six flags, colors, indentation, CJK and emoji at %ix%i", async (cols, rows) => {
    const source = terminal(cols, rows), target = terminal(cols, rows);
    await write(source, fixture);
    const screen = snapshot(source);
    await writeCaptureScreen(target as unknown as Terminal, screen);
    expect(snapshot(target)).toEqual(screen);
    expect(() => verifyCaptureScreen(target as unknown as Terminal, screen)).not.toThrow();
  });

  it.each([true, false])("round trips alternate screens and cursor visibility=%s", async visible => {
    const source = terminal(), target = terminal();
    await write(source, fixture + "\x1b[?1049h" + fixture + "\x1b[?25" + (visible ? "h" : "l"));
    const screen = snapshot(source);
    await writeCaptureScreen(target as unknown as Terminal, screen);
    expect(snapshot(target)).toEqual(screen);
  });

  it.each(["offscreen", "in viewport"])("preserves a scrolled PC viewport with its cursor %s", async kind => {
    const source = terminal(20, 5), target = terminal(20, 5);
    await write(source, Array.from({ length: 20 }, (_, i) => `  line ${i}\r\n`).join(""));
    source.scrollToLine(kind === "offscreen" ? 2 : source.buffer.active.baseY - 1);
    if (kind === "in viewport") await write(source, "\x1b[1;4H");
    const screen = snapshot(source);
    expect(screen.atBottom).toBe(false);
    expect(screen.cursor === null).toBe(kind === "offscreen");
    await writeCaptureScreen(target as unknown as Terminal, screen); target.scrollToTop();
    expect(snapshot(target)).toEqual(screen);
  });

  it("resets a previous tab, including alternate contents, before reuse", async () => {
    const source = terminal(20, 5), target = terminal(20, 5);
    await write(target, "\x1b[?1049h\x1b[41mOLD"); target.reset();
    await write(source, "new\x1b[?25l");
    const screen = snapshot(source);
    await writeCaptureScreen(target as unknown as Terminal, screen);
    expect(snapshot(target)).toEqual(screen);
  });

  it("rejects replay divergence with a fixed error without disclosing the cells", async () => {
    const source = terminal(), target = terminal(); await write(source, fixture);
    expect(() => verifyCaptureScreen(target as unknown as Terminal, snapshot(source))).toThrow(/^pane.capture unavailable$/);
  });
});

describe("shared terminal options", () => {
  it.each(["mayonaka", "kyokuya", "geppaku"])("preserves live typography and rendering policy for %s", id => {
    useThemeStore.getState().hydrateSettings({ themeId: id, fontSize: 13, lineHeight: 1.1 });
    const state = useThemeStore.getState(), appearance = readLiveTerminalAppearance();
    const live = buildTerminalOptions({ fontSize: state.fontSize, fontFamily: state.fontFamily, lineHeight: state.lineHeight,
      theme: resolveTerminalTheme(state.theme.terminal, appearance.terminalOpacity, appearance.mediaActive),
      cursorBlink: true, minimumContrastRatio: appearance.minimumContrastRatio });
    const screen = { ...snapshot(terminal()), theme: terminalScreenTheme(live.theme) };
    const capture = captureTerminalOptions("unmounted", screen);
    for (const key of ["fontFamily", "fontSize", "lineHeight", "fontWeight", "fontWeightBold", "letterSpacing",
      "cursorStyle", "customGlyphs", "rescaleOverlappingGlyphs", "allowTransparency", "windowsPty", "minimumContrastRatio"] as const) {
      expect(capture[key], key).toEqual(live[key]);
    }
    expect(terminalScreenTheme(capture.theme)).toEqual(terminalScreenTheme(live.theme));
    expect(capture.theme?.background).toBe(screen.theme.background);
    expect(capture.cursorBlink).toBe(false); expect(capture.disableStdin).toBe(true);
    expect(live).toMatchObject({ fontWeight: 500, fontWeightBold: 700, letterSpacing: 0, scrollback: 5000,
      altClickMovesCursor: false, macOptionClickForcesSelection: true, rightClickSelectsWord: true,
      smoothScrollDuration: 0, allowProposedApi: true });
  });

  it("inherits the live canvas text policy instead of the body font smoothing", () => {
    const root = document.createElement("div"), source = document.createElement("div"), host = document.createElement("div");
    root.id = "root"; root.append(source); document.body.append(root, host);
    // jsdom does not implement this WebKit-only property. Keep the supported
    // CSS reads real and assert the transfer to setProperty for smoothing.
    const computed = getComputedStyle;
    const readStyle = vi.spyOn(globalThis, "getComputedStyle").mockImplementation(element => {
      const style = computed(element);
      return { getPropertyValue: (property: string) => property === "-webkit-font-smoothing" ? "auto" : style.getPropertyValue(property) } as CSSStyleDeclaration;
    });
    const setProperty = vi.spyOn(host.style, "setProperty");
    source.style.setProperty("font-feature-settings", '"liga" 0');
    source.style.setProperty("text-rendering", "geometricPrecision");
    liveTerms.set("styled", { element: source } as Terminal);
    try {
      applyCaptureTypography(host, "styled");
      expect(setProperty).toHaveBeenCalledWith("-webkit-font-smoothing", "auto");
      expect(readStyle).toHaveBeenLastCalledWith(source);
      expect(host.style.getPropertyValue("font-feature-settings")).toBe('"liga" 0');
      expect(host.style.getPropertyValue("text-rendering").toLowerCase()).toBe("geometricprecision");
      source.remove();
      applyCaptureTypography(host, "styled");
      expect(setProperty).toHaveBeenCalledWith("-webkit-font-smoothing", "auto");
      expect(readStyle).toHaveBeenLastCalledWith(root);
    } finally { root.remove(); host.remove(); }
  });

  it("applies store changes on the next capture and preserves OSC screen colors", () => {
    const screen = snapshot(terminal());
    const first = captureTerminalOptions("cold", screen);
    useThemeStore.getState().hydrateSettings({ themeId: "kyokuya", fontSize: 17, lineHeight: 1.8 });
    screen.theme = { ...screen.theme, foreground: "#112233", background: "#445566" };
    const second = captureTerminalOptions("cold", screen);
    expect(second.fontSize).toBe(17); expect(second.lineHeight).toBe(1.8);
    expect(second.theme).toMatchObject({ foreground: "#112233", background: "#445566" });
    expect(first.fontSize).toBe(14);
  });

  it("re-reads live font, weight, spacing, glyph and contrast overrides on every capture", () => {
    const options = { fontFamily: "monospace", fontSize: 15, lineHeight: 1.6, fontWeight: 400,
      fontWeightBold: 900, letterSpacing: 1.2, cursorStyle: "bar", customGlyphs: false,
      rescaleOverlappingGlyphs: false, allowTransparency: false, windowsPty: { backend: "conpty", buildNumber: 22631 }, minimumContrastRatio: 3 };
    liveTerms.set("custom", { options } as unknown as Terminal);
    const screen = snapshot(terminal());
    expect(captureTerminalOptions("custom", screen)).toMatchObject(options);
    Object.assign(options, { fontFamily: "serif", fontWeight: 600, letterSpacing: 2, minimumContrastRatio: 4,
      cursorStyle: "underline", windowsPty: { backend: "conpty", buildNumber: 26100 } });
    expect(captureTerminalOptions("custom", screen)).toMatchObject(options);
  });
});

describe("capture DPR and fonts", () => {
  it.each([1, 1.1, 1.15, 1.25, 1.5, 1.75, 2])("isolates DPR %s on one instance, including subsequent window notifications", scale => {
    let windowDpr = window.devicePixelRatio;
    const prototype = { get dpr() { return windowDpr; } };
    const captureBrowser = Object.create(prototype), liveBrowser = Object.create(prototype);
    const change = vi.fn(() => expect(captureBrowser.dpr).toBe(scale));
    const target = { _core: { _coreBrowserService: captureBrowser, _renderService: { handleDevicePixelRatioChange: change } } } as unknown as Terminal;
    expect(setCaptureDpr(target, scale)).toBe(true);
    windowDpr = 3; change();
    expect(captureBrowser.dpr).toBe(scale); expect(liveBrowser.dpr).toBe(3);
    expect(window.devicePixelRatio).toBe(1);
    expect(Object.hasOwn(prototype, "dpr")).toBe(true);
  });

  it("keeps CSS options unchanged for a requested DPR and can switch back to native", () => {
    const browser = { dpr: 1 }, options = { fontSize: 13, letterSpacing: 1, lineHeight: 1.1 };
    const target = { options: {}, _core: { _coreBrowserService: browser,
      _renderService: { handleDevicePixelRatioChange: vi.fn() } } } as unknown as Terminal;
    expect(applyCaptureScale(target, options, 2)).toBe("dpr");
    expect(target.options).toEqual(options); expect(browser.dpr).toBe(2);
    expect(applyCaptureScale(target, options, 1)).toBe("dpr"); expect(browser.dpr).toBe(1);
  });

  it.each(["missing browser", "missing handler", "sealed getter"])("rasterizes scaled fonts when the private DPR API has a %s", condition => {
    const browser = condition === "sealed getter" ? Object.freeze({ dpr: 1 }) : { dpr: 1 };
    const target = { options: {}, _core: {
      _coreBrowserService: condition === "missing browser" ? undefined : browser,
      _renderService: condition === "missing handler" ? {} : { handleDevicePixelRatioChange() {} },
    } } as unknown as Terminal;
    const options = { fontSize: 13, fontFamily: "monospace", letterSpacing: 1.5, lineHeight: 1.1 };
    expect(applyCaptureScale(target, options, 2)).toBe("font");
    expect(target.options).toEqual({ ...options, fontSize: 26, letterSpacing: 3 });
    expect(options.fontSize).toBe(13); expect(browser.dpr).toBe(1);
  });

  it("restores an overridden getter if the private notification fails", () => {
    const browser = { dpr: 1 };
    const target = { _core: { _coreBrowserService: browser,
      _renderService: { handleDevicePixelRatioChange() { throw new Error("internal details"); } } } } as unknown as Terminal;
    expect(() => setCaptureDpr(target, 2)).toThrow(/^pane.capture unavailable$/);
    expect(browser.dpr).toBe(1);
  });

  it("awaits both configured weights and lets font failures use the ordinary fallback stack", async () => {
    let finish!: () => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("missing fixture font"));
    vi.stubGlobal("FontFaceSet", undefined);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    try {
      let completed = false;
      const pending = loadCaptureFonts({ fontFamily: '"Fixture Font", monospace', fontSize: 15, fontWeight: 400, fontWeightBold: 800 })
        .then(() => { completed = true; });
      await Promise.resolve(); expect(completed).toBe(false);
      expect(load.mock.calls).toEqual([['400 15px "Fixture Font", monospace'], ['800 15px "Fixture Font", monospace']]);
      finish(); await pending; expect(completed).toBe(true);
    } finally { Reflect.deleteProperty(document, "fonts"); vi.unstubAllGlobals(); }
  });
});

describe("capture serialization and deadline", () => {
  const image = { type: "image/png" as const, scale: 1, native: true, width: 20, height: 5, data: "synthetic-png" };
  const rendered = { image, renderPath: "sync" as const };
  let renderer: CaptureRenderer, service: TerminalCaptureService, screen: PaneCaptureScreen;
  beforeEach(() => {
    vi.useFakeTimers(); screen = { sessionId: "test-session", ...snapshot(terminal(20, 5)) };
    renderer = { render: vi.fn().mockResolvedValue(rendered), dispose: vi.fn() };
    service = new TerminalCaptureService(renderer);
  });
  afterEach(() => service.dispose());

  it.each([null, 0, 3, -1, 1.5, "1", true, NaN, Infinity])("rejects scale=%s with the contract error", async value => {
    await expect(service.capture(async () => screen, value)).rejects.toThrow(/^pane.capture scale must be native, 1 or 2$/);
    expect(renderer.render).not.toHaveBeenCalled();
  });
  it("defaults scale to native and accepts 2", async () => {
    expect(validateCaptureScale(undefined)).toBe("native"); expect(validateCaptureScale(2)).toBe(2);
    expect(await service.capture(async () => screen)).toEqual({ sessionId: "test-session", screen, image, renderer: "webgl", elapsedMs: 0 });
    await service.capture(async () => screen, 2);
    expect(renderer.render).toHaveBeenLastCalledWith(screen, { scale: 2, native: false, renderDpr: 2 }, expect.any(Function));
  });
  it("resolves fractional native DPR to two decimals and numeric scales report native equality", () => {
    expect(resolveCaptureScale(undefined, 1.5)).toEqual({ scale: 1.5, native: true, renderDpr: 1.5 });
    expect(resolveCaptureScale("native", 1.33333)).toEqual({ scale: 1.33, native: true, renderDpr: 1.33333 });
    expect(resolveCaptureScale(1, 1)).toEqual({ scale: 1, native: true, renderDpr: 1 });
    expect(resolveCaptureScale(2, 1.5)).toEqual({ scale: 2, native: false, renderDpr: 2 });
    expect(() => validateCaptureScale(1.5)).toThrow("pane.capture scale must be native, 1 or 2");
  });
  it("rejects a concurrent request immediately, including during screen acquisition", async () => {
    let finish!: (value: PaneCaptureScreen) => void;
    const pending = service.capture(() => new Promise(resolve => { finish = resolve; }));
    const read = vi.fn();
    await expect(service.capture(read)).rejects.toThrow(/^pane.capture busy$/);
    expect(read).not.toHaveBeenCalled();
    finish(screen); await pending;
  });
  it("excludes acquisition from elapsedMs and the render deadline", async () => {
    const pending = service.capture(() => new Promise(resolve => setTimeout(() => resolve(screen), 1000)));
    await vi.advanceTimersByTimeAsync(1000); expect((await pending).elapsedMs).toBe(0);
  });
  it("times out at 400 ms, discards late output and lets a new capture proceed", async () => {
    let finish!: () => void;
    vi.mocked(renderer.render).mockImplementationOnce(async (_screen, _scale, check) => {
      await new Promise<void>(resolve => { finish = resolve; }); check(); return rendered;
    });
    const pending = expect(service.capture(async () => screen)).rejects.toThrow(/^pane.capture timeout$/);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS); await pending;
    expect(renderer.dispose).not.toHaveBeenCalled();
    const next = await service.capture(async () => screen); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(next.screen).toBe(screen); expect(service.diagnostics()).toMatchObject({ captures: 1, busy: false });
  });
  it("checks wall time even when a synchronous task prevents the timeout callback", async () => {
    vi.mocked(renderer.render).mockImplementationOnce(async () => { vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS + 1); return rendered; });
    await expect(service.capture(async () => screen)).rejects.toThrow(/^pane.capture timeout$/);
  });
  it.each(["pane.capture unavailable", "private screen text"])("sanitizes renderer failure %s", async message => {
    vi.mocked(renderer.render).mockRejectedValueOnce(new Error(message));
    await expect(service.capture(async () => screen)).rejects.toThrow(/^pane.capture unavailable$/);
    expect(service.diagnostics().allocated).toBe(false);
  });
  it("preserves pane.screen acquisition errors", async () => {
    await expect(service.capture(async () => { throw new Error("no terminal buffer for session"); })).rejects.toThrow(/^no terminal buffer for session$/);
    expect(renderer.render).not.toHaveBeenCalled();
  });
  it("rejects a lifetime change after encoding instead of returning stale content", async () => {
    let current = true;
    vi.mocked(renderer.render).mockImplementationOnce(async () => { current = false; return rendered; });
    await expect(service.capture(async () => screen, 1, () => current)).rejects.toThrow(/^pane read lifetime changed$/);
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(service.diagnostics().allocated).toBe(true);
  });
  it("finishes idle cleanup and preserves fixed capture errors if disposal throws", async () => {
    vi.mocked(renderer.dispose).mockImplementation(() => { throw new Error("private cleanup details"); });
    await service.capture(async () => screen);
    await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS);
    expect(service.diagnostics().allocated).toBe(false);
    vi.mocked(renderer.render).mockRejectedValueOnce(new Error("private render details"));
    await expect(service.capture(async () => screen)).rejects.toThrow(/^pane.capture unavailable$/);
    expect(service.diagnostics().allocated).toBe(false);
  });
  it("returns the extra context after 60 seconds idle and restarts the idle clock on use", async () => {
    await service.capture(async () => screen); await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS - 1);
    expect(renderer.dispose).not.toHaveBeenCalled(); await service.capture(async () => screen);
    await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS - 1); expect(renderer.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(service.diagnostics()).toMatchObject({ allocated: false });
  });
  it("does not send screen text or images to any console method", async () => {
    const spies = ["log", "warn", "error", "debug", "info"].map(key => vi.spyOn(console, key as "log").mockImplementation(() => {}));
    screen.lines[0] = [[0, 1, "private fixture", null, null, 0]];
    await service.capture(async () => screen);
    vi.mocked(renderer.render).mockRejectedValueOnce(new Error("private fixture"));
    await expect(service.capture(async () => screen)).rejects.toThrow("pane.capture unavailable");
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });
});

describe("capture write scheduling", () => {
  it("uses a guarded synchronous parser without waiting for a background timer", async () => {
    const screen = snapshot(terminal()), sync = vi.fn(), queued = vi.fn();
    const target = { _core: { writeSync: sync }, write: queued } as unknown as Terminal;
    const pending = writeCaptureScreen(target, screen);
    expect(sync).toHaveBeenCalledWith(serializeCaptureScreen(screen));
    expect(queued).not.toHaveBeenCalled(); expect(await pending).toBe("sync");
  });
  it("falls back to the public callback when the private parser entry is unavailable", async () => {
    const screen = snapshot(terminal()); let complete!: () => void;
    const target = { _core: {}, write: vi.fn((_text, callback) => { complete = callback; }) } as unknown as Terminal;
    const pending = writeCaptureScreen(target, screen); complete();
    expect(await pending).toBe("async");
  });
});

describe("same-task WebGL copy", () => {
  it("encodes PNG synchronously without a background Blob task or a pixel resize", async () => {
    const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 40;
    const encode = vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/png;base64,c3ludGhldGlj");
    const blob = vi.spyOn(canvas, "toBlob");
    expect(await pngCaptureImage(canvas, { scale: 2, native: false })).toEqual({ type: "image/png",
      scale: 2, native: false, width: 80, height: 40, data: "c3ludGhldGlj" });
    expect(encode).toHaveBeenCalledExactlyOnceWith("image/png"); expect(blob).not.toHaveBeenCalled();
    const internalTarget = resolveCaptureScale("native", 1.149999976158142);
    expect(await pngCaptureImage(canvas, internalTarget)).toEqual({ type: "image/png", scale: 1.15,
      native: true, width: 80, height: 40, data: "c3ludGhldGlj" });
    encode.mockReturnValue("data:,");
    await expect(pngCaptureImage(canvas, { scale: 1, native: true })).rejects.toThrow("pane.capture unavailable");
  });
  it("renders synchronously and copies backing pixels before the drawing buffer is cleared", async () => {
    const events: string[] = [];
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn(() => events.push("copy")) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    const source = document.createElement("canvas"); source.width = 80; source.height = 40;
    const term = { rows: 5, _core: { _renderService: {
      _renderRows: () => events.push("render"),
      _renderer: { value: { _canvas: source, _gl: { isContextLost: () => false } } },
      dimensions: { css: { canvas: { width: 40, height: 20 } } },
    } } } as unknown as Terminal;
    const native = await copyWebglTerminalGrid(term, "#010203");
    expect(events).toEqual(["render", "copy"]); expect(native.renderPath).toBe("sync");
    expect([native.canvas.width, native.canvas.height]).toEqual([80, 40]);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0);
  });
  it("copies the actual backing dimensions for native fractional DPR without a rounding loss", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {}, drawImage() {} } as never);
    const source = document.createElement("canvas"); source.width = 85; source.height = 49;
    const term = { rows: 5, _core: { _renderService: {
      _renderRows() {}, _renderer: { value: { _canvas: source, _gl: { isContextLost: () => false } } },
      dimensions: { css: { canvas: { width: 57, height: 33 } } },
    } } } as unknown as Terminal;
    const result = await copyWebglTerminalGrid(term, "#000000");
    expect([result.canvas.width, result.canvas.height]).toEqual([85, 49]);
  });
  it("rejects a missing or lost WebGL renderer instead of copying DOM", async () => {
    const term = { rows: 5, _core: { _renderService: { _renderRows() {} } } } as unknown as Terminal;
    await expect(copyWebglTerminalGrid(term, "#000000")).rejects.toThrow(/^pane.capture unavailable$/);
  });

  it("uses onRender and the public refresh when the synchronous entry is absent", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {}, drawImage() {} } as never);
    const source = document.createElement("canvas"); source.width = 80; source.height = 40;
    let render!: () => void;
    const dispose = vi.fn(), refresh = vi.fn(() => render());
    const target = { rows: 5, onRender: vi.fn(callback => { render = callback; return { dispose }; }), refresh,
      _core: { _renderService: { _renderer: { value: { _canvas: source, _gl: { isContextLost: () => false } } } } },
    } as unknown as Terminal;
    const result = await copyWebglTerminalGrid(target, "#000000");
    expect(result.renderPath).toBe("onRender"); expect(refresh).toHaveBeenCalledWith(0, 4);
    expect(dispose).toHaveBeenCalled(); expect(result.canvas.width).toBe(80);
  });
});
