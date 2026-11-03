/** Synthetic agent-style output. Keep all names fictional and widths reproducible. */
export function paneScreenSampleAnsi(cols: number, rows: number): string {
  const border = "─".repeat(cols - 2);
  const line = (row: number, text: string) => `\x1b[${row};1H${text}`;
  return [
    "\x1b[2J\x1b[H",
    line(1, `\x1b[90m┌${border}┐\x1b[0m`),
    line(2, "\x1b[90m│\x1b[0m  \x1b[1;38;2;136;192;208mSample Agent\x1b[0m  サンプル企画"),
    line(3, `\x1b[90m└${border}┘\x1b[0m`),
    line(5, "  \x1b[32m⏺\x1b[0m 読み取り専用の画面を確認しています"),
    line(7, "    1. 字下げと空行を保持"),
    line(8, "    2. 日本語・結合文字 e\u0301・絵文字 🧪"),
    line(10, "  \x1b[3;38;5;110mReviewing a small synthetic change\x1b[0m"),
    line(12, "\x1b[31m  - const mode = 'text';\x1b[0m"),
    line(13, "\x1b[32m  + const mode = 'cells';\x1b[0m"),
    line(15, "    \x1b[4mBackground-only cells follow:\x1b[0m"),
    line(16, "    \x1b[48;2;45;65;80m              \x1b[0m"),
    line(18, "    \x1b[9mold note\x1b[0m  \x1b[7m review \x1b[0m  \x1b[2mdim\x1b[0m"),
    line(20, "  " + "A wrapped physical row remains separate. ".repeat(4)),
    line(rows - 3, `\x1b[90m${"─".repeat(cols)}\x1b[0m`),
    line(rows - 2, "  \x1b[38;2;136;192;208m❯\x1b[0m 次の入力を待っています"),
    `\x1b[${rows - 1};3H\x1b[?25h`,
  ].join("");
}
