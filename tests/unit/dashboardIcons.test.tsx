// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArrowLeft } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardCount, DashboardIconButton, DashboardStatusLabel, DashboardStatusMark } from "../../src/components/dashboard/DashboardUi";
import { dashboardStrings } from "../../src/components/dashboard/dashboardStrings";
import type { DashboardDisplayState } from "../../src/components/dashboard/dashboardModel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("dashboard icon presentation", () => {
  it("keeps a readable action name, hover text, focus and click routing on an icon-only button", async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<DashboardIconButton icon={ArrowLeft} label="Back to session" onClick={onClick} />));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Back to session");
    expect(button.title).toBe("Back to session");
    expect(button.textContent).toBe("");
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("distinguishes every dashboard state by SVG geometry, with a name for each", async () => {
    const states: DashboardDisplayState[] = ["needsHuman", "error", "running", "noUpdate", "done", "acknowledged", "idle", "stopped", "delegated", "delegationUnknown", "unknown"];
    await act(async () => root.render(<>{states.map(state => <DashboardStatusMark key={state} state={state} />)}</>));
    const markers = [...host.querySelectorAll("[data-dashboard-status]")];
    expect(markers).toHaveLength(states.length);
    const shapes = markers.map(marker => {
      const image = marker.querySelector("[role=img]")!;
      expect(image.getAttribute("aria-label")?.trim()).toBeTruthy();
      expect(image.getAttribute("title")).toBe(image.getAttribute("aria-label"));
      expect(image.textContent).toBe("");
      return image.querySelector("svg")!.innerHTML;
    });
    expect(new Set(shapes).size).toBe(states.length);
  });

  it("hides a zero count and preserves the meaning of a positive count without visible prose", async () => {
    await act(async () => root.render(<><DashboardCount count={0} label="Nothing selected" /><DashboardCount count={3} label="3 selected tabs" /></>));
    expect(host.querySelectorAll("[role=img]")).toHaveLength(1);
    expect(host.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("3 selected tabs");
    expect(host.textContent).toBe("3");
  });
});

it("uses the same working shape for the watch row and recipient vocabulary", async () => {
  await act(async () => root.render(<><DashboardStatusMark state="running" /><DashboardStatusLabel label={dashboardStrings.stateRunning} /><DashboardStatusLabel label={dashboardStrings.watchRunning} /></>));
  const shapes = [...host.querySelectorAll("[data-dashboard-status] svg")].map(icon => icon.innerHTML);
  expect(shapes).toHaveLength(3);
  expect(new Set(shapes).size).toBe(1);
});
