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
const tab = { id:"t", sessionId:"pty-t", agentId:"codex", agentKind:"codex", agentSessionId:"session-t", cwd:"/work", workspaceId:"w", paneId:"p", label:"", tail:[] };
const source = { event_id:"event-0", source_revision:1, source_byte_start:0 };

function scan(texts: string[], useHeading = true, useInitial = true): AutoNameScan {
  const events: SemanticEventEnvelope[] = texts.map((text, index) => ({eventId:"event-" + index, sourceRevision:1,
    sourceByteStart:index * 100, sourceByteEnd:(index + 1) * 100, occurredAt:index,
    kind:{type:"userMessage", kind:index ? "taskChange" : "taskStart", text, digest:"fixture"}}));
  const entries = events.map((event, index) => ({eventId:event.eventId, order:index + 1, sourceRevision:1,
    sourceByteStart:event.sourceByteStart, sourceByteEnd:event.sourceByteEnd, role:"user" as const,
    chars:Array.from(texts[index]).length, hash:createHash("sha256").update(texts[index]).digest("hex"), complete:true}));
  const last = events.at(-1)!;
  const plan = {latestInput:{eventId:last.eventId, order:events.length, sourceByteStart:last.sourceByteStart,
    sourceByteEnd:last.sourceByteEnd, kind:last.kind.type === "userMessage" ? last.kind.kind : "taskStart" as const, complete:true, choice:false},
    latestAgent:null, entries, coverage:{readStart:0, readEnd:last.sourceByteEnd, sourceUnknown:false, countLoss:null, characterLoss:null}};
  const material = {...plannedNamingMaterial(tab as AutoNameScan["tabs"][number], plan, events), material_status:"ready", record_owner:"session-t",
    ...(useInitial ? {initial_instruction:texts[0], initial_instruction_complete:true, initial_instruction_source:source} : {}),
    ...(useHeading ? {task_title:heading, task_title_source:"spec", task_title_complete:true, task_title_explicit:true, task_title_input:source} : {})} as NamingMaterial;
  return {tabs:[tab], workspaces:[{id:"w", name:"workspace", status:"running", createdAt:0, gridTemplateId:"1x1",
    panes:[{id:"p", sessionId:tab.sessionId, agentId:"codex", activeTabId:tab.id, tabs:[tab]}]}],
    naming:new Map([[tab.id, buildAutoNameEvidence(tab as AutoNameScan["tabs"][number], material)]])} as AutoNameScan;
}

describe("F02 shared cwd material", () => {
  it.each(["missing", "unreadable"] as const)("keeps date-fix and subtitle-fix launch labels on %s", status => {
    const tabs = ["date-fix", "subtitle-fix"].map((label, index) => ({...tab, id:"t" + index, sessionId:"pty-" + index,
      agentSessionId:undefined, cwd:"/shared/work", label, labelSource:"launch" as const}));
    const naming = new Map(tabs.map(t => [t.id, buildAutoNameEvidence(t as AutoNameScan["tabs"][number], {
      tab_id:t.id, pty_session_id:t.sessionId, agent_kind:"codex", cwd:t.cwd, material_status:status, events:[],
      task_title:heading, task_title_source:"spec", task_title_complete:true})]));
    const input = {tabs, workspaces:[{...scan([request]).workspaces[0], panes:[{id:"p", tabs}]}], naming} as AutoNameScan;
    const result = createAutoNamePolicy(() => 0).identify(input);
    expect(tabs.map(t => result.tabs.get(t.id)?.displayName)).toEqual(["date-fix", "subtitle-fix"]);
  });
});

describe("F03 invalidated initial sources", () => {
  it.each([cancel, "\u5225\u306e\u4f9d\u983c\u3067\u3059\u3002\u6b21\u306f\u4f1a\u8b70\u3092\u4e88\u7d04\u3057\u3066\u304f\u3060\u3055\u3044"])("does not revive a spec after stop/replacement then continue: %s", stopped => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    policy.identify(scan([request]));
    now = 1000; policy.identify(scan([request, stopped]));
    now = 11000; policy.identify(scan([request, stopped]));
    now = 12000; policy.identify(scan([request, stopped, reply]));
    now = 22000; const result = policy.identify(scan([request, stopped, reply]));
    expect(result.tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    expect(policy.meanings().get("t")?.source).toBe("none");
  });
  it("reconstructs cancellation before continue in a new policy", () => {
    const policy = createAutoNamePolicy(() => 1800000);
    expect(policy.identify(scan([request, cancel, reply])).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
  it("keeps a cancellation watermark when later bounded history omits it", () => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    policy.identify(scan([request])); now = 1000; policy.identify(scan([request, cancel]));
    now = 11000; policy.identify(scan([request, cancel]));
    const input = scan([request, reply]);
    const evidence = input.naming.get("t")!;
    evidence.instructionPositions = [200]; evidence.instructions = [reply]; evidence.instructionCompleteness = [true];
    evidence.latestInput = {...evidence.latestInput!, sourceByteStart:200}; evidence.contentKey += "-bounded";
    now = 22000;
    expect(policy.identify(input).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

describe("F04 source positions and generations", () => {
  it("preserves the spec input position and replaces it after subtitle fix then continue in one scan", () => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    expect(policy.identify(scan(["Read /work/spec.md"])).tabs.get("t")?.displayName).toBe(heading);
    expect(policy.meanings().get("t")?.instructionPosition).toBe(0);
    expect(policy.meanings().get("t")?.instructionSource).toEqual(source);
    now = 1000; policy.identify(scan(["Read /work/spec.md", subtitle, reply]));
    now = 11000;
    expect(policy.identify(scan(["Read /work/spec.md", subtitle, reply])).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    expect(policy.meanings().get("t")?.source).toBe("none");
  });
});

describe("F05 thirty minute source lifetime", () => {
  it.each([true, false])("does not re-confirm an unchanged initial source after thirty minutes ten seconds (spec=%s)", withSpec => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    policy.identify(scan([request], withSpec));
    now = 1000; policy.identify(scan([request, reply], withSpec));
    now = LAST_CONCRETE_NAME_MS; policy.identify(scan([request, reply], withSpec));
    now += 10000; const name = policy.identify(scan([request, reply], withSpec)).tabs.get("t")?.displayName;
    const meaning = policy.meanings().get("t")!;
    if (name !== UNKNOWN_AUTO_NAME) {
      expect(meaning.staleSince).toBeDefined();
      expect(meaning.fresh).toBe(false);
      expect(autoNameDescription(meaning)).toContain("\u524d\u56de");
    } else expect(meaning.fresh).toBe(false);
  });
  it("re-reading the same direct input does not extend confirmation", () => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    policy.identify(scan([request], false));
    for (now = 60000; now < LAST_CONCRETE_NAME_MS; now += 60000) policy.identify(scan([request], false));
    now = LAST_CONCRETE_NAME_MS; policy.identify(scan([request, reply], false));
    now += 10000;
    expect(policy.identify(scan([request, reply], false)).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it.each([true, false])("F05 a first observation of an old source is marked and has a finite lifetime (spec=%s)", withSpec => {
  let now = 0; const policy = createAutoNamePolicy(() => now);
  const name = policy.identify(scan([request, reply], withSpec)).tabs.get("t")?.displayName;
  if (name !== UNKNOWN_AUTO_NAME) {
    expect(policy.meanings().get("t")?.staleSince).toBeDefined();
    expect(policy.meanings().get("t")?.fresh).toBe(false);
  }
  now = LAST_CONCRETE_NAME_MS; policy.identify(scan([request, reply], withSpec)); now += 10000;
  expect(policy.identify(scan([request, reply], withSpec)).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
});
it("F03 a spec referenced by a cancellation cannot revive at the cancellation's position", () => {
  const input = scan([request, cancel + " Read /work/spec.md", reply]);
  const evidence = input.naming.get("t")!;
  evidence.taskTitleInput = {event_id:"event-1", source_revision:1, source_byte_start:100};
  evidence.contentKey += "cancel-source";
  expect(createAutoNamePolicy(() => 0).identify(input).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
});
it("F02 a partial history cannot upgrade an old explicit source to a current task", () => {
  const input = scan([reply]); const evidence = input.naming.get("t")!;
  evidence.initialInstruction = request; evidence.initialInstructionSource = source;
  evidence.contextHistoryComplete = false; evidence.instructionHistoryComplete = false; evidence.contentKey += "lost-history";
  expect(createAutoNamePolicy(() => 0).identify(input).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
});
