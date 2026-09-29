import { isIgnoredPromptDecoration } from "../components/layout/tabSweep";

export interface PromptShapeMatch {
  line: number;
  kind: "question" | "choice" | "field";
}

const CURSOR_CHOICE = /^\s*[>❯›▶]\s*\S/u;
const NUMBERED_CHOICE = /^\s*(?:\d+\.|\[\d+\])(?:\s+\S.*)?$/u;
const CONFIRMATION_CHOICE = /(?:\[(?:y\/n|y\/N|Y\/n)\]|\((?:y\/n|y\/N|Y\/n)\))/u;

function usable(line: string): boolean {
  return !isIgnoredPromptDecoration(line);
}

function isChoice(line: string): boolean {
  return usable(line) && (CURSOR_CHOICE.test(line) || NUMBERED_CHOICE.test(line) || CONFIRMATION_CHOICE.test(line));
}

export function detectPromptShape(lines: readonly string[]): PromptShapeMatch | null {
  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line] ?? "";
    if (!usable(value) || !value.trimEnd().endsWith("?")) continue;
    for (let offset = 1; offset <= 3 && line + offset < lines.length; offset += 1) {
      if (isChoice(lines[line + offset] ?? "")) return { line, kind: "question" };
    }
  }

  for (let line = 0; line + 1 < lines.length; line += 1) {
    if (isChoice(lines[line] ?? "") && isChoice(lines[line + 1] ?? "")) {
      return { line, kind: "choice" };
    }
  }

  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line] ?? "";
    if (!usable(value) || !/[>:]\s*$/u.test(value)) continue;
    if (lines.slice(line + 1).every((next) => !usable(next))) return { line, kind: "field" };
  }
  return null;
}
