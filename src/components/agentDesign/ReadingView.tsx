import { useEffect, useState } from "react";
import type { AgentDesignApi, AgentDesignCatalog, DesignScene, DesignService } from "../../lib/agentDesignApi";
import { agentDesignStrings as s, chars, number } from "./agentDesignStrings";
import { AmountBand, Badge } from "./ui";

export function ReadingView({ catalog, service: a, api, query, notify }: { catalog: AgentDesignCatalog; service: DesignService; api: AgentDesignApi; query: string; notify: (n: string) => void }) {
  const [path, setPath] = useState(""); const [scene, setScene] = useState<DesignScene | null>(null); const [checking, setChecking] = useState(false);
  useEffect(() => { setScene(null); setPath(""); }, [catalog.cwd]);
  const codex = a.id === "codex"; const names = codex ? s.codexFlowNames : s.flowNames;
  const hookCount = (...events: string[]) => a.hooks.filter(h => events.includes(h.event)).length;
  const hooks = (...events: string[]) => a.hooks.filter(h => events.includes(h.event)).map(h => h.script === "unsupported" ? s.unsupported : h.script).join(" · ");
  const stages = [0, 1, 1, 1, 1, 2, 3, 4, 4, 4, 5, 6];
  const quantities = [null, a.context.instructions, a.context.memory, a.context.listing, a.context.startup, null, null, null, null, null, null, null];
  const details = [
    a.settings.filter(f => ["model", "effortLevel", "model_reasoning_effort", "approval_policy"].includes(f.key)).map(f => f.value).join(" · "),
    catalog.items.filter(i => i.service === a.id && i.layer === 3 && i.kind !== "rule").map(i => i.displayName + (i.active ? "" : " / " + s.overridden)).join(" · "),
    codex ? s.inputParts[1] : "MEMORY.md / 200 " + s.linesUnit + " / 25,000 " + s.charsUnit,
    number(a.session.listing.count) + " / " + s.readOnly,
    hooks("SessionStart") || s.unknown,
    hooks("UserPromptSubmit", "UserPrompt") || s.absent,
    hooks("PreToolUse", "PostToolUse", "PreToolCall", "PostToolCall") || s.absent,
    codex ? s.declared : s.pathMatch,
    s.timings.onDemand, s.timings.onDemand, hooks("Stop", "AfterAgent", "Response") || s.absent, hooks("SessionEnd") || s.absent,
  ];
  const unused = catalog.findings.find(f => f.service === a.id && f.kind === (codex ? "disabledPlugins" : "unusedListing"));
  const checkScene = async () => {
    setChecking(true);
    try { setScene(await api.scene(path, catalog.cwd)); } catch { notify(s.error); } finally { setChecking(false); }
  };
  return <div className="ad-split" data-ad-view="reading"><main className="ad-main">
    <p className="ad-intro">{catalog.cwd} / {s.flowHelp}</p>
    {a.id === "hermes" ? <p>{s.hermesScope}</p> : <ol className="ad-flow" aria-label={s.flowTitle}>{names.map((name, index) => (!query || (name + details[index]).toLowerCase().includes(query.toLowerCase())) && <li key={index} className={"ad-flow-step ad-flow-" + index}>
      <span className="ad-flow-stage">{index === 0 || stages[index] !== stages[index - 1] ? s.stages[stages[index]] : ""}</span><span className="ad-flow-dot" />
      <div className="ad-flow-card" tabIndex={-1}><div><strong>{name}{[4, 5, 6, 10, 11].includes(index) && " " + number(index === 4 ? hookCount("SessionStart") : index === 5 ? hookCount("UserPromptSubmit", "UserPrompt") : index === 6 ? hookCount("PreToolUse", "PostToolUse") : index === 10 ? hookCount("Stop", "AfterAgent", "Response") : hookCount("SessionEnd"))}</strong>
        <small>{index >= 1 && index <= 4 ? chars(quantities[index]) : index === 7 ? s.timings.conditional + " / " + s.unknown : [8, 9].includes(index) ? s.timings.onDemand + " / " + s.unknown : s.timings.outside} <Badge value={(index === 3 && a.session.listing.chars != null) || (index === 4 && a.context.startup != null) || (codex && [1, 2].includes(index) && quantities[index] != null) ? "measured" : "declaration"} evidence /></small></div>
        <p>{details[index]}</p></div>
    </li>)}</ol>}
  </main><aside className="ad-detail"><h2>{s.parts}</h2><AmountBand service={a} compact /><h3>{s.listingParts}</h3>
    <ul className="ad-listing-parts">{a.session.listing.groups.map(g => <li key={g.kind}>{s.groupNames[g.kind] ?? s.unknown} {number(g.count)} / {chars(g.chars)}</li>)}{a.session.listing.count == null && <li>{s.unknown}</li>}</ul>
    <h3>{s.reductions}</h3>{unused ? <p>{s.findingTitles[unused.kind]} {number(unused.count)} / {chars(unused.chars)}</p> : <p className="ad-muted">{s.noReduction}</p>}
    <h3>{s.scenario}</h3><code className="ad-path">{catalog.cwd}</code><label className="ad-form-field">{s.touchedPath}<input aria-label={s.touchedPath} value={path} onChange={e => setPath(e.target.value)} placeholder={s.touchedPathPlaceholder} /></label>
    <button onClick={() => void checkScene()} disabled={checking || !path.trim()}>{s.checkScenario}</button><p className="ad-muted">{s.scenarioNote}</p>
    {scene && <section role="status"><strong>{scene.itemIds.length ? s.conditionalAdded + " / " + chars(scene.chars) : s.noConditional}</strong>{scene.itemIds.map(id => <p key={id}>{catalog.items.find(i => i.id === id)?.displayName}</p>)}<Badge value="declaration" evidence /></section>}
    <h3>{s.source}</h3><code className="ad-path">{a.session.file ?? s.unknown}</code><p>{s.consumedRecords} {number(a.session.linesRead)} / {s.stoppedAt} {s.stopNames[a.session.stoppedAt] ?? s.unknown}</p>
  </aside></div>;
}
