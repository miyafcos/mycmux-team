// @vitest-environment jsdom
// Same state as focusControllerRemount.test.ts, but the unregister/register come from a real
// React commit: a store change moves the terminal component to another parent,
// and the focus request is issued synchronously after the store change, as the
// drop handler does (usePaneDragSource.ts:316-322). Real timers, no act().
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";

let currentPane = "A";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const movePane = (next: string) => { currentPane = next; listeners.forEach(listener => listener()); };
const focused: string[] = [];
const registrations: string[] = [];

function Terminal({ label }: { label: string }) {
  useEffect(() => {
    registrations.push(`register:${label}`);
    const unregister = focusController.registerTerminal("moved", {
      focus: () => { focused.push(label); },
      // The terminal that is leaving never reports ownership, so a tick that still
      // sees it keeps retrying; only the remounted terminal can end the retry.
      containsActiveElement: () => label === "B" && focused.at(-1) === "B",
    });
    return () => { registrations.push(`unregister:${label}`); unregister(); };
  }, [label]);
  return <div data-label={label} />;
}

function Pane({ id }: { id: string }) {
  const pane = useSyncExternalStore(subscribe, () => currentPane);
  return <section>{pane === id ? <Terminal label={id} /> : null}</section>;
}

let root: Root | null = null;
afterEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root?.unmount());
  root = null;
  focusController.clearSession("moved");
  vi.unstubAllGlobals();
});

it("keeps the drag focus retry when the moved terminal remounts in its new pane", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStore.setState({ activePaneId: "other", focusRevision: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<><Pane id="A" /><Pane id="B" /></>));
  expect(registrations).toEqual(["register:A"]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  movePane("B");
  focusController.request("drag", { sessionId: "moved", focus: true });
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(registrations).toEqual(["register:A", "unregister:A", "register:B"]);
  expect(host.querySelector('[data-label="B"]')).not.toBeNull();
  expect(focused.at(-1)).toBe("B");
});
