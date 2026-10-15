// Read-only comparison: --evidence contains pane.list_all plus bounded native materials.
// --base points to src/lib extracted from the immutable starting commit.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  if (at < 0 || !args[at + 1]) throw new Error(`Missing ${name}`);
  return resolve(args[at + 1]);
};
const evidence = option("--evidence"), base = option("--base");
const modulePath = value => JSON.stringify(value.replaceAll("\\", "/"));
const bundle = await build({ write: false, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  stdin: { resolveDir: root, loader: "ts", contents: `
    export {createAutoNamePolicy as newPolicy, deriveAutoName as derive, UNKNOWN_AUTO_NAME as unknown} from ${modulePath(root + "/src/lib/autoNamePolicy.ts")};
    export {isAutomaticNameTarget} from ${modulePath(root + "/src/lib/autoNameOwnership.ts")};
    export {buildAutoNameEvidence as newEvidence} from ${modulePath(root + "/src/lib/autoNameMaterial.ts")};
    export {createAutoNamePolicy as basePolicy} from ${modulePath(base + "/src/lib/autoNamePolicy.ts")};
    export {buildAutoNameEvidence as baseEvidence} from ${modulePath(base + "/src/lib/autoNameMaterial.ts")};
  ` } });
const engine = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const read = name => JSON.parse(readFileSync(resolve(evidence, name), "utf8"));
const live = read("pane-list-all.json"), saved = read("saved-layout.json"), materials = read("naming-materials.json");
const savedTabs = new Map(saved.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => [t.tab_id, t]))));
const savedWorkspaces = new Map(saved.workspaces.map(w => [w.id, w]));
const byId = new Map(materials.map(row => [row.material.tab_id, row]));
const workspaces = new Map(), scanTabs = [];
for (const pane of live.panes) {
  const prior = savedWorkspaces.get(pane.workspaceId);
  const workspace = workspaces.get(pane.workspaceId) ?? {id:pane.workspaceId, name:pane.workspaceName,
    nameSource:prior?.name_source, status:"running", createdAt:0, gridTemplateId:"1x1", panes:[]};
  workspaces.set(workspace.id, workspace);
  const tabs = pane.tabs.map(tab => {
    const saved = savedTabs.get(tab.id);
    return {id:tab.id, sessionId:tab.sessionId, agentId:tab.agentId, type:tab.type ?? "terminal",
      label:tab.label ?? "", labelSource:saved?.label_source, displayName:tab.display_name ?? saved?.display_name,
      displayNameSource:saved?.display_name_source, cwd:tab.cwd ?? pane.cwd ?? "",
      agentKind:tab.liveAgentKind || tab.agentKind || "shell", agentSessionId:tab.agentSessionId ?? undefined};
  });
  workspace.panes.push({id:pane.id, sessionId:tabs[0]?.sessionId ?? "", agentId:pane.agentId, activeTabId:pane.activeTabId, tabs});
  for (const tab of tabs) scanTabs.push({...tab, workspaceId:workspace.id, workspaceName:workspace.name, paneId:pane.id,
    column:1, lastOutputAt:null, tail:[], sessionTitle:byId.get(tab.id)?.titles.session_title});
}
const scan = {tabs:scanTabs, workspaces:[...workspaces.values()], scannedAt:0, baseline:[], workspaceIds:[...workspaces.keys()], lineageClusters:[]};
function evaluate(policyFactory, evidenceBuilder) {
  const naming = new Map(scan.tabs.map(tab => [tab.id, evidenceBuilder(tab, byId.get(tab.id)?.material)]));
  const policy = policyFactory(() => 0);
  const result = policy.identify({...scan, naming});
  return {result, meanings:policy.meanings(), evidence:naming};
}
const before = evaluate(engine.basePolicy, engine.baseEvidence), after = evaluate(engine.newPolicy, engine.newEvidence);
const rows = scan.tabs.map(tab => {
  const automatic = after.result.tabs.get(tab.id)?.displayName;
  const protectedName = tab.labelSource === "user" ? tab.label : undefined;
  const fallback = tab.displayName ?? tab.label;
  return {id:tab.id, workspace:tab.workspaceName, kind:tab.agentKind, hasSessionId:!!tab.agentSessionId,
    label:tab.label, protected:!engine.isAutomaticNameTarget(tab),
    observed:protectedName ?? fallback, base:protectedName ?? before.result.tabs.get(tab.id)?.displayName ?? fallback,
    after:protectedName ?? automatic ?? fallback, source:after.meanings.get(tab.id)?.source,
    reason:engine.isAutomaticNameTarget(tab) ? after.meanings.get(tab.id)?.unknownReason : undefined,
    inferredObservedReason:engine.derive(after.evidence.get(tab.id)).unknownReason};
});
const counts = field => rows.filter(row => row[field]?.startsWith(engine.unknown)).length;
console.log(JSON.stringify({tabs:rows.length, observedUnknown:counts("observed"), baseUnknown:counts("base"), afterUnknown:counts("after"), rows}));
