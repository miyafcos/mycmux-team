// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCHABLE_AGENTS } from "../../src/lib/agentCatalog";
const mocks = vi.hoisted(() => ({ main: true, invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../../src/lib/windowContext", async (original) => ({
  ...await original<typeof import("../../src/lib/windowContext")>(),
  isMainWindow: () => mocks.main,
}));
const installed = Object.fromEntries(LAUNCHABLE_AGENTS.map(({ target }) => [target, false]));
beforeEach(() => { vi.resetModules(); localStorage.clear(); mocks.main = true; mocks.invoke.mockReset(); mocks.listen.mockReset().mockResolvedValue(vi.fn()); });

describe("detection lifecycle and real settings persistence (T2)", () => {
  it("detects once at startup, merges only missing keys, and persists once", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { detectAgentServicesOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    let finish!: (value: { status: "success"; installed: Record<string, boolean> }) => void;
    mocks.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const write = vi.spyOn(Storage.prototype, "setItem");
    const pending = detectAgentServicesOnStartup();
    expect(useAgentServiceDetectionStore.getState().detection.status).toBe("detecting");
    expect(detectAgentServicesOnStartup()).toBeUndefined();
    useSettingsStore.getState().setAgentServiceVisible("hermes", true);
    write.mockClear();
    finish({ status: "success", installed });
    await pending;
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("detect_agent_services");
    expect(write).toHaveBeenCalledTimes(1);
    const saved = useSettingsStore.getState().agentServiceVisibility;
    expect(saved).toEqual({ ...installed, claude: true, codex: true, hermes: true });
    expect(JSON.parse(localStorage.getItem("mycmux-settings")!).state.agentServiceVisibility).toEqual(saved);
    useSettingsStore.getState().initializeDetectedAgentServices({ status: "success", installed });
    expect(write).toHaveBeenCalledTimes(1);
    mocks.invoke.mockResolvedValue({ status: "success", installed });
    await useAgentServiceDetectionStore.getState().refresh();
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });
  it("does not probe when every catalog key already has a saved value", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { detectAgentServicesOnStartup } = await import("../../src/stores/agentServiceDetectionStore");
    useSettingsStore.setState({ agentServiceVisibility: installed });
    expect(detectAgentServicesOnStartup()).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("keeps failure transient and rejects incomplete successful replies", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    mocks.invoke.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ status: "success", installed: {} });
    for (let attempt = 0; attempt < 2; attempt++) {
      await useAgentServiceDetectionStore.getState().refresh();
      expect(useAgentServiceDetectionStore.getState().detection.status).toBe("failed");
      expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
      expect(localStorage.getItem("mycmux-settings")).toBeNull();
    }
  });
  it("never initializes or starts a startup probe in a detached window", async () => {
    mocks.main = false;
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { detectAgentServicesOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    expect(detectAgentServicesOnStartup()).toBeUndefined();
    mocks.invoke.mockResolvedValue({ status: "success", installed });
    await useAgentServiceDetectionStore.getState().refresh();
    expect(useAgentServiceDetectionStore.getState().detection.status).toBe("success");
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
    expect(localStorage.getItem("mycmux-settings")).toBeNull();
  });
  it("hydrates existing version-7 settings without a migration or changed preferences", async () => {
    localStorage.setItem("mycmux-settings", JSON.stringify({ version: 7, state: { launcherHiddenIds: ["web-grok"], crsmShowClaude: false } }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
    expect(useSettingsStore.getState().launcherHiddenIds).toEqual(["web-grok"]);
    expect(useSettingsStore.getState().crsmShowClaude).toBe(false);
  });
});

describe("login PATH readiness and startup retry (K2)", () => {
  it("keeps every cold-start choice visible without saving or consuming the startup request", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { detectAgentServicesOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    const { isAgentServiceVisible } = await import("../../src/lib/agentServiceVisibility");
    mocks.invoke.mockResolvedValue({ status: "waiting-for-path" });
    await detectAgentServicesOnStartup();
    const detection = useAgentServiceDetectionStore.getState().detection;
    expect(detection.status).toBe("waiting-for-path");
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({});
    expect(localStorage.getItem("mycmux-settings")).toBeNull();
    for (const { target } of LAUNCHABLE_AGENTS) expect(isAgentServiceVisible(target, {}, detection)).toBe(true);
    mocks.invoke.mockResolvedValue({ status: "success", installed });
    expect(detectAgentServicesOnStartup()).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(useAgentServiceDetectionStore.getState().detection.status).toBe("success"), { timeout: 5000 });
  });

  it.each(["after the deferred reply", "while the deferred reply is in flight"])("runs exactly one ready probe when PATH arrives %s", async (order) => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { startAgentServiceDetectionOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    let finish!: (reply: { status: "waiting-for-path" }) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue({ status: "success", installed });
    const stop = startAgentServiceDetectionOnStartup();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(mocks.listen).toHaveBeenCalledWith("agent-service-path-ready", expect.any(Function));
    const signal = mocks.listen.mock.calls[0][1];
    if (order === "while the deferred reply is in flight") signal({ payload: null });
    finish({ status: "waiting-for-path" });
    if (order === "after the deferred reply") {
      await vi.waitFor(() => expect(useAgentServiceDetectionStore.getState().detection.status).toBe("waiting-for-path"), { timeout: 5000 });
      expect(localStorage.getItem("mycmux-settings")).toBeNull();
      // The operator's choice made during readiness waiting must survive too.
      useSettingsStore.getState().setAgentServiceVisible("hermes", true);
      signal({ payload: null });
    }
    await vi.waitFor(() => expect(useAgentServiceDetectionStore.getState().detection.status).toBe("success"), { timeout: 5000 });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().agentServiceVisibility).toEqual({ ...installed, claude: true, codex: true,
      ...(order === "after the deferred reply" ? { hermes: true } : {}) });
    signal({ payload: null }); signal({ payload: null });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    const remove = await mocks.listen.mock.results[0].value;
    stop();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("skips a late readiness probe after the operator has resolved every key", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { startAgentServiceDetectionOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    mocks.invoke.mockResolvedValue({ status: "waiting-for-path" });
    const stop = startAgentServiceDetectionOnStartup();
    await vi.waitFor(() => expect(useAgentServiceDetectionStore.getState().detection.status).toBe("waiting-for-path"), { timeout: 5000 });
    useSettingsStore.setState({ agentServiceVisibility: installed });
    mocks.listen.mock.calls[0][1]({ payload: null });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps Windows startup to one normal probe and cleans up the subscription", async () => {
    const { startAgentServiceDetectionOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    mocks.invoke.mockResolvedValue({ status: "success", installed });
    const stop = startAgentServiceDetectionOnStartup();
    await vi.waitFor(() => expect(useAgentServiceDetectionStore.getState().detection.status).toBe("success"), { timeout: 5000 });
    mocks.listen.mock.calls[0][1]({ payload: null });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("detect_agent_services");
    stop();
  });

  it("does not subscribe in a detached window or start after an early unmount", async () => {
    const { startAgentServiceDetectionOnStartup } = await import("../../src/stores/agentServiceDetectionStore");
    mocks.main = false;
    startAgentServiceDetectionOnStartup()();
    expect(mocks.listen).not.toHaveBeenCalled();
    mocks.main = true;
    const remove = vi.fn();
    let subscribed!: (unlisten: () => void) => void;
    mocks.listen.mockReturnValue(new Promise(resolve => { subscribed = resolve; }));
    startAgentServiceDetectionOnStartup()();
    subscribed(remove);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
