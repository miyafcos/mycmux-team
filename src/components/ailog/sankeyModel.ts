/**
 * Builds the three-layer graph (model -> work tag -> project/title) that the
 * relation diagram draws.
 *
 * F1 has no "work tag x project" cross tabulation and the Rust side is out of
 * scope, so the second band is assembled here from the session list, exactly as
 * the F2 spec §3.4.2 prescribes:
 *
 * - model -> tag comes from `ailog_models.byWorkTag`, which is turn-accurate.
 * - tag -> project comes from `ailog_sessions`; a session carrying several tags
 *   is counted in full under each of them. Never pro-rated — the overlap is
 *   disclosed as a number instead.
 *
 * One caveat this module surfaces rather than hides: `SessionRow.costUsd` is the
 * whole session's cost as stored at index time, while the tag totals are clipped
 * to the selected range. For a narrow range the two bands can therefore disagree,
 * and `notes.bandMismatchPct` says by how much.
 */

import {
  SYNTHETIC_MODEL,
  workTagHint,
  workTagLabel,
  type SessionRow,
  type WorkTagRow,
} from "../../lib/ailog";

export const OTHER_KEY = "__other__";
export const UNTAGGED_KEY = "__untagged__";
export const UNKNOWN_PROJECT = "(unknown)";
export const UNTITLED = "(untitled)";
export const UNSUMMARIZED_KEY = "__unsummarized__";
export const UNSUMMARIZED_LABEL = "(未要約)";

/** A node whose share is at least this much is called out as too coarse. */
export const DOMINANT_SHARE_PCT = 40;

export type LeafDimension = "project" | "title";

export interface RollupInput {
  key: string;
  label: string;
  value: number;
}

export interface RollupEntry extends RollupInput {
  isOther: boolean;
  /** How many source rows the `その他` bucket absorbed. */
  otherCount: number;
  /** Keys the `その他` bucket absorbed, for the drill-down table. */
  otherKeys: string[];
}

export interface RollupResult {
  entries: RollupEntry[];
  otherCount: number;
  otherValue: number;
  otherKeys: string[];
}

/**
 * Keep the `limit` most expensive rows and fold the rest into one `その他`
 * bucket that carries both the folded count and the folded amount. Nothing is
 * dropped silently: `otherCount` / `otherValue` are always reported, and a
 * non-finite `limit` (the "全部" choice) keeps every row.
 */
export function rollupTopN(rows: RollupInput[], limit: number): RollupResult {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (!Number.isFinite(limit) || limit <= 0 || sorted.length <= limit) {
    return {
      entries: sorted.map((row) => ({ ...row, isOther: false, otherCount: 0, otherKeys: [] })),
      otherCount: 0,
      otherValue: 0,
      otherKeys: [],
    };
  }
  const kept = sorted.slice(0, limit);
  const folded = sorted.slice(limit);
  const otherValue = folded.reduce((sum, row) => sum + row.value, 0);
  const otherKeys = folded.map((row) => row.key);
  const entries: RollupEntry[] = kept.map((row) => ({
    ...row,
    isOther: false,
    otherCount: 0,
    otherKeys: [],
  }));
  entries.push({
    key: OTHER_KEY,
    label: `その他 (${folded.length}件)`,
    value: otherValue,
    isOther: true,
    otherCount: folded.length,
    otherKeys,
  });
  return { entries, otherCount: folded.length, otherValue, otherKeys };
}

export interface SankeyNodeDatum {
  key: string;
  label: string;
  value: number;
  sharePct: number;
  isOther: boolean;
  otherCount: number;
  otherKeys: string[];
  tooltip: string;
}

export interface SankeyFlowDatum {
  source: string;
  target: string;
  value: number;
  sessionCount?: number;
}

export interface SankeyNotes {
  /** Sum of the model -> tag band. */
  modelBandTotal: number;
  /** Sum of the tag -> leaf band. */
  leafBandTotal: number;
  /** |difference| between the two bands, as a percentage of the larger. */
  bandMismatchPct: number;
  /** Range total from the overview, used for the overlap disclosure. */
  grandTotal: number;
  syntheticExcluded: boolean;
  syntheticCost: number;
  untaggedSessions: number;
  untaggedCost: number;
  /** Sessions the query could not return (list truncated at the fetch cap). */
  truncatedSessions: number;
  fetchedSessions: number;
  totalSessions: number;
  modelOther: { count: number; value: number };
  tagOther: { count: number; value: number };
  leafOther: { count: number; value: number };
  /** Set when one leaf node is >= DOMINANT_SHARE_PCT of the leaf band. */
  dominantLeaf: { key: string; label: string; value: number; sharePct: number } | null;
}

export interface SankeyGraph {
  models: SankeyNodeDatum[];
  tags: SankeyNodeDatum[];
  leaves: SankeyNodeDatum[];
  modelToTag: SankeyFlowDatum[];
  tagToLeaf: SankeyFlowDatum[];
  notes: SankeyNotes;
}

export interface SankeyBuildInput {
  byWorkTag: WorkTagRow[];
  sessions: SessionRow[];
  totalSessions: number;
  leafDimension: LeafDimension;
  excludeSynthetic: boolean;
  grandTotal: number;
  topN: { model: number; tag: number; leaf: number };
  /** Restrict the leaf layer to one project (used by the drill-down). */
  projectFilter?: string | null;
}

export function leafKeyOf(session: SessionRow, dimension: LeafDimension): string {
  if (dimension === "project") return session.projectLabel?.trim() || UNKNOWN_PROJECT;
  return session.title?.trim() || UNTITLED;
}

function addTo(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function shareOf(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function toNodes(
  rollup: RollupResult,
  total: number,
  tooltipFor: (key: string, entry: RollupEntry) => string,
): SankeyNodeDatum[] {
  return rollup.entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    value: entry.value,
    sharePct: shareOf(entry.value, total),
    isOther: entry.isOther,
    otherCount: entry.otherCount,
    otherKeys: entry.otherKeys,
    tooltip: tooltipFor(entry.key, entry),
  }));
}

function remap(keys: Set<string>, key: string): string {
  return keys.has(key) ? key : OTHER_KEY;
}

function mergeFlows(flows: SankeyFlowDatum[]): SankeyFlowDatum[] {
  const merged = new Map<string, SankeyFlowDatum>();
  for (const flow of flows) {
    if (flow.value <= 0) continue;
    const id = `${flow.source}\u0000${flow.target}`;
    const existing = merged.get(id);
    if (existing) existing.value += flow.value;
    else merged.set(id, { ...flow });
  }
  return [...merged.values()].sort((a, b) => b.value - a.value);
}

export function buildSankeyGraph(input: SankeyBuildInput): SankeyGraph {
  const {
    byWorkTag,
    sessions,
    totalSessions,
    leafDimension,
    excludeSynthetic,
    grandTotal,
    topN,
    projectFilter,
  } = input;

  // --- band 1: model -> tag (turn accurate) --------------------------------
  const modelTotals = new Map<string, number>();
  const tagInflow = new Map<string, number>();
  const rawModelToTag: SankeyFlowDatum[] = [];
  let syntheticCost = 0;

  for (const row of byWorkTag) {
    for (const entry of row.perModel) {
      if (entry.model === SYNTHETIC_MODEL) {
        syntheticCost += entry.costUsd;
        if (excludeSynthetic) continue;
      }
      if (entry.costUsd <= 0) continue;
      addTo(modelTotals, entry.model, entry.costUsd);
      addTo(tagInflow, row.workTag, entry.costUsd);
      rawModelToTag.push({ source: entry.model, target: row.workTag, value: entry.costUsd });
    }
  }

  // --- band 2: tag -> leaf (session level, tags deliberately overlap) -------
  const scopedSessions = projectFilter
    ? sessions.filter((session) => (session.projectLabel?.trim() || UNKNOWN_PROJECT) === projectFilter)
    : sessions;

  const tagOutflow = new Map<string, number>();
  const leafTotals = new Map<string, number>();
  const rawTagToLeaf: SankeyFlowDatum[] = [];
  let untaggedSessions = 0;
  let untaggedCost = 0;

  for (const session of scopedSessions) {
    const cost = session.costUsd;
    if (session.workTags.length === 0) {
      untaggedSessions += 1;
      untaggedCost += cost;
      continue;
    }
    if (cost <= 0) continue;
    const leaf = leafKeyOf(session, leafDimension);
    for (const tag of session.workTags) {
      addTo(tagOutflow, tag, cost);
      addTo(leafTotals, leaf, cost);
      rawTagToLeaf.push({ source: tag, target: leaf, value: cost });
    }
  }

  // --- rollups -------------------------------------------------------------
  const modelBandTotal = [...modelTotals.values()].reduce((sum, value) => sum + value, 0);
  const leafBandTotal = [...leafTotals.values()].reduce((sum, value) => sum + value, 0);

  const tagKeys = new Set([...tagInflow.keys(), ...tagOutflow.keys()]);
  const tagValue = (tag: string) => Math.max(tagInflow.get(tag) ?? 0, tagOutflow.get(tag) ?? 0);
  const tagBandTotal = [...tagKeys].reduce((sum, tag) => sum + tagValue(tag), 0);

  const modelRollup = rollupTopN(
    [...modelTotals.entries()].map(([key, value]) => ({ key, label: key, value })),
    topN.model,
  );
  const tagRollup = rollupTopN(
    [...tagKeys].map((key) => ({ key, label: workTagLabel(key), value: tagValue(key) })),
    topN.tag,
  );
  const leafRollup = rollupTopN(
    [...leafTotals.entries()].map(([key, value]) => ({ key, label: key, value })),
    topN.leaf,
  );

  const keptModels = new Set(modelRollup.entries.filter((e) => !e.isOther).map((e) => e.key));
  const keptTags = new Set(tagRollup.entries.filter((e) => !e.isOther).map((e) => e.key));
  const keptLeaves = new Set(leafRollup.entries.filter((e) => !e.isOther).map((e) => e.key));

  const modelToTag = mergeFlows(
    rawModelToTag.map((flow) => ({
      source: remap(keptModels, flow.source),
      target: remap(keptTags, flow.target),
      value: flow.value,
    })),
  );
  const tagToLeaf = mergeFlows(
    rawTagToLeaf.map((flow) => ({
      source: remap(keptTags, flow.source),
      target: remap(keptLeaves, flow.target),
      value: flow.value,
    })),
  );

  const models = toNodes(modelRollup, modelBandTotal, (key, entry) =>
    entry.isOther
      ? `${entry.otherCount}件のモデルをまとめています`
      : `モデル ${key}`,
  );
  const tags = toNodes(tagRollup, tagBandTotal, (key, entry) => {
    if (entry.isOther) return `${entry.otherCount}件の作業種別をまとめています`;
    const inflow = tagInflow.get(key) ?? 0;
    const outflow = tagOutflow.get(key) ?? 0;
    return `${workTagHint(key)}｜モデル側 $${inflow.toFixed(0)} / 案件側 $${outflow.toFixed(0)}`;
  });
  const leaves = toNodes(leafRollup, leafBandTotal, (key, entry) =>
    entry.isOther
      ? `${entry.otherCount}件をまとめています`
      : key,
  );

  const dominantEntry = leafRollup.entries
    .filter((entry) => !entry.isOther)
    .find((entry) => shareOf(entry.value, leafBandTotal) >= DOMINANT_SHARE_PCT);

  const larger = Math.max(modelBandTotal, leafBandTotal);
  const notes: SankeyNotes = {
    modelBandTotal,
    leafBandTotal,
    bandMismatchPct: larger > 0 ? (Math.abs(modelBandTotal - leafBandTotal) / larger) * 100 : 0,
    grandTotal,
    syntheticExcluded: excludeSynthetic,
    syntheticCost,
    untaggedSessions,
    untaggedCost,
    truncatedSessions: Math.max(0, totalSessions - sessions.length),
    fetchedSessions: sessions.length,
    totalSessions,
    modelOther: { count: modelRollup.otherCount, value: modelRollup.otherValue },
    tagOther: { count: tagRollup.otherCount, value: tagRollup.otherValue },
    leafOther: { count: leafRollup.otherCount, value: leafRollup.otherValue },
    dominantLeaf: dominantEntry
      ? {
          key: dominantEntry.key,
          label: dominantEntry.label,
          value: dominantEntry.value,
          sharePct: shareOf(dominantEntry.value, leafBandTotal),
        }
      : null,
  };

  return { models, tags, leaves, modelToTag, tagToLeaf, notes };
}

export interface ProjectSankeyGraph {
  projects: SankeyNodeDatum[];
  tags: SankeyNodeDatum[];
  models: SankeyNodeDatum[];
  projectToTag: SankeyFlowDatum[];
  tagToModel: SankeyFlowDatum[];
  notes: Pick<SankeyNotes, "grandTotal" | "syntheticExcluded" | "syntheticCost" | "untaggedSessions" | "untaggedCost" | "truncatedSessions" | "fetchedSessions" | "totalSessions" | "tagOther" | "modelOther"> & {
    projectOther: { count: number; value: number };
  };
}

/** Build the project-first view. Both bands retain their native aggregation
 * source, and the visible note below the diagram explains the tag overlap. */
export function buildProjectSankeyGraph(input: Omit<SankeyBuildInput, "leafDimension">): ProjectSankeyGraph {
  const projectValues = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  const projectTag = new Map<string, { value: number; sessions: number }>();
  let untaggedSessions = 0;
  let untaggedCost = 0;
  for (const session of input.sessions) {
    const project = session.projectLabel?.trim() || UNKNOWN_PROJECT;
    addTo(projectValues, project, session.costUsd);
    projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    if (session.workTags.length === 0) {
      untaggedSessions += 1;
      untaggedCost += session.costUsd;
    }
    for (const tag of session.workTags) {
      const key = `${project}\u0000${tag}`;
      const entry = projectTag.get(key) ?? { value: 0, sessions: 0 };
      entry.value += session.costUsd;
      entry.sessions += 1;
      projectTag.set(key, entry);
    }
  }
  const projectRollup = rollupTopN(
    [...projectValues.entries()].map(([key, value]) => ({ key, label: key, value })),
    10,
  );
  const projectKeys = new Set(projectRollup.entries.map((entry) => entry.key));
  const foldedProjectKeys = new Set(projectRollup.otherKeys);
  const tagValues = new Map<string, number>();
  const modelValues = new Map<string, number>();
  const tagModel = new Map<string, { value: number; sessions: number }>();
  let syntheticCost = 0;
  for (const row of input.byWorkTag) {
    for (const entry of row.perModel) {
      if (input.excludeSynthetic && entry.model === SYNTHETIC_MODEL) { syntheticCost += entry.costUsd; continue; }
      addTo(tagValues, row.workTag, entry.costUsd);
      addTo(modelValues, entry.model, entry.costUsd);
      const key = `${row.workTag}\u0000${entry.model}`;
      const aggregate = tagModel.get(key) ?? { value: 0, sessions: 0 };
      aggregate.value += entry.costUsd;
      aggregate.sessions += entry.sessions;
      tagModel.set(key, aggregate);
    }
  }
  const tagRollup = rollupTopN([...tagValues.entries()].map(([key, value]) => ({ key, label: workTagLabel(key), value })), input.topN.tag);
  const modelRollup = rollupTopN([...modelValues.entries()].map(([key, value]) => ({ key, label: key, value })), input.topN.model);
  const tagKeys = new Set(tagRollup.entries.map((entry) => entry.key));
  const modelKeys = new Set(modelRollup.entries.map((entry) => entry.key));
  const projectToTag = new Map<string, { value: number; sessions: number }>();
  for (const [pair, entry] of projectTag) {
    const [rawProject, rawTag] = pair.split("\u0000");
    const project = projectKeys.has(rawProject) ? rawProject : foldedProjectKeys.has(rawProject) ? OTHER_KEY : rawProject;
    const tag = tagKeys.has(rawTag) ? rawTag : OTHER_KEY;
    if (!projectKeys.has(project) || !tagKeys.has(tag)) continue;
    const key = `${project}\u0000${tag}`;
    const aggregate = projectToTag.get(key) ?? { value: 0, sessions: 0 };
    aggregate.value += entry.value;
    aggregate.sessions += entry.sessions;
    projectToTag.set(key, aggregate);
  }
  const rolledTagModel = new Map<string, { value: number; sessions: number }>();
  for (const [pair, entry] of tagModel) {
    const [rawTag, rawModel] = pair.split("\u0000");
    const tag = tagKeys.has(rawTag) ? rawTag : OTHER_KEY;
    const model = modelKeys.has(rawModel) ? rawModel : OTHER_KEY;
    if (!tagKeys.has(tag) || !modelKeys.has(model)) continue;
    const key = `${tag}\u0000${model}`;
    const aggregate = rolledTagModel.get(key) ?? { value: 0, sessions: 0 };
    aggregate.value += entry.value;
    aggregate.sessions += entry.sessions;
    rolledTagModel.set(key, aggregate);
  }
  const projects = toNodes(projectRollup, [...projectValues.values()].reduce((a, b) => a + b, 0), (key, entry) => entry.isOther ? `${entry.otherCount} 件を集約` : `${projectCounts.get(key) ?? 0} セッション`);
  const tags = toNodes(tagRollup, [...tagValues.values()].reduce((a, b) => a + b, 0), (key) => workTagHint(key));
  const models = toNodes(modelRollup, [...modelValues.values()].reduce((a, b) => a + b, 0), () => "期間内ターンのコスト相当");
  return {
    projects, tags, models,
    projectToTag: [...projectToTag.entries()].map(([key, entry]) => { const [source, target] = key.split("\u0000"); return { source, target, value: entry.value, sessionCount: entry.sessions }; }),
    tagToModel: [...rolledTagModel.entries()].map(([key, entry]) => { const [source, target] = key.split("\u0000"); return { source, target, value: entry.value, sessionCount: entry.sessions }; }),
    notes: {
      grandTotal: input.grandTotal, syntheticExcluded: input.excludeSynthetic, syntheticCost, untaggedSessions, untaggedCost,
      truncatedSessions: Math.max(0, input.totalSessions - input.sessions.length), fetchedSessions: input.sessions.length, totalSessions: input.totalSessions,
      projectOther: { count: projectRollup.otherCount, value: projectRollup.otherValue }, tagOther: { count: tagRollup.otherCount, value: tagRollup.otherValue }, modelOther: { count: modelRollup.otherCount, value: modelRollup.otherValue },
    },
  };
}

/** Client-side F3 topic layer. One session has one cluster, so unlike work
 * tags it never double-counts a session across the middle band. */
export function buildProjectTopicSankeyGraph(input: Pick<SankeyBuildInput, "sessions" | "totalSessions" | "excludeSynthetic" | "grandTotal" | "topN">): ProjectSankeyGraph {
  const projectValues = new Map<string, number>();
  const topicValues = new Map<string, number>();
  const modelValues = new Map<string, number>();
  const projectTopic = new Map<string, { value: number; sessions: number }>();
  const topicModel = new Map<string, { value: number; sessions: number }>();
  let syntheticCost = 0;
  for (const session of input.sessions) {
    const model = session.primaryModel?.trim() || "(不明モデル)";
    if (input.excludeSynthetic && model === SYNTHETIC_MODEL) { syntheticCost += session.costUsd; continue; }
    const project = session.projectLabel?.trim() || UNKNOWN_PROJECT;
    const topic = session.goalCluster?.trim() || UNSUMMARIZED_KEY;
    addTo(projectValues, project, session.costUsd);
    addTo(topicValues, topic, session.costUsd);
    addTo(modelValues, model, session.costUsd);
    for (const [map, key] of [[projectTopic, `${project}\u0000${topic}`], [topicModel, `${topic}\u0000${model}`]] as const) {
      const entry = map.get(key) ?? { value: 0, sessions: 0 };
      entry.value += session.costUsd; entry.sessions += 1; map.set(key, entry);
    }
  }
  const projectsRollup = rollupTopN([...projectValues.entries()].map(([key, value]) => ({ key, label: key, value })), 10);
  const topicsRollup = rollupTopN([...topicValues.entries()].map(([key, value]) => ({ key, label: key === UNSUMMARIZED_KEY ? UNSUMMARIZED_LABEL : key, value })), 10);
  const modelsRollup = rollupTopN([...modelValues.entries()].map(([key, value]) => ({ key, label: key, value })), input.topN.model);
  const projectKeys = new Set(projectsRollup.entries.map((entry) => entry.key));
  const topicKeys = new Set(topicsRollup.entries.map((entry) => entry.key));
  const modelKeys = new Set(modelsRollup.entries.map((entry) => entry.key));
  const rolled = (source: Map<string, { value: number; sessions: number }>, left: Set<string>, right: Set<string>) => {
    const out = new Map<string, { value: number; sessions: number }>();
    for (const [pair, entry] of source) {
      const [rawLeft, rawRight] = pair.split("\u0000");
      const a = left.has(rawLeft) ? rawLeft : OTHER_KEY; const b = right.has(rawRight) ? rawRight : OTHER_KEY;
      if (!left.has(a) || !right.has(b)) continue;
      const result = out.get(`${a}\u0000${b}`) ?? { value: 0, sessions: 0 };
      result.value += entry.value; result.sessions += entry.sessions; out.set(`${a}\u0000${b}`, result);
    }
    return [...out.entries()].map(([pair, entry]) => { const [source, target] = pair.split("\u0000"); return { source, target, value: entry.value, sessionCount: entry.sessions }; });
  };
  const total = (values: Map<string, number>) => [...values.values()].reduce((sum, value) => sum + value, 0);
  return {
    projects: toNodes(projectsRollup, total(projectValues), () => "セッション"),
    tags: toNodes(topicsRollup, total(topicValues), () => "目的クラスタ"),
    models: toNodes(modelsRollup, total(modelValues), () => "セッションのコスト相当"),
    projectToTag: rolled(projectTopic, projectKeys, topicKeys),
    tagToModel: rolled(topicModel, topicKeys, modelKeys),
    notes: { grandTotal: input.grandTotal, syntheticExcluded: input.excludeSynthetic, syntheticCost, untaggedSessions: 0, untaggedCost: 0, truncatedSessions: Math.max(0, input.totalSessions - input.sessions.length), fetchedSessions: input.sessions.length, totalSessions: input.totalSessions, projectOther: { count: projectsRollup.otherCount, value: projectsRollup.otherValue }, tagOther: { count: topicsRollup.otherCount, value: topicsRollup.otherValue }, modelOther: { count: modelsRollup.otherCount, value: modelsRollup.otherValue } },
  };
}

/**
 * Titles inside one project, for the drill-down that keeps a 40%+ node from
 * being an opaque blob.
 */
export function titlesWithinProject(
  sessions: SessionRow[],
  projectKey: string,
): { key: string; sessions: number; costUsd: number; sharePct: number }[] {
  const totals = new Map<string, { sessions: number; costUsd: number }>();
  let total = 0;
  for (const session of sessions) {
    if ((session.projectLabel?.trim() || UNKNOWN_PROJECT) !== projectKey) continue;
    const key = session.title?.trim() || UNTITLED;
    const entry = totals.get(key) ?? { sessions: 0, costUsd: 0 };
    entry.sessions += 1;
    entry.costUsd += session.costUsd;
    totals.set(key, entry);
    total += session.costUsd;
  }
  return [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      sessions: entry.sessions,
      costUsd: entry.costUsd,
      sharePct: shareOf(entry.costUsd, total),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}
