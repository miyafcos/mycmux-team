import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAutoNamePolicy, LAST_CONCRETE_NAME_MS, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, plannedNamingMaterial, type AutoNameScan, type NamingMaterial } from "../../src/lib/autoNameMaterial";
import * as language from "../../src/lib/autoNameLanguage";
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





type Exception = "continuation" | "status" | "supplement" | "output" | "attribute" | "ack";
const cases = JSON.parse(readFileSync("tests/fixtures/auto_naming_fix6.json", "utf8")) as
  Array<{ id: string; text: string; exception: Exception | null; review: boolean }>;

describe("fix6 closed exceptions use the entire input", () => {
  it.each(cases)("$id: $text", row => {
    expect(language.namingContextException(row.text)).toBe(row.exception === "ack" ? undefined : row.exception ?? undefined);
    expect(language.isNamingTaskDirective(row.text)).toBe(!row.exception);
    if (row.exception) expect(language.isNamingUncertainTask(row.text)).toBe(false);
  });
  it("keeps a positive for each of the five closed types", () => {
    expect([...new Set(cases.map(row => row.exception).filter(kind => kind && kind !== "ack"))].sort())
      .toEqual(["attribute", "continuation", "output", "status", "supplement"]);
    expect(cases.filter(row => row.review)).toHaveLength(58);
  });
});

describe("fix6 default invalidation or finite retention", () => {
  const matrix = cases.flatMap(row => [false, true].flatMap(withSpec => ["", "date-fix"].flatMap(label =>
    [false, true].map(trailingAck => ({ ...row, withSpec, label, trailingAck })))));
  it.each(matrix)("$id (spec=$withSpec, label=$label, Ack=$trailingAck)", ({text, exception, withSpec, label, trailingAck}) => {
    tab.label = label;
    let now = 0;
    const policy = createAutoNamePolicy(() => now);
    const initial = withSpec ? "Read /work/date-spec.md" : request;
    const oldName = withSpec ? heading : "\u65e5\u4ed8\u8868\u793a\u4fee\u6b63";
    expect(policy.identify(scan([initial], withSpec)).tabs.get("t")?.displayName).toBe(oldName);
    const input = () => scan(trailingAck ? [initial, text, reply] : [initial, text], withSpec);
    for (const at of [1000, 11000, 30000, LAST_CONCRETE_NAME_MS]) {
      now = at;
      const current = input();
      const name = policy.identify(current).tabs.get("t")?.displayName;
      const meaning = policy.meanings().get("t")!;
      if (exception) {
        expect(name).toBe(oldName);
        expect(meaning.fresh).toBe(false);
        expect(meaning.staleSince).toBe(1000);
        expect(autoNameDescription(meaning)).toContain("\u524d\u56de");
      } else if (at >= 11000) {
        expect(name).not.toBe(oldName);
        if (["heading", "prompt", "instruction"].includes(meaning.source ?? "")) expect(meaning.instructionPosition).not.toBe(0);
      }
    }
    for (const at of [1810000, 1821000, 3642000]) {
      now = at;
      expect(policy.identify(input()).tabs.get("t")?.displayName).not.toBe(oldName);
      if (exception) expect(policy.identify(input()).tabs.get("t")?.displayName).toBe(label || UNKNOWN_AUTO_NAME);
    }
    if (!exception) {
      expect(createAutoNamePolicy(() => now).identify(input()).tabs.get("t")?.displayName).not.toBe(oldName);
    }
  });
});

it.each(["answer", "ack"] as const)("fix6 keeps semantic %s inputs outside the default barrier", kind => {
  tab.label = "";
  let now = 0;
  const policy = createAutoNamePolicy(() => now);
  const first = policy.identify(scan([request])).tabs.get("t")?.displayName;
  const input = scan([request, "Windows only"]);
  const evidence = input.naming.get("t")!;
  evidence.instructionKinds = [kind, "taskStart"];
  evidence.latestInput!.kind = kind;
  for (const at of [1000, 11000, 30000]) {
    now = at;
    expect(policy.identify(input).tabs.get("t")?.displayName).toBe(first);
  }
});
