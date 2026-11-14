import type { CSSProperties } from "react";

export const feedbackLabelStyle: CSSProperties = {
  display: "grid", gap: 6, fontSize: 12, color: "var(--cmux-text)",
};
export const feedbackInputStyle: CSSProperties = {
  boxSizing: "border-box", width: "100%", border: "1px solid var(--cmux-border)", borderRadius: 6,
  background: "var(--cmux-bg)", color: "var(--cmux-text)", padding: "7px 9px",
  fontFamily: "inherit", fontSize: 12, lineHeight: 1.5,
};
