export type OperatorAttentionCoverageState = "complete" | "partial" | "unavailable";
export type OperatorAttentionSeverity = "blocking" | "warning" | "advisory";
export type OperatorAttentionActor = "human" | "lane" | "system";
export type OperatorAttentionFreshness = "fresh" | "stale";

export interface OperatorAttentionCoverage {
  state: OperatorAttentionCoverageState;
  expected_sessions: number;
  observed_sessions: number;
  stale_sessions: number;
  failed_probes: number;
  status_untracked_sessions: number;
}

export interface OperatorAttentionNextAction {
  type: string;
  label: string;
  target: string;
}

export interface OperatorAttentionItem {
  attention_id: string;
  incident_group_id: string;
  kind: string;
  severity: OperatorAttentionSeverity;
  requires_human_action: boolean;
  actor: OperatorAttentionActor;
  summary: string;
  why_now: string;
  next_action: OperatorAttentionNextAction;
  affected_lane_ids: string[];
  evidence_refs: string[];
  first_seen_at: string;
  last_changed_at: string;
  freshness: OperatorAttentionFreshness;
  rank: number;
}

export interface OperatorAttentionSnapshotV1 {
  schema_version: 1;
  snapshot_id: string;
  generated_at: string;
  source_watermark: number;
  coverage: OperatorAttentionCoverage;
  items: OperatorAttentionItem[];
}

export interface ObservationIncompleteCard {
  kind: "sessionBoardIncident";
  whyNow: "調整面のデータが読めません";
  impact: string;
  evidenceDetail: string;
}

export type SessionBoardAttentionDecode =
  | { state: "complete"; snapshot: OperatorAttentionSnapshotV1 }
  | {
    state: "observationIncomplete";
    reason: "coverage";
    snapshot: OperatorAttentionSnapshotV1;
    card: ObservationIncompleteCard;
  }
  | {
    state: "observationIncomplete";
    reason: "invalid";
    snapshot: null;
    card: ObservationIncompleteCard;
  };

const SNAPSHOT_KEYS = [
  "schema_version",
  "snapshot_id",
  "generated_at",
  "source_watermark",
  "coverage",
  "items",
] as const;
const COVERAGE_KEYS = [
  "state",
  "expected_sessions",
  "observed_sessions",
  "stale_sessions",
  "failed_probes",
  "status_untracked_sessions",
] as const;
const ITEM_KEYS = [
  "attention_id",
  "incident_group_id",
  "kind",
  "severity",
  "requires_human_action",
  "actor",
  "summary",
  "why_now",
  "next_action",
  "affected_lane_ids",
  "evidence_refs",
  "first_seen_at",
  "last_changed_at",
  "freshness",
  "rank",
] as const;
const NEXT_ACTION_KEYS = ["type", "label", "target"] as const;

export function parseOperatorAttentionSnapshot(value: unknown): OperatorAttentionSnapshotV1 {
  const snapshot = exactObject(value, SNAPSHOT_KEYS, "snapshot");
  if (snapshot.schema_version !== 1) {
    throw new Error(`snapshot.schema_version must be 1, received ${String(snapshot.schema_version)}`);
  }
  const snapshotId = text(snapshot.snapshot_id, "snapshot.snapshot_id");
  if (!/^snap-[A-Za-z0-9._:-]+$/.test(snapshotId)) {
    throw new Error("snapshot.snapshot_id does not match the v1 contract");
  }
  const generatedAt = dateTime(snapshot.generated_at, "snapshot.generated_at");
  const sourceWatermark = integer(snapshot.source_watermark, "snapshot.source_watermark");
  const coverage = parseCoverage(snapshot.coverage);
  if (!Array.isArray(snapshot.items)) throw new Error("snapshot.items must be an array");
  const items = snapshot.items.map((item, index) => parseItem(item, index));
  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    generated_at: generatedAt,
    source_watermark: sourceWatermark,
    coverage,
    items,
  };
}

export function decodeOperatorAttentionSnapshot(value: unknown): SessionBoardAttentionDecode {
  let snapshot: OperatorAttentionSnapshotV1;
  try {
    snapshot = parseOperatorAttentionSnapshot(value);
  } catch (error) {
    return {
      state: "observationIncomplete",
      reason: "invalid",
      snapshot: null,
      card: observationIncomplete(error instanceof Error ? error.message : String(error)),
    };
  }
  if (snapshot.coverage.state !== "complete") {
    const coverage = snapshot.coverage;
    return {
      state: "observationIncomplete",
      reason: "coverage",
      snapshot,
      card: observationIncomplete(
        `coverage=${coverage.state}; observed=${coverage.observed_sessions}/${coverage.expected_sessions}; stale=${coverage.stale_sessions}; failed=${coverage.failed_probes}`,
      ),
    };
  }
  return { state: "complete", snapshot };
}

function parseCoverage(value: unknown): OperatorAttentionCoverage {
  const coverage = exactObject(value, COVERAGE_KEYS, "snapshot.coverage");
  return {
    state: enumValue(
      coverage.state,
      ["complete", "partial", "unavailable"] as const,
      "snapshot.coverage.state",
    ),
    expected_sessions: integer(coverage.expected_sessions, "snapshot.coverage.expected_sessions"),
    observed_sessions: integer(coverage.observed_sessions, "snapshot.coverage.observed_sessions"),
    stale_sessions: integer(coverage.stale_sessions, "snapshot.coverage.stale_sessions"),
    failed_probes: integer(coverage.failed_probes, "snapshot.coverage.failed_probes"),
    status_untracked_sessions: integer(
      coverage.status_untracked_sessions,
      "snapshot.coverage.status_untracked_sessions",
    ),
  };
}

function parseItem(value: unknown, index: number): OperatorAttentionItem {
  const path = `snapshot.items[${index}]`;
  const item = exactObject(value, ITEM_KEYS, path);
  const attentionId = text(item.attention_id, `${path}.attention_id`);
  if (!/^incident-[A-Za-z0-9._:-]+$/.test(attentionId)) {
    throw new Error(`${path}.attention_id does not match the v1 contract`);
  }
  const firstSeenAt = dateTime(item.first_seen_at, `${path}.first_seen_at`);
  const lastChangedAt = dateTime(item.last_changed_at, `${path}.last_changed_at`);
  if (Date.parse(firstSeenAt) > Date.parse(lastChangedAt)) {
    throw new Error(`${path}.first_seen_at must not follow last_changed_at`);
  }
  if (typeof item.requires_human_action !== "boolean") {
    throw new Error(`${path}.requires_human_action must be a boolean`);
  }
  const rank = integer(item.rank, `${path}.rank`, 1);
  return {
    attention_id: attentionId,
    incident_group_id: text(item.incident_group_id, `${path}.incident_group_id`),
    kind: text(item.kind, `${path}.kind`),
    severity: enumValue(
      item.severity,
      ["blocking", "warning", "advisory"] as const,
      `${path}.severity`,
    ),
    requires_human_action: item.requires_human_action,
    actor: enumValue(item.actor, ["human", "lane", "system"] as const, `${path}.actor`),
    summary: text(item.summary, `${path}.summary`),
    why_now: text(item.why_now, `${path}.why_now`),
    next_action: parseNextAction(item.next_action, path),
    affected_lane_ids: uniqueTextArray(item.affected_lane_ids, `${path}.affected_lane_ids`),
    evidence_refs: uniqueTextArray(item.evidence_refs, `${path}.evidence_refs`, 1),
    first_seen_at: firstSeenAt,
    last_changed_at: lastChangedAt,
    freshness: enumValue(item.freshness, ["fresh", "stale"] as const, `${path}.freshness`),
    rank,
  };
}

function parseNextAction(value: unknown, itemPath: string): OperatorAttentionNextAction {
  const path = `${itemPath}.next_action`;
  const action = exactObject(value, NEXT_ACTION_KEYS, path);
  return {
    type: text(action.type, `${path}.type`),
    label: text(action.label, `${path}.label`),
    target: text(action.target, `${path}.target`),
  };
}

function exactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  path: string,
): Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set<string>(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  return object as Record<Keys[number], unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${path} must be one non-empty line`);
  }
  return value;
}

function dateTime(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed)
    || Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${path} must be an RFC 3339 timestamp`);
  }
  return parsed;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${path} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${path} must be one of ${values.join(", ")}`);
  }
  return value as Values[number];
}

function uniqueTextArray(value: unknown, path: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${path} must contain at least ${minimum} items`);
  }
  const items = value.map((item, index) => text(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${path} must contain unique items`);
  return items;
}

function observationIncomplete(evidenceDetail: string): ObservationIncompleteCard {
  return {
    kind: "sessionBoardIncident",
    whyNow: "調整面のデータが読めません",
    impact: "session-board の観測が不完全なため、現在の調整事項を確定できません",
    evidenceDetail,
  };
}
