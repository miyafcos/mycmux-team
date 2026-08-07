import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const menuSourcePath = fileURLToPath(
  new URL("../../src/components/layout/CliAccountMenu.tsx", import.meta.url),
);
const badgeSourcePath = fileURLToPath(
  new URL("../../src/components/layout/CliAccountBadge.tsx", import.meta.url),
);
const panelSourcePath = fileURLToPath(
  new URL("../../src/components/settings/CliAccountsPanel.tsx", import.meta.url),
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
});

describe("CliAccountsPanel editing contracts", () => {
  it("does not submit or cancel a rename while the IME is composing", () => {
    const source = readFileSync(panelSourcePath, "utf8");
    expect(source).toContain('event.key === "Enter" && !event.nativeEvent.isComposing');
    expect(source).toContain('event.key === "Escape" && !event.nativeEvent.isComposing');
  });
});
