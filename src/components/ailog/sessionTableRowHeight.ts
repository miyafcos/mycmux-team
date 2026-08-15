import { UI_DENSITY_TOKENS, type UiDensity } from "../../stores/themeStore";

const STANDARD_LINE_HEIGHT = 1.2;
const CELL_VERTICAL_PADDING_PX = 10;
const CELL_BORDER_PX = 1;
const CHIP_VERTICAL_CHROME_PX = 6;

export function getSessionTableRowMetrics(
  density: UiDensity,
  uiFontScale: number,
): { rowHeight: number; lineHeight: number } {
  const tokens = UI_DENSITY_TOKENS[density];
  const baseFontSize = Number.parseFloat(tokens.fontXs);
  const fontSize = uiFontScale === 1
    ? baseFontSize
    : Math.max(11, Math.round(baseFontSize * uiFontScale));
  const lineHeight = tokens.lineHeightUi === "normal"
    ? STANDARD_LINE_HEIGHT
    : Number.parseFloat(tokens.lineHeightUi);
  const contentHeight = fontSize * lineHeight + CHIP_VERTICAL_CHROME_PX;
  return {
    rowHeight: Math.ceil(contentHeight + CELL_VERTICAL_PADDING_PX + CELL_BORDER_PX),
    lineHeight,
  };
}
