// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { capturePaneFocusReturn, captureTemporaryFocusReturn } from "../../src/lib/focusController";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";

let pane: HTMLDivElement, heading: HTMLButtonElement, temporary: HTMLButtonElement, outside: HTMLButtonElement;
beforeEach(() => {
  pane = document.createElement("div"); pane.dataset.dndWorkspaceId = "workspace"; pane.dataset.dndPaneId = "pane";
  heading = document.createElement("button"); heading.className = "pane-active-heading"; heading.tabIndex = 0;
  temporary = document.createElement("button"); pane.append(heading, temporary);
  outside = document.createElement("button"); document.body.append(pane, outside);
  useWorkspaceListStore.setState({ activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", panes: [{ id: "pane" }] }] } as never);
  useUiStore.setState({ focusRevision: 0, zoomedPaneId: null }); temporary.focus();
});
afterEach(() => { pane.remove(); outside.remove(); });

it.each(["pointer", "outside-focus", "other-owned-focus"])("L2 invalidates a captured return after %s even when focus later falls to body", decision => {
  const restore = capturePaneFocusReturn(pane, heading);
  if (decision === "pointer") outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  else if (decision === "outside-focus") outside.focus();
  else heading.focus();
  (document.activeElement as HTMLElement).blur(); expect(document.activeElement).toBe(document.body);
  temporary.remove(); restore(temporary); expect(document.activeElement).toBe(document.body);
});
it("L2 restores an actually removed focused control once and consumes that return", () => {
  const restore = capturePaneFocusReturn(pane, heading); temporary.remove();
  expect(document.activeElement).toBe(document.body); restore(temporary); expect(document.activeElement).toBe(heading);
  heading.blur(); restore(temporary); expect(document.activeElement).toBe(document.body);
});
it("keeps the app-owned rename portal inside its owner's focus-return lifetime", () => {
  const restore = capturePaneFocusReturn(pane, heading);
  const portal = document.createElement("div"); portal.dataset.paneFocusPaneId = "pane"; portal.dataset.paneFocusWorkspaceId = "workspace";
  const input = document.createElement("input"); portal.append(input); document.body.append(portal); input.focus();
  restore(portal); expect(document.activeElement).toBe(heading); portal.remove();
});
it("does not permit an unregistered owner-less host", () => {
  const restore = capturePaneFocusReturn(outside, outside); temporary.blur();
  restore(temporary); expect(document.activeElement).toBe(document.body);
});
it("renews only the synchronous intent on re-entry while an old async capture stays cancelled", () => {
  const asyncReturn = capturePaneFocusReturn(pane, heading);
  const synchronousReturn = captureTemporaryFocusReturn(pane, heading, () => temporary);
  outside.focus(); useUiStore.getState().bumpFocusRevision(); temporary.focus();
  const revision = useUiStore.getState().focusRevision; temporary.remove();
  asyncReturn(temporary); expect(document.activeElement).toBe(document.body);
  synchronousReturn(temporary); expect(document.activeElement).toBe(heading);
  expect(useUiStore.getState().focusRevision).toBe(revision);
  heading.blur();
  pane.append(temporary); temporary.focus(); temporary.remove(); synchronousReturn(temporary);
  expect(document.activeElement).toBe(document.body);
});
it("does not renew an explicitly disposed synchronous return", () => {
  const restore = captureTemporaryFocusReturn(pane, heading, () => temporary);
  restore.cancel(); outside.focus(); temporary.focus(); temporary.remove(); restore(temporary);
  expect(document.activeElement).toBe(document.body);
});
it("does not renew focus entry into a hidden temporary surface", () => {
  const restore = captureTemporaryFocusReturn(pane, heading, () => temporary);
  outside.focus(); temporary.hidden = true; temporary.focus(); temporary.remove(); restore(temporary);
  expect(document.activeElement).toBe(document.body);
});
