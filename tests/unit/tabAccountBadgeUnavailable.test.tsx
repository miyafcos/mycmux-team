// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Set<(event: { payload: { profile_id: string } }) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: { profile_id: string } }) => void) => {
    mocks.handlers.add(handler);
    return () => { mocks.handlers.delete(handler); };
  }),
}));
import { TabAccountBadge } from "../../src/components/layout/TabAccountBadge";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import type { TabAccountEvidence } from "../../src/lib/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const label = "Sample account";
const firstLine = `\u30a2\u30ab\u30a6\u30f3\u30c8: ${label} (\u3053\u306e\u30bf\u30d6\u3060\u3051)`;
const unavailable = "\u78ba\u8a8d\u306e\u72b6\u614b\u3092\u8aad\u307f\u53d6\u308c\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u524d\u306b\u78ba\u304b\u3081\u305f\u7d50\u679c\u306f\u8868\u793a\u3057\u3066\u3044\u307e\u305b\u3093\u3002";
const evidence = (result: TabAccountEvidence["result"]): TabAccountEvidence => ({
  provider: "claude", profile_id: "selected", method: "claude_launch_token", result,
  checked_at: "2026-11-12T09:30:00Z", launched_at: "2026-11-12T09:30:00Z",
});
const emitUpdated = () => { for (const handler of mocks.handlers) handler({ payload: { profile_id: "selected" } }); };
const badge = () => host.querySelector<HTMLElement>("[data-tab-account-badge]")!;
function expectUnavailable() {
  expect(badge().getAttribute("data-account-result")).toBe("unavailable");
  expect(badge().querySelector("svg.lucide-triangle-alert")).not.toBeNull();
  expect(badge().querySelector("[data-account-evidence-icon]")?.getAttribute("data-account-evidence-icon")).toBe("warning");
  expect(badge().style.color).toBe("var(--cmux-usage-warn)");
  expect(badge().title).toBe(`${firstLine}\n${unavailable}`);
  expect(badge().title).not.toContain("\u78ba\u8a8d\u6e08\u307f:");
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear();
  mocks.invoke.mockResolvedValue(evidence("verified"));
  useCliAccountStore.setState({ profiles: [{
    id: "selected", provider: "claude", label, email: "fixture@example.test", identity_key: "fixture",
    plan: null, org_name: null, captured_at: "", last_switched_at: null, needs_relogin: false,
  }], active: { claude: null, codex: null, grok: null }, loading: false });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("tab account badge unavailable evidence", () => {
  it.each(["verified", "mismatch", "org_shared"] as const)("replaces prior %s evidence after a failed notification refresh and recovers", async result => {
    mocks.invoke.mockResolvedValue(evidence(result));
    await act(async () => root.render(<TabAccountBadge accountId="selected" sessionId="pty" />));
    expect(badge().getAttribute("data-account-result")).toBe(result);
    const priorSecondLine = badge().title.split("\n")[1];
    mocks.invoke.mockRejectedValueOnce(new Error("fixture read unavailable"));
    await act(async () => emitUpdated());
    expectUnavailable();
    expect(badge().title).not.toContain(priorSecondLine);
    mocks.invoke.mockResolvedValue(evidence("verified"));
    await act(async () => emitUpdated());
    expect(badge().getAttribute("data-account-result")).toBe("verified");
    expect(badge().querySelector("svg.lucide-circle-check")).not.toBeNull();
    expect(badge().style.color).toBe("var(--cmux-text-secondary)");
    expect(badge().title.split("\n")[0]).toBe(firstLine);
    expect(badge().title).toContain("\u78ba\u8a8d\u6e08\u307f:");
    expect(badge().title).not.toContain(unavailable);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });
  it("shows the warning even when the first evidence read fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("fixture first read unavailable"));
    await act(async () => root.render(<TabAccountBadge accountId="selected" sessionId="pty" />));
    expectUnavailable();
  });
});
