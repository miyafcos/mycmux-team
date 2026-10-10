// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DshDelivery, DshRunRef, DshState } from "../../src/lib/agentAdapterApi";
const api = vi.hoisted(() => ({ answerDshPermission: vi.fn(), cancelDshPrompt: vi.fn(), closeDshSession: vi.fn(),
  getDshExperimentStatus: vi.fn(), sendDshPrompt: vi.fn(), setDshExperimentEnabled: vi.fn(),
  startDshExperiment: vi.fn(), stopDshOwnedProcess: vi.fn() }));
vi.mock("../../src/lib/agentAdapterApi", () => api);
import { DshAcpSection } from "../../src/components/settings/tabs/DshAcpSection";
import { useSettingsStore } from "../../src/stores/settingsStore";

const run: DshRunRef = { runId: "run", generation: 1, convId: "opaque/session:one", cwd: "/trial" };
function snapshot(patch: Partial<DshState> = {}): DshState {
  return { version: 1, enabled: false, run: null, requiredExecutableVersion: "0.2.0-rc.2", executableVersion: null,
    agentInfoVersion: null, resumeSupported: false, process: "notStarted", activity: "unknown", confidence: "unknown",
    sessionClosed: false, delivery: null, permissions: [], read: null, error: null, ...patch };
}
function delivery(patch: Partial<DshDelivery> = {}): DshDelivery {
  return { operationId: "op", requestId: "rpc", submittedAtMs: 1, acceptedAtMs: null, observedAtMs: null,
    settledAtMs: null, status: "submitted", stopReason: null, cancelRequested: false, ...patch };
}
let container: HTMLDivElement;
let root: Root;
let current: DshState;
let unmounted: boolean;
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function render() { await act(async () => root.render(<DshAcpSection />)); }
async function connected(patch: Partial<DshState> = {}) {
  current = snapshot({ enabled: true, run, process: "running", activity: "quiescent", confidence: "observed", ...patch });
  useSettingsStore.setState({ dshAcpExperimentEnabled: true, dshAcpSavedRun: run }); await render();
}
beforeEach(() => {
  vi.resetAllMocks();
  current = snapshot();
  useSettingsStore.setState({ dshAcpExperimentEnabled: false, dshAcpExecutablePath: "/prepared/dsh", dshAcpHomePath: "/prepared/home", dshAcpSavedRun: null });
  api.getDshExperimentStatus.mockImplementation(async () => current);
  api.setDshExperimentEnabled.mockImplementation(async (enabled) => {
    current = { ...current, enabled, ...(enabled ? {} : { process: "exited" }) }; return current;
  });
  api.startDshExperiment.mockImplementation(async () => { current = snapshot({ enabled: true, run, process: "running", activity: "quiescent" }); return current; });
  api.stopDshOwnedProcess.mockImplementation(async () => { current = { ...current, process: "exited" }; return current; });
  api.closeDshSession.mockImplementation(async () => { current = { ...current, sessionClosed: true }; return current; });
  api.cancelDshPrompt.mockImplementation(async () => { current = { ...current, delivery: delivery({ cancelRequested: true }) }; return current; });
  api.answerDshPermission.mockImplementation(async () => current);
  api.sendDshPrompt.mockImplementation(async (request) => {
    current = { ...current, activity: "pending", delivery: delivery({ operationId: request.operationId }) }; return current.delivery;
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); unmounted = false;
});
afterEach(() => { if (!unmounted) act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("dsh opt-in settings experiment", () => {
  it("defaults off with no trial panel, IPC, spawn or automatic acquisition", async () => {
    await render();
    expect(useSettingsStore.getState().dshAcpExperimentEnabled).toBe(false);
    expect(container.querySelector("section")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(api.getDshExperimentStatus).not.toHaveBeenCalled();
    expect(api.setDshExperimentEnabled).not.toHaveBeenCalled();
    expect(api.startDshExperiment).not.toHaveBeenCalled();
  });
  it("a restored opt-in reports unverified versions and missing history without auto-launch", async () => {
    useSettingsStore.getState().setDshAcpExperimentEnabled(true); await render();
    expect(container.textContent).toContain("0.2.0-rc.2"); expect(container.textContent).toContain("未確認");
    expect(container.textContent).toContain("過去の履歴は未取得");
    expect(api.startDshExperiment).not.toHaveBeenCalled(); expect(api.setDshExperimentEnabled).not.toHaveBeenCalled();
  });
  it("requires an explicit connect and only passes path, cwd, home and resume references", async () => {
    await connected({ process: "notStarted", run: null });
    await click("新しい会話に接続");
    expect(api.startDshExperiment).toHaveBeenCalledExactlyOnceWith({ executable: "/prepared/dsh", cwd: "/trial", dshHome: "/prepared/home", resume: null });
    expect(useSettingsStore.getState().dshAcpSavedRun).toEqual(run);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
  it("keeps submitted, observed and settled distinct and never fabricates acceptance", async () => {
    await connected(); await click("1 件送信");
    expect(api.sendDshPrompt.mock.calls[0][0].expectedRun).toEqual(run);
    expect(api.sendDshPrompt.mock.calls[0][0].operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(container.textContent).toContain("送信済み（受理は未確認）");
    expect(container.textContent).toContain("受理：未確認"); expect(container.textContent).toContain("静止：未確認");
    expect(button("1 件送信").disabled).toBe(true);
    current = { ...current, activity: "quiescent", delivery: delivery({ status: "settled", settledAtMs: 3, stopReason: "end_turn" }) };
    await click("試験の状態を再確認"); expect(button("1 件送信").disabled).toBe(false);
    expect(container.textContent).toContain("静止は作業全体の完了ではありません");
  });
  it("an unknown outcome cannot trigger a resend or cancel acknowledgement treated as success", async () => {
    await connected({ activity: "unknown", delivery: delivery({ status: "unknown" }) });
    expect(container.textContent).toContain("不明（自動再送しません）");
    expect(button("1 件送信").disabled).toBe(true); expect(button("ターンを中断").disabled).toBe(true);
    await click("試験の状態を再確認"); expect(api.sendDshPrompt).not.toHaveBeenCalled();
  });
  it("IPC loss retains the send ID and suppresses another send even if a stale status is quiescent", async () => {
    await connected(); api.sendDshPrompt.mockRejectedValueOnce(new Error("API_KEY=sk-private")); await click("1 件送信");
    expect(button("1 件送信").disabled).toBe(true); expect(api.sendDshPrompt).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("sk-private"); await click("試験の状態を再確認");
    expect(api.sendDshPrompt).toHaveBeenCalledTimes(1);
  });
  it.each(["allow", "reject"] as const)("answers a one-shot %s permission using the current run", async (choice) => {
    await connected({ activity: "pending", delivery: delivery(), permissions: [{ permissionId: "permission", operationId: "op", allowAvailable: true, rejectAvailable: true }] });
    await click(choice === "allow" ? "1 回許可" : "拒否");
    expect(api.answerDshPermission).toHaveBeenCalledExactlyOnceWith({ expectedRun: run, permissionId: "permission", choice });
    expect(current.delivery?.settledAtMs).toBeNull();
  });
  it("cancel remains pending until the correlated prompt settlement", async () => {
    await connected({ activity: "pending", delivery: delivery() }); await click("ターンを中断");
    expect(api.cancelDshPrompt).toHaveBeenCalledExactlyOnceWith(run);
    expect(current.activity).toBe("pending"); expect(container.textContent).toContain("中断を要求済み");
    expect(button("1 件送信").disabled).toBe(true);
  });
  it("close, process stop and saved resume are separate and preserve the conversation reference", async () => {
    await connected(); await click("会話を閉じる");
    expect(api.closeDshSession).toHaveBeenCalledExactlyOnceWith(run); expect(api.stopDshOwnedProcess).not.toHaveBeenCalled();
    expect(button("1 件送信").disabled).toBe(true); await click("接続プロセスを止める");
    expect(api.stopDshOwnedProcess).toHaveBeenCalledExactlyOnceWith(run);
    await click("保存した会話を再開"); expect(api.startDshExperiment.mock.calls[0][0].resume).toEqual(run);
    expect(useSettingsStore.getState().dshAcpSavedRun?.convId).toBe(run.convId);
  });
  it("stops the owned process when the settings section unmounts", async () => {
    await connected(); await act(async () => { root.unmount(); unmounted = true; });
    expect(api.stopDshOwnedProcess).toHaveBeenCalledExactlyOnceWith(run);
    expect(useSettingsStore.getState().dshAcpSavedRun).toEqual(run);
  });
  it("stops a process returned after the settings section closed during startup", async () => {
    await connected({ process: "notStarted", run: null });
    let finish!: (value: DshState) => void;
    api.startDshExperiment.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click("新しい会話に接続");
    await act(async () => { root.unmount(); unmounted = true; });
    await act(async () => finish(snapshot({ enabled: true, run, process: "running", activity: "quiescent" })));
    expect(api.stopDshOwnedProcess).toHaveBeenCalledExactlyOnceWith(run);
  });
  it("turning the flag off stops through the backend and hides the panel", async () => {
    await connected(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(api.setDshExperimentEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(container.querySelector("section")).toBeNull(); expect(useSettingsStore.getState().dshAcpSavedRun).toEqual(run);
  });
  it("projects known fields and hides credentials in text, errors and unrecognized metadata", async () => {
    const privateState = snapshot({ enabled: true, run, process: "running", activity: "quiescent", error: "API_KEY=sk-private",
      read: { source: "acpUpdates", run, cursor: 1, historyAvailable: false, gap: false, truncated: false,
        updates: [{ sequence: 1, source: "acpUpdate", operationId: null, kind: "agent_message_chunk", text: "hello sk-private" }] } });
    await connected({ ...privateState, ...{ remoteSecret: "sk-private" } });
    expect(container.textContent).not.toContain("sk-private"); expect(container.textContent).toContain("非表示");
    useSettingsStore.getState().setDshAcpSavedRun({ ...run, ...{ apiKey: "sk-private" } });
    expect(Object.keys(useSettingsStore.getState().dshAcpSavedRun!)).toEqual(["runId", "generation", "convId", "cwd"]);
  });
  it("does not overlap polling and stops the timer on unmount", async () => {
    vi.useFakeTimers(); await connected(); let finish!: (value: DshState) => void;
    api.getDshExperimentStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => vi.advanceTimersByTime(3000)); expect(api.getDshExperimentStatus).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); unmounted = true; }); await act(async () => finish(current));
    await act(async () => vi.advanceTimersByTime(3000)); expect(api.getDshExperimentStatus).toHaveBeenCalledTimes(2);
  });
});
