import type { ComposerAgentLabelKind } from "../../lib/composerSend";

export const COMPOSER_LINE_HEIGHT = 20;
export const COMPOSER_MAX_ROWS = 6;
export const COMPOSER_MIN_HEIGHT = COMPOSER_LINE_HEIGHT + 4;
export const COMPOSER_MAX_HEIGHT = COMPOSER_LINE_HEIGHT * COMPOSER_MAX_ROWS;
export const COMPOSER_PLACEHOLDER = "メッセージを入力";
export const COMPOSER_NEWLINE_HINT = "Shift+Enter で改行";

export const TARGET_LABEL: Record<ComposerAgentLabelKind, string> = {
  claude: "Claude",
  "claude-codex": "claude-codex",
  codex: "Codex",
  grok: "Grok",
  omp: "Oh My Pi",
  cursor: "Cursor",
  shell: "シェル",
};
