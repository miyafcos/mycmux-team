// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHooksStatus, HookInstallState, RepairReason } from "../../src/lib/agentHooksApi";
const api = vi.hoisted(() => ({ agentHooksStatus: vi.fn(), agentHooksSet: vi.fn() }));
vi.mock("../../src/lib/agentHooksApi", () => api);
import { AgentIntegrationsSection } from "../../src/components/settings/tabs/AgentIntegrationsSection";

let container: HTMLDivElement;
let root: Root;
function status(state: HookInstallState = { state: "installed" }): AgentHooksStatus {
  return { version: 2, providers: [
    { provider: "claude", enabled: state.state !== "disabled", ...state },
    { provider: "codex", enabled: false, state: "disabled" },
    { provider: "grok", enabled: false, state: "disabled" },
  ] };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.agentHooksStatus.mockResolvedValue(status());
  api.agentHooksSet.mockResolvedValue(status({ state: "disabled" }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(value = status()) {
  api.agentHooksStatus.mockResolvedValue(value);
  await act(async () => root.render(<AgentIntegrationsSection />));
}
function row() { return container.querySelector('[role="group"][aria-label="Claude Code"]')!; }
function button(label: string, scope: ParentNode = row()) {
  return Array.from(scope.querySelectorAll("button")).find((element) => element.textContent === label);
}
async function click(label: string, scope?: ParentNode) {
  expect(button(label, scope)).toBeDefined();
  await act(async () => button(label, scope)!.click());
}
describe("Agent integrations settings", () => {
  it.each([
    [{ state: "installed" }, "入っています", null],
    [{ state: "disabled" }, "外しています", "入れる"],
    [{ state: "unavailable" }, "使えません", "入れる"],
    [{ state: "needs-repair", reason: "duplicate" }, "直す必要があります", "直す"],
  ] as const)("renders %s and its action", async (state, label, action) => {
    await render(status(state));
    expect(row().textContent).toContain(label);
    expect(Boolean(button("入れる"))).toBe(action === "入れる");
    expect(Boolean(button("直す"))).toBe(action === "直す");
    expect(Boolean(button("外す"))).toBe(state.state !== "disabled");
    expect(api.agentHooksSet).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Grok");
  });
  it.each([
    ["duplicate", "同じ hook が 2 つ以上あります"],
    ["missing", "足りない hook があります"],
    ["helper-path", "hook の呼び先が違います"],
    ["untrusted", "Codex の側でまだ許可されていません"],
    ["unknown-shape", "設定ファイルの形を読み取れないため、書き換えていません"],
  ] as [RepairReason, string][])("renders the %s reason", async (reason, message) => {
    await render(status({ state: "needs-repair", reason }));
    expect(row().textContent).toContain(message);
  });
  it.each([
    [{ state: "disabled" }, "入れる"],
    [{ state: "needs-repair", reason: "missing" }, "直す"],
  ] as const)("enables or repairs the selected provider", async (state, label) => {
    await render(status(state));
    api.agentHooksSet.mockResolvedValue(status());
    await click(label);
    expect(api.agentHooksSet).toHaveBeenCalledExactlyOnceWith("claude", true);
    expect(row().textContent).toContain("入っています");
  });
  it("confirms disable once, supports cancel, and sends only the selected provider", async () => {
    await render();
    await click("外す");
    const text = "Claude Code の設定ファイルから mycmux の hook を外します。ほかの hook はそのまま残ります。";
    expect(container.textContent).toContain(text);
    expect(api.agentHooksSet).not.toHaveBeenCalled();
    await click("やめる", container);
    expect(container.textContent).not.toContain(text);
    await click("外す");
    const confirm = container.querySelector(`[role="group"][aria-label="${text}"]`)!;
    await click("外す", confirm);
    expect(api.agentHooksSet).toHaveBeenCalledExactlyOnceWith("claude", false);
    expect(container.textContent).not.toContain(text);
    expect(row().textContent).toContain("外しています");
  });
  it("serializes actions while busy and shows the returned state", async () => {
    let finish!: (value: AgentHooksStatus) => void;
    api.agentHooksSet.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(status({ state: "disabled" }));
    await click("入れる");
    expect(container.textContent).toContain("変更中…");
    expect(Array.from(container.querySelectorAll("button")).every((element) => element.disabled)).toBe(true);
    await click("入れる");
    expect(api.agentHooksSet).toHaveBeenCalledTimes(1);
    await act(async () => finish(status()));
    expect(row().textContent).toContain("入っています");
  });
  it("shows loading, a localized failure and a retry", async () => {
    let fail!: (reason: Error) => void;
    api.agentHooksStatus.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await act(async () => root.render(<AgentIntegrationsSection />));
    expect(container.textContent).toContain("確認中…");
    await act(async () => fail(new Error("read failed")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("状態を確認できませんでした。");
    await click("再確認", container);
    expect(row().textContent).toContain("入っています");
  });
  it("refreshes after a failed update without hiding the error", async () => {
    await render(status({ state: "disabled" }));
    api.agentHooksSet.mockRejectedValue(new Error("write failed"));
    api.agentHooksStatus.mockResolvedValue(status({ state: "needs-repair", reason: "unknown-shape" }));
    await click("入れる");
    expect(api.agentHooksStatus).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("変更できませんでした。");
    expect(row().textContent).toContain("設定ファイルの形を読み取れない");
  });
});
