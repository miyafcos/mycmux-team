import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAutoNamePolicy, LAST_CONCRETE_NAME_MS, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, plannedNamingMaterial, type AutoNameScan, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import { autoNameDescription } from "../../src/lib/autoNameStatus";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";

const request = "\u65e5\u4ed8\u8868\u793a\u3092\u4fee\u6b63\u3059\u308b";
const heading = "\u65e5\u4ed8\u8868\u793a\u306e\u4fee\u6b63";
const subtitle = "\u5b57\u5e55\u4f4d\u7f6e\u3092\u4fee\u6b63\u3059\u308b";
const cancel = "\u305d\u306e\u4f5c\u696d\u306f\u4e2d\u6b62\u3057\u3066\u304f\u3060\u3055\u3044";
const reply = "\u7d9a\u3051\u3066";
const tab = { id:"t", sessionId:"pty-t", agentId:"codex", agentKind:"codex", agentSessionId:"session-t", cwd:"/work", workspaceId:"w", paneId:"p", label:"", labelSource:"launch" as const, tail:[] };
const source = { event_id:"event-0", source_revision:1, source_byte_start:0 };

function scan(texts: string[], useHeading = true, useInitial = true): AutoNameScan {
  const events: SemanticEventEnvelope[] = texts.map((text, index) => ({eventId:"event-" + index, sourceRevision:1,
    sourceByteStart:index * 100, sourceByteEnd:(index + 1) * 100, occurredAt:index,
    kind:{type:"userMessage", kind:text === reply ? "ack" : index ? "taskChange" : "taskStart", text, digest:"fixture"}}));
  const entries = events.map((event, index) => ({eventId:event.eventId, order:index + 1, sourceRevision:1,
    sourceByteStart:event.sourceByteStart, sourceByteEnd:event.sourceByteEnd, role:"user" as const,
    chars:Array.from(texts[index]).length, hash:createHash("sha256").update(texts[index]).digest("hex"), complete:true}));
  const last = events.at(-1)!;
  const plan = {latestInput:{eventId:last.eventId, order:events.length, sourceByteStart:last.sourceByteStart,
    sourceByteEnd:last.sourceByteEnd, kind:last.kind.type === "userMessage" ? last.kind.kind : "taskStart" as const, complete:true, choice:false},
    latestAgent:null, entries:entries.filter(entry=>texts[Number(entry.eventId.slice(6))] !== reply), coverage:{readStart:0, readEnd:last.sourceByteEnd, sourceUnknown:false, countLoss:null, characterLoss:null}};
  const material = {...plannedNamingMaterial(tab as AutoNameScan["tabs"][number], plan, events), material_status:"ready", record_owner:"session-t",
    ...(useInitial ? {initial_instruction:texts[0], initial_instruction_complete:true, initial_instruction_source:source} : {}),
    ...(useHeading ? {task_title:heading, task_title_source:"spec", task_title_complete:true, task_title_explicit:true, task_title_input:source} : {})} as NamingMaterial;
  return {tabs:[tab], workspaces:[{id:"w", name:"workspace", status:"running", createdAt:0, gridTemplateId:"1x1",
    panes:[{id:"p", sessionId:tab.sessionId, agentId:"codex", activeTabId:tab.id, tabs:[tab]}]}],
    naming:new Map([[tab.id, buildAutoNameEvidence(tab as AutoNameScan["tabs"][number], material)]])} as AutoNameScan;
}


describe("R2-02 complete replacements invalidate unparseable old tasks", () => {
  it.each(["Read /work/subtitle-spec.md", "Please fix the subtitle position", subtitle])("rejects the old spec after %s then continue", replacement => {
    tab.label = "";
    let now = 0; const policy = createAutoNamePolicy(() => now);
    const out = [];
    for (const at of [0, 1000, 11000, 30000]) {
      now = at;
      const input = scan(at ? ["Read /work/date-spec.md", replacement, reply] : ["Read /work/date-spec.md"]);
      const name = policy.identify(input).tabs.get("t")?.displayName;
      const meaning = policy.meanings().get("t")!;
      out.push({at, name, source:meaning.source, staleSince:meaning.staleSince ?? null});
    }
    console.log(JSON.stringify({replacement, out}));
    expect(out[0].name).toBe(heading);
    expect(out.slice(2).map(row=>row.name)).toEqual([UNKNOWN_AUTO_NAME, UNKNOWN_AUTO_NAME]);
    expect(policy.meanings().get("t")?.source).toBe("none");
  });
});

describe("R2-03 source expiry survives presentation changes", () => {
  it.each(["", "date-fix"].flatMap(label=>[true, false].map(withSpec=>({label, withSpec}))))("never revives unchanged old material ($label, spec=$withSpec)", ({label, withSpec}) => {
    tab.label = label;
    let now = 0; const policy = createAutoNamePolicy(() => now);
    const out = [];
    for (const at of [0,1000,1800000,1810000,1811000,1821000,1860000,1920000,3621000,3631000,3632000,3642000]) {
      now = at;
      const name = policy.identify(scan(at ? [request, reply] : [request], withSpec)).tabs.get("t")?.displayName;
      const meaning = policy.meanings().get("t")!;
      out.push({at, name, source:meaning.source, fresh:meaning.fresh, staleSince:meaning.staleSince ?? null});
    }
    console.log(JSON.stringify({label, withSpec, out}));
    expect(out[0].name).toBe("\u65e5\u4ed8\u8868\u793a\u4fee\u6b63");
    expect(out[1].staleSince).toBe(1000);
    expect(out[2].staleSince).toBe(1000);
    expect(out.slice(3).map(row=>row.name)).toEqual(Array(9).fill(label || UNKNOWN_AUTO_NAME));
    expect(out.slice(3).some(row=>row.source === "heading" || row.source === "prompt" || row.source === "instruction")).toBe(false);
  });
  it("allows a genuinely new input to confirm a new source after expiry", () => {
    tab.label = "date-fix";
    let now = 0; const policy = createAutoNamePolicy(() => now);
    for (const at of [0,1000,1800000,1810000,1811000]) {
      now = at; policy.identify(scan(at ? [request, reply] : [request]));
    }
    now = 1821000; policy.identify(scan([request, reply, request]));
    now = 1831000;
    expect(policy.identify(scan([request, reply, request])).tabs.get("t")?.displayName).toBe("\u65e5\u4ed8\u8868\u793a\u4fee\u6b63");
    expect(policy.meanings().get("t")?.instructionPosition).toBe(200);
    expect(policy.meanings().get("t")?.fresh).toBe(true);
  });
});


it("R2-03 preserves the first stale mark after a temporary launch-label display", () => {
  tab.label = "date-fix";
  let now = 0; const policy = createAutoNamePolicy(() => now);
  policy.identify(scan([request]));
  now = 1000; policy.identify(scan([request, reply]));
  expect(policy.meanings().get("t")?.staleSince).toBe(1000);
  const gap = () => {
    const input = scan([request, reply]); const evidence = input.naming.get("t")!;
    evidence.materialStatus = "unverified"; evidence.contentKey += "-unverified";
    return input;
  };
  now = 2000; policy.identify(gap());
  now = 12000; expect(policy.identify(gap()).tabs.get("t")?.displayName).toBe("date-fix");
  for (const at of [12001, 72001, 132001]) { now = at; policy.identify(scan([request, reply])); }
  expect(policy.meanings().get("t")?.source).toBe("heading");
  expect(policy.meanings().get("t")?.staleSince).toBe(1000);
  expect(policy.nextCheckMs()).toBe(LAST_CONCRETE_NAME_MS - now);
  expect(autoNameDescription(policy.meanings().get("t")!)).toContain("\u524d\u56de");
  for (const at of [1800000,1810000,1821000]) { now = at; policy.identify(scan([request, reply])); }
  expect(policy.meanings().get("t")?.source).toBe("label");
});
