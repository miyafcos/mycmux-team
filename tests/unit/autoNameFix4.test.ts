import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAutoNamePolicy, LAST_CONCRETE_NAME_MS, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, plannedNamingMaterial, type AutoNameScan, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import { autoNameDescription } from "../../src/lib/autoNameStatus";
import type { SemanticEventEnvelope } from "../../src/lib/livebrief";

const request = "\u65e5\u4ed8\u8868\u793a\u3092\u4fee\u6b63\u3059\u308b";
const heading = "\u65e5\u4ed8\u8868\u793a\u306e\u4fee\u6b63";
const subtitle = "\u5b57\u5e55\u4f4d\u7f6e\u3092\u4fee\u6b63\u3059\u308b";
const reply = "\u7d9a\u3051\u3066";
const tab = { id:"t", sessionId:"pty-t", agentId:"codex", agentKind:"codex", agentSessionId:"session-t", cwd:"/work", workspaceId:"w", paneId:"p", label:"", labelSource:"launch" as const, tail:[] };
const source = { event_id:"event-0", source_revision:1, source_byte_start:0 };

function scan(texts: string[], useHeading = true, useInitial = true): AutoNameScan {
  const events: SemanticEventEnvelope[] = texts.map((text, index) => ({eventId:"event-" + index, sourceRevision:1,
    sourceByteStart:index * 100, sourceByteEnd:(index + 1) * 100, occurredAt:index,
    kind:{type:"userMessage", kind:[reply,"yes","ok","okay","\u306f\u3044"].includes(text) ? "ack" : index ? "taskChange" : "taskStart", text, digest:"fixture"}}));
  const entries = events.map((event, index) => ({eventId:event.eventId, order:index + 1, sourceRevision:1,
    sourceByteStart:event.sourceByteStart, sourceByteEnd:event.sourceByteEnd, role:"user" as const,
    chars:Array.from(texts[index]).length, hash:createHash("sha256").update(texts[index]).digest("hex"), complete:true}));
  const last = events.at(-1)!;
  const plan = {latestInput:{eventId:last.eventId, order:events.length, sourceByteStart:last.sourceByteStart,
    sourceByteEnd:last.sourceByteEnd, kind:last.kind.type === "userMessage" ? last.kind.kind : "taskStart" as const, complete:true, choice:false},
    latestAgent:null, entries:entries.filter(entry=>{ const event=events.find(event=>event.eventId===entry.eventId); return event?.kind.type === "userMessage" && event.kind.kind !== "ack"; }), coverage:{readStart:0, readEnd:last.sourceByteEnd, sourceUnknown:false, countLoss:null, characterLoss:null}};
  const material = {...plannedNamingMaterial(tab as AutoNameScan["tabs"][number], plan, events), material_status:"ready", record_owner:"session-t",
    ...(useInitial ? {initial_instruction:texts[0], initial_instruction_complete:true, initial_instruction_source:source} : {}),
    ...(useHeading ? {task_title:heading, task_title_source:"spec", task_title_complete:true, task_title_explicit:true, task_title_input:source} : {})} as NamingMaterial;
  return {tabs:[tab], workspaces:[{id:"w", name:"workspace", status:"running", createdAt:0, gridTemplateId:"1x1",
    panes:[{id:"p", sessionId:tab.sessionId, agentId:"codex", activeTabId:tab.id, tabs:[tab]}]}],
    naming:new Map([[tab.id, buildAutoNameEvidence(tab as AutoNameScan["tabs"][number], material)]])} as AutoNameScan;
}



describe("R3-01 a complete input is not proof of a separate job", () => {
  it.each([
    "\u65e5\u4ed8\u306e\u5f62\u5f0f\u306f YYYY/MM/DD \u3067\u3059",
    "\u88dc\u8db3\uff1a\u5bfe\u8c61\u306fWindows\u3067\u3059",
    "\u65e5\u672c\u8a9e\u3067\u304a\u9858\u3044\u3057\u307e\u3059",
    "Please continue", "\u7d9a\u3051\u3066", "\u306f\u3044", "\u9032\u6357\u306f\u3069\u3046\uff1f",
    "Please use YYYY/MM/DD for dates", "The target is Windows",
    "\u88dc\u8db3\uff1a\u4fee\u6b63\u5bfe\u8c61\u306fWindows\u3067\u3059",
  ])("retains the previous spec with its original expiry after %s", addition => {
    tab.label = "";
    let now = 0; const policy = createAutoNamePolicy(() => now);
    const out = [];
    for (const at of [0,1000,11000,30000,LAST_CONCRETE_NAME_MS,1810000,1821000,3642000]) {
      now = at;
      const input = scan(at ? ["Read /work/date-spec.md", addition, reply] : ["Read /work/date-spec.md"]);
      const name = policy.identify(input).tabs.get("t")?.displayName;
      const meaning = policy.meanings().get("t")!;
      out.push({at,name,source:meaning.source,staleSince:meaning.staleSince ?? null});
    }
    console.log(JSON.stringify({addition,out}));
    expect(out.slice(0,5).map(row=>row.name)).toEqual(Array(5).fill(heading));
    expect(out.slice(1,5).map(row=>row.staleSince)).toEqual(Array(4).fill(1000));
    expect(out.slice(5).map(row=>row.name)).toEqual(Array(3).fill(UNKNOWN_AUTO_NAME));
  });
  it.each([true,false])("retains a natural answer without a trailing acknowledgement (spec=%s)", withSpec => {
    tab.label = "";
    let now = 0; const policy = createAutoNamePolicy(() => now);
    const oldName = policy.identify(scan([request],withSpec)).tabs.get("t")?.displayName;
    for (const at of [1000,11000,30000]) { now=at; expect(policy.identify(scan([request,"The target is Windows"],withSpec)).tabs.get("t")?.displayName).toBe(oldName); }
    expect(policy.meanings().get("t")?.staleSince).toBe(1000);
    expect(policy.meanings().get("t")?.fresh).toBe(false);
    expect(autoNameDescription(policy.meanings().get("t")!)).toContain("\u524d\u56de");
  });
  it.each(["", "date-fix"].flatMap(label=>["Read /work/subtitle-spec.md","Please fix the subtitle position",subtitle,'Read "C:\\work\\fix4_spec.md"',"/work/subtitle-spec.md \u3092\u8aad\u3093\u3067\u304f\u3060\u3055\u3044","\u4f1a\u8b70\u3092\u4e88\u7d04\u3057\u3066\u304f\u3060\u3055\u3044","\u8a2d\u5099\u3092\u70b9\u691c\u3057\u3066\u304f\u3060\u3055\u3044","\u914d\u9001\u4fbf\u3092\u624b\u914d\u3057\u3066\u304f\u3060\u3055\u3044"].map(replacement=>({label,replacement}))))("still invalidates a confirmed different request ($label: $replacement)", ({label,replacement}) => {
    tab.label=label;
    let now=0; const policy=createAutoNamePolicy(()=>now);
    expect(policy.identify(scan(["Read /work/date-spec.md"])).tabs.get("t")?.displayName).toBe(heading);
    for (const at of [1000,11000,30000]) {
      now=at; const name=policy.identify(scan(["Read /work/date-spec.md",replacement,reply])).tabs.get("t")?.displayName;
      if (at>=11000) expect(name).toBe(label || UNKNOWN_AUTO_NAME);
    }
    expect(["heading","prompt","instruction"]).not.toContain(policy.meanings().get("t")?.source);
  });
});


it.each([true,false])("R3-01 a first observation of a supplement keeps a valid older source with a finite lifetime (spec=%s)", withSpec => {
  tab.label="";
  let now=0; const policy=createAutoNamePolicy(()=>now);
  const input=scan([request,"The target is Windows"],withSpec);
  expect(policy.identify(input).tabs.get("t")?.displayName).toBe(withSpec ? heading : "\u65e5\u4ed8\u8868\u793a\u4fee\u6b63");
  expect(policy.meanings().get("t")?.staleSince).toBe(0);
  expect(policy.meanings().get("t")?.fresh).toBe(false);
  now=LAST_CONCRETE_NAME_MS; policy.identify(input); now+=10000;
  expect(policy.identify(input).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
});


it("fix6 a bare date is not a clearly identified attribute or semantic answer", () => {
  tab.label = "";
  let now = 0;
  const policy = createAutoNamePolicy(() => now);
  policy.identify(scan(["Read /work/date-spec.md"]));
  for (const at of [1000, 11000, 30000]) {
    now = at;
    const name = policy.identify(scan(["Read /work/date-spec.md", "2026/10/15", reply])).tabs.get("t")?.displayName;
    if (at >= 11000) expect(name).toBe(UNKNOWN_AUTO_NAME);
  }
});
