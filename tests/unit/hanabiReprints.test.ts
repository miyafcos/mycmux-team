import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetHanabiCelebrationsForTests, connectHanabiCelebrations } from "../../src/stores/hanabiCelebrationObserver";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { queueTerminalOutputObservation } from "../../src/stores/terminalObservationStore";
import type { Workspace } from "../../src/types";

vi.mock("../../src/stores/liveTailStore", () => ({
  subscribeLiveTailObservations: () => () => {},
  acquireLiveTailConsumer: () => () => {},
}));
let release: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  __resetHanabiCelebrationsForTests();
  useWorkspaceListStore.setState({ workspaces: [{
    id: "w", panes: [{ id: "p", tabs: [{ id: "t", sessionId: "s", type: "terminal" }] }],
  } as Workspace] });
});
afterEach(() => { release?.(); release = undefined; vi.useRealTimers(); useWorkspaceListStore.setState({ workspaces: [] }); });
function queue(text: string, start: number, source: "live" | "snapshot") {
  const data = new TextEncoder().encode(text);
  queueTerminalOutputObservation({ sessionId: "s", epoch: 1, startOffset: start, endOffset: start + data.length, data, source });
  vi.runAllTimers();
  return start + data.length;
}
const ort = "Merge made by the 'ort' strategy.\n";
const ff = "Updating abc1234..def5678\nFast-forward\n";
describe("E2 independent conhost-shaped reprints", () => {
  it.each([
    ["cursor-position-only row boundaries", ort, "\x1b[H$ old\x1b[2;1HMerge made by the 'ort' strategy.\x1b[3;1H$ ready"],
    ["success at top without Updating", ff, "\x1b[HFast-forward\r\nfile stats\r\n$ ready\r\n"],
    ["soft wrap represented only by cursor movement", ff, "\x1b[HUpdating abc1234..def\x1b[2;1H5678\r\nFast-forward\r\n$ ready\r\n"],
    ["wrapped Updating row with explicit line boundaries", ff, "\x1b[HUpdating abc1234..def\r\n5678\r\nFast-forward\r\n$ ready\r\n"],
    ["Updating context becomes visible after bare success", "Fast-forward\n", "\x1b[HUpdating abc1234..def5678\r\nFast-forward\r\n$ ready\r\n"],
  ])("does not add a celebration: %s", (_name, initial, repaint) => {
    let now = 100;
    const celebrate = vi.fn();
    release = connectHanabiCelebrations(celebrate, () => now);
    const end = queue(initial, 0, "live");
    expect(celebrate).toHaveBeenCalledTimes(1);
    now = 13000;
    queue(repaint, end, "live");
    expect(celebrate).toHaveBeenCalledTimes(1);
  });
  it("does not celebrate a historic snapshot success when it is reprinted live", () => {
    let now = 100;
    const celebrate = vi.fn();
    release = connectHanabiCelebrations(celebrate, () => now);
    const end = queue(ort, 0, "snapshot");
    expect(celebrate).not.toHaveBeenCalled();
    now = 13000;
    queue("\x1b[H" + ort + "$ ready\r\n", end, "live");
    expect(celebrate).not.toHaveBeenCalled();
  });
});
