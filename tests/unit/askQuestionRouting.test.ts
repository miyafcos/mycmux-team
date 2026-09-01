import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { scanAskQuestion } from "../../src/lib/askQuestionScan";
import {
  findSubmitOption,
  submitAskQuestionChoice,
  submitAskQuestionMultiSelect,
  submitAskQuestionReview,
  type AskQuestionDeps,
  type AskSentKey,
} from "../../src/components/dashboard/askQuestionRouting";
import type { SessionAttention } from "../../src/stores/sessionAttentionStore";
import {
  ingestAskQuestionLines,
  questionKey,
  useAskQuestionStore,
} from "../../src/stores/askQuestionStore";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/askQuestionScreens.json", import.meta.url), "utf8"),
) as Record<"single" | "tabbed" | "review" | "multiSelect", string[]>;

const sessionId = "ask-session";

function attention(overrides: Partial<SessionAttention> = {}): SessionAttention {
  return {
    sessionId,
    sessionEpoch: 7,
    attentionId: "att-1",
    kind: "input",
    detail: "question",
    sessionRevision: 3,
    uiState: "waiting",
    stateSince: 1,
    occurrenceOrder: 1,
    ...overrides,
  };
}

function densityLines(): string[] {
  return fixtures.tabbed.map((line) => {
    if (line.includes("Theme") && line.includes("Density")) {
      return "\u2190  \u2612 Theme  \u2610 Density  \u2714 Submit  \u2192";
    }
    if (line === "Which theme?") return "Which density?";
    if (line.includes("1. Light")) return line.replace("Light", "Tight");
    if (line.includes("2. Dark")) return line.replace("Dark", "Loose");
    return line;
  });
}

function setMultiSelectBox(line: string, label: string, checked: boolean): string {
  const box = checked ? "[✔]" : "[ ]";
  return line
    .replace(`[ ] ${label}`, `${box} ${label}`)
    .replace(`[✔] ${label}`, `${box} ${label}`);
}

function stripCursor(line: string): string {
  return line.replace(/^\s*\u276F\s+/, "");
}

function withCursor(line: string): string {
  return `\u276F ${stripCursor(line)}`;
}

function isOptionLine(line: string, label: string): boolean {
  const body = stripCursor(line);
  if (label === "Submit") return /^Submit\s*$/.test(body);
  if (label === "Type something") return /^\d+\.\s+\[(?: |\u2714)\]\s+Type something/.test(body);
  return body.includes(label);
}

function multiSelectAt(label: string, checked: readonly string[] = []): string[] {
  return fixtures.multiSelect.map((line) => {
    let next = line;
    for (const name of ["Auth", "Billing", "Search", "Type something"]) {
      next = setMultiSelectBox(next, name, checked.includes(name));
    }
    const body = stripCursor(next);
    if (isOptionLine(next, label)) return withCursor(body);
    return body;
  });
}

function scriptedDeps(input: {
  reads: string[][];
  attention?: SessionAttention | (() => SessionAttention | undefined);
  exists?: boolean;
  send?: (args: Record<string, unknown>) => Promise<unknown>;
  onSend?: (args: Record<string, unknown>) => void;
}): { deps: Partial<AskQuestionDeps>; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  let read = 0;
  let attentionCalls = 0;
  const deps: Partial<AskQuestionDeps> = {
    readTail: async () => {
      const lines = input.reads[Math.min(read, input.reads.length - 1)] ?? [];
      read += 1;
      return lines;
    },
    readInputRevision: async () => 7 + sent.length,
    send: async (args) => {
      input.onSend?.(args);
      sent.push(args);
      if (input.send) return input.send(args);
      return { unverified: true };
    },
    attentionFor: () => {
      attentionCalls += 1;
      if (typeof input.attention === "function") return input.attention();
      return input.attention ?? attention();
    },
    sessionExists: () => input.exists ?? true,
    claimPrompt: async () => true,
    isCurrentLaunch: async () => true,
    now: () => 1_000 + read,
    sleep: async () => {},
    waitTimeoutMs: 1,
    pollMs: 1,
  };
  void attentionCalls;
  return { deps, sent };
}

function keyText(sent: Record<string, unknown>[]): AskSentKey[] {
  return sent.map((args) => (
    args.key ? { kind: "key" as const, key: String(args.key) } : { kind: "text" as const, text: String(args.text ?? "") }
  ));
}

beforeEach(() => {
  useAskQuestionStore.getState().resetForTests();
});

describe("submitAskQuestionChoice", () => {
  it("P2-02 sends exactly one numeric byte through the existing guarded path", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single, ["PS C:\\>", "working"]],
    });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result).toEqual({ ok: true, stopReason: null, keysSent: [{ kind: "text", text: "2" }] });
    expect(sent).toEqual([{
      sessionId,
      text: "2",
      expectedAttentionId: "att-1",
      expectedSessionEpoch: 7,
      expectedSessionRevision: 3,
      expectedInputRevision: 7,
    }]);
    expect(sent[0]).not.toHaveProperty("enter");
    expect(useAskQuestionStore.getState().bySession[sessionId].screen).toBeNull();
  });

  it("sends one key per confirmed tab, pauses on a newly discovered question, then submits review with 1", async () => {
    ingestAskQuestionLines(sessionId, fixtures.tabbed, 1, 7);
    const first = scriptedDeps({ reads: [fixtures.tabbed, densityLines()] });
    const firstResult = await submitAskQuestionChoice(sessionId, 2, first.deps);
    expect(firstResult.keysSent).toEqual([{ kind: "text", text: "2" }]);
    expect(firstResult.ok).toBe(false);
    expect(firstResult.stopReason).toBe("needs_confirmation");
    expect(useAskQuestionStore.getState().bySession[sessionId].screen?.question).toBe("Which density?");

    const second = scriptedDeps({ reads: [densityLines(), fixtures.review] });
    const secondResult = await submitAskQuestionChoice(sessionId, 1, second.deps);
    expect(secondResult.keysSent).toEqual([{ kind: "text", text: "1" }]);
    expect(secondResult.stopReason).toBeNull();
    expect(useAskQuestionStore.getState().bySession[sessionId].screen?.kind).toBe("review");

    const review = scriptedDeps({ reads: [fixtures.review, ["done"]] });
    const reviewResult = await submitAskQuestionReview(sessionId, review.deps);
    expect(reviewResult.keysSent).toEqual([{ kind: "text", text: "1" }]);
    expect(review.sent[0]).toMatchObject({ text: "1", expectedAttentionId: "att-1" });
    expect(useAskQuestionStore.getState().bySession[sessionId].screen).toBeNull();
  });

  it("does not send a key for an unopened tab until the operator confirms it", async () => {
    ingestAskQuestionLines(sessionId, fixtures.tabbed, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.tabbed, densityLines()] });
    const result = await submitAskQuestionChoice(sessionId, 1, deps);
    expect(keyText(sent)).toEqual([{ kind: "text", text: "1" }]);
    expect(result.stopReason).toBe("needs_confirmation");
    expect(sent).toHaveLength(1);
    expect(useAskQuestionStore.getState().bySession[sessionId].confirmedKeys)
      .not.toContain(questionKey(useAskQuestionStore.getState().bySession[sessionId].screen!));
  });

  it("rejects numbered choice routing on a review screen with zero bytes", async () => {
    ingestAskQuestionLines(sessionId, fixtures.review, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.review] });

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result).toEqual({ ok: false, stopReason: "ambiguous", keysSent: [] });
    expect(sent).toEqual([]);
  });

  it("does not treat a tabbed screen disappearing before review as success", async () => {
    ingestAskQuestionLines(sessionId, fixtures.tabbed, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.tabbed, ["done"]] });

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result).toEqual({
      ok: false,
      stopReason: "ambiguous",
      keysSent: [{ kind: "text", text: "2" }],
    });
    expect(sent).toHaveLength(1);
    expect(useAskQuestionStore.getState().bySession[sessionId].screen).toBeNull();
    expect(useAskQuestionStore.getState().bySession[sessionId].stopReason).toBe("ambiguous");
  });
});

describe("submitAskQuestionMultiSelect", () => {
  it("toggles only the difference, verifies each down, Enter only on Submit, then review 1", async () => {
    const start = multiSelectAt("Auth");
    expect(scanAskQuestion(start)?.multiSelect).toBe(true);
    expect(scanAskQuestion(start)?.options.map((option) => [option.label, option.checked, option.current])).toEqual(
      scanAskQuestion(fixtures.multiSelect)?.options.map((option) => [option.label, option.checked, option.current]),
    );
    const authOn = multiSelectAt("Auth", ["Auth"]);
    const authBilling = multiSelectAt("Auth", ["Auth", "Billing"]);
    const atBilling = multiSelectAt("Billing", ["Auth", "Billing"]);
    const atSearch = multiSelectAt("Search", ["Auth", "Billing"]);
    const atType = multiSelectAt("Type something", ["Auth", "Billing"]);
    const atSubmit = multiSelectAt("Submit", ["Auth", "Billing"]);
    ingestAskQuestionLines(sessionId, start, 1, 7);
    const key = questionKey(useAskQuestionStore.getState().bySession[sessionId].screen!);
    useAskQuestionStore.getState().setDraftChecked(sessionId, key, [1, 2]);
    const { deps, sent } = scriptedDeps({
      reads: [
        start,
        start, authOn,
        authOn, authBilling,
        authBilling, atBilling,
        atBilling, atSearch,
        atSearch, atType,
        atType, atSubmit,
        atSubmit, fixtures.review,
        fixtures.review, ["done"],
      ],
    });
    const result = await submitAskQuestionMultiSelect(sessionId, deps);
    expect(result.ok).toBe(true);
    expect(keyText(sent)).toEqual([
      { kind: "text", text: "1" },
      { kind: "text", text: "2" },
      { kind: "key", key: "down" },
      { kind: "key", key: "down" },
      { kind: "key", key: "down" },
      { kind: "key", key: "down" },
      { kind: "key", key: "enter" },
      { kind: "text", text: "1" },
    ]);
    expect(sent.find((args) => args.key === "enter")).toBeDefined();
    expect(sent.filter((args) => args.text === "3")).toEqual([]);
  });

  it("does not treat disappearance after Submit Enter as success", async () => {
    const start = multiSelectAt("Submit");
    ingestAskQuestionLines(sessionId, start, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [start, start, ["done"]] });

    const result = await submitAskQuestionMultiSelect(sessionId, deps);

    expect(result).toEqual({
      ok: false,
      stopReason: "ambiguous",
      keysSent: [{ kind: "key", key: "enter" }],
    });
    expect(keyText(sent)).toEqual([{ kind: "key", key: "enter" }]);
  });

  it("requires a numberless submit option and sends zero bytes when it is absent", async () => {
    expect(findSubmitOption(scanAskQuestion(fixtures.review)!)).toBeUndefined();
    const withoutSubmit = fixtures.multiSelect.filter((line) => line !== "Submit");
    const screen = scanAskQuestion(withoutSubmit);
    expect(screen?.multiSelect).toBe(true);
    ingestAskQuestionLines(sessionId, withoutSubmit, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [withoutSubmit] });

    const result = await submitAskQuestionMultiSelect(sessionId, deps);

    expect(result).toEqual({ ok: false, stopReason: "ambiguous", keysSent: [] });
    expect(sent).toEqual([]);
  });
});

describe("askQuestion fail-closed", () => {
  it("keeps the screen-bound input revision when a competing write advances Q1 to Q2", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single],
      send: async () => ({ sent: false, reason: "input_revision" }),
    });
    deps.readInputRevision = async () => 8;

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("session_revision_mismatch");
    expect(sent).toEqual([expect.objectContaining({
      text: "2",
      expectedInputRevision: 7,
    })]);
  });

  it("sends nothing when the PTY session epoch changes before preflight", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    let reads = 0;
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single],
      attention: () => attention({ sessionEpoch: reads++ === 0 ? 7 : 8 }),
    });

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("session_revision_mismatch");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the prompt went stale before the first key", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.tabbed] });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("stale_question");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the scan returns null", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [["ready"]] });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("null_scan");
    expect(sent).toEqual([]);
  });

  it("sends nothing on attention mismatch", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    let calls = 0;
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single],
      attention: () => {
        calls += 1;
        return attention({ attentionId: calls === 1 ? "att-1" : "att-2" });
      },
    });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("attention_mismatch");
    expect(sent).toEqual([]);
  });

  it.each([
    ["future", 9, 3],
    ["older", 3, 9],
  ])("sends nothing when the expected session revision is %s", async (_label, firstRevision, secondRevision) => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    let calls = 0;
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single],
      attention: () => {
        calls += 1;
        return attention({ sessionRevision: calls === 1 ? firstRevision : secondRevision });
      },
    });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("session_revision_mismatch");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the target session disappeared", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.single], exists: false });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("target_disappeared");
    expect(sent).toEqual([]);
  });

  it("does not retry when the screen is unchanged after the one allowed key", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.single, fixtures.single] });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([{ kind: "text", text: "2" }]);
    expect(result.stopReason).toBe("timed_out");
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the headless read fails before any key", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({ reads: [fixtures.single] });
    deps.readTail = async () => {
      throw new Error("headless read failed");
    };
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("read_failure");
    expect(sent).toEqual([]);
  });

  it("does not retry after a transport exception", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single],
      send: async () => {
        throw new Error("socket down");
      },
    });
    const result = await submitAskQuestionChoice(sessionId, 2, deps);
    expect(result.keysSent).toEqual([]);
    expect(result.stopReason).toBe("transport");
    expect(sent).toHaveLength(1);
  });

  it("does not wait or retry when a semantic key write is unconfirmed", async () => {
    const start = multiSelectAt("Submit");
    ingestAskQuestionLines(sessionId, start, 1, 7);
    const { deps, sent } = scriptedDeps({
      reads: [start],
      send: async () => ({ ok: false, confirmed: false, reason: "submit_unconfirmed" }),
    });
    const result = await submitAskQuestionMultiSelect(sessionId, deps);
    expect(result.keysSent).toEqual([{ kind: "key", key: "enter" }]);
    expect(result.stopReason).toBe("unchanged_screen");
    expect(keyText(sent)).toEqual([{ kind: "key", key: "enter" }]);
  });

  it("P2-03 lets only one window win the prompt CAS and quietly rejects double and late answers", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const claimed = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps, sent } = scriptedDeps({
      reads: [fixtures.single, fixtures.single, ["done"]],
      send: async () => {
        await gate;
        return { unverified: true };
      },
    });
    deps.claimPrompt = async (_session, promptId) => {
      if (claimed.has(promptId)) return false;
      claimed.add(promptId);
      return true;
    };
    const first = submitAskQuestionChoice(sessionId, 2, deps);
    const second = submitAskQuestionChoice(sessionId, 3, deps);
    const secondResult = await second;
    expect(secondResult).toEqual({ ok: false, stopReason: "already_answered", keysSent: [] });
    expect(useAskQuestionStore.getState().bySession[sessionId].stopReason).toBeNull();
    release();
    const firstResult = await first;
    expect(firstResult.keysSent).toEqual([{ kind: "text", text: "2" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("2");
    useAskQuestionStore.getState().resetForTests();
    ingestAskQuestionLines(sessionId, fixtures.single, 10_000, 7);
    deps.readTail = async () => fixtures.single;
    const late = await submitAskQuestionChoice(sessionId, 3, deps);
    expect(late.stopReason).toBe("already_answered");
    expect(sent).toHaveLength(1);
  });

  it("P2-04 refuses a superseded hook launch before sending", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    const hookAttention = attention({ attentionId: "agent-hook:old-launch:event-a" });
    const { deps, sent } = scriptedDeps({ reads: [fixtures.single], attention: hookAttention });
    deps.isCurrentLaunch = async (_session, launchId) => {
      expect(launchId).toBe("old-launch");
      return false;
    };

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result.stopReason).toBe("superseded_launch");
    expect(sent).toEqual([]);
    expect(useAskQuestionStore.getState().bySession[sessionId].stopReason).toBe("superseded_launch");
  });

  it("P2-06 leaves scanner-only behavior unchanged and skips the launch check", async () => {
    ingestAskQuestionLines(sessionId, fixtures.single, 1, 7);
    let launchChecks = 0;
    const { deps, sent } = scriptedDeps({ reads: [fixtures.single, ["done"]] });
    deps.isCurrentLaunch = async () => {
      launchChecks += 1;
      return false;
    };

    const result = await submitAskQuestionChoice(sessionId, 2, deps);

    expect(result).toEqual({ ok: true, stopReason: null, keysSent: [{ kind: "text", text: "2" }] });
    expect(sent).toHaveLength(1);
    expect(launchChecks).toBe(0);
  });
});
