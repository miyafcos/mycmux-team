import type { Pane, PaneTab, Workspace } from "../types";
import type {
  PersistentPaneKey,
  PersistentPaneTabKey,
  PersistentWorkspaceKey,
} from "../types/workspace";

export type Sha256 = string & { readonly __brand: "Sha256" };

export class PersistentLayoutValidationError extends Error {
  readonly code = "non_finite_persistent_number";

  constructor(readonly path: string) {
    super(`Persistent layout contains a non-finite persistent number at ${path}`);
    this.name = "PersistentLayoutValidationError";
  }
}

function finiteNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) throw new PersistentLayoutValidationError(path);
  return value;
}

function projectStringRecord(source: Record<string, string> | undefined): Record<string, string> | undefined {
  if (source === undefined) return undefined;
  const result = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (typeof value !== "string") {
      throw new TypeError(`Persistent string record contains a non-string value at ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function projectSuppressedSessions(source: PaneTab["suppressedAgentSessions"] | Pane["suppressedAgentSessions"]) {
  return source?.map((session) => ({
    agentKind: session.agentKind,
    agentSessionId: session.agentSessionId,
    claudeSessionId: session.claudeSessionId,
  }));
}

export function persistentTabProjection(tab: PaneTab) {
  const projection = {
    id: tab.id,
    sessionId: tab.sessionId,
    agentId: tab.agentId,
    label: tab.label,
    labelSource: tab.labelSource,
    type: tab.type,
    presetId: tab.presetId,
    cwd: tab.cwd,
    lastProcess: tab.lastProcess,
    claudeSessionId: tab.claudeSessionId,
    agentKind: tab.agentKind,
    agentSessionId: tab.agentSessionId,
    suppressedAgentSessions: projectSuppressedSessions(tab.suppressedAgentSessions),
    launchEnv: projectStringRecord(tab.launchEnv),
    initialPrompt: tab.initialPrompt,
    commandArgv: tab.commandArgv,
    ephemeral: tab.ephemeral,
    terminalSnapshot: tab.terminalSnapshot,
    turnMarks: tab.turnMarks?.map((mark, index) => ({
      label: mark.label,
      at: finiteNumber(mark.at, `tab.turnMarks[${index}].at`),
      lines_from_bottom: finiteNumber(
        mark.lines_from_bottom,
        `tab.turnMarks[${index}].lines_from_bottom`,
      ),
    })),
    htmlPath: tab.htmlPath,
    sourcePath: tab.sourcePath,
    sourceKind: tab.sourceKind,
    previewPath: tab.previewPath,
    isDirty: tab.isDirty,
    reloadCounter: tab.reloadCounter === undefined
      ? undefined
      : finiteNumber(tab.reloadCounter, "tab.reloadCounter"),
    lifecycle: tab.lifecycle,
    origin: tab.origin === undefined ? undefined : {
      kind: tab.origin.kind,
      parentTabId: tab.origin.parentTabId,
    },
    declaredPrompt: tab.declaredPrompt,
    declaredTarget: tab.declaredTarget,
  } satisfies Record<PersistentPaneTabKey, unknown>;
  return projection;
}

export type PersistentTabProjection = ReturnType<typeof persistentTabProjection>;

function persistentPaneProjection(pane: Pane) {
  const projection = {
    id: pane.id,
    agentId: pane.agentId,
    sessionId: pane.sessionId,
    activeTabId: pane.activeTabId,
    label: pane.label,
    cwd: pane.cwd,
    gitBranch: pane.gitBranch,
    lastProcess: pane.lastProcess,
    claudeSessionId: pane.claudeSessionId,
    agentKind: pane.agentKind,
    agentSessionId: pane.agentSessionId,
    suppressedAgentSessions: projectSuppressedSessions(pane.suppressedAgentSessions),
    launchEnv: projectStringRecord(pane.launchEnv),
    pinnedTabId: pane.pinnedTabId,
    tabs: pane.tabs.map(persistentTabProjection),
  } satisfies Record<PersistentPaneKey, unknown>;
  return projection;
}

function persistentWorkspaceProjection(workspace: Workspace) {
  const projection = {
    id: workspace.id,
    name: workspace.name,
    gridTemplateId: workspace.gridTemplateId,
    status: workspace.status,
    createdAt: finiteNumber(workspace.createdAt, "workspace.createdAt"),
    color: workspace.color,
    pet: workspace.pet,
    splitColumns: (workspace.splitColumns ?? []).map((column) => [...column]),
    columnWidths: (workspace.columnWidths ?? []).map((width, index) => (
      finiteNumber(width, `workspace.columnWidths[${index}]`)
    )),
    rowHeightsPerCol: (workspace.rowHeightsPerCol ?? []).map((column, columnIndex) => (
      column.map((height, rowIndex) => (
        finiteNumber(height, `workspace.rowHeightsPerCol[${columnIndex}][${rowIndex}]`)
      ))
    )),
    panes: workspace.panes.map(persistentPaneProjection),
  } satisfies Record<PersistentWorkspaceKey, unknown>;
  return projection;
}

type PersistentWorkspaceProjection = ReturnType<typeof persistentWorkspaceProjection>;

export interface PersistentLayoutProjection {
  workspaces: PersistentWorkspaceProjection[];
}

export function persistentLayoutProjection(workspaces: readonly Workspace[]): PersistentLayoutProjection {
  return {
    workspaces: workspaces.map(persistentWorkspaceProjection),
  };
}

export function canonicalize(value: unknown): unknown {
  if (typeof value === "number") return finiteNumber(value, "canonical value");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (typeof item === "function") continue;
    result[key] = canonicalize(item);
  }
  return result;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small synchronous SHA-256 implementation so the compiler remains a pure sync function. */
export function sha256Hex(input: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = [...new TextEncoder().encode(input)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((bytes[base] << 24) | (bytes[base + 1] << 16)
        | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + constants[index] + words[index]) >>> 0;
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function hashCanonical(value: unknown): Sha256 {
  return sha256Hex(canonicalStringify(canonicalize(value))) as Sha256;
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (typeof value === "number") {
    finiteNumber(value, "canonical value");
    return Object.is(value, -0) ? "number:-0" : `number:${String(value)}`;
  }
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(Object.prototype.hasOwnProperty.call(value, index)
        ? canonicalStringify(value[index])
        : "hole");
    }
    return `array:[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `object:{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalStringify(source[key])}`
    )).join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
}

function projectionEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const leftValue = left[index];
      const rightValue = right[index];
      if (leftValue === undefined || rightValue === undefined) {
        const leftHasIndex = Object.prototype.hasOwnProperty.call(left, index);
        const rightHasIndex = Object.prototype.hasOwnProperty.call(right, index);
        if (leftHasIndex !== rightHasIndex) return false;
      }
      if (!projectionEquals(leftValue, rightValue)) return false;
    }
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!projectionEquals(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

/** Structural equality over the same generated projection used by the signature. */
export function persistentLayoutEquals(a: readonly Workspace[], b: readonly Workspace[]): boolean {
  const left = persistentLayoutProjection(a);
  const right = a === b ? left : persistentLayoutProjection(b);
  return projectionEquals(left, right);
}

/** Canonical SHA-256 of the persistent layout projection. */
export function persistentLayoutSignature(workspaces: readonly Workspace[]): Sha256 {
  return hashCanonical(persistentLayoutProjection(workspaces));
}
