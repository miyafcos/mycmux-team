import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeOperatorAttentionSnapshot,
  parseOperatorAttentionSnapshot,
  type OperatorAttentionSeverity,
} from "../../src/lib/sessionBoardAttention";
import type { AttentionCard, AttentionKind } from "../../src/lib/attentionBridge";
import { sortAttentionCards } from "../../src/components/dashboard/attentionModel";

const GOLDEN_DIR = resolve(import.meta.dirname, "../fixtures/session_board_attention");
const GOLDEN_PATHS = readdirSync(GOLDEN_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => resolve(GOLDEN_DIR, name));

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

type Waiting = "human" | "work" | "none";
type OrderedAttentionCard = AttentionCard & {
  waiting: Waiting;
  severity: OperatorAttentionSeverity;
};

const MYCMUX_KIND_AXES: Record<Exclude<AttentionKind, "sessionBoardIncident">, {
  waiting: Waiting;
  severity: OperatorAttentionSeverity;
}> = {
  agentAsked: { waiting: "human", severity: "blocking" },
  workStopped: { waiting: "work", severity: "blocking" },
  outOfScopeWrite: { waiting: "work", severity: "blocking" },
  conflictDetected: { waiting: "work", severity: "blocking" },
  workOrderStalled: { waiting: "work", severity: "warning" },
  completionWithoutTests: { waiting: "work", severity: "warning" },
  budgetReached: { waiting: "work", severity: "warning" },
  nextItemReady: { waiting: "none", severity: "advisory" },
  reportsComplete: { waiting: "none", severity: "advisory" },
  goalReached: { waiting: "none", severity: "advisory" },
};

function waitingFor(requiresHumanAction: boolean, severity: OperatorAttentionSeverity): Waiting {
  if (requiresHumanAction) return "human";
  return severity === "advisory" ? "none" : "work";
}

function attentionCard(
  id: string,
  kind: AttentionKind,
  waiting: Waiting,
  severity: OperatorAttentionSeverity,
  firstSeenAt: number,
  sourceRank: number | null = null,
): OrderedAttentionCard {
  return {
    id,
    fingerprint: id,
    kind,
    waiting,
    severity,
    actor: null,
    freshness: null,
    sourceRank,
    workorderId: null,
    session: null,
    whyNow: "now",
    impact: "impact",
    evidence: [{ source: "test", kind: "fixture", refId: id, detail: "fixture" }],
    primaryAction: { type: "openSession", session: { type: "logical", logical_session_id: id } },
    replyRoute: { type: "none" },
    resolutionPredicate: { type: "userAcknowledged" },
    state: "open",
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    revision: 1,
    resolvedAt: null,
  };
}

function adrOrder(cards: readonly OrderedAttentionCard[]): OrderedAttentionCard[] {
  const waitingOrder: Record<Waiting, number> = { human: 0, work: 1, none: 2 };
  const severityOrder: Record<OperatorAttentionSeverity, number> = {
    blocking: 0,
    warning: 1,
    advisory: 2,
  };
  return [...cards].sort((left, right) => (
    waitingOrder[left.waiting] - waitingOrder[right.waiting]
    || severityOrder[left.severity] - severityOrder[right.severity]
    || left.firstSeenAt - right.firstSeenAt
    || (left.sourceRank ?? Number.MAX_SAFE_INTEGER) - (right.sourceRank ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ));
}

describe("OperatorAttentionSnapshot v1 decoder", () => {
  it("keeps the copied session-board golden set at ten fixtures", () => {
    expect(GOLDEN_PATHS.map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      "complete_zero.json",
      "delivery_verification_failure.json",
      "duplicate_root_cause.json",
      "fresh_status_untracked.json",
      "mixed_severity.json",
      "owned_open_issue.json",
      "partial_observation.json",
      "resolved_before_click.json",
      "single_conflict.json",
      "stale_session.json",
    ]);
  });

  it.each(GOLDEN_PATHS)("structurally decodes %s", (path) => {
    const snapshot = parseOperatorAttentionSnapshot(fixture(path));
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.snapshot_id).toMatch(/^snap-/);
  });

  it("T1 orders all golden items and all mycmux kinds by the ADR axes", () => {
    const fixtureCards = GOLDEN_PATHS.flatMap((path) => {
      const name = path.split(/[\\/]/).at(-1) ?? path;
      return parseOperatorAttentionSnapshot(fixture(path)).items.map((item, index) => attentionCard(
        `${name}:${index}:${item.attention_id}`,
        "sessionBoardIncident",
        waitingFor(item.requires_human_action, item.severity),
        item.severity,
        Date.parse(item.first_seen_at),
        item.rank,
      ));
    });
    const mycmuxCards = Object.entries(MYCMUX_KIND_AXES).map(([kind, axes], index) => attentionCard(
      `mycmux:${kind}`,
      kind as Exclude<AttentionKind, "sessionBoardIncident">,
      axes.waiting,
      axes.severity,
      Date.parse("2026-08-30T11:40:00.000Z") + index,
    ));
    const cards = [...fixtureCards, ...mycmuxCards].reverse();

    expect(fixtureCards).toHaveLength(10);
    expect(mycmuxCards).toHaveLength(10);
    expect(sortAttentionCards(cards).map((card) => card.id))
      .toEqual(adrOrder(cards).map((card) => card.id));
  });

  it("preserves producer-owned rank without recomputing mixed severity", () => {
    const snapshot = parseOperatorAttentionSnapshot(
      fixture(resolve(GOLDEN_DIR, "mixed_severity.json")),
    );
    expect(snapshot.items.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(snapshot.items.map((item) => item.severity)).toEqual([
      "blocking",
      "warning",
      "advisory",
    ]);
  });

  it.each([
    ["partial", fixture(resolve(GOLDEN_DIR, "partial_observation.json"))],
    [
      "unavailable",
      {
        ...(fixture(resolve(GOLDEN_DIR, "complete_zero.json")) as Record<string, unknown>),
        coverage: {
          state: "unavailable",
          expected_sessions: 2,
          observed_sessions: 0,
          stale_sessions: 0,
          failed_probes: 2,
          status_untracked_sessions: 0,
        },
      },
    ],
    [
      "schema mismatch",
      {
        ...(fixture(resolve(GOLDEN_DIR, "complete_zero.json")) as Record<string, unknown>),
        schema_version: 2,
      },
    ],
  ])("turns %s into one observation-incomplete card", (_name, value) => {
    const decoded = decodeOperatorAttentionSnapshot(value);
    expect(decoded.state).toBe("observationIncomplete");
    if (decoded.state !== "observationIncomplete") throw new Error("expected incomplete observation");
    expect(decoded.card.kind).toBe("sessionBoardIncident");
    expect(decoded.card.whyNow).toBe("調整面のデータが読めません");
  });
});
