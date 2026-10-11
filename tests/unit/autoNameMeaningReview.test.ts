import { expect, it } from "vitest";
import { buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import { buildAutoNameEvidence, type AutoNameScan, type AutoNameEvidence, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import { createAutoNamePolicy, deriveAutoName, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { aggregateWorkspaceName } from "../../src/lib/autoWorkspaceNaming";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";
import type { Workspace } from "../../src/types";
import { fixtureMaterial } from "./helpers/autoNamingInvariants";
function evidence(text: string): AutoNameEvidence {
  return { id: "t", workspaceId: "w", binding: "binding", contentKey: text, instructions: text ? [text] : [], activity: [], files: [], taskTitle: "", cwd: "", evidenceRefs: ["u"] };
}
const event = (index: number, kind: SemanticEventEnvelope["kind"]): SemanticEventEnvelope => ({ eventId: "e-" + index, sourceRevision: index, occurredAt: index, sourceByteStart: index * 10, sourceByteEnd: index * 10 + 10, kind });
async function harness() {
  let now = 0;
  const ws: Workspace = { id: "w", name: "old", nameSource: "auto", createdAt: 0, gridTemplateId: "1x1", status: "running",
    panes: [{ id: "p", sessionId: "s", activeTabId: "t", agentId: "shell-starter", tabs: [{ id: "t", sessionId: "s", agentId: "shell-starter", agentKind: "claude", agentSessionId: "a", cwd: "/sample" }] }] };
  const base = await buildLocalGroupingScan({ workspaces: [ws], metadata: {}, attentionByTabId: {}, now });
  const tab = base.tabs[0], policy = createAutoNamePolicy(() => now);
  const material: NamingMaterial = { tab_id: tab.id, pty_session_id: tab.sessionId, agent_session_id: tab.agentSessionId, agent_kind: tab.agentKind, cwd: tab.cwd, events: [] };
  const run = (at: number) => { now = at; const scan: AutoNameScan = { ...base, naming: new Map([[tab.id, buildAutoNameEvidence(tab, fixtureMaterial(material))]]) }; return policy.identify(scan).tabs.get("t")?.displayName; };
  return { base, tab, policy, material, run };
}
it.each(["動画を編集しない", "動画を編集しません", "動画は編集しないでください", "動画を編集するな", "動画を編集せずに待ってください", "動画を編集しなくてよい", "動画の編集はしません", "動画の編集をしない", "スライドは作らない", "字幕位置を直しません"])("R4: negation is not a positive task: %s", text => {
  expect(deriveAutoName(evidence(text)).strength).toBe("unknown");
});
it("R4: a rejected accepted task becomes unknown after the quiet period", async () => {
  const h = await harness();
  h.material.latest_instruction = "動画を編集する"; expect(h.run(0)).toBe("動画編集");
  h.material.latest_instruction = "動画を編集しません"; h.run(1_000);
  expect(h.run(11_000)).toBe(UNKNOWN_AUTO_NAME);
});
it.each(["続きをお願いします", "そのまま続けてください", "引き続きお願いします"])("R5: contextual continuation keeps bounded prior concrete work: %s", async text => {
  const h = await harness();
  h.material.events = [event(0, { type: "userMessage", kind: "taskStart", text: "方程式の解説スライドを作ってください", digest: "a" })];
  expect(h.run(0)).toBe("方程式の解説スライド制作");
  // These strings are taskChange in the real adapter, not exact ack strings.
  h.material.events.push(event(1, { type: "userMessage", kind: "taskChange", text, digest: "b" }));
  h.run(1_000); expect(h.run(11_000)).toBe(UNKNOWN_AUTO_NAME);
});
it("R5: an acknowledgement clause preserves its substantive trailing instruction", async () => {
  const h = await harness();
  h.material.events = [event(0, { type: "userMessage", kind: "taskStart", text: "スライドを作ってください", digest: "a" })]; h.run(0);
  h.material.events.push(event(1, { type: "userMessage", kind: "taskChange", text: "了解です。次は字幕位置を直してください", digest: "b" }));
  h.run(1_000); expect(h.run(11_000)).toBe("字幕位置修正");
});
it("R5: unsupported follow-up alone does not erase a known task", async () => {
  const h = await harness(); h.material.latest_instruction = "解説スライドを作る"; h.run(0);
  h.material.latest_instruction = "いつ終わりそうですか"; h.run(1_000);
  expect(h.run(11_000)).toBe(UNKNOWN_AUTO_NAME);
});
it("R6: a stale heading plus an unrelated write cannot replace the accepted task", async () => {
  const h = await harness(); h.material.latest_instruction = "解説スライドを作る"; expect(h.run(0)).toBe("解説スライド制作");
  h.material.latest_instruction = null; h.material.task_title = "動画を編集する";
  h.material.events = [event(2, { type: "toolStart", tool: "Write", call_id: "w", target: "lesson.pptx" })];
  h.run(30_000); h.run(60_000); h.run(120_000);
  expect(h.run(180_000)).toBe(UNKNOWN_AUTO_NAME);
  expect(h.policy.meanings().get("t")?.topic).not.toBe("動画編集");
});
it("R7: sustained activity inflections invalidate the semantic cache", async () => {
  const h = await harness();
  h.material.events = [event(0, { type: "agentMessage", text: "スライドを作っている" })]; expect(h.run(0)).toBe("スライド制作");
  h.material.events = [event(1, { type: "agentMessage", text: "字幕位置を直している" })];
  h.run(30_000); h.run(60_000); expect(h.run(120_000)).toBe("字幕位置修正");
});
it("R7: the most recent write order invalidates the semantic cache", async () => {
  const h = await harness();
  const write = (index: number, target: string) => event(index, { type: "toolStart", tool: "Write", call_id: String(index), target });
  h.material.events = [write(0, "movie.mp4"), write(1, "lesson.pptx")]; expect(h.run(0)).toBe(UNKNOWN_AUTO_NAME);
  const beforeKey = h.policy.meanings().get("t")?.contentKey;
  h.material.events = [write(2, "lesson.pptx"), write(3, "movie.mp4")]; h.run(30_000); h.run(60_000);
  expect(h.policy.meanings().get("t")?.contentKey).not.toBe(beforeKey);
  expect(h.run(120_000)).toBe(UNKNOWN_AUTO_NAME);
});
it.each([
  ["動画制作費の見積を作る", "動画制作費見積"], ["スライド制作費の見積を作る", "スライド制作費見積"],
  ["動画編集の費用を調べる", "動画編集の費用調査"], ["字幕編集の手順を比較する", "字幕編集の手順比較"],
])("R8: task action takes precedence over domain words: %s", (text, topic) => {
  expect(deriveAutoName(evidence(text)).topic).toBe(topic);
});
it("R8: two independent video-domain estimates aggregate as estimates", () => {
  const ws: Workspace = { id: "w", name: "old", createdAt: 0, status: "running", gridTemplateId: "1x1", panes: [{
    id: "p", sessionId: "s", activeTabId: "a", agentId: "shell-starter",
    tabs: ["a", "b"].map(id => ({ id, sessionId: "s-" + id, agentId: "shell-starter" })),
  }] };
  const meanings = new Map(ws.panes[0].tabs.map((tab, i) => {
    const input = evidence((i ? "字幕" : "動画") + "制作費の見積を作る");
    input.binding = JSON.stringify([tab.id, tab.sessionId, "", null, ""]);
    return [tab.id, deriveAutoName(input)];
  }));
  const summary = aggregateWorkspaceName(ws, meanings);
  expect(summary.name).toBe("字幕制作費見積・動画制作費見積"); expect(summary.description).not.toContain("動画編集");
});

it("R4: a negative premise does not become part of the following positive target", () => {
  const result = deriveAutoName(evidence("動画を編集しないで字幕位置を直してください"));
  expect(result.fullName).toBe("字幕位置修正");
});
it("R4: an explicitly rejected saved automatic name is invalidated", async () => {
  const h = await harness();
  Object.assign(h.base.workspaces[0].panes[0].tabs[0], { displayName: "動画編集", displayNameSource: "auto" });
  h.tab.displayName = "動画編集"; expect(h.run(0)).toBe(UNKNOWN_AUTO_NAME);
  h.material.latest_instruction = "動画を編集しない"; h.run(1_000);
  expect(h.run(11_000)).toBe(UNKNOWN_AUTO_NAME);
});
it("R6: an equal explicit user task promotes the accepted file provenance", async () => {
  const h = await harness();
  h.material.events = [event(0, { type: "toolStart", tool: "Write", call_id: "w", target: "lesson.pptx" })];
  expect(h.run(0)).toBe(UNKNOWN_AUTO_NAME);
  h.material.latest_instruction = "スライドを編集する"; h.run(30_000); expect(h.run(40_000)).toBe("スライド編集");
  h.material.latest_instruction = null; h.material.task_title = "動画を編集する";
  h.material.events = [event(1, { type: "toolStart", tool: "Write", call_id: "w2", target: "次回.pptx" })];
  h.run(60_000); h.run(90_000);
  expect(h.run(120_000)).toBe(UNKNOWN_AUTO_NAME);
});
