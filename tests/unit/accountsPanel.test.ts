import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const panelSource = read("../../src/components/layout/AccountsPanel.tsx");
const buttonSource = read("../../src/components/layout/AccountsButton.tsx");
const cliPanelSource = read("../../src/components/settings/CliAccountsPanel.tsx");
const titleBarSource = read("../../src/components/layout/TitleBar.tsx");

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
    expect(buttonSource).toContain("${PROVIDER_SHORT.claude}·${PROVIDER_SHORT.codex}");
    expect(buttonSource).toContain('role="img"');
    expect(buttonSource).toContain("aria-label={attention}");
  });

  it("exposes dialog state and moves focus into the panel when opened", () => {
    expect(buttonSource).toContain('aria-haspopup="dialog"');
    expect(buttonSource).toContain("aria-expanded={isOpen}");
    expect(panelSource).toContain('role="dialog"');
    expect(panelSource).toContain('querySelector<HTMLButtonElement>("button:not([disabled])")');
    expect(panelSource).toContain("(firstButton ?? menuRef.current)?.focus()");
  });

  it("keeps all four width modes reachable and polling centralized", () => {
    expect(buttonSource).toContain(
      'type AccountsButtonMode = "full" | "medium" | "compact" | "extreme"',
    );
    expect(buttonSource).toContain('if (resolved === "hidden") return "extreme";');
    expect(buttonSource).toContain('if (resolved === "compact" && flags.max900) return "compact";');
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
    expect(panelSource).toContain('<UsageBar label="5h"');
    expect(panelSource).toContain('<UsageBar label="7d"');
    // The provider headings the old panel grouped by are gone.
    expect(panelSource).not.toContain("PROVIDER_TITLE");
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
    expect(panelSource).toContain("title={resetHint(stat)}");
  });

  it("offers capture and a link to the detail tab in the footer", () => {
    expect(panelSource).toContain("+ 現在のログインを登録");
    expect(panelSource).toContain("先にログインが必要です");
    expect(panelSource).toContain("⚙ 詳細");
    expect(panelSource).toContain("onOpenUsageSettings");
    expect(panelSource).toContain("disabled={!canCapture}");
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
