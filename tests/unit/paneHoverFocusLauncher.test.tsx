// @vitest-environment jsdom
import { setup, cleanup, mount, workspace, pane, content, textarea, pointer, advance, field, host, root, mocks } from "./paneHoverFocusHarness";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import LauncherPane from "../../src/components/workspace/LauncherPane";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { launcherStrings } from "../../src/components/workspace/launcherStrings";

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  setup();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  useLauncherDirsStore.setState({ view: null, loading: false });
  mocks.invoke.mockImplementation((name: string) => Promise.resolve(name === "get_test_profile" ? null
    : name === "launcher_dirs_get" ? { doc: { sections: [], entries: [], rules: [] }, entries_exist: [], scan: { candidates: [] } } : []));
});
afterEach(async () => { await cleanup(); if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else delete (HTMLElement.prototype as any).scrollIntoView; });
const active = () => useUiStore.getState().activePaneId;
const list = () => host.querySelector<HTMLElement>("[data-pane-hover-focus-surface='launcher']")!;
const search = () => host.querySelector<HTMLInputElement>("[data-launcher-pane] input")!;
async function mountLauncher() { return mount(workspace([pane("a"), pane("b", { type: "launcher" })])); }
async function aim(el = list(), x = 20) { await act(async () => { pointer(el, "pointermove", { clientX: x }); }); }

describe("launcher hover and approved popover protection", () => {
  it("I12 claims the launcher search through existing behavior, protects it, then permits click back", async () => {
    const ws = await mountLauncher();
    expect(host.querySelectorAll("[data-pane-hover-focus-surface]")).toHaveLength(2);
    await aim(); await advance(99); expect(active()).toBe("a"); await advance(1);
    expect(active()).toBe("b"); expect(document.activeElement).toBe(search()); expect(useUiStore.getState().focusRevision).toBe(1);
    const revision = useWorkspaceListStore.getState().layoutRevision;
    await act(async () => { search().value = "search text"; search().dispatchEvent(new Event("input", { bubbles: true })); });
    await aim(content("a"), 21); await advance(200); expect(active()).toBe("b"); expect(document.activeElement).toBe(search());
    await act(async () => { pointer(content("a"), "pointerdown", { buttons: 1 }); pointer(content("a"), "pointerup"); });
    await advance(0); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(useWorkspaceListStore.getState().layoutRevision).toBe(revision); expect(ws.panes[1].activeTabId).toBe("t-b");
  });
  it.each(["header", "footer", "search", "button", "spec"])("I12 list registration excludes %s", async (kind) => {
    await mountLauncher(); let el: Element;
    const launcher = host.querySelector("[data-launcher-pane]")!;
    if (kind === "header") el = launcher.firstElementChild!;
    else if (kind === "footer") el = launcher.lastElementChild!;
    else if (kind === "search") el = search();
    else if (kind === "button") el = list().querySelector("button")!;
    else {
      const spec = document.createElement("div"); spec.setAttribute("data-launcher-spec", "true"); launcher.insertBefore(spec, list()); el = spec;
    }
    await aim(el); await advance(200); expect(active()).toBe("a"); expect(document.activeElement).not.toBe(search());
  });
  it("I12 typed model stays protected and explicit launcher keyboard operations retain focus", async () => {
    await mountLauncher(); await aim(); await advance();
    const specButton = [...list().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Grok"));
    expect(specButton).toBeDefined();
    await act(async () => { specButton!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); specButton!.click(); });
    const model = host.querySelector<HTMLInputElement>(`[data-launcher-spec] input[aria-label='${launcherStrings.modelLabel}']`)!;
    expect(model).not.toBeNull(); expect(document.activeElement).toBe(model);
    await aim(content("a"), 21); await advance(200); expect(active()).toBe("b"); expect(document.activeElement).toBe(model);
  });
  it("I12 delayed isActive effect cannot steal overlay focus after hover claim", async () => {
    await mountLauncher();
    const ownSearch = search();
    const original = ownSearch.focus.bind(ownSearch);
    let editor: HTMLElement;
    vi.spyOn(ownSearch, "focus").mockImplementationOnce(() => { original(); editor = field("input", { role: "dialog" }); });
    await aim(); await advance();
    expect(active()).toBe("b"); expect(document.activeElement).toBe(editor!);
    expect(ownSearch.focus).toHaveBeenCalledOnce(); // no second focus from the active effect
  });
  it("I12 review: expired hover guard does not follow a later explicit launcher selection", async () => {
    await mountLauncher();
    const ownSearch = search(), original = ownSearch.focus.bind(ownSearch);
    let editor: HTMLElement;
    vi.spyOn(ownSearch, "focus").mockImplementationOnce(() => { original(); editor = field("input", { role: "dialog" }); });
    await aim(); await advance(); expect(document.activeElement).toBe(editor!);
    editor!.remove();
    await act(async () => { useUiStore.getState().setActivePaneId("a"); });
    await act(async () => { useUiStore.getState().setActivePaneId("b"); });
    expect(document.activeElement).toBe(ownSearch);
  });
  it("I12 review: a throwing DOM guard stops the hover effect without unmounting the launcher", async () => {
    await mountLauncher(); const ownSearch = search(), original = ownSearch.focus.bind(ownSearch);
    vi.spyOn(ownSearch, "focus").mockImplementationOnce(() => {
      original(); vi.spyOn(window, "getComputedStyle").mockImplementation(() => { throw new Error("closed focus surface"); });
    });
    await aim(); await advance();
    expect(search()).toBe(ownSearch); expect(ownSearch.focus).toHaveBeenCalledOnce();
  });
  it.each(["click", "hover"] as const)("I12 ordinary mousedown preserves launcher search in %s", async (mode) => {
    useSettingsStore.setState({ paneFocusMode: mode }); await mountLauncher();
    await act(async () => { search().parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(active()).toBe("b"); expect(document.activeElement).toBe(search());
  });
  it("I08 detached launcher and hidden workspace do not register", async () => {
    const ws = workspace([pane("b", { type: "launcher" })]); useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: "w" });
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    await act(async () => { root.render(<LauncherPane workspaceId="w" paneId="p-b" tabId="t-b" sessionId="b" isActive={false} />); });
    expect(add.mock.calls.filter(([, fn]) => (fn as any).name === "paneHoverFocusListener")).toHaveLength(0);
    await act(async () => { useWorkspaceListStore.setState({ activeWorkspaceId: "hidden" }); });
    expect(host.querySelector("[data-pane-hover-focus-surface]")).toBeNull();
  });
  it("I05/I09 real terminal artifact popover blocks all hover until dismissed with fresh movement", async () => {
    await mount(); await act(async () => { pointer(content(), "pointermove"); }); await advance(50, false);
    await act(async () => { mocks.props.get("a").onArtifactLinkClick("/tmp/example.zip", { x: 20, y: 20 }); });
    expect(host.querySelector("[data-pane-hover-focus-blocker]")).not.toBeNull(); await advance(200); expect(active()).toBe("a");
    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await advance(200); expect(active()).toBe("a");
    await act(async () => { pointer(content(), "pointermove", { clientX: 21 }); }); await advance(); expect(active()).toBe("b");
  });
  it("I05 approved publish and artifact popovers have the same identification attribute", () => {
    const tabBar = readFileSync("src/components/workspace/PaneTabBar.tsx", "utf8");
    const terminal = readFileSync("src/components/workspace/TerminalPane.tsx", "utf8");
    expect(tabBar).toMatch(/ref=\{publishPopoverRef\}\s+data-pane-hover-focus-blocker="true"/);
    expect(terminal).toMatch(/ref=\{artifactLinkPopoverRef\}\s+data-pane-hover-focus-blocker="true"/);
  });
});
