import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terminalPaneSource = readFileSync(
  new URL("../../src/components/workspace/TerminalPane.tsx", import.meta.url),
  "utf8",
);
const xtermWrapperSource = readFileSync(
  new URL("../../src/components/terminal/XTermWrapper.tsx", import.meta.url),
  "utf8",
);
const socketCommandsSource = readFileSync(
  new URL("../../src/components/layout/socketCommands.ts", import.meta.url),
  "utf8",
);
const paneTabBarSource = readFileSync(
  new URL("../../src/components/workspace/PaneTabBar.tsx", import.meta.url),
  "utf8",
);

describe("terminal tab mount contract", () => {
  it("mounts one renderer for the active tab instead of every pane tab", () => {
    const rendererStart = terminalPaneSource.indexOf("activeTab && agent ?");
    const rendererEnd = terminalPaneSource.indexOf(") : null}", rendererStart);
    const rendererBlock = terminalPaneSource.slice(rendererStart, rendererEnd);

    expect(rendererStart).toBeGreaterThan(-1);
    expect(rendererEnd).toBeGreaterThan(rendererStart);
    expect(rendererBlock.match(/<XTermWrapper/g)).toHaveLength(1);
    expect(rendererBlock).toContain("sessionId={activeTab.sessionId}");
    expect(rendererBlock).not.toContain("pane.tabs.map");
  });

  it("resynchronizes backend scrollback when the active renderer attaches", () => {
    expect(xtermWrapperSource).toContain("getSessionScrollback(sessionId)");
    expect(xtermWrapperSource).toContain("terminalScrollbackResyncNeeded.add(sessionId)");
    expect(xtermWrapperSource).toContain("await syncDroppedBatchScrollbackIfNeeded()");
  });

  it("rebinds artifact links when a cached terminal is attached", () => {
    const attachStart = xtermWrapperSource.indexOf("const attachCachedTerminal");
    const attachEnd = xtermWrapperSource.indexOf("const cached = termCache.get", attachStart);
    const attachBlock = xtermWrapperSource.slice(attachStart, attachEnd);
    const cleanupStart = xtermWrapperSource.indexOf("const cleanup =");
    const cleanupEnd = xtermWrapperSource.indexOf("const attachCachedTerminal", cleanupStart);
    const cleanupBlock = xtermWrapperSource.slice(cleanupStart, cleanupEnd);

    expect(xtermWrapperSource).toContain("const registerArtifactLinks =");
    expect(attachBlock).toContain("registerArtifactLinks(cached.term)");
    expect(xtermWrapperSource).toContain("registerArtifactLinks(term)");
    expect(cleanupBlock).toContain("artifactLinkProviderDisposable?.dispose()");
  });

  it("starts background PTYs without importing an xterm renderer into the launch path", () => {
    const headlessStart = socketCommandsSource.indexOf("async function startBackgroundTabSession");
    const headlessEnd = socketCommandsSource.indexOf("function isKnownPaneSession", headlessStart);
    const headlessBlock = socketCommandsSource.slice(headlessStart, headlessEnd);

    expect(headlessStart).toBeGreaterThan(-1);
    expect(headlessEnd).toBeGreaterThan(headlessStart);
    expect(headlessBlock).toContain("await createSession(");
    expect(headlessBlock).not.toContain("XTermWrapper");
    expect(headlessBlock).not.toContain("@xterm/");
    expect(headlessBlock).not.toContain("new Terminal");
  });

  it("routes declared tab clicks through the flag-guarded layout-store action", () => {
    expect(paneTabBarSource).not.toContain("handleSocketCommand");
    expect(paneTabBarSource).toContain("const launchDeclaredTab = useWorkspaceLayoutStore");
    expect(paneTabBarSource).toContain("if (!declaredLaunchEnabled) return;");
    expect(paneTabBarSource).not.toContain("is-declared");
  });
});
