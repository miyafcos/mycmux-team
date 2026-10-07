import { type ReactNode } from "react";

/** Highlight plain text without treating skill content as markup. */
export function SkillHighlight({ text, query }: { text: string; query: string }) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return <>{text}</>;
  const parts: ReactNode[] = []; const lower = text.toLocaleLowerCase(); let at = 0, next = lower.indexOf(term);
  while (next >= 0) { parts.push(text.slice(at, next), <mark key={next}>{text.slice(next, next + term.length)}</mark>); at = next + term.length; next = lower.indexOf(term, at); }
  parts.push(text.slice(at)); return <>{parts}</>;
}
