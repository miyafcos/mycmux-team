// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarResizer } from "../../src/components/layout/AppShell";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../src/lib/constants";
import { useUiStore } from "../../src/stores/uiStore";

function dispatchPointer(target: HTMLElement, type: string, pointerId: number, clientX: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
  });
  target.dispatchEvent(event);
}

function TestResizer({ sidebarCollapsed = false }: { sidebarCollapsed?: boolean }) {
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  return (
    <SidebarResizer
      sidebarCollapsed={sidebarCollapsed}
      sidebarWidth={sidebarWidth}
      setSidebarWidth={setSidebarWidth}
      onResizingChange={() => {}}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useUiStore.setState({ sidebarCollapsed: false, sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("sidebar width", () => {
  it("clamps invalid and boundary values", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(280.6)).toBe(281);
  });

  it("changes the width while dragging within bounds", async () => {
    await act(async () => root.render(<TestResizer />));
    const resizer = container.querySelector<HTMLElement>("[data-sidebar-resizer='true']")!;

    await act(async () => dispatchPointer(resizer, "pointerdown", 1, 300));
    await act(async () => dispatchPointer(resizer, "pointermove", 1, 700));
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    expect(resizer.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_MAX_WIDTH));

    await act(async () => dispatchPointer(resizer, "pointermove", 1, -200));
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    await act(async () => dispatchPointer(resizer, "pointerup", 1, -200));
  });

  it("supports keyboard resize controls", async () => {
    await act(async () => root.render(<TestResizer />));
    const resizer = container.querySelector<HTMLElement>("[data-sidebar-resizer='true']")!;

    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(useUiStore.getState().sidebarWidth).toBe(296);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true })));
    expect(useUiStore.getState().sidebarWidth).toBe(264);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(useUiStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("does not render while the sidebar is collapsed", async () => {
    await act(async () => root.render(<TestResizer sidebarCollapsed />));
    expect(container.querySelector("[data-sidebar-resizer='true']")).toBeNull();
  });
});

describe("sidebar width persistence wiring", () => {
  it("SocketListener saves and hydrates sidebar_width on both paths", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/layout/SocketListener.tsx"),
      "utf8",
    );
    expect(source).toMatch(/sidebar_width:\s*uiState\.sidebarWidth/);
    const hydrateSites = source.match(/setSidebarWidth\((?:data\.)?settings\.sidebar_width \?\? Number\.NaN\)/g) ?? [];
    expect(hydrateSites.length).toBe(2);
  });
});
