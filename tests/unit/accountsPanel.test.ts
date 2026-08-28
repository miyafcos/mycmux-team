import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountsPanel } from "../../src/components/layout/AccountsPanel";
import {
  SHARED_RESET_TITLE,
  formatResetShort,
} from "../../src/lib/accountRows";
import type { ProfileUsage, WindowStat } from "../../src/lib/ipc";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const panelSource = read("../../src/components/layout/AccountsPanel.tsx");
const buttonSource = read("../../src/components/layout/AccountsButton.tsx");
const cliPanelSource = read("../../src/components/settings/CliAccountsPanel.tsx");
const titleBarSource = read("../../src/components/layout/TitleBar.tsx");
const progressSource = read("../../src/components/common/CliLoginProgress.tsx");

describe("active account guard", () => {
  it("never switches to the account already in use and keeps its row disabled", () => {
    const handler = panelSource.slice(
      panelSource.indexOf("const handleClick = async"),
      panelSource.indexOf("const message =", panelSource.indexOf("const handleClick = async")),
    );
    expect(handler).toContain("if (row.is_active) return;");
    expect(panelSource).toContain("disabled={disabled}");
  });

  it("leaves an unregistered live login clickable so it can be captured in place", () => {
    expect(panelSource).toContain("await capture(row.provider)");
    // registered && needs_relogin is what disables a row, not "not registered".
    expect(panelSource).toContain("providerBusy || row.needs_relogin");
  });
});

describe("titlebar button", () => {
  it("keeps a compact form at narrow widths and exposes the warning reason", () => {
    expect(buttonSource).not.toContain('return "hidden"');
    expect(buttonSource).toContain('return "compact"');
    expect(buttonSource).toContain("PROVIDER_SHORT.grok");
    expect(buttonSource).toContain('role="img"');
    expect(buttonSource).toContain("aria-label={attention}");
  });

  it("exposes dialog state and moves focus into the panel when opened", () => {
    expect(buttonSource).toContain('aria-haspopup="dialog"');
    expect(buttonSource).toContain("aria-expanded={isOpen}");
    expect(panelSource).toContain('role="dialog"');
    expect(panelSource).toContain('querySelector<HTMLButtonElement>(');
    expect(panelSource).toContain('"button:not([disabled])"');
    expect(panelSource).toContain("(firstButton ?? menuRef.current)?.focus()");
  });

  it("keeps all four width modes reachable and polling centralized", () => {
    expect(buttonSource).toContain(
      'type AccountsButtonMode = "full" | "medium" | "compact" | "extreme"',
    );
    expect(buttonSource).toContain('if (resolved === "hidden") return "extreme";');
    expect(buttonSource).toContain('if (resolved === "compact" && flags.max1000) return "compact";');
    expect(buttonSource).toContain('if (resolved === "compact") return "medium";');
    expect(buttonSource).toContain('return "full";');
    expect(buttonSource).toContain("resolveMeterMode(flags, hasAccountChips)");
    expect(buttonSource).toContain('<WindowChip label="5h"');
    expect(buttonSource).toContain('<WindowChip label="7d"');
    expect(buttonSource).not.toContain("setInterval");
    expect(buttonSource).not.toContain('addEventListener("focus"');
  });

  it("is the only account surface the titlebar mounts", () => {
    expect(titleBarSource).toContain("<AccountsButton");
    expect(titleBarSource).not.toContain("<CliAccountBadge />");
    expect(titleBarSource).not.toContain("<UsageMeter />");
    expect(titleBarSource).not.toContain("<UsageAccountsDialog />");
  });
});

describe("panel layout", () => {
  it("puts each account on one row of two lines with a provider badge", () => {
    expect(panelSource).toContain("{PROVIDER_SHORT[row.provider]}");
    expect(panelSource).toContain("const windows = displayWindows(row)");
    expect(panelSource).toContain("windows.map(({ key, ...window })");
    // The provider headings the old panel grouped by are gone.
    expect(panelSource).not.toContain("PROVIDER_TITLE");
  });

  it("keeps the trailing status label on screen no matter how many meters a row has", () => {
    // A row is a one-column grid: an auto column would take its width from the
    // widest line (the meters), lay the line above out at that width, and push
    // "使用中" past the 400px panel, which clips it.
    expect(panelSource).toContain('gridTemplateColumns: "minmax(0, 1fr)"');
    // Per-model windows buy their space by shrinking the meters, not by
    // wrapping the row onto more lines.
    expect(panelSource).toContain(
      'const dense = windows.length >= 4 ? "tight" : windows.length >= 3 ? "snug" : "roomy"',
    );
    expect(panelSource).toContain(
      'const cells = dense === "tight" ? 3 : dense === "snug" ? 5 : 10',
    );
    expect(panelSource).toContain('dense !== "tight" &&');
    expect(panelSource).not.toContain('flexWrap: "wrap"');
  });

  it("drops the provenance vocabulary that existed to reconcile two sources", () => {
    for (const gone of [
      "usageSourceLabel",
      "CLI 使用量",
      "使用量登録",
      "unattributedSummary",
      "accountNoticeMessage",
    ]) {
      expect(panelSource).not.toContain(gone);
    }
  });

  it("shows reset times in the local language, on hover", () => {
    expect(panelSource).not.toContain("Resets at");
    expect(panelSource).toContain("title={hint}");
  });

  it("links to the detail tab and leaves capture to the backend watcher", () => {
    expect(panelSource).toContain("⚙ 詳細");
    expect(panelSource).toContain("onOpenUsageSettings");
    // Outside logins are auto-registered by live_sync, so the footer has no
    // manual capture button (the settings panel keeps its update variant).
    expect(panelSource).not.toContain("+ 現在のログインを登録");
    expect(panelSource).not.toContain("先にログインが必要です");
  });

  it("confirms before switching and keeps the warning wording", () => {
    expect(panelSource).toContain("switchWarningText(");
    expect(panelSource).toContain('title: "CLI アカウントを切り替える"');
    expect(panelSource).toContain('kind: "warning"');
    expect(panelSource).toContain('cancelLabel: "キャンセル"');
  });
});

describe("CliAccountsPanel editing contracts", () => {
  it("does not submit or cancel a rename while the IME is composing", () => {
    expect(cliPanelSource).toContain('event.key === "Enter" && !event.nativeEvent.isComposing');
    expect(cliPanelSource).toContain('event.key === "Escape" && !event.nativeEvent.isComposing');
  });
});

describe("add account entry points", () => {
  const footerSource = panelSource.slice(panelSource.indexOf("function Footer"));

  it("lets the panel add an account with no live login, unlike capture", () => {
    expect(footerSource).toContain("+ アカウントを追加");
    // Only an in-flight login disables it; `canCapture` gates the other button.
    expect(footerSource).toContain("disabled={loginInProgress}");
    expect(footerSource).toContain('startLogin(provider, "new")');
  });

  it("shows the wait in the button and takes its abort from the shared component", () => {
    expect(footerSource).toContain("ログイン待機中… ${loginRemainingLabel(loginEntry.startedAt, nowMs)}");
    expect(footerSource).toContain("<CliLoginProgress provider={loginProvider} compact />");
    // Exactly one abort control in the footer, and it is the shared one.
    expect(progressSource).toContain("中止");
    expect(footerSource).not.toContain("中止");
  });

  it("keeps one abort control and the three stage strings in the shared component", () => {
    expect(progressSource).toContain('"ログイン画面を開いています…"');
    expect(progressSource).toContain('"登録中…"');
    expect(progressSource).toContain("`ログインの完了を待っています… ${loginRemainingLabel(entry.startedAt, nowMs)}`");
    expect(cliPanelSource).toContain("<CliLoginProgress key={provider} provider={provider} />");
  });

  it("opens the provider choice on left click, never a context menu", () => {
    expect(footerSource).toContain('aria-haspopup="menu"');
    expect(footerSource).toContain("setAddMenuOpen((open) => !open)");
    expect(panelSource).not.toContain("onContextMenu");
  });

  it("has no manual capture action; registration is the watcher's job", () => {
    expect(footerSource).not.toContain("現在のログインを登録");
    expect(footerSource).not.toContain("capture(");
    // An unregistered row can still be captured in place while the watcher
    // has not caught up yet.
    expect(panelSource).toContain("await capture(row.provider)");
  });

  it("offers add buttons and an in-place relogin in the settings panel", () => {
    expect(cliPanelSource).toContain("+ {addAccountLabel(provider)}");
    expect(cliPanelSource).toContain('label="再ログイン"');
    expect(cliPanelSource).toContain('startLogin(profile.provider, "reauth", profile.id)');
    // A profile kept for re-login must still be removable from the same row.
    expect(cliPanelSource).toContain('label="削除"');
    // The old CLI-first instructions stay, demoted to a note.
    expect(cliPanelSource).toContain("現在のログインを登録/更新");
    expect(cliPanelSource).toContain("codex login");
  });
});

function stat(pct: number, resets_at: string): WindowStat {
  return { pct, resets_at };
}

function usageRow(overrides: Partial<ProfileUsage> = {}): ProfileUsage {
  return {
    profile_id: "row-1",
    provider: "claude",
    label: "one",
    email: "anna@example.com",
    plan: null,
    registered: true,
    is_active: false,
    needs_relogin: false,
    state: "ok",
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    model_windows: [],
    error_code: null,
    retry_at: null,
    fetched_at: "2026-08-21T12:00:00Z",
    ...overrides,
  };
}

function renderPanel(row: ProfileUsage): string {
  return renderToStaticMarkup(
    createElement(AccountsPanel, {
      rows: [row],
      onClose: () => {},
      onOpenUsageSettings: () => {},
    }),
  );
}

function countResetMarks(html: string): number {
  return (html.match(/↻/g) ?? []).length;
}

describe("shared reset mark (render)", () => {
  const sharedIso = "2026-08-27T00:00:00Z";

  it("T2: draws exactly one ↻ with the short date on a Grok-shaped shared row", () => {
    const html = renderPanel(
      usageRow({
        provider: "grok",
        email: "tari@kywa.uk",
        seven_day: stat(65, sharedIso),
        model_windows: [
          { key: "GrokBuild", window: stat(59, sharedIso) },
          { key: "GrokHeavy", window: stat(4, sharedIso) },
          { key: "GrokFast", window: stat(2, sharedIso) },
        ],
      }),
    );
    const label = formatResetShort(sharedIso);
    expect(countResetMarks(html)).toBe(1);
    expect(html).toContain(`↻${label}`);
    expect(html).toContain(SHARED_RESET_TITLE);
  });

  it("T3: draws one ↻ per window when the dates differ, and no shared mark", () => {
    const html = renderPanel(
      usageRow({
        five_hour: stat(12, "2026-07-20T00:00:00Z"),
        seven_day: stat(22, "2026-08-26T00:00:00Z"),
        model_windows: [
          { key: "seven_day_fable", window: stat(26, "2026-08-28T00:00:00Z") },
        ],
      }),
    );
    expect(countResetMarks(html)).toBe(3);
    expect(html).toContain(`↻${formatResetShort("2026-07-20T00:00:00Z")}`);
    expect(html).toContain(`↻${formatResetShort("2026-08-26T00:00:00Z")}`);
    expect(html).toContain(`↻${formatResetShort("2026-08-28T00:00:00Z")}`);
    expect(html).not.toContain(SHARED_RESET_TITLE);
  });

  it("T4: keeps one shared ↻ in tight rows and draws none when tight dates differ", () => {
    const sharedHtml = renderPanel(
      usageRow({
        provider: "grok",
        seven_day: stat(65, sharedIso),
        model_windows: [
          { key: "a", window: stat(59, sharedIso) },
          { key: "b", window: stat(4, sharedIso) },
          { key: "c", window: stat(2, sharedIso) },
        ],
      }),
    );
    expect(countResetMarks(sharedHtml)).toBe(1);
    expect(sharedHtml).toContain(`↻${formatResetShort(sharedIso)}`);
    expect(sharedHtml).toContain(SHARED_RESET_TITLE);

    const mixedHtml = renderPanel(
      usageRow({
        seven_day: stat(10, "2026-08-22T00:00:00Z"),
        model_windows: [
          { key: "a", window: stat(20, "2026-08-23T00:00:00Z") },
          { key: "b", window: stat(30, "2026-08-24T00:00:00Z") },
          { key: "c", window: stat(40, "2026-08-25T00:00:00Z") },
        ],
      }),
    );
    expect(countResetMarks(mixedHtml)).toBe(0);
    expect(mixedHtml).not.toContain(SHARED_RESET_TITLE);
  });

  it("T2-claude: draws exactly one ↻ on a Claude snug row whose windows share a date", () => {
    const html = renderPanel(
      usageRow({
        provider: "claude",
        five_hour: stat(12, sharedIso),
        seven_day: stat(22, sharedIso),
        seven_day_sonnet: stat(26, sharedIso),
      }),
    );
    expect(countResetMarks(html)).toBe(1);
    expect(html).toContain(`↻${formatResetShort(sharedIso)}`);
    expect(html).toContain(SHARED_RESET_TITLE);
  });

  it("T2-claude-roomy: draws exactly one ↻ on a Claude two-window row with a shared date", () => {
    const html = renderPanel(
      usageRow({
        provider: "claude",
        five_hour: stat(12, sharedIso),
        seven_day: stat(22, sharedIso),
      }),
    );
    expect(countResetMarks(html)).toBe(1);
    expect(html).toContain(`↻${formatResetShort(sharedIso)}`);
    expect(html).toContain(SHARED_RESET_TITLE);
  });

  it("T2-claude-stale: keeps one shared ↻ on a Claude cooldown row with last-known windows", () => {
    const html = renderPanel(
      usageRow({
        provider: "claude",
        state: "cooldown",
        retry_at: "2026-08-21T13:00:00Z",
        five_hour: stat(12, sharedIso),
        seven_day: stat(22, sharedIso),
        seven_day_sonnet: stat(26, sharedIso),
      }),
    );
    expect(countResetMarks(html)).toBe(1);
    expect(html).toContain(`↻${formatResetShort(sharedIso)}`);
    expect(html).toContain(SHARED_RESET_TITLE);
  });
});


// Reported as "the grok limit shows three numbers and I can't tell what any of
// them are". A grok row carries one meter, so the line reads 65% / a reset date
// / a fetch time -- three numbers where only the first is a limit, and the
// reset was marked with a bare arrow. One meter has room to say the word.
describe("single-meter rows spell out the reset date", () => {
  const resetIso = "2026-08-29T00:00:00Z";

  it("writes リセット next to a lone meter", () => {
    const html = renderPanel(usageRow({
      provider: "grok",
      seven_day: stat(65, resetIso),
    }));

    // The hover copy has always said "リセット <full date>"; what changed is
    // the visible text, which now carries the short date instead of an arrow.
    expect(html).toContain(`>リセット ${formatResetShort(resetIso)}<`);
    expect(countResetMarks(html)).toBe(0);
  });

  // claude's 5h and 7d reset on different days, so they cannot collapse into
  // one mark. Spelling the word twice would run past the panel's width.
  it("keeps the arrow once a second meter shares the line", () => {
    const html = renderPanel(usageRow({
      five_hour: stat(20, "2026-08-27T00:00:00Z"),
      seven_day: stat(65, resetIso),
    }));

    expect(html).not.toContain(`>リセット ${formatResetShort(resetIso)}<`);
    expect(countResetMarks(html)).toBe(2);
  });

  it("still labels the fetch time so it is not read as a limit", () => {
    const html = renderPanel(usageRow({
      provider: "grok",
      seven_day: stat(65, resetIso),
    }));

    expect(html).toContain("取得 ");
  });
});
