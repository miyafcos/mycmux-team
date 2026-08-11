import { describe, expect, it } from "vitest";

import {
  latestInstruction,
  noUpdateMinutes,
  toActivityChain,
  toTimelineRows,
  unresolvedQuestion,
} from "../../src/components/dashboard/liveTimelineModel";
import type { LiveSessionBrief, SemanticEvent, SemanticEventEnvelope } from "../../src/lib/livebrief";

let sequence = 0;

function envelope(kind: SemanticEvent, at = 1_000 + (sequence += 1)): SemanticEventEnvelope {
  return {
    eventId: `e${sequence}`,
    sourceRevision: sequence,
    occurredAt: at,
    sourceByteStart: 0,
    sourceByteEnd: 1,
    kind,
  };
}

function toolPair(callId: string, tool: string, target: string | null, ok = true): SemanticEventEnvelope[] {
  return [
    envelope({ type: "toolStart", call_id: callId, tool, target }),
    envelope({ type: "toolEnd", call_id: callId, tool, target, ok, summary: null }),
  ];
}

describe("toTimelineRows", () => {
  it("is safe on an empty event list", () => {
    expect(toTimelineRows([])).toEqual([]);
    expect(toActivityChain([])).toEqual([]);
    expect(latestInstruction([])).toBeNull();
    expect(unresolvedQuestion([])).toBeNull();
  });

  it("pairs a toolStart with its toolEnd into a single row", () => {
    const rows = toTimelineRows(toolPair("c1", "Read", "src/a.ts", false));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool", title: "Read", target: "src/a.ts", ok: false, count: 1 });
  });

  it("keeps an orphan toolEnd as its own result row", () => {
    const rows = toTimelineRows([envelope({ type: "toolEnd", call_id: "c9", tool: "Bash", target: "ls", ok: true, summary: "done" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "result", title: "Bash", detail: "done", ok: true });
  });

  it("folds consecutive identical tool+target rows into one ×N row", () => {
    const rows = toTimelineRows([
      ...toolPair("c1", "Read", "src/a.ts"),
      ...toolPair("c2", "Read", "src/a.ts"),
      ...toolPair("c3", "Read", "src/a.ts"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Read ×3");
    expect(rows[0].count).toBe(3);
  });

  it("does not fold across a different target or a different tool", () => {
    const rows = toTimelineRows([
      ...toolPair("c1", "Read", "src/a.ts"),
      ...toolPair("c2", "Read", "src/b.ts"),
      ...toolPair("c3", "Edit", "src/b.ts"),
    ]);
    expect(rows.map((row) => row.title)).toEqual(["Read", "Read", "Edit"]);
    expect(rows.every((row) => row.count === 1)).toBe(true);
  });

  it("does not fold two identical tools separated by another row", () => {
    const rows = toTimelineRows([
      ...toolPair("c1", "Read", "src/a.ts"),
      envelope({ type: "agentMessage", text: "thinking" }),
      ...toolPair("c2", "Read", "src/a.ts"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["tool", "agentText", "tool"]);
  });

  it("honours the row limit by keeping the newest rows", () => {
    const rows = toTimelineRows(
      [
        envelope({ type: "agentMessage", text: "one" }),
        envelope({ type: "agentMessage", text: "two" }),
        envelope({ type: "agentMessage", text: "three" }),
      ],
      { limit: 2 },
    );
    expect(rows.map((row) => row.title)).toEqual(["two", "three"]);
  });

  it("maps the non-tool event kinds", () => {
    const rows = toTimelineRows([
      envelope({ type: "userMessage", kind: "taskStart", text: "ship it", digest: "d" }),
      envelope({ type: "userMessage", kind: "answer", text: "yes", digest: "d" }),
      envelope({ type: "testResult", pass: 4, fail: 0 }),
      envelope({ type: "fileChange", path: "src/a.ts", change: "modified" }),
      envelope({ type: "error", fingerprint: "f", text: "boom" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["instruction", "answer", "test", "file", "error"]);
    expect(rows[2]).toMatchObject({ title: "4/0", ok: true });
    expect(rows[3]).toMatchObject({ title: "src/a.ts", detail: "modified" });
  });
});

describe("toActivityChain", () => {
  it("returns the last n tool operations as structured items", () => {
    const chain = toActivityChain([
      ...toolPair("c1", "Read", "src/a.ts"),
      ...toolPair("c2", "Edit", "src/b.ts"),
      ...toolPair("c3", "Bash", "npm test", false),
      envelope({ type: "agentMessage", text: "done" }),
    ]);
    expect(chain.map((item) => item.tool)).toEqual(["Read", "Edit", "Bash"]);
    expect(chain[2]).toMatchObject({ target: "npm test", ok: false, count: 1 });
  });

  it("carries the folded count instead of repeating the tool", () => {
    const chain = toActivityChain([...toolPair("c1", "Read", "a"), ...toolPair("c2", "Read", "a")], 3);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ tool: "Read", count: 2 });
  });
});

describe("latestInstruction", () => {
  it("takes the newest task-shaped user message verbatim", () => {
    expect(latestInstruction([
      envelope({ type: "userMessage", kind: "taskStart", text: "build a parser", digest: "d" }),
      envelope({ type: "userMessage", kind: "taskChange", text: "  make it streaming  ", digest: "d" }),
    ])).toBe("make it streaming");
  });

  it("is not overwritten by an answer or an ack", () => {
    expect(latestInstruction([
      envelope({ type: "userMessage", kind: "taskStart", text: "build a parser", digest: "d" }),
      envelope({ type: "userMessage", kind: "answer", text: "option B", digest: "d" }),
      envelope({ type: "userMessage", kind: "ack", text: "はい", digest: "d" }),
    ])).toBe("build a parser");
  });

  it("takes a correction as the current instruction", () => {
    expect(latestInstruction([
      envelope({ type: "userMessage", kind: "taskStart", text: "build a parser", digest: "d" }),
      envelope({ type: "userMessage", kind: "correction", text: "違う、戻して", digest: "d" }),
    ])).toBe("違う、戻して");
  });
});

describe("unresolvedQuestion", () => {
  it("reports a question that has no matching resolution", () => {
    const found = unresolvedQuestion([
      envelope({ type: "question", prompt_event_id: "p1", provider_call_id: "c1", prompt: "Continue?", kind: "choice", options: [{ id: "option-0", label: "Yes" }] }),
      envelope({ type: "questionResolved", prompt_event_id: "other", provider_call_id: "c2" }),
    ]);
    expect(found).toMatchObject({ promptEventId: "p1", prompt: "Continue?", kind: "choice" });
    expect(found?.options).toEqual([{ id: "option-0", label: "Yes" }]);
  });

  it("clears once the matching resolution arrives", () => {
    expect(unresolvedQuestion([
      envelope({ type: "question", prompt_event_id: "p1", provider_call_id: "c1", prompt: "Continue?", kind: "choice", options: [] }),
      envelope({ type: "questionResolved", prompt_event_id: "p1", provider_call_id: "c1" }),
    ])).toBeNull();
  });

  it("returns the newest of several open questions", () => {
    const found = unresolvedQuestion([
      envelope({ type: "question", prompt_event_id: "p1", provider_call_id: "c1", prompt: "First?", kind: "freeText", options: [] }),
      envelope({ type: "question", prompt_event_id: "p2", provider_call_id: "c2", prompt: "Second?", kind: "freeText", options: [] }),
    ]);
    expect(found?.promptEventId).toBe("p2");
  });
});

describe("noUpdateMinutes", () => {
  const brief = {
    lastEventAt: 1_000_000,
    lastSuccessfulReadAt: 2_000_000,
    updatedAt: 3_000_000,
  } as LiveSessionBrief;

  it("measures from the last semantic event", () => {
    expect(noUpdateMinutes(brief, 1_000_000 + 5 * 60_000)).toBe(5);
  });

  it("falls back through read time and update time", () => {
    expect(noUpdateMinutes({ ...brief, lastEventAt: null }, 2_000_000 + 60_000)).toBe(1);
    expect(noUpdateMinutes({ ...brief, lastEventAt: null, lastSuccessfulReadAt: null }, 3_000_000)).toBe(0);
  });

  it("never goes negative and tolerates a missing brief", () => {
    expect(noUpdateMinutes(brief, 0)).toBe(0);
    expect(noUpdateMinutes(undefined, Date.now())).toBeNull();
  });
});
