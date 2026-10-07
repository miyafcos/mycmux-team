import type { SkillRow } from "../../lib/skillsApi";

export type MatchGroup = "name" | "trigger" | "body";
export interface SkillMatch { row: SkillRow; group: MatchGroup; snippet: string }
/** Ordered exact substring matches: Japanese input and single characters work. */
export function searchSkills(rows: readonly SkillRow[], query: string): SkillMatch[] {
  const term = query.trim().toLocaleLowerCase();
  const matches: SkillMatch[] = [];
  for (const row of rows) {
    const name = [row.id, row.label, row.line, row.description, ...row.aliases].join(" ").toLocaleLowerCase();
    const triggers = (Array.isArray(row.triggers) ? row.triggers.join(" ") : row.triggers ?? "").toLocaleLowerCase();
    const body = row.body.toLocaleLowerCase();
    const group = !term || name.includes(term) ? "name" : triggers.includes(term) ? "trigger" : body.includes(term) ? "body" : null;
    if (group) {
      const index = body.indexOf(term);
      matches.push({ row, group, snippet: group === "body" ? row.body.slice(Math.max(0, index - 60), index + term.length + 140) : "" });
    }
  }
  return matches.sort((a, b) => ["name", "trigger", "body"].indexOf(a.group) - ["name", "trigger", "body"].indexOf(b.group));
}
