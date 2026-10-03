// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CliAccountProfile, CliProvider, ProfileUsage } from "../../src/lib/ipc";

// The whole chain on the real stores, with only the Tauri boundary mocked: an
// automatic switch waits in the real mutation queue behind another provider's
// operation, its target is unticked meanwhile, and the flow must end on the
// next candidate. The replay of an evaluation that arrived mid-run is pinned
// by the unit tests in accountAutoSwitch.test.tsx; this one pins that the
// guard really runs inside the queue, after the wait, with the latest picks.
const ipc = vi.hoisted(() => ({
  releaseCapture: null as null | (() => void),
  switched: [] as string[],
}));

vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: vi.fn(async () => false) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "C:\\Users\\test") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (command: string, args: { profileId?: string } | undefined) => {
    switch (command) {
      case "list_cli_accounts":
        return {
          profiles: [profile("a"), profile("b"), profile("c"), profile("x", "codex")],
          live: [
            { provider: "claude", present: true, email: null, identity_key: "a", matched_profile_id: "a", plan: null, org_name: null, error: null },
            { provider: "codex", present: true, email: null, identity_key: "x", matched_profile_id: "x", plan: null, org_name: null, error: null },
            { provider: "grok", present: false, email: null, identity_key: null, matched_profile_id: null, plan: null, org_name: null, error: null },
          ],
          active: { claude: "a", codex: "x", grok: null },
          orphans: [],
          backup_root: "C:\\backup",
          generated_at: new Date().toISOString(),
        };
      case "get_account_usage":
        return {
          accounts: [usage("a", 100, true), usage("b", 5), usage("c", 40), usage("x", 10, true, "codex")],
          generated_at: new Date().toISOString(),
        };
      case "capture_cli_account":
        // Holds the shared queue until the test lets it go.
        return new Promise((resolve) => {
          ipc.releaseCapture = () => resolve(profile("x", "codex"));
        });
      case "switch_cli_account":
        ipc.switched.push(args?.profileId ?? "");
        // No identity key: skips the delayed revert check and its timer.
        return { profile: { ...profile(args?.profileId ?? ""), identity_key: "" }, wrote_back_to: null,
          backup_dir: "C:\\backup", warnings: [] };
      default:
        return null;
    }
  }),
}));

import { useAccountAutoSwitch } from "../../src/hooks/useAccountAutoSwitch";
import { useAccountAutoSwitchStore } from "../../src/stores/accountAutoSwitchStore";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import { useUsageStore } from "../../src/stores/usageStore";

function profile(id: string, provider: CliProvider = "claude"): CliAccountProfile {
  return { id, provider, label: id, email: null, identity_key: id, plan: null, org_name: null,
    captured_at: "2026-09-01T00:00:00Z", last_switched_at: null, needs_relogin: false };
}

function usage(id: string, pct: number, active = false, provider: CliProvider = "claude"): ProfileUsage {
  const resets_at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  return { profile_id: id, provider, label: id, email: null, plan: null, registered: true, is_active: active,
    needs_relogin: false, state: "ok", five_hour: { pct, resets_at }, seven_day: { pct: 10, resets_at },
    seven_day_sonnet: null, seven_day_opus: null, model_windows: [], error_code: null, retry_at: null,
    fetched_at: new Date().toISOString() };
}

function Probe() {
  useAccountAutoSwitch(true);
  return null;
}

it("drops a target unticked while its switch is queued, and ends on the next candidate", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  await act(async () => {
    await useCliAccountStore.getState().fetch();
    await useUsageStore.getState().fetch();
  });
  // Another provider's operation holds the shared queue.
  const capture = useCliAccountStore.getState().capture("codex");
  useAccountAutoSwitchStore.setState({ enabled: { claude: true, codex: false, grok: false },
    excludedTargets: { claude: [], codex: [], grok: [] }, attempts: {}, status: {} });

  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  // a is at its limit, so the switch to b (the least loaded) is now waiting in the queue.
  await vi.waitFor(() => expect(useCliAccountStore.getState().busyByProvider.claude).toBe("b"), { timeout: 10_000 });

  await act(async () => useAccountAutoSwitchStore.getState().setTargetIncluded("claude", "b", false));
  await act(async () => {
    ipc.releaseCapture?.();
    await capture;
  });

  await vi.waitFor(() => expect(ipc.switched).toEqual(["c"]), { timeout: 10_000 });
  expect(useAccountAutoSwitchStore.getState().enabled.claude).toBe(true);
  expect(useAccountAutoSwitchStore.getState().attempts.claude).toMatchObject({ source: "a", target: "c" });
  await act(async () => root.unmount());
});
