// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Terminal } from "@xterm/xterm";
import { BrowserCaptureRenderer, CAPTURE_IDLE_MS, CAPTURE_TIMEOUT_MS, TerminalCaptureService, type PaneCaptureScreen } from "../../src/components/terminal/terminalCapture";
import { terminalScreenTheme } from "../../src/components/terminal/terminalScreenSnapshot";
import { liveTerms } from "../../src/components/terminal/terminalCache";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useThemeStore } from "../../src/stores/themeStore";
import { setEffectiveMediaActive } from "../../src/stores/compositionStore";

// Real published browser Terminal/parser/services, with only the GPU and PNG
// codec replaced. Windows harness covers the real GPU/codec and exact pixels.
const gpu = vi.hoisted(() => ({ resources: [] as Array<{
  term: Terminal; lost: boolean; loss: () => void; loseContext: ReturnType<typeof vi.fn>;
  canvas: HTMLCanvasElement; resize: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>;
}>, initializeMs: 0, failure: undefined as "no-webgl2" | "after-context" | undefined }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  private resource?: typeof gpu.resources[number];
  private _renderer?: unknown;
  constructor(preserve: boolean) { expect(preserve).toBe(false); }
  activate(term: Terminal) {
    if (gpu.failure === "no-webgl2") throw new Error("WebGL2 not supported");
    const core = (term as any)._core;
    const canvas = document.createElement("canvas");
    const dimensions = { css: { canvas: { width: 0, height: 0 }, cell: { width: 7, height: 14 } },
      device: { canvas: { width: 0, height: 0 } } };
    let dpr = core._coreBrowserService.dpr;
    const resource = { term, canvas, lost: false, loss: () => {}, loseContext: vi.fn(), render: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        canvas.width = cols * Math.floor(term.options.fontSize! / 2 * core._coreBrowserService.dpr);
        canvas.height = rows * Math.floor(term.options.fontSize! * term.options.lineHeight! * core._coreBrowserService.dpr);
        dimensions.device.canvas = { width: canvas.width, height: canvas.height };
        dimensions.css.canvas = { width: canvas.width / core._coreBrowserService.dpr, height: canvas.height / core._coreBrowserService.dpr };
      }) };
    this.resource = resource; gpu.resources.push(resource);
    const renderer = {
      _canvas: canvas, _gl: { isContextLost: () => resource.lost,
        getExtension: () => ({ loseContext: resource.loseContext }) }, dimensions,
      renderRows: resource.render, handleResize: resource.resize, onRequestRedraw: () => ({ dispose() {} }),
      handleDevicePixelRatioChange: () => {
        if (dpr !== core._coreBrowserService.dpr) { dpr = core._coreBrowserService.dpr; resource.resize(term.cols, term.rows); }
      },
      handleCharSizeChanged: () => resource.resize(term.cols, term.rows),
      handleSelectionChanged() {}, handleCursorMove() {}, handleBlur() {}, handleFocus() {}, clear() {}, dispose() {},
    };
    this._renderer = renderer;
    if (gpu.failure === "after-context") throw new Error("addon activation failed");
    core._renderService.setRenderer(renderer);
    resource.resize(term.cols, term.rows);
    if (gpu.initializeMs) vi.advanceTimersByTime(gpu.initializeMs);
  }
  onContextLoss(callback: () => void) { this.resource!.loss = callback; return { dispose() {} }; }
  dispose() {}
} }));

let service: TerminalCaptureService;
const extraTerms: Terminal[] = [];
const screen: PaneCaptureScreen = { sessionId: "synthetic", cols: 20, rows: 5, lines: [[], [], [], [], []],
  cursor: { col: 0, row: 0, visible: true }, alternateScreen: false, atBottom: true, scrollbackLines: 0,
  theme: terminalScreenTheme() };
const read = async () => screen;
beforeEach(() => {
  vi.useFakeTimers(); gpu.resources.length = 0; gpu.initializeMs = 0; gpu.failure = undefined;
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(224);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(14);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect() {}, drawImage() {}, measureText: () => ({ width: 7 }),
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw==");
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: vi.fn().mockResolvedValue([]) } });
  useSettingsStore.setState({ terminalRenderer: "webgl" }); setEffectiveMediaActive(false);
  useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", fontFamily: "monospace", fontSize: 14, lineHeight: 1.35 });
  service = new TerminalCaptureService(new BrowserCaptureRenderer());
});
afterEach(() => {
  service.dispose(); extraTerms.splice(0).forEach(term => term.dispose()); liveTerms.clear();
  Reflect.deleteProperty(document, "fonts"); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("pinned xterm capture integration", () => {
  it("checks the installed 6.0.0 browser services and private synchronous API at runtime", async () => {
    expect(JSON.parse(readFileSync("node_modules/@xterm/xterm/package.json", "utf8")).version).toBe("6.0.0");
    expect(JSON.parse(readFileSync("node_modules/@xterm/addon-webgl/package.json", "utf8")).version).toBe("0.19.0");
    await service.capture(read, 2);
    const core = (gpu.resources[0].term as any)._core;
    expect(typeof core.writeSync).toBe("function"); expect(typeof core._renderService._renderRows).toBe("function");
    expect(typeof core._renderService.handleDevicePixelRatioChange).toBe("function");
    expect(typeof core._charSizeService.measure).toBe("function");
    expect(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(core._coreBrowserService), "dpr")?.get).toBe("function");
    expect(core._coreBrowserService.dpr).toBe(2);
    // The addon private fields are exercised by the real Windows GPU harness;
    // guard the pinned source layout here as well as the browser runtime above.
    const addon = readFileSync("node_modules/@xterm/addon-webgl/src/WebglRenderer.ts", "utf8");
    for (const field of ["_canvas", "_gl", "handleResize", "handleDevicePixelRatioChange"]) expect(addon).toContain(field);
  });

  it("reuses one context for all scales and synchronously sizes a paused renderer", async () => {
    const first = await service.capture(read, 2);
    const resource = gpu.resources[0], core = (resource.term as any)._core;
    core._renderService._isPaused = true;
    const native = await service.capture(read);
    expect(first.image.width).toBe(native.image.width * 2);
    expect(gpu.resources).toHaveLength(1); expect(resource.render).toHaveBeenCalledTimes(2);
    expect(resource.resize).toHaveBeenLastCalledWith(20, 5);
    expect(resource.term.options.fontSize).toBe(14); expect(window.devicePixelRatio).toBe(1);
    const host = resource.term.element!.parentElement!;
    expect(host.style.opacity).toBe("0"); expect(host.style.left).toBe("0px");
    expect(host.inert).toBe(true); expect(host.getAttribute("aria-hidden")).toBe("true");
    await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS);
    expect(resource.loseContext).toHaveBeenCalledOnce(); expect(host.isConnected).toBe(false);
    await service.capture(read); expect(gpu.resources).toHaveLength(2);
  });

  it("keeps a warmed terminal after a cold initialization exceeds the deadline", async () => {
    gpu.initializeMs = CAPTURE_TIMEOUT_MS + 1;
    await expect(service.capture(read)).rejects.toThrow(/^pane.capture timeout$/);
    const resource = gpu.resources[0];
    expect(resource.loseContext).not.toHaveBeenCalled(); expect(service.diagnostics().allocated).toBe(true);
    gpu.initializeMs = 0;
    await service.capture(read);
    expect(gpu.resources).toHaveLength(1); expect(service.diagnostics().captures).toBe(1);
  });

  it.each([1.100000023841858, 1.149999976158142])("rasterizes native with the raw window DPR %s", async dpr => {
    vi.stubGlobal("devicePixelRatio", dpr);
    liveTerms.set(screen.sessionId, { options: { fontSize: 40 } } as Terminal);
    const capture = await service.capture(read);
    const core = (gpu.resources[0].term as any)._core;
    expect(core._coreBrowserService.dpr).toBe(dpr);
    expect(capture.image.scale).toBe(Math.round(dpr * 100) / 100);
    // At 115%, 20 * raw DPR floors to 22, while 20 * rounded 1.15 is 23.
    expect(capture.image.width).toBe(screen.cols * Math.floor(20 * dpr));
    expect(Object.keys(capture.image).sort()).toEqual(["data", "height", "native", "scale", "type", "width"]);
  });

  it("skips unchanged resizes but repairs observer dimensions and hidden geometry changes", async () => {
    await service.capture(read);
    const resource = gpu.resources[0], core = (resource.term as any)._core;
    core._renderService._isPaused = true;
    resource.resize.mockClear();
    await service.capture(read);
    expect(resource.resize).not.toHaveBeenCalled();
    resource.canvas.width++;
    const repaired = await service.capture(read);
    expect(resource.resize).toHaveBeenCalledOnce(); expect(repaired.image.width).toBe(140);
    resource.resize.mockClear();
    const larger = await service.capture(async () => ({ ...screen, cols: 21 }));
    expect(resource.resize).toHaveBeenCalledOnce(); expect(larger.image.width).toBe(147);
    resource.resize.mockClear();
    useThemeStore.getState().hydrateSettings({ lineHeight: 1.5 });
    const updated = await service.capture(async () => ({ ...screen, cols: 21 }));
    expect(resource.resize).toHaveBeenCalledOnce(); expect(updated.image.height).toBe(105);
    resource.resize.mockClear();
    await service.capture(async () => ({ ...screen, cols: 21 }));
    expect(resource.resize).not.toHaveBeenCalled();
  });

  it.each(["idle", "unavailable"])("removes the host and releases GL when terminal disposal throws during %s", async reason => {
    await service.capture(read);
    const resource = gpu.resources[0], host = resource.term.element!.parentElement!;
    vi.spyOn(resource.term, "dispose").mockImplementationOnce(() => { throw new Error("private disposal failure"); });
    if (reason === "idle") await vi.advanceTimersByTimeAsync(CAPTURE_IDLE_MS);
    else {
      resource.lost = true;
      await expect(service.capture(read)).rejects.toThrow(/^pane.capture unavailable$/);
    }
    expect(host.isConnected).toBe(false); expect(resource.loseContext).toHaveBeenCalledOnce();
    expect(service.diagnostics().allocated).toBe(false);
    resource.term.dispose(); // Finish this deliberately interrupted test terminal's listeners.
    await service.capture(read); expect(gpu.resources).toHaveLength(2);
  });

  it.each(["no-webgl2", "after-context"] as const)("cleans failed addon activation (%s) and can retry", async failure => {
    gpu.failure = failure;
    await expect(service.capture(read)).rejects.toThrow(/^pane.capture unavailable$/);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(service.diagnostics().allocated).toBe(false);
    if (failure === "after-context") expect(gpu.resources[0].loseContext).toHaveBeenCalledOnce();
    else expect(gpu.resources).toHaveLength(0);
    gpu.failure = undefined;
    await service.capture(read); expect(service.diagnostics().captures).toBe(1);
  });

  it("re-rasterizes after live settings and computed typography changes", async () => {
    const live = new Terminal({ fontSize: 13, fontFamily: "monospace", lineHeight: 1.1, fontWeight: 400, letterSpacing: 1 });
    extraTerms.push(live); const host = document.createElement("div"); document.body.append(host); live.open(host);
    liveTerms.set(screen.sessionId, live);
    await service.capture(read);
    live.options = { fontSize: 17, lineHeight: 1.7, fontWeight: 600, fontWeightBold: 900, letterSpacing: 2, minimumContrastRatio: 3 };
    live.element!.style.setProperty("font-feature-settings", '"liga" 0');
    const updated = await service.capture(read);
    expect(updated.image.width).toBe(160);
    expect(gpu.resources.at(-1)!.term.options).toMatchObject({ fontSize: 17, lineHeight: 1.7, fontWeight: 600,
      fontWeightBold: 900, letterSpacing: 2, minimumContrastRatio: 3 });
    expect(gpu.resources.at(-1)!.term.element!.parentElement!.style.getPropertyValue("font-feature-settings")).toBe('"liga" 0');
  });

  it("awaits fonts inside the deadline, rejects busy immediately, and recovers after a timed-out load", async () => {
    let finish!: () => void;
    vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    const pending = expect(service.capture(read)).rejects.toThrow("pane.capture timeout");
    await vi.advanceTimersByTimeAsync(399); expect(gpu.resources).toHaveLength(0);
    await expect(service.capture(read)).rejects.toThrow("pane.capture busy");
    await vi.advanceTimersByTimeAsync(1); await pending;
    await service.capture(read); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(gpu.resources).toHaveLength(1); expect(service.diagnostics().captures).toBe(1);
  });

  it("fails a lost context without publishing and creates a new one on the next capture", async () => {
    await service.capture(read); const resource = gpu.resources[0];
    resource.render.mockImplementationOnce(() => { resource.lost = true; resource.loss(); });
    await expect(service.capture(read)).rejects.toThrow("pane.capture unavailable");
    expect(resource.loseContext).toHaveBeenCalledOnce();
    await service.capture(read); expect(gpu.resources).toHaveLength(2);
  });

  it("re-reads renderer policy and recreates capture after switching back from DOM", async () => {
    await service.capture(read); useSettingsStore.setState({ terminalRenderer: "dom" });
    await expect(service.capture(read)).rejects.toThrow("pane.capture unavailable");
    useSettingsStore.setState({ terminalRenderer: "webgl" });
    await service.capture(read); expect(gpu.resources).toHaveLength(2);
  });

  it("handles a closed tab while fonts are loading without painting or logging contents", async () => {
    const spies = ["log", "warn", "error", "debug", "info"].map(key => vi.spyOn(console, key as "log").mockImplementation(() => {}));
    let finish!: () => void, current = true;
    vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    const pending = expect(service.capture(read, "native", () => current)).rejects.toThrow("pane read lifetime changed");
    await vi.advanceTimersByTimeAsync(0); current = false; finish(); await pending;
    expect(gpu.resources).toHaveLength(0); spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });
});
