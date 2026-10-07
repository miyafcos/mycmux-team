import { ArrowLeft } from "lucide-react";
import type { AgentDesignApi, AgentDesignCatalog, DesignItem, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars, number, count, bytes } from "./agentDesignStrings";
import { ItemDetail, Links, ServiceMark } from "./ui";
export const compareKinds = ["instruction", "folderInstruction", "rule", "settings", "permissionRules", "memoryIndex", "skill", "skillListing", "plugins", "agent", "mcp", "hooks", "scheduled", "reference"];
export function compareItems(catalog: AgentDesignCatalog, service: DesignService, row: number) {
  const root = service.root.replace(/\\/g, "/").toLowerCase();
  return catalog.items.filter(i => i.service === service.id && (row === 0 ? i.kind === "instruction" && i.path?.replace(/\\/g, "/").toLowerCase().startsWith(root + "/")
    : row === 1 ? ["instruction", "override", "shadowedInstruction"].includes(i.kind) && !i.path?.replace(/\\/g, "/").toLowerCase().startsWith(root + "/")
    : row === 4 ? i.kind === (service.id === "claude" ? "settings" : "permissionRules")
    : i.kind === compareKinds[row]));
}
function summary(catalog: AgentDesignCatalog, a: DesignService, row: number) {
  if (a.state === "absent") return [s.absent, a.root];
  const st = a.stats; const docs = compareItems(catalog, a, row);
  const name = docs.map(i => i.displayName).slice(0, 2).join(" · ") || s.absent;
  if (a.id === "hermes") return [row === 6 ? count(st.skillsOwn) : docs.some(i => i.active) ? name : s.absent, docs[0]?.path ?? s.hermesScope];
  if (row <= 1) { const active = docs.filter(i => i.active); const amount = active.length && active.every(i => i.size.chars != null) ? active.reduce((sum, i) => sum + i.size.chars!, 0) : null; return [name, chars(amount) + (docs.some(i => i.kind === "override") ? " / " + s.overridden : "")]; }
  if (row === 2) return a.id === "claude" ? [count(st.rules), s.timings.always + " " + number(st.rulesAlways) + " / " + s.timings.conditional + " " + number(st.rulesConditional)] : [s.absent, "AGENTS.md"];
  if (row === 3) return [name, a.settings.filter(f => ["model", "effortLevel", "model_reasoning_effort"].includes(f.key)).map(f => f.value).join(" · ")];
  if (row === 4) return a.id === "claude" ? [s.fieldNames.allowCount + " " + number(st.allow) + " + " + number(st.allowLocal), a.settings.find(f => f.key === "defaultMode")?.value ?? s.unknown]
    : ["default.rules " + bytes(st.rulesBytes), a.settings.filter(f => ["approval_policy", "sandbox_mode"].includes(f.key)).map(f => f.value).join(" · ")];
  if (row === 5) return [count(st.memoryFiles), chars(a.context.memory) + " / " + s.timings.always];
  if (row === 6) return [a.id === "claude" ? count(st.skillsOwn) : number(st.skillsCodex) + " + " + number(st.skillsAgents), s.groupNames.user + " / " + number(a.session.listing.groups.find(g => g.kind === "user")?.count ?? (a.id === "claude" ? a.session.listing.groups.find(g => g.kind === "own")?.count : null))];
  if (row === 7) return [count(a.session.listing.count), chars(a.session.listing.chars) + " / " + s.timings.always];
  if (row === 8) return [count(st.plugins), s.enabled + " " + number(st.pluginsEnabled) + (Object.keys(a.session.listing.disabledCounts).length ? " / " + s.damaged : "")];
  if (row === 9) return [count(st.agents), a.id === "claude" ? "agents/*.md" : "agents/*.toml"];
  if (row === 10) return [a.id === "claude" ? number(st.mcpUser) + " + " + number(st.mcpProject) : count(st.mcp), a.id === "codex" ? s.mcpCommented + " " + number(st.mcpCommented) : s.fieldNames.count];
  if (row === 11) return [number(st.hookEvents) + " / " + number(st.hookHandlers), "hooks_dispatch.py / hooks.json"];
  if (row === 12) return [count(st.scheduledJobs), s.enabled + " " + number(st.scheduledEnabled)];
  return [count(st.references), s.layerNotes[7]];
}
export function ComparisonView({ catalog, api, query, selectedRow, setSelectedRow, opened, setOpened, onSkill }: {
  catalog: AgentDesignCatalog; api: AgentDesignApi; query: string; selectedRow: number; setSelectedRow: (r: number) => void; opened: boolean; setOpened: (b: boolean) => void; onSkill: (id?: string) => void;
}) {
  const services = ["claude", "codex", "hermes"].map(id => catalog.services.find(a => a.id === id)!);
  const tag = (row: number) => row === 8 && Object.keys(services[1].session.listing.disabledCounts).length ? s.damaged : row === 2 ? s.claudeOnly : [1, 4, 6].includes(row) ? s.differentForm : [9, 10, 11, 12, 13].includes(row) ? s.differentCount : s.sameRole;
  const rows = s.compareRows.map((label, row) => ({ label, row })).filter(({ label, row }) => !query || (label + services.map(a => summary(catalog, a, row).join(" ")).join(" ")).toLowerCase().includes(query.toLowerCase()));
  const selected = (a: DesignService): DesignItem | undefined => { const items = compareItems(catalog, a, selectedRow); return items.find(i => i.active && i.documentAllowed) ?? items.find(i => i.active) ?? items[0]; };
  return <main className="ad-compare ad-main" data-ad-view="compare">
    <p className="ad-intro">{s.compareHelp}</p>
    {opened ? <><button className="ad-back" onClick={() => setOpened(false)}><ArrowLeft size={13} />{s.back}</button><h2>{s.compareRows[selectedRow]}</h2>
      <div className="ad-compare-documents">{services.map(a => <section key={a.id}><h3><ServiceMark id={a.id} />{a.displayName}</h3>
        {selected(a) ? <ItemDetail item={selected(a)!} catalog={catalog} api={api} onBack={() => setOpened(false)} onSkill={onSkill} /> : <p>{s.absent}</p>}</section>)}</div></>
      : <table className="ad-compare-table" tabIndex={0} aria-label={s.compareTitle}><colgroup><col style={{ width: "14%" }} /><col style={{ width: "29%" }} /><col style={{ width: "29%" }} /><col style={{ width: "17%" }} /><col style={{ width: "11%" }} /></colgroup>
        <thead><tr><th>{s.sameRole}</th>{services.map(a => <th key={a.id}><ServiceMark id={a.id} />{a.displayName}</th>)}<th>{s.compareTag}</th></tr></thead>
        <tbody>{rows.map(({ label, row }) => <tr key={row} tabIndex={-1} data-ad-compare-row={row} aria-selected={row === selectedRow} className={row === selectedRow ? "selected" : ""} onClick={() => { setSelectedRow(row); setOpened(true); }}>
          <th scope="row">{label}</th>{services.map(a => { const values = summary(catalog, a, row); return <td key={a.id}><strong>{values[0]}</strong><small>{values[1]}</small></td>; })}<td><span className={"ad-compare-tag" + (tag(row) === s.damaged ? " damaged" : "")}>{tag(row)}</span></td></tr>)}</tbody>
      </table>}
    <h3>{s.crossLinks}</h3><Links catalog={catalog} links={catalog.links.filter(l => l.sourceService !== l.targetService)} />
  </main>;
}
