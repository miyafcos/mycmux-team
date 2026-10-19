// @vitest-environment jsdom
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCHABLE_AGENTS } from "../../src/lib/agentCatalog";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../../src/lib/windowContext", async (original) => ({
  ...await original<typeof import("../../src/lib/windowContext")>(),
  isMainWindow: () => true,
}));
const installed = Object.fromEntries(LAUNCHABLE_AGENTS.map(({ target }) => [target, false]));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.listen.mockReset().mockResolvedValue(vi.fn());
});

describe("PATH readiness during a settings-triggered probe (S2-01)", () => {
  it.each(["after", "during"])("retries once when readiness arrives %s a settings refresh", async (order) => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore");
    const { startAgentServiceDetectionOnStartup, useAgentServiceDetectionStore } = await import("../../src/stores/agentServiceDetectionStore");
    mocks.invoke.mockResolvedValueOnce({ status: "waiting-for-path" });
    const stop = startAgentServiceDetectionOnStartup();
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
      // All fixture IPC resolves as microtasks; an event-loop turn drains them
      // without a timer deadline or an arbitrary count of promise reactions.
      await nextTurn();
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(useAgentServiceDetectionStore.getState().detection.status).toBe("waiting-for-path");
      expect(write).not.toHaveBeenCalled();
      expect(localStorage.getItem("mycmux-settings")).toBeNull();

      useSettingsStore.getState().setAgentServiceVisible("hermes", true);
      write.mockClear();
      let finish!: (reply: { status: "waiting-for-path" }) => void;
      mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
        .mockResolvedValue({ status: "success", installed });
      // AgentServicesTab invokes this same refresh action on each mount.
      const settingsProbe = useAgentServiceDetectionStore.getState().refresh();
      await nextTurn();
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      const signal = mocks.listen.mock.calls[0][1];
      if (order === "during") signal({ payload: null });
      await nextTurn();
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      expect(write).not.toHaveBeenCalled();

      finish({ status: "waiting-for-path" });
      await settingsProbe;
      if (order === "after") signal({ payload: null });
      await nextTurn();
      expect(mocks.invoke).toHaveBeenCalledTimes(3);
      expect(useAgentServiceDetectionStore.getState().detection.status).toBe("success");
      const saved = { ...installed, claude: true, codex: true, hermes: true };
      expect(useSettingsStore.getState().agentServiceVisibility).toEqual(saved);
      expect(JSON.parse(localStorage.getItem("mycmux-settings")!).state.agentServiceVisibility).toEqual(saved);
      expect(write).toHaveBeenCalledTimes(1);

      signal({ payload: null });
      signal({ payload: null });
      await nextTurn();
      expect(mocks.invoke).toHaveBeenCalledTimes(3);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      write.mockRestore();
    }
  });
});
