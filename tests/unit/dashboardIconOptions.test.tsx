// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { Info, PanelsTopLeft, ArrowLeft, CircleHelp, CircleCheck } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardCount, DashboardGlyph, DashboardIconButton, DashboardStatusMark, DashboardUiScope, type DashboardStatus } from "../../src/components/dashboard/DashboardUi";
import { MinimapTabChip } from "../../src/components/dashboard/MinimapTabChip";
import type { MinimapChip } from "../../src/components/dashboard/minimapModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, style: HTMLStyleElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  style = document.createElement("style");
  style.textContent = readFileSync("src/components/dashboard/DashboardUi.css", "utf8");
  document.head.append(style);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const symbols: Partial<Record<DashboardStatus, string>> = {
  running: "loader-circle", sending: "loader-circle", needsHuman: "message-square-reply", needsReview: "triangle-alert",
  done: "check", acknowledged: "check-check", sent: "check-check", stopped: "square",
  error: "x", failed: "x", idle: "pause", delegated: "hourglass",
  delegationUnknown: "search", notStarted: "minus", dormant: "moon",
};
it("renders the chosen small symbols for every state with accessible names", async () => {
  await act(async () => root.render(<div className="cmux-dashboard-view">
    {(Object.keys(symbols) as DashboardStatus[]).map(state => <DashboardStatusMark state={state} key={state} />)}
    <DashboardStatusMark state="unknown" /><DashboardStatusMark state="noUpdate" hasElapsed />
  </div>));
  for (const [state, symbol] of Object.entries(symbols)) {
    const mark = host.querySelector(`[data-dashboard-status="${state}"]`)!;
    expect(mark.getAttribute("aria-label")?.trim()).toBeTruthy();
    expect(mark.getAttribute("title")).toBe(mark.getAttribute("aria-label"));
    expect(mark.querySelectorAll("svg")).toHaveLength(1);
    const svg = mark.querySelector("svg")!;
    expect(svg.classList.contains(`lucide-${symbol}`)).toBe(true);
    expect(getComputedStyle(svg).display).not.toBe("none");
    expect(mark.querySelector("[data-status-shape],.cmux-dashboard-status-dot")).toBeNull();
  }
  for (const state of ["unknown", "noUpdate"]) {
    const mark = host.querySelector(`[data-dashboard-status="${state}"]`)!;
    expect(mark.querySelector("svg")).toBeNull();
    expect(mark.querySelector(".cmux-dashboard-status-text")?.textContent).toBe(mark.getAttribute("aria-label"));
    expect(mark.classList.contains("cmux-dashboard-sr-only")).toBe(true);
    expect(mark.getAttribute("title")?.trim()).toBeTruthy();
  }
  expect(host.querySelector("[data-dash-icon-style]")).toBeNull();
});
it("keeps context, note and action symbols visible with hover and accessible names", async () => {
  await act(async () => root.render(<div className="cmux-dashboard-view">
    <span title="Another window" aria-label="Another window"><DashboardGlyph icon={PanelsTopLeft} label="Another window" /></span>
    <DashboardGlyph icon={Info} label="Details" /><DashboardIconButton icon={ArrowLeft} label="Back" />
  </div>));
  for (const glyph of host.querySelectorAll(".cmux-dashboard-glyph")) {
    expect(getComputedStyle(glyph.querySelector("svg")!).display).not.toBe("none");
    expect(glyph.getAttribute("title")).toBe(glyph.getAttribute("aria-label"));
  }
  const context = host.querySelector(".cmux-dashboard-glyph")!;
  expect(context.parentElement?.title).toBe("Another window");
  expect(context.getAttribute("aria-label")).toBe("Another window");
  const button = host.querySelector("button")!;
  expect(getComputedStyle(button.querySelector("svg")!).display).not.toBe("none");
  expect(button.title).toBe("Back"); expect(button.getAttribute("aria-label")).toBe("Back");
});

it.each([[180, false], [45, true]] as const)("shows a complete agent name only when it fits (%i px)", async (width, hidden) => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("cmux-minimap-meta") ? width : 40; });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const measured = this.classList.contains("cmux-minimap-agent-dot") ? 6 : 12;
    return { x: 0, y: 0, left: 0, top: 0, right: measured, bottom: 12, width: measured, height: 12, toJSON: () => ({}) };
  });
  const chip = { tabId: "fit-tab", label: "Task name", lastOutputAt: 1000, contextPct: 55,
    mark: { kind: "live", label: "Claude", color: { fg: "#88c0d0", bg: "#242933" } } } as MinimapChip;
  await act(async () => root.render(<MinimapTabChip chip={chip} workspaceId="ws" paneId="pane" selected={false} open={false}
    selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState="running" collapsed={false} now={4000}
    onSelect={() => {}} onSelectGroup={() => {}} />));
  const agent = host.querySelector(".cmux-minimap-agent")!;
  expect(agent.textContent).toBe("Claude");
  expect(agent.classList.contains("is-name-hidden")).toBe(hidden);
  expect(host.querySelector(".cmux-minimap-agent-dot")).not.toBeNull();
  const card = host.querySelector("button")!;
  expect(card.getAttribute("aria-label")).toContain("Claude");
  expect(card.title).toContain("Claude");
  expect(host.querySelector(".cmux-minimap-label")?.textContent).toBe("Task name");
});

it("preserves the original terminal-transcript presentation outside the dashboard", async () => {
  await act(async () => root.render(<DashboardUiScope dashboard={false}>
    <DashboardStatusMark state="unknown" label="Legacy unknown" />
    <DashboardStatusMark state="done" label="Legacy done" />
    <DashboardCount count={2} label="Legacy count" /><DashboardIconButton icon={ArrowLeft} label="Legacy action" />
  </DashboardUiScope>));
  const unknown = host.querySelector("[data-dashboard-status=unknown] svg")!;
  const done = host.querySelector("[data-dashboard-status=done] svg")!;
  expect(unknown.outerHTML).toBe(renderToStaticMarkup(<CircleHelp size={15} aria-hidden="true" />));
  expect(done.outerHTML).toBe(renderToStaticMarkup(<CircleCheck size={15} aria-hidden="true" />));
  expect(unknown.getAttribute("width")).toBe("15");
  expect(host.querySelector(".cmux-dashboard-count svg")?.getAttribute("width")).toBe("15");
  expect(host.querySelector("button svg")?.getAttribute("width")).toBe("16");
  expect(host.querySelector("[data-dashboard-status=unknown] [role=img]")?.getAttribute("title")).toBe("Legacy unknown");
  expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Legacy action");
});

it("keeps the stalled elapsed value visible in collapsed cards", async () => {
  const chip = { tabId: "quiet-tab", label: "Quiet task", lastOutputAt: 1000,
    mark: { kind: "live", label: "Claude", color: { fg: "#88c0d0", bg: "#242933" } } } as MinimapChip;
  await act(async () => root.render(<div className="cmux-dashboard-view">
    <MinimapTabChip chip={chip} workspaceId="ws" paneId="pane" selected={false} open={false}
      selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState="noUpdate" collapsed now={121000}
      onSelect={() => {}} onSelectGroup={() => {}} />
  </div>));
  const card = host.querySelector("button")!;
  const elapsed = card.querySelector(".cmux-minimap-age.is-stalled");
  expect(elapsed?.textContent).toBe("2分");
  expect(card.querySelector("svg,[data-status-shape]")).toBeNull();
  expect(card.getAttribute("aria-label")).toContain("出力なし");
  expect(card.title).toContain("出力なし");
  expect(card.getAttribute("aria-label")).toContain("2分");
});

function mockMetaWidth(getWidth: () => number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cmux-minimap-meta") ? getWidth() : 40;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cmux-minimap-ctx") ? 18 : 40;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("cmux-minimap-agent-dot") ? 6
      : this.classList.contains("cmux-minimap-age") ? 22
        : this.classList.contains("cmux-minimap-ctx") ? 18 : 11;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 11, width, height: 11, toJSON: () => ({}) };
  });
}
const narrowChip = { tabId: "narrow-tab", label: "Narrow task", lastOutputAt: 1000, contextPct: 55,
  mark: { kind: "live", label: "Claude", color: { fg: "#88c0d0", bg: "#242933" } } } as MinimapChip;
function narrowCard(chip = narrowChip, state: "running" | "unknown" = "running") {
  return <MinimapTabChip chip={chip} workspaceId="ws" paneId="pane" selected={false} open={false}
    selectedTabIds={new Set()} groupPulseTabIds={new Set()} displayState={state} collapsed={false} now={46000}
    onSelect={() => {}} onSelectGroup={() => {}} />;
}
it.each([[180, true, true, 5], [82, true, false, 5], [54, false, false, 5], [43, false, false, 5]] as const)(
  "reserves elapsed text before CTX at %i px and keeps hidden values accessible", async (width, contextVisible, nameVisible, gap) => {
    mockMetaWidth(() => width);
    await act(async () => root.render(narrowCard()));
    const context = host.querySelector(".cmux-minimap-ctx")!;
    expect(context.classList.contains("is-ctx-hidden")).toBe(!contextVisible);
    expect(context.textContent).toBe("55%");
    expect(host.querySelector(".cmux-minimap-agent")!.classList.contains("is-name-hidden")).toBe(!nameVisible);
    expect(host.querySelector(".cmux-minimap-agent-dot")).not.toBeNull();
    const meta = host.querySelector<HTMLElement>(".cmux-minimap-meta")!;
    expect(meta.style.columnGap).toBe(`${gap}px`);
    expect(meta.querySelector("[data-dashboard-status]")).toBeNull();
    expect(host.querySelector(".cmux-minimap-status-line [data-dashboard-status]")).not.toBeNull();
    expect(meta.nextElementSibling?.className).toBe("cmux-minimap-status-line");
    const elapsed = host.querySelector(".cmux-minimap-age")!;
    expect(elapsed.textContent).toBe("45秒");
    expect(elapsed.classList.contains("cmux-dashboard-sr-only")).toBe(false);
    const card = host.querySelector("button")!;
    for (const text of [card.title, card.getAttribute("aria-label")!]) {
      expect(text).toContain("CTX 55%"); expect(text).toContain("45秒"); expect(text).toContain("Claude");
    }
  },
);
it("restores CTX and the full agent name when a narrow card expands", async () => {
  let width = 43;
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  mockMetaWidth(() => width);
  await act(async () => root.render(narrowCard()));
  expect(host.querySelector(".is-ctx-hidden")).not.toBeNull();
  width = 180;
  await act(async () => resize());
  expect(host.querySelector(".is-ctx-hidden,.is-name-hidden")).toBeNull();
  expect(host.querySelector<HTMLElement>(".cmux-minimap-meta")!.style.columnGap).toBe("5px");
});
it("preserves elapsed text without an agent name or a known state", async () => {
  mockMetaWidth(() => 30);
  await act(async () => root.render(narrowCard({ ...narrowChip, mark: null } as MinimapChip, "unknown")));
  expect(host.querySelector(".is-ctx-hidden")).not.toBeNull();
  expect(host.querySelector(".cmux-minimap-age")?.textContent).toBe("45秒");
  expect(host.querySelector("[data-dashboard-status] svg")).toBeNull();
  expect(host.querySelector("button")?.title).toContain("CTX 55%");
});
