// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ label: "main", invoke: vi.fn(), listen: vi.fn(), registry: (() => {}) as () => void }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../../src/lib/windowContext", async original => ({ ...await original<object>(), windowLabel: () => mocks.label }));
import { usePeerWindowTabs } from "../../src/components/dashboard/usePeerWindowTabs";
import { usePeerWindowTabsStore } from "../../src/components/dashboard/peerWindowTabsStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { peerIndex } from "./fixtures/peerWindowTabs";
let root: Root, host: HTMLDivElement;
function Probe() { const index = usePeerWindowTabs(); return <div>{index.length}</div>; }
async function open() { await act(async () => { useDashboardViewStore.getState().openView(); }); }
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  mocks.label = "main"; mocks.invoke.mockReset().mockResolvedValue(peerIndex());
  mocks.listen.mockReset().mockImplementation(async (_event, handler) => { mocks.registry = handler; return () => {}; });
  useDashboardViewStore.setState({ open: false });
  usePeerWindowTabsStore.setState({ index: [], completedReads: 0, pollers: 0, reading: false, requestSequence: 0, handledRequestSequence: 0 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("peer window tab polling", () => {
  it("is silent while closed and in non-main windows", async () => {
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.label = "mycmux-w1"; await act(async () => root.render(<Probe />)); await open();
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
  it("reads on open, every three seconds and registry changes; pauses hidden intervals and retains the cache", async () => {
    await open(); expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const index = usePeerWindowTabsStore.getState().index;
    await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(usePeerWindowTabsStore.getState().index).toBe(index);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await act(async () => mocks.registry()); expect(mocks.invoke).toHaveBeenCalledTimes(3);
    await act(async () => useDashboardViewStore.getState().close());
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(usePeerWindowTabsStore.getState().index).toBe(index);
  });
  it("refreshes immediately and 600ms after a request, coalescing overlapping reads", async () => {
    await open();
    await act(async () => usePeerWindowTabsStore.getState().requestRefresh());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(600)); expect(mocks.invoke).toHaveBeenCalledTimes(3);
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => usePeerWindowTabsStore.getState().requestRefresh());
    await act(async () => { mocks.registry(); mocks.registry(); await vi.advanceTimersByTimeAsync(600); });
    expect(mocks.invoke).toHaveBeenCalledTimes(4);
    await act(async () => finish(peerIndex()));
    expect(mocks.invoke).toHaveBeenCalledTimes(5);
  });
  it("picks up a request made while closed on open, then reads again exactly 600ms later", async () => {
    usePeerWindowTabsStore.getState().requestRefresh();
    expect(mocks.invoke).not.toHaveBeenCalled();
    await open();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(usePeerWindowTabsStore.getState().handledRequestSequence).toBe(usePeerWindowTabsStore.getState().requestSequence);
    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it.each([null, undefined, {}, [{ window_label: "bad" }]])("keeps the last index for malformed response %j", async value => {
    await open(); const index = usePeerWindowTabsStore.getState().index;
    mocks.invoke.mockResolvedValueOnce(value);
    await act(async () => mocks.registry());
    expect(usePeerWindowTabsStore.getState().index).toBe(index);
    expect(usePeerWindowTabsStore.getState().completedReads).toBe(2);
  });
  it("catches listener failures and retains the same received index after rejected and timed-out reads", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("no event backend"));
    await open();
    const index = usePeerWindowTabsStore.getState().index;
    expect(index).toEqual(peerIndex());
    mocks.invoke.mockRejectedValueOnce(new Error("offline"));
    await act(async () => usePeerWindowTabsStore.getState().requestRefresh());
    expect(usePeerWindowTabsStore.getState().completedReads).toBe(2);
    expect(usePeerWindowTabsStore.getState().index).toBe(index);
    mocks.invoke.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(usePeerWindowTabsStore.getState().completedReads).toBe(3);
    expect(usePeerWindowTabsStore.getState().index).toBe(index);
  });
});
