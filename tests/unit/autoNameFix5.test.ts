import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAutoNamePolicy, LAST_CONCRETE_NAME_MS, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, plannedNamingMaterial, type AutoNameScan, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import { isNamingNewContext, isNamingTaskDirective } from "../../src/lib/autoNameLanguage";
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




const englishSwitches = [
  "New task: Please fix the subtitle position",
  "New task: translate the meeting minutes into French.",
  "Translate the meeting minutes into French.",
  "For the next task, please fix the subtitle position",
  "Also, please fix the subtitle position",
  "For this request, please fix the subtitle position",
];
const taskFiles = [
  "Read /work/subtitle-instructions.md",
  "Handoff from the previous session. Read /work/subtitle-instructions.md and continue.",
  'Read "C:\\work\\subtitle instructions.md"',
  "Please follow /work/subtitle-instructions.MD",
  "Use `/work/subtitle-instructions.md`",
  "/work/subtitle-instructions.md \u3092\u8aad\u3093\u3067\u304f\u3060\u3055\u3044",
  "/work/subtitle-instructions.md \u3092\u6e21\u3057\u3066\u304f\u3060\u3055\u3044",
  "Read /work/subtitle-spec.md",
];
const modes = [false, true];

function invalidatesPrevious(addition: string, withSpec: boolean, label: string) {
  tab.label = label;
  const initial = withSpec ? "Read /work/date-spec.md" : request;
  const expected = withSpec ? heading : "\u65e5\u4ed8\u8868\u793a\u4fee\u6b63";
  let now = 0;
  const policy = createAutoNamePolicy(() => now);
  expect(policy.identify(scan([initial], withSpec)).tabs.get("t")?.displayName).toBe(expected);
  for (const at of [1000, 11000, 30000, 1810000, 3642000]) {
    now = at;
    const input = scan([initial, addition, reply], withSpec);
    expect(input.naming.get("t")?.latestInput?.kind).toBe("ack");
    const name = policy.identify(input).tabs.get("t")?.displayName;
    if (at >= 11000) {
      expect(name).toBe(label || UNKNOWN_AUTO_NAME);
      expect(["heading", "prompt", "instruction"]).not.toContain(policy.meanings().get("t")?.source);
    }
  }
  // A fresh policy must also reject the old native initial/spec fallback.
  expect(createAutoNamePolicy(() => now).identify(scan([initial, addition, reply], withSpec)).tabs.get("t")?.displayName)
    .toBe(label || UNKNOWN_AUTO_NAME);
}

describe("R4-01 explicit English work switches invalidate older sources before an Ack", () => {
  it.each(modes.flatMap(withSpec => ["", "date-fix"].flatMap(label =>
    englishSwitches.map(addition => ({withSpec, label, addition})))))("$addition (spec=$withSpec, label=$label)", ({addition, withSpec, label}) => {
      invalidatesPrevious(addition, withSpec, label);
    });
  it("keeps explicit context markers while defaulting unknown complete inputs to replacement", () => {
    expect(isNamingNewContext("New task: details will follow")).toBe(true);
    expect(isNamingTaskDirective("New task: details will follow")).toBe(true);
    expect(isNamingTaskDirective("Please fix the subtitle position")).toBe(true);
    expect(isNamingNewContext("Please fix the subtitle position")).toBe(false);
    expect(isNamingTaskDirective("Please continue")).toBe(false);
    expect(isNamingNewContext("Please continue")).toBe(false);
  });
});

describe("R4-02 explicit Markdown task files invalidate older sources before an Ack", () => {
  it.each(modes.flatMap(withSpec => ["", "date-fix"].flatMap(label =>
    taskFiles.map(addition => ({withSpec, label, addition})))))("$addition (spec=$withSpec, label=$label)", ({addition, withSpec, label}) => {
      invalidatesPrevious(addition, withSpec, label);
    });
});

describe("R4 closed controls preserve continuations and supplements with the old expiry", () => {
  it.each(modes.flatMap(withSpec => [
    "Please continue",
    "\u65e5\u4ed8\u306e\u5f62\u5f0f\u306f YYYY/MM/DD \u3067\u3059",
    "\u88dc\u8db3\uff1a\u5bfe\u8c61\u306fWindows\u3067\u3059",
    "\u65e5\u672c\u8a9e\u3067\u304a\u9858\u3044\u3057\u307e\u3059",

  ].map(addition => ({withSpec, addition}))))("$addition (spec=$withSpec)", ({withSpec, addition}) => {
    tab.label = "";
    const initial = withSpec ? "Read /work/date-spec.md" : request;
    const expected = withSpec ? heading : "\u65e5\u4ed8\u8868\u793a\u4fee\u6b63";
    let now = 0;
    const policy = createAutoNamePolicy(() => now);
    expect(policy.identify(scan([initial], withSpec)).tabs.get("t")?.displayName).toBe(expected);
    for (const at of [1000, 11000, 30000]) {
      now = at;
      expect(policy.identify(scan([initial, addition, reply], withSpec)).tabs.get("t")?.displayName).toBe(expected);
      expect(policy.meanings().get("t")?.staleSince).toBe(1000);
      expect(policy.meanings().get("t")?.fresh).toBe(false);
      expect(autoNameDescription(policy.meanings().get("t")!)).toContain("\u524d\u56de");
    }
    now = LAST_CONCRETE_NAME_MS + 1000;
    policy.identify(scan([initial, addition, reply], withSpec));
    now += 10000;
    expect(policy.identify(scan([initial, addition, reply], withSpec)).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});


describe("fix6 references outside the closed exception list use default invalidation", () => {
  it.each(modes.flatMap(withSpec => [
    "For reference: /work/subtitle-instructions.md",
    "The reference is /work/subtitle-instructions.md",
    '\"Read /work/subtitle-instructions.md\" is a reference',
    '\"Please fix the subtitle position\" is a reference',
    "> Read /work/subtitle-instructions.md",
    '```\nRead /work/subtitle-instructions.md\n```',
  ].map(addition => ({withSpec, addition}))))("$addition (spec=$withSpec)", ({withSpec, addition}) => {
    invalidatesPrevious(addition, withSpec, "");
  });
});
