// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReceipt, ExperimentSnapshot } from "../../src/lib/agentAdapterApi";

const api = vi.hoisted(() => ({
  closeCodexExperiment: vi.fn(), codexExperimentCommand: vi.fn(), getAgentAdapterCapabilities: vi.fn(),
  getCodexExperimentStatus: vi.fn(), setCodexExperimentEnabled: vi.fn(), startCodexExperiment: vi.fn(),
}));
vi.mock("../../src/lib/agentAdapterApi", () => api);
import { CodexAppServerSection } from "../../src/components/settings/tabs/CodexAppServerSection";
import { useSettingsStore } from "../../src/stores/settingsStore";

let container: HTMLDivElement;
let root: Root;
let current: ExperimentSnapshot;
let unmounted: boolean;

function snapshot(patch: Partial<ExperimentSnapshot> = {}): ExperimentSnapshot {
  return {
    version: 1, enabled: false, connectionId: null, cliVersion: null, processState: "notStarted",
    agentState: "unknown", threadId: null, configuration: { requested: null, effective: null, source: null, observed: false },
    delivery: null, reply: "", replyTruncated: false, events: [],
    usage: { tokenUsage: null, chatgptAllowance: null, apiStandardEstimateUsd: null, extraCostUsd: null },
    error: null, ...patch,
  };
}
function delivery(patch: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return { operationId: "operation-a", requestId: "send:operation-a", turnId: "turn-a",
    submittedAtMs: 1, acceptedAtMs: 2, startedAtMs: null, completedAtMs: null, status: "accepted", ...patch };
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function checkbox() { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }
async function render() { await act(async () => root.render(<CodexAppServerSection />)); }
async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function running(patch: Partial<ExperimentSnapshot> = {}) {
  useSettingsStore.getState().setCodexAppServerExperimentEnabled(true);
  current = snapshot({ enabled: true, processState: "running", connectionId: "connection-a",
    cliVersion: "0.160.0", threadId: "thread-a", ...patch });
  await render();
}

beforeEach(() => {
  vi.resetAllMocks();
  current = snapshot();
  useSettingsStore.getState().setCodexAppServerExperimentEnabled(false);
  api.getCodexExperimentStatus.mockImplementation(async () => current);
  api.getAgentAdapterCapabilities.mockResolvedValue({ version: 1, adapters: [] });
  api.setCodexExperimentEnabled.mockImplementation(async (enabled: boolean) => {
    current = { ...current, enabled, ...(enabled ? {} : { processState: "exited" }) };
    return current;
  });
  api.startCodexExperiment.mockImplementation(async () => {
    current = snapshot({ enabled: true, processState: "running", cliVersion: "0.160.0", threadId: "thread-a" });
    return current;
  });
  api.closeCodexExperiment.mockImplementation(async () => {
    current = { ...current, processState: "exited" };
    return current;
  });
  api.codexExperimentCommand.mockResolvedValue({ duplicate: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  unmounted = false;
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Codex app-server opt-in settings trial", () => {
  it("defaults off and reads state without launching, sending or changing backend settings", async () => {
    await render();
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(container.querySelector('[aria-label="試験の作業フォルダ"]')).toBeNull();
    expect(api.getCodexExperimentStatus).toHaveBeenCalledTimes(1);
    expect(api.startCodexExperiment).not.toHaveBeenCalled();
    expect(api.setCodexExperimentEnabled).not.toHaveBeenCalled();
    expect(api.codexExperimentCommand).not.toHaveBeenCalled();
  });
  it("persists an explicit opt-in without launching until connect is clicked", async () => {
    await render();
    await checkbox();
    expect(api.setCodexExperimentEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(useSettingsStore.getState().codexAppServerExperimentEnabled).toBe(true);
    expect(api.startCodexExperiment).not.toHaveBeenCalled();
    expect(button("試験に接続").disabled).toBe(true);
    await input("試験の作業フォルダ", "C:/trial");
    await click("試験に接続");
    expect(api.startCodexExperiment).toHaveBeenCalledExactlyOnceWith("C:/trial", "");
    expect(container.textContent).toContain("0.160.0");
    expect(api.codexExperimentCommand).not.toHaveBeenCalled();
  });
  it("a restored opt-in still never auto-launches", async () => {
    useSettingsStore.getState().setCodexAppServerExperimentEnabled(true);
    await render();
    expect(api.startCodexExperiment).not.toHaveBeenCalled();
    expect(api.setCodexExperimentEnabled).not.toHaveBeenCalled();
  });
  it("uses one stable send ID and shows acceptance separately from start and completion", async () => {
    await running();
    api.codexExperimentCommand.mockImplementation(async (request) => {
      current = { ...current, delivery: delivery({ operationId: request.operationId, requestId: "send:" + request.operationId }) };
      return { duplicate: false, delivery: current.delivery };
    });
    await click("1 件送信");
    const request = api.codexExperimentCommand.mock.calls[0][0];
    expect(request.operation).toBe("send");
    expect(request.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.expectedTurnId).toBeUndefined();
    expect(container.textContent).toContain(request.operationId);
    const rows = Array.from(container.querySelectorAll("table tr"));
    expect(rows.find((row) => row.firstElementChild?.textContent === "開始")?.textContent).toContain("未確認");
    expect(rows.find((row) => row.firstElementChild?.textContent === "終了")?.textContent).toContain("未確認");
    expect(button("1 件送信").disabled).toBe(true);
    current = { ...current, delivery: delivery({ startedAtMs: 3, completedAtMs: 4, status: "completed" }), reply: "MYCMUX_O2_OK" };
    await click("試験の状態を再確認");
    expect(container.textContent).toContain("MYCMUX_O2_OK");
    expect(button("ターンを中断").disabled).toBe(true);
    expect(button("途中指示").disabled).toBe(true);
  });
  it("pins control operations to the active turn without treating an acknowledgement as completion", async () => {
    await running({ delivery: delivery({ status: "started", startedAtMs: 3 }) });
    api.codexExperimentCommand.mockImplementation(async (request) => ({
      duplicate: false, control: { operationId: request.operationId, requestId: "control:" + request.operationId,
        method: "turn/" + request.operation, turnId: "turn-a", status: "accepted", accepted: true, observed: false, error: null },
    }));
    await click("途中指示");
    await click("ターンを中断");
    expect(api.codexExperimentCommand.mock.calls.map(([request]) => [request.operation, request.expectedTurnId]))
      .toEqual([["steer", "turn-a"], ["interrupt", "turn-a"]]);
    const interrupt = api.codexExperimentCommand.mock.calls[1][0];
    expect(interrupt.text).toBeUndefined();
    expect(current.delivery?.completedAtMs).toBeNull();
    expect(container.textContent).toContain("実行結果は出来事で確認");
  });
  it.each(["unknown", "rejected", "completed", "interrupted"])("disables controls for a %s turn", async (status) => {
    await running({ delivery: delivery({ status, completedAtMs: status === "unknown" || status === "rejected" ? null : 4 }) });
    expect(button("途中指示").disabled).toBe(true);
    expect(button("ターンを中断").disabled).toBe(true);
  });
  it("does not automatically repeat a send with an unknown outcome", async () => {
    await running();
    api.codexExperimentCommand.mockRejectedValueOnce(new Error("outcome unknown"));
    await click("1 件送信");
    const firstId = api.codexExperimentCommand.mock.calls[0][0].operationId;
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("outcome unknown");
    expect(api.codexExperimentCommand).toHaveBeenCalledTimes(1);
    current = { ...current, delivery: delivery({ operationId: firstId, status: "unknown" }), processState: "exited" };
    await click("試験の状態を再確認");
    expect(button("1 件送信").disabled).toBe(true);
    expect(api.codexExperimentCommand).toHaveBeenCalledTimes(1);
  });
  it("serializes same-frame clicks so one operation consumes the turn", async () => {
    await running();
    let finish!: (value: object) => void;
    api.codexExperimentCommand.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { button("1 件送信").click(); button("1 件送信").click(); });
    expect(api.codexExperimentCommand).toHaveBeenCalledTimes(1);
    expect(container.querySelector("section")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish({ duplicate: false }));
  });
  it("an explicit disable closes the trial through the backend and retains the result", async () => {
    await running({ delivery: delivery({ status: "completed", completedAtMs: 4 }), reply: "MYCMUX_O2_OK" });
    await checkbox();
    expect(api.setCodexExperimentEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(useSettingsStore.getState().codexAppServerExperimentEnabled).toBe(false);
    expect(container.textContent).toContain("MYCMUX_O2_OK");
    expect(container.querySelector('[aria-label="試験の作業フォルダ"]')).toBeNull();
    expect(api.startCodexExperiment).not.toHaveBeenCalled();
  });
  it("reports unsupported schema without fabricating a connected state", async () => {
    api.getCodexExperimentStatus.mockResolvedValue({ ...current, version: 2 });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("確認できません");
    expect(api.startCodexExperiment).not.toHaveBeenCalled();
  });
  it("polls events without an overlapping request and stops polling on unmount", async () => {
    vi.useFakeTimers();
    await running();
    let finish!: (value: ExperimentSnapshot) => void;
    api.getCodexExperimentStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(api.getCodexExperimentStatus).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); unmounted = true; });
    await act(async () => finish({ ...current, reply: "late response" }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(api.getCodexExperimentStatus).toHaveBeenCalledTimes(2);
  });
});
