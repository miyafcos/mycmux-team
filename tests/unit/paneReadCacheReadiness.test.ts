import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { cacheOrDisposeOnUnmount, isTerminalBufferReady, markTerminalBufferReady, liveTerms, termCache, terminalSizeCache, type CachedTerm } from "../../src/components/terminal/terminalCache";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const ipc = vi.hoisted(() => ({ getSessionScrollback: vi.fn() }));
vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/ipc")>(),
  getSessionScrollback: ipc.getSessionScrollback,
}));

const terms: HeadlessTerminal[] = [];
function terminal(sessionId: string, cached: boolean) {
  const term = new HeadlessTerminal({ cols: 132, rows: 40, allowProposedApi: true });
  terms.push(term);
  const rendered = term as unknown as CachedTerm["term"];
  terminalSizeCache.set(sessionId, { cols: 132, rows: 40 });
  if (cached) {
    cacheOrDisposeOnUnmount(sessionId, {
      term: rendered, fitAddon: {} as CachedTerm["fitAddon"], searchAddon: {} as CachedTerm["searchAddon"],
      xtermElement: {} as HTMLElement, unlistenExit: null,
    });
  } else liveTerms.set(sessionId, rendered);
  return term;
}

beforeEach(() => {
  vi.clearAllMocks();
  const tabs = ["front", "behind", "last"].map((id) => ({ id, sessionId: id, agentId: "shell-starter", type: "terminal" as const }));
  useWorkspaceListStore.setState({ workspaces: [{
    id: "workspace", name: "Read fixture", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "pane", agentId: "shell-starter", sessionId: "front", tabs, activeTabId: "front" }],
    splitColumns: [["pane"]],
  }], activeWorkspaceId: "workspace", lastActivePaneByWorkspace: {} });
  const data = new TextEncoder().encode("M5CLOCK 1\r\n\x1b[2J\x1b[H" + "wide ".repeat(20) + "M5CLOCK 2\r\n");
  ipc.getSessionScrollback.mockResolvedValue({ data, startOffset: 0, endOffset: data.length });
});

afterEach(() => {
  terms.splice(0).forEach((term) => term.dispose());
  termCache.clear(); liveTerms.clear(); terminalSizeCache.clear();
});

describe("pane.read with actual unsynchronized retained terminals", () => {
  it.each(["MacIntel", "Win32"])("reads an unparsed cached terminal at its known size on %s", async (platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    useSettingsStore.setState({ macNativePaneTearoutEnabled: true });
    terminal("behind", true);
    const result = await handleSocketCommand("pane.read", { sessionId: "behind" }) as { lines: string[] };
    expect(result.lines).toContain("wide ".repeat(20) + "M5CLOCK 2");
    expect(ipc.getSessionScrollback).toHaveBeenCalledWith("behind");
  });

  it.each(["MacIntel", "Win32"])("reads an unparsed mounted retained terminal on %s", async (platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    terminal("behind", false);
    const result = await handleSocketCommand("pane.read", { sessionId: "behind" }) as { lines: string[] };
    expect(result.lines.some((line) => line.includes("M5CLOCK 2"))).toBe(true);
  });

  it.each([
    ["MacIntel", false], ["MacIntel", true], ["Win32", false], ["Win32", true],
  ] as const)("keeps a parsed cleared screen authoritative on %s (cached=%s)", async (platform, cached) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const term = terminal("front", cached);
    await new Promise<void>((resolve) => term.write("visible\r\n", () => {
      markTerminalBufferReady(term as unknown as CachedTerm["term"]);
      resolve();
    }));
    const visible = await handleSocketCommand("pane.read", { sessionId: "front" }) as { lines: string[] };
    expect(visible.lines).toEqual(["visible"]);
    await new Promise<void>((resolve) => term.write("\x1b[3J\x1b[2J\x1b[H", resolve));
    await expect(handleSocketCommand("pane.read", { sessionId: "front" })).resolves.toEqual({ sessionId: "front", lines: [] });
    expect(ipc.getSessionScrollback).not.toHaveBeenCalled();
  });

  it("requires the parse callback, and never carries readiness to a fresh Terminal with the same ID", async () => {
    const old = terminal("behind", true);
    const oldRendered = old as unknown as CachedTerm["term"];
    const parsed = new Promise<void>((resolve) => old.write("old cache", () => {
      markTerminalBufferReady(oldRendered);
      resolve();
    }));
    expect(isTerminalBufferReady(oldRendered)).toBe(false);
    await parsed;
    expect(isTerminalBufferReady(oldRendered)).toBe(true);
    termCache.delete("behind");
    const fresh = terminal("behind", true);
    expect(isTerminalBufferReady(fresh as unknown as CachedTerm["term"])).toBe(false);
    const result = await handleSocketCommand("pane.read", { sessionId: "behind" }) as { lines: string[] };
    expect(result.lines.some((line) => line.includes("M5CLOCK 2"))).toBe(true);
  });

  it.each(["MacIntel", "Win32"])("keeps the no-cache backend path when tear-out is OFF on %s", async (platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
    const result = await handleSocketCommand("pane.read", { sessionId: "last" }) as { lines: string[] };
    expect(result.lines.some((line) => line.includes("M5CLOCK 2"))).toBe(true);
    expect(ipc.getSessionScrollback).toHaveBeenCalledWith("last");
  });

  it("keeps a successfully synchronized truly empty terminal authoritative", async () => {
    const term = terminal("front", false);
    markTerminalBufferReady(term as unknown as CachedTerm["term"]);
    await expect(handleSocketCommand("pane.read", { sessionId: "front" })).resolves.toEqual({ sessionId: "front", lines: [] });
    expect(ipc.getSessionScrollback).not.toHaveBeenCalled();
  });
});
