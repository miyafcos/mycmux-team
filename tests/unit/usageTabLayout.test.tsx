// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAccountProfile, CliAccountsSnapshot, CliProvider } from "../../src/lib/ipc";

// 設定 → アカウント・使用量, rendered with the real stores. Only the Tauri
// boundary is mocked, so this checks how the pieces are put together.
const ipc = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("../../src/lib/appConfirmation", () => ({ cancelAppConfirmations: vi.fn(() => false), confirm: vi.fn(async () => false) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "C:\\Users\\test") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command === "list_cli_accounts" ? structuredClone(ipc.snapshot) : null)),
  Channel: class {},
}));

import { UsageTab } from "../../src/components/settings/tabs/UsageTab";
import { useAccountAutoSwitchStore } from "../../src/stores/accountAutoSwitchStore";
import { useCliAccountStore } from "../../src/stores/cliAccountStore";
import { useCliLoginStore } from "../../src/stores/cliLoginStore";

function profile(id: string, provider: CliProvider): CliAccountProfile {
  return { id, provider, label: `label-${id}`, email: `${id}@example.test`, identity_key: id, plan: null,
    org_name: null, captured_at: "2026-09-01T00:00:00Z", last_switched_at: null, needs_relogin: false };
}

function snapshot(): CliAccountsSnapshot {
  return {
    profiles: [profile("a", "claude"), profile("b", "claude"), profile("c", "claude"), profile("x", "codex")],
    live: [
      { provider: "claude", present: true, email: "a@example.test", identity_key: "a", matched_profile_id: "a", plan: null, org_name: null, error: null },
      { provider: "codex", present: true, email: "x@example.test", identity_key: "x", matched_profile_id: "x", plan: null, org_name: null, error: null },
      { provider: "grok", present: false, email: null, identity_key: null, matched_profile_id: null, plan: null, org_name: null, error: null },
    ],
    active: { claude: "a", codex: "x", grok: null },
    orphans: [],
    backup_root: "C:\\backup",
    generated_at: "2026-09-25T00:00:00Z",
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ipc.snapshot = snapshot();
  localStorage.clear();
  useAccountAutoSwitchStore.setState({ enabled: { claude: false, codex: false, grok: false },
    excludedTargets: { claude: [], codex: [], grok: [] }, attempts: {}, status: {} });
  useCliLoginStore.setState({ byProvider: { claude: null, codex: null, grok: null } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<UsageTab />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function block(title: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
  if (!found) throw new Error(`no block for ${title}`);
  return found;
}

describe("アカウント・使用量 tab", () => {
  it("keeps each provider's switch, candidates and accounts in one block", () => {
    const claude = block("Claude Code");
    expect(claude.querySelectorAll('input[role="switch"]')).toHaveLength(1);
    const ticks = claude.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])');
    // The address keeps two accounts renamed alike apart for a screen reader.
    expect([...ticks].map((tick) => tick.getAttribute("aria-label"))).toEqual([
      "「label-a」(a@example.test) を自動切り替えの候補にする",
      "「label-b」(b@example.test) を自動切り替えの候補にする",
      "「label-c」(c@example.test) を自動切り替えの候補にする",
    ]);
    expect(claude.querySelector('button[aria-label="Claude Code のアカウントを追加"]')?.textContent).toBe("+ アカウントを追加");

    // One account: nowhere to switch to. None: nothing to list either.
    const codexSwitch = block("Codex").querySelector<HTMLInputElement>('input[role="switch"]');
    expect(codexSwitch?.disabled).toBe(true);
    expect(block("Codex").textContent).toContain("アカウントを 2 つ以上登録すると使えます。");
    expect(block("Grok Build").textContent).toContain("登録済みアカウントはありません");

    // The old stand-alone section is gone; its caveat lives in the intro.
    expect(host.textContent).not.toContain("アカウントの自動切り替え");
    expect(host.textContent).toContain("新しく起動するセッションから反映");
  });

  it("changes only the ticked provider's candidates", async () => {
    const tick = block("Claude Code").querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')[1];
    await act(async () => tick.click());
    expect(useAccountAutoSwitchStore.getState().excludedTargets).toEqual({ claude: ["b"], codex: [], grok: [] });
  });

  it("gives every candidate tick its own name, even for look-alike accounts", async () => {
    const twin = (id: string) => ({ ...profile(id, "claude"), label: "仕事用", email: null });
    const next = snapshot();
    next.profiles = [profile("a", "claude"), twin("t1"), twin("t2")];
    ipc.snapshot = next;
    await act(async () => useCliAccountStore.getState().fetch());
    const names = [...block("Claude Code").querySelectorAll('input[type="checkbox"]:not([role="switch"])')]
      .map((tick) => tick.getAttribute("aria-label"));
    expect(names).toEqual([
      "「label-a」(a@example.test) を自動切り替えの候補にする",
      "「仕事用」(2 件目) を自動切り替えの候補にする",
      "「仕事用」(3 件目) を自動切り替えの候補にする",
    ]);
  });

  it("keeps the in-use tag while that account is being renamed", async () => {
    const row = host.querySelector<HTMLElement>('[data-cli-account-row="a"]');
    expect(row?.textContent).toContain("使用中");
    const rename = [...row!.querySelectorAll("button")].find((button) => button.textContent === "名前");
    await act(async () => rename?.click());
    expect(row!.querySelector("input:not([type])")).not.toBeNull();
    expect(row!.textContent).toContain("使用中");
  });

  it("puts every piece of text on the settings type scale", async () => {
    // The complaint this guards: the auto-switch labels carried no size and
    // fell through to the browser's 16px while the rest of the dialog is 12px.
    // A login in progress is included: its line and 中止 button live here too.
    await act(async () => {
      useCliLoginStore.setState({ byProvider: { claude: { stage: "waiting", loginId: "login-1", mode: "new",
        startedAt: Date.now(), sessionId: null, tabId: null }, codex: null, grok: null } });
    });
    expect(block("Claude Code").textContent).toContain("中止");
    const allowed = new Set(["12px", "var(--cmux-font-size-xs)"]);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const offenders: string[] = [];
    let checked = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text) continue;
      checked += 1;
      let element: HTMLElement | null = node.parentElement;
      let size = "";
      while (element && element !== host) {
        size = element.style.fontSize;
        if (size && size !== "inherit") break;
        element = element.parentElement;
      }
      if (!element || element === host || !allowed.has(size)) offenders.push(`${text.slice(0, 20)} -> ${size || "(unsized)"}`);
    }
    expect(checked).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
  });
});
