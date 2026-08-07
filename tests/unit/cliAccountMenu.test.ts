import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const menuSourcePath = fileURLToPath(
  new URL("../../src/components/layout/AccountsPanel.tsx", import.meta.url),
);
const badgeSourcePath = fileURLToPath(
  new URL("../../src/components/layout/AccountsButton.tsx", import.meta.url),
);
const panelSourcePath = fileURLToPath(
  new URL("../../src/components/settings/CliAccountsPanel.tsx", import.meta.url),
);
const titleBarSourcePath = fileURLToPath(
  new URL("../../src/components/layout/TitleBar.tsx", import.meta.url),
);

describe("CliAccountMenu active account guard", () => {
  it("does not invoke switching for the active account and keeps its row disabled", () => {
    const source = readFileSync(menuSourcePath, "utf8");
    const handler = source.slice(
      source.indexOf("const handleSwitch = async"),
      source.indexOf("return (", source.indexOf("const handleSwitch = async")),
    );
    expect(handler).toContain("if (isActive) return;");
    expect(source).toContain("disabled={disabled}");
    expect(source).not.toContain("disabled={disabled && !isActive}");
  });
});

describe("CliAccountBadge accessibility contracts", () => {
  it("keeps a compact badge at narrow widths and exposes the warning reason", () => {
    const source = readFileSync(badgeSourcePath, "utf8");
    expect(source).not.toContain('return "hidden"');
    expect(source).toContain('return "compact"');
    expect(source).toContain("${PROVIDER_SHORT.claude}·${PROVIDER_SHORT.codex}");
    expect(source).toContain('role="img"');
    expect(source).toContain("aria-label={attention}");
  });

  it("exposes dialog state and the menu moves focus when opened", () => {
    const badgeSource = readFileSync(badgeSourcePath, "utf8");
    const menuSource = readFileSync(menuSourcePath, "utf8");
    expect(badgeSource).toContain('aria-haspopup="dialog"');
    expect(badgeSource).toContain("aria-expanded={isOpen}");
    expect(menuSource).toContain('role="dialog"');
    expect(menuSource).toContain('querySelector<HTMLButtonElement>("button:not([disabled])")');
    expect(menuSource).toContain("(firstButton ?? menuRef.current)?.focus()");
  });

  it("keeps all four width modes reachable and polling centralized", () => {
    const source = readFileSync(badgeSourcePath, "utf8");
    const titleBarSource = readFileSync(titleBarSourcePath, "utf8");
    expect(source).toContain('type AccountsButtonMode = "full" | "medium" | "compact" | "extreme"');
    expect(source).toContain('if (resolved === "hidden") return "extreme";');
    expect(source).toContain('if (resolved === "compact" && flags.max900) return "compact";');
    expect(source).toContain('if (resolved === "compact") return "medium";');
    expect(source).toContain('return "full";');
    expect(source).toContain("resolveMeterMode(flags, hasAccountChips)");
    expect(source).toContain("<span>5h</span>");
    expect(source).toContain("<span>7d</span>");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain('addEventListener("focus"');
    expect(titleBarSource).toContain("<AccountsButton />");
    expect(titleBarSource).not.toContain("<CliAccountBadge />");
    expect(titleBarSource).not.toContain("<UsageMeter />");
  });
});

describe("CliAccountsPanel editing contracts", () => {
  it("does not submit or cancel a rename while the IME is composing", () => {
    const source = readFileSync(panelSourcePath, "utf8");
    expect(source).toContain('event.key === "Enter" && !event.nativeEvent.isComposing');
    expect(source).toContain('event.key === "Escape" && !event.nativeEvent.isComposing');
  });
});

describe("AccountsPanel usage provenance", () => {
  it("labels CLI live and OAuth account values separately", () => {
    const source = readFileSync(menuSourcePath, "utf8");
    const usageBlock = source.slice(
      source.indexOf('{row.usage.source !== "none"'),
      source.indexOf("{row.notices.map"),
    );
    expect(source).toContain('if (source === "cli-live") return "CLI 使用量";');
    expect(source).toContain('if (source === "oauth-account") return "使用量登録";');
    expect(usageBlock).toContain("{usageSourceLabel(row.usage.source)}");
    expect(usageBlock).toContain("row.usage.error && (");
    expect(usageBlock).toContain('<UsageRow label="5h"');
    expect(usageBlock).toContain('<UsageRow label="7d"');
  });
});
