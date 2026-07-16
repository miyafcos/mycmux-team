import type { CSSProperties } from "react";

// Shared inline-style building blocks for SettingsDialog tabs. Mirrors the
// idioms previously inlined per-row in SettingsMenu.tsx (checkbox label
// rows, section headings, buttons) so every tab reads the same way.

export const checkboxLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--cmux-text)",
  cursor: "pointer",
  padding: "6px 0",
};

export function checkboxLabelStyleFor(enabled: boolean): CSSProperties {
  return {
    ...checkboxLabelStyle,
    color: enabled ? "var(--cmux-text)" : "var(--cmux-text-dim)",
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

export const sectionHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  marginBottom: 10,
};

export const sectionSubheadingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--cmux-text-dim, rgba(255,255,255,0.55))",
  marginBottom: 6,
};

export const dialogButtonStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--cmux-border)",
  background: "transparent",
  color: "var(--cmux-text)",
  cursor: "pointer",
};

export const dividerStyle: CSSProperties = {
  height: 1,
  background: "var(--cmux-border)",
  margin: "16px 0",
};

export const tabBodyStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  padding: 20,
};
