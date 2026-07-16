import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { THEMES } from "../../src/components/theme/themeDefinitions";

// WCAG AA body-text floor. chrome.textDim/chrome.textMuted back real
// readable content (ErrorBoundary crash messages, notification/log lines)
// at small font sizes, so both must clear this against chrome.background.
const CONTRAST_TARGET = 4.5;

describe("theme chrome text contrast", () => {
  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: textDim meets contrast floor against chrome.background",
    (_id, theme) => {
      const ratio = contrastRatio(theme.chrome.textDim, theme.chrome.background);
      expect(ratio).toBeGreaterThanOrEqual(CONTRAST_TARGET);
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: textMuted meets contrast floor against chrome.background",
    (_id, theme) => {
      const ratio = contrastRatio(theme.chrome.textMuted, theme.chrome.background);
      expect(ratio).toBeGreaterThanOrEqual(CONTRAST_TARGET);
    },
  );
});
