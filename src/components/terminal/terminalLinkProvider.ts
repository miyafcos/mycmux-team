import type { ILink, Terminal } from "@xterm/xterm";
import { homeDir } from "@tauri-apps/api/path";
import { resolveLocalPathLinks, type ResolvedLocalPathLink } from "../../lib/ipc";
import { getTerminalWriteCounter } from "./terminalCache";

export const HTTP_LINK_REGEX = /https?:\/\/[^\s"'<>+\uFF0B]+[^\s"'<>+\uFF0B.,!?;:)}\]]/i;
const ARTIFACT_EXTENSION_PATTERN = String.raw`html?|markdown|md|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm`;
const GENERIC_FILE_EXTENSION_PATTERN = String.raw`[A-Za-z0-9][A-Za-z0-9_~-]{0,9}`;
const GENERIC_FILE_EXTENSION_SUFFIX_PATTERN = String.raw`${GENERIC_FILE_EXTENSION_PATTERN}(?:\.${GENERIC_FILE_EXTENSION_PATTERN})*`;
const ARTIFACT_LINK_TERMINATOR_PATTERN = String.raw`(?=$|[\s\x60"'<>+\uFF0B.,!?;:)}\]\uFF08\uFF09\u30FB\u3002\u3001\uFF0C])`;
const MSYS_DRIVE_PREFIX_PATTERN = String.raw`(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/`;
const ARTIFACT_LINK_REGEX = new RegExp(
  String.raw`(?:file:\/\/\/[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|[A-Za-z]:[\\/](?![\\/])[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|${MSYS_DRIVE_PREFIX_PATTERN}[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|file:\/\/\/[^\r\n"'<>+\uFF0B]*?[\\/]|[A-Za-z]:[\\/](?![\\/])(?:[^\r\n"'<>+\uFF0B]*?[\\/])?|${MSYS_DRIVE_PREFIX_PATTERN}[^\r\n"'<>+\uFF0B]*?[\\/])${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "gi",
);
const PREVIEW_ARTIFACT_EXTENSION_REGEX = new RegExp(
  String.raw`\.(?:${ARTIFACT_EXTENSION_PATTERN})${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "i",
);
const ARTIFACT_LINK_CONTEXT_LINES = 16;
const ARTIFACT_LINK_MAX_WRAPPED_LINES = 64;
const ARTIFACT_LINK_MAX_HARD_CONTINUATION_LINES = 4;
/// A row that hard-wrapped filled nearly all of its width, whether it wrapped at
/// the terminal edge or inside an agent TUI's reserved right margin. A row that
/// ended on purpose stops far short of that. Measured cases: Claude Code wraps at
/// 74 of 80 cells (93%), while a deliberately short line runs 12 of 80 (15%).
const ARTIFACT_LINK_MIN_WRAPPED_ROW_FILL = 0.5;
const ARTIFACT_LINK_MAX_SEGMENT_CHARS = 8192;
const LOCAL_PATH_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const LOCAL_PATH_RESOLUTION_HIT_TTL_MS = 30_000;
const LOCAL_PATH_RESOLUTION_MISS_TTL_MS = 3_000;
const LOCAL_PATH_PREWARM_DEBOUNCE_MS = 250;
const LOCAL_PATH_PREWARM_CONTEXT_LINES = 8;
const LOCAL_PATH_PREWARM_MAX_CANDIDATES = 64;
const ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX =
  /(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/)/i;
const BARE_LOCAL_PATH_PREFIX_REGEX =
  /file:\/\/\/|(?<![A-Za-z0-9._\\/:])[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\//gi;
const RELATIVE_LOCAL_PATH_PREFIX_REGEX =
  /(?<![\p{L}\p{N}._\\/:])(?:~[\\/]|\.{1,2}[\\/]|[\p{L}\p{N}._~-]+[\\/])/giu;
const BARE_LOCAL_FILE_PREFIX_REGEX =
  /(?<![\p{L}\p{N}._\\/:])[\p{L}\p{N}._~-]+\.[A-Za-z0-9][A-Za-z0-9_~-]{0,9}(?=$|[\s\x60"'<>+.,!?;:)}\]])/giu;
const BARE_LOCAL_PATH_HARD_STOP_REGEX = /[\r\n\x60"'<>+\uFF0B\uFF08\uFF09\u300C\u300D]/;

type ArtifactLinkPart = {
  text: string;
  lineIndex?: number;
  nextLineIndex?: number;
  sourceOffset?: number;
  hardBoundary?: boolean;
};

export type LocalFilePathLinkMatch = {
  text: string;
  index: number;
  endIndex: number;
};

export type ResolvedLocalPathLinkMatch = LocalFilePathLinkMatch & {
  activationUri: string;
};

type LocalPathResolutionCacheEntry = {
  value: ResolvedLocalPathLink | null;
  expiresAt: number;
};

const localPathResolutionCache = new Map<string, LocalPathResolutionCacheEntry>();
const localPathResolutionInFlight = new Map<string, Promise<ResolvedLocalPathLink | null>>();
let localPathResolutionCacheGeneration = 0;
let memoizedHomeDir: string | undefined;
let homeDirSettled = false;
let homeDirInFlight: Promise<string | undefined> | null = null;

// Resolution entries are path-global, so terminal session eviction must not clear them.
export function clearLocalPathResolutionCache(): void {
  localPathResolutionCache.clear();
  localPathResolutionInFlight.clear();
  localPathResolutionCacheGeneration++;
  memoizedHomeDir = undefined;
  homeDirSettled = false;
  homeDirInFlight = null;
}

function readLocalPathResolutionCache(
  lookupText: string,
): { found: boolean; value: ResolvedLocalPathLink | null } {
  const cached = localPathResolutionCache.get(lookupText);
  if (!cached) return { found: false, value: null };
  if (cached.expiresAt <= Date.now()) {
    localPathResolutionCache.delete(lookupText);
    return { found: false, value: null };
  }
  localPathResolutionCache.delete(lookupText);
  localPathResolutionCache.set(lookupText, cached);
  return { found: true, value: cached.value };
}

function rememberLocalPathResolution(
  lookupText: string,
  value: ResolvedLocalPathLink | null,
): void {
  if (localPathResolutionCache.has(lookupText)) {
    localPathResolutionCache.delete(lookupText);
  }
  localPathResolutionCache.set(lookupText, {
    value,
    expiresAt: Date.now() + (
      value === null ? LOCAL_PATH_RESOLUTION_MISS_TTL_MS : LOCAL_PATH_RESOLUTION_HIT_TTL_MS
    ),
  });
  if (localPathResolutionCache.size <= LOCAL_PATH_RESOLUTION_CACHE_MAX_ENTRIES) return;
  const oldest = localPathResolutionCache.keys().next().value;
  if (oldest !== undefined) {
    localPathResolutionCache.delete(oldest);
  }
}

function resolveAndCacheLocalPathLookups(lookupTexts: string[]): Promise<void> {
  const pending: Array<Promise<ResolvedLocalPathLink | null>> = [];
  const newLookups: string[] = [];
  for (const lookupText of new Set(lookupTexts)) {
    if (readLocalPathResolutionCache(lookupText).found) continue;
    const inFlight = localPathResolutionInFlight.get(lookupText);
    if (inFlight) {
      pending.push(inFlight);
    } else {
      newLookups.push(lookupText);
    }
  }

  if (newLookups.length > 0) {
    const generation = localPathResolutionCacheGeneration;
    const batch = resolveLocalPathLinks(newLookups);
    for (let index = 0; index < newLookups.length; index++) {
      const lookupText = newLookups[index];
      const item = batch
        .then((resolved) => resolved[index] ?? null)
        .then((value) => {
          if (generation === localPathResolutionCacheGeneration) {
            rememberLocalPathResolution(lookupText, value);
          }
          return value;
        })
        .finally(() => {
          if (localPathResolutionInFlight.get(lookupText) === item) {
            localPathResolutionInFlight.delete(lookupText);
          }
        });
      localPathResolutionInFlight.set(lookupText, item);
      pending.push(item);
    }
  }

  return Promise.all(pending).then(() => undefined);
}

function ensureHomeDir(): Promise<string | undefined> {
  if (homeDirSettled) return Promise.resolve(memoizedHomeDir);
  if (homeDirInFlight) return homeDirInFlight;
  const generation = localPathResolutionCacheGeneration;
  const request = Promise.resolve()
    .then(() => homeDir())
    .then((value) => {
      const normalized = value?.trim() || undefined;
      if (generation === localPathResolutionCacheGeneration) {
        memoizedHomeDir = normalized;
        homeDirSettled = true;
      }
      return normalized;
    })
    .catch(() => undefined)
    .finally(() => {
      if (homeDirInFlight === request) {
        homeDirInFlight = null;
      }
    });
  homeDirInFlight = request;
  return request;
}

type BufferLine = ReturnType<Terminal["buffer"]["active"]["getLine"]>;

/// How far a line was actually written, ignoring the blank cells xterm reports
/// past the last written cell.
///
/// `translateToString(false)` pads the row out to the terminal width, so a line
/// the TUI ended early (hard newline) and a line that filled every column look
/// identical as strings. That padding is not real whitespace: an unwritten cell
/// carries `NULL_CELL_CHAR` ("") while a typed space carries " ". Reading the
/// cells is the only way to tell them apart, and both wrap heuristics below
/// depend on the difference.
type WrittenLineExtent = {
  /// String length up to (and including) the last written cell.
  textLength: number;
  /// Cell column just past the last written cell.
  cellEnd: number;
};

function measureWrittenLineExtent(line: BufferLine, rawText: string): WrittenLineExtent {
  if (!line) {
    return { textLength: rawText.length, cellEnd: 0 };
  }
  // Fast path: a row whose last cell holds a real glyph has no padding at all.
  if (rawText.length > 0 && !/\s$/.test(rawText)) {
    return { textLength: rawText.length, cellEnd: line.length };
  }
  let offset = 0;
  let textLength = 0;
  let cellEnd = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing spacer cell of a wide glyph
    const chars = cell.getChars();
    offset += chars.length || 1;
    if (chars !== "") {
      textLength = offset;
      cellEnd = x + width;
    }
  }
  return { textLength: Math.min(textLength, rawText.length), cellEnd };
}

function cellXForStringOffset(line: BufferLine, offset: number): number {
  if (!line || offset <= 0) return 0;
  let stringOffset = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (stringOffset >= offset) return x;
    stringOffset += cell.getChars().length || 1;
    if (stringOffset > offset) return x;
  }
  return line.length;
}

function mapWrappedStringOffset(
  term: Terminal,
  parts: ArtifactLinkPart[],
  offset: number,
  preferPreviousBoundary: boolean,
): { lineIndex: number; cellX: number } {
  let accumulated = 0;
  let previousLineIndex = 0;
  for (const part of parts) {
    const textLength = part.text.length;
    const boundaryAtEnd = offset === accumulated + textLength;
    if (offset < accumulated + textLength || (preferPreviousBoundary && boundaryAtEnd)) {
      if (part.lineIndex === undefined) {
        const lineIndex = preferPreviousBoundary ? previousLineIndex : (part.nextLineIndex ?? previousLineIndex);
        const line = term.buffer.active.getLine(lineIndex);
        return { lineIndex, cellX: preferPreviousBoundary ? line?.translateToString(true).length ?? 0 : 0 };
      }
      const lineIndex = part.lineIndex;
      const line = term.buffer.active.getLine(lineIndex);
      const localOffset = Math.max(0, Math.min(offset - accumulated, textLength));
      previousLineIndex = lineIndex;
      return { lineIndex, cellX: cellXForStringOffset(line, (part.sourceOffset ?? 0) + localOffset) };
    }
    if (part.lineIndex !== undefined) {
      previousLineIndex = part.lineIndex;
    }
    accumulated += textLength;
  }
  return { lineIndex: previousLineIndex, cellX: 0 };
}

function hasOpenArtifactPath(text: string): boolean {
  const startMatches = [...text.matchAll(/(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/)/gi)];
  const lastStart = startMatches[startMatches.length - 1];
  if (!lastStart || lastStart.index === undefined) return false;
  const tail = text.slice(lastStart.index);
  return !BARE_LOCAL_PATH_HARD_STOP_REGEX.test(tail);
}

export function findLocalFilePathLinks(text: string): LocalFilePathLinkMatch[] {
  const regex = new RegExp(ARTIFACT_LINK_REGEX.source, ARTIFACT_LINK_REGEX.flags);
  const matches: LocalFilePathLinkMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    matches.push({
      text: match[0],
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return matches;
}

function rangesOverlap(left: LocalFilePathLinkMatch, right: LocalFilePathLinkMatch): boolean {
  return left.index < right.endIndex && right.index < left.endIndex;
}

type PathCandidateStart = { index: number; isAbsolute: boolean };

function bareLocalPathCandidateEnd(
  text: string,
  start: PathCandidateStart,
  nextStart: PathCandidateStart | undefined,
): number {
  // An absolute path owns everything up to a hard delimiter, even when a later
  // component looks like a fresh candidate. Directory names routinely contain
  // spaces ("... 合同会社 Dropbox\..."), and cutting at the next candidate start
  // would truncate the path at the space. Over-reaching is safe: the resolver
  // trims the candidate back to its longest prefix that exists on disk.
  const limit = start.isAbsolute || nextStart === undefined ? text.length : nextStart.index;
  const tail = text.slice(start.index, limit);
  const hardStop = tail.search(BARE_LOCAL_PATH_HARD_STOP_REGEX);
  return hardStop === -1 ? limit : start.index + hardStop;
}

function pathCandidateStarts(text: string): PathCandidateStart[] {
  const starts = new Map<number, boolean>();
  const collect = (regex: RegExp, isAbsolute: boolean): void => {
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      if (match.index === undefined) continue;
      starts.set(match.index, (starts.get(match.index) ?? false) || isAbsolute);
    }
  };
  collect(BARE_LOCAL_PATH_PREFIX_REGEX, true);
  collect(RELATIVE_LOCAL_PATH_PREFIX_REGEX, false);
  collect(BARE_LOCAL_FILE_PREFIX_REGEX, false);
  return [...starts.entries()]
    .map(([index, isAbsolute]) => ({ index, isAbsolute }))
    .sort((left, right) => left.index - right.index);
}

export function findBareLocalPathCandidates(
  text: string,
  occupiedMatches: LocalFilePathLinkMatch[] = findLocalFilePathLinks(text),
): LocalFilePathLinkMatch[] {
  const starts = pathCandidateStarts(text);

  const candidates: LocalFilePathLinkMatch[] = [];
  for (let startIndex = 0; startIndex < starts.length; startIndex++) {
    const start = starts[startIndex];
    const index = start.index;
    const endIndex = bareLocalPathCandidateEnd(text, start, starts[startIndex + 1]);
    const textCandidate = text.slice(index, endIndex).trimEnd();
    const candidate: LocalFilePathLinkMatch = {
      text: textCandidate,
      index,
      endIndex: index + textCandidate.length,
    };
    if (candidate.text.length === 0) continue;
    if (occupiedMatches.some((occupied) => rangesOverlap(candidate, occupied))) continue;
    if (candidates.some((existing) => rangesOverlap(candidate, existing))) continue;
    candidates.push(candidate);
  }
  return candidates;
}

export function isArtifactPreviewUri(uri: string): boolean {
  return PREVIEW_ARTIFACT_EXTENSION_REGEX.test(uri.trim());
}

export function isDirectoryLikeUri(uri: string): boolean {
  const trimmed = uri.trim();
  return /[\\/]$/.test(trimmed) || /^file:\/\/\/.*\/$/i.test(trimmed);
}

function hasArtifactLinkCandidate(text: string): boolean {
  return text.includes("file:///")
    || ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX.test(text)
    || new RegExp(RELATIVE_LOCAL_PATH_PREFIX_REGEX.source, "iu").test(text)
    || new RegExp(BARE_LOCAL_FILE_PREFIX_REGEX.source, "iu").test(text);
}

function stripHardContinuationPrefix(text: string): { text: string; sourceOffset: number } {
  const prefix = /^[ \t]*(?:(?:\u23BF|[\u2500-\u257F])[ \t]*)*/.exec(text)?.[0] ?? "";
  return { text: text.slice(prefix.length), sourceOffset: prefix.length };
}

function normalizeSoftWrappedArtifactLine(text: string, nextText: string): string {
  if (!/\s$/.test(text)) return text;
  const trimmed = text.trimEnd();
  const next = nextText.trimStart();
  if (!trimmed || !next) return trimmed;
  if (next.startsWith("/") || next.startsWith("\\") || trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    return trimmed;
  }
  return `${trimmed} `;
}

function activationUriForResolvedLocalPath(
  existingPrefix: string,
  resolved: ResolvedLocalPathLink,
): string {
  if (!resolved.isDir || /[\\/]$/.test(existingPrefix)) {
    return existingPrefix;
  }
  if (/^[A-Za-z]:[\\/]/.test(existingPrefix)) {
    return `${existingPrefix}\\`;
  }
  return `${existingPrefix}/`;
}

type PreparedPathCandidate = {
  candidate: LocalFilePathLinkMatch;
  sourceCandidate: LocalFilePathLinkMatch;
  lookupText: string;
  lookupBase?: string;
  displayBase: string;
  virtualSpaceOffsets: number[];
  resolutionPriority: number;
};

type PathCandidateVariant = {
  candidate: LocalFilePathLinkMatch;
  sourceCandidate: LocalFilePathLinkMatch;
  virtualSpaceOffsets: number[];
  resolutionPriority: number;
};

function isAbsoluteLocalPath(text: string): boolean {
  return /^file:\/\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\/[A-Za-z]\//.test(text);
}

function withTrailingPathSeparator(base: string): string {
  if (/[\\/]$/.test(base)) return base;
  return `${base}${/^[A-Za-z]:/.test(base) || base.includes("\\") ? "\\" : "/"}`;
}

function preparePathCandidate(
  variant: PathCandidateVariant,
  cwd: string | undefined,
  home: string | undefined,
): PreparedPathCandidate | null {
  const { candidate } = variant;
  if (isAbsoluteLocalPath(candidate.text)) {
    return { ...variant, lookupText: candidate.text, displayBase: "" };
  }
  if (/^~[\\/]/.test(candidate.text)) {
    if (!home) return null;
    const lookupBase = withTrailingPathSeparator(home);
    return {
      ...variant,
      lookupText: `${lookupBase}${candidate.text.slice(2)}`,
      lookupBase,
      displayBase: candidate.text.slice(0, 2),
    };
  }
  if (!cwd) return null;
  const lookupBase = withTrailingPathSeparator(cwd);
  return {
    ...variant,
    lookupText: `${lookupBase}${candidate.text}`,
    lookupBase,
    displayBase: "",
  };
}

function insertVirtualSpaces(
  candidate: LocalFilePathLinkMatch,
  boundaryOffsets: number[],
): PathCandidateVariant {
  let text = "";
  let cursor = 0;
  const virtualSpaceOffsets: number[] = [];
  for (const boundaryOffset of boundaryOffsets) {
    text += candidate.text.slice(cursor, boundaryOffset);
    virtualSpaceOffsets.push(text.length);
    text += " ";
    cursor = boundaryOffset;
  }
  text += candidate.text.slice(cursor);
  return {
    candidate: {
      text,
      index: candidate.index,
      endIndex: candidate.index + text.length,
    },
    sourceCandidate: candidate,
    virtualSpaceOffsets,
    resolutionPriority: virtualSpaceOffsets.length,
  };
}

function expandPathCandidateVariants(
  candidates: LocalFilePathLinkMatch[],
  hardBoundaryOffsets: number[],
): PathCandidateVariant[] {
  const direct = candidates.map((candidate) => ({
    candidate,
    sourceCandidate: candidate,
    virtualSpaceOffsets: [],
    resolutionPriority: 0,
  }));
  const single: PathCandidateVariant[] = [];
  const multiple: PathCandidateVariant[] = [];
  for (const candidate of candidates) {
    const localBoundaries = hardBoundaryOffsets
      .filter((offset) => candidate.index < offset && offset < candidate.endIndex)
      .map((offset) => offset - candidate.index);
    const combinations = 1 << localBoundaries.length;
    for (let mask = 1; mask < combinations; mask++) {
      const selected = localBoundaries.filter((_, index) => (mask & (1 << index)) !== 0);
      const variant = insertVirtualSpaces(candidate, selected);
      (selected.length === 1 ? single : multiple).push(variant);
    }
  }
  multiple.sort((left, right) =>
    left.resolutionPriority - right.resolutionPriority);
  return [...direct, ...single, ...multiple];
}

function limitPreparedPathCandidates(
  prepared: PreparedPathCandidate[],
  maxLookups: number,
): PreparedPathCandidate[] {
  const selected: PreparedPathCandidate[] = [];
  const lookupTexts = new Set<string>();
  for (const candidate of prepared) {
    if (!lookupTexts.has(candidate.lookupText)) {
      if (lookupTexts.size >= maxLookups) continue;
      lookupTexts.add(candidate.lookupText);
    }
    selected.push(candidate);
  }
  return selected;
}

function remapResolvedPathLink(
  prepared: PreparedPathCandidate,
  resolved: ResolvedLocalPathLink | null,
): { display: ResolvedLocalPathLink | null; activationPrefix?: string } {
  if (!resolved) return { display: null };
  let existingPrefix = resolved.existingPrefix;
  if (prepared.lookupBase) {
    const prefixMatches = existingPrefix.toLowerCase().startsWith(
      prepared.lookupBase.toLowerCase(),
    );
    if (!prefixMatches) return { display: null };
    const suffix = existingPrefix.slice(prepared.lookupBase.length);
    existingPrefix = `${prepared.displayBase}${suffix}`;
  }
  if (!existingPrefix || !prepared.candidate.text.startsWith(existingPrefix)) {
    return { display: null };
  }
  const consumedVirtualSpaces = prepared.virtualSpaceOffsets
    .filter((offset) => offset < existingPrefix.length)
    .length;
  const sourceLength = existingPrefix.length - consumedVirtualSpaces;
  const sourcePrefix = prepared.sourceCandidate.text.slice(0, sourceLength);
  if (!sourcePrefix) return { display: null };
  return {
    display: { existingPrefix: sourcePrefix, isDir: resolved.isDir },
    activationPrefix: resolved.existingPrefix,
  };
}

export function mergeResolvedPathLinkMatches(
  candidates: LocalFilePathLinkMatch[],
  resolvedLinks: Array<ResolvedLocalPathLink | null>,
  activationPrefixes: Array<string | undefined> = [],
  resolutionPriorities: number[] = [],
): ResolvedLocalPathLinkMatch[] {
  const matches: Array<{ match: ResolvedLocalPathLinkMatch; priority: number }> = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const resolved = resolvedLinks[index];
    if (
      !resolved ||
      resolved.existingPrefix.length === 0 ||
      !candidate.text.startsWith(resolved.existingPrefix)
    ) {
      continue;
    }
    matches.push({
      match: {
        text: resolved.existingPrefix,
        index: candidate.index,
        endIndex: candidate.index + resolved.existingPrefix.length,
        activationUri: activationUriForResolvedLocalPath(
          activationPrefixes[index] ?? resolved.existingPrefix,
          resolved,
        ),
      },
      priority: resolutionPriorities[index] ?? 0,
    });
  }

  matches.sort((left, right) =>
    right.match.text.length - left.match.text.length
    || left.priority - right.priority
    || left.match.index - right.match.index);
  const merged: ResolvedLocalPathLinkMatch[] = [];
  for (const { match } of matches) {
    if (merged.some((existing) => rangesOverlap(match, existing))) continue;
    merged.push(match);
  }
  return merged.sort((left, right) => left.index - right.index || left.endIndex - right.endIndex);
}

/**
 * Resolve local paths in ordinary text with the terminal provider's detector,
 * cache, and longest-existing-prefix rules. Dashboard surfaces use this rather
 * than maintaining a second (and inevitably divergent) path resolver.
 */
export async function resolveTextLocalPathLinks(
  text: string,
  cwd?: string,
): Promise<ResolvedLocalPathLinkMatch[]> {
  const candidates = [
    ...findLocalFilePathLinks(text),
    ...findBareLocalPathCandidates(text, []),
  ];
  if (!candidates.length) return [];

  const normalizedCwd = cwd?.trim() || undefined;
  const needsHome = candidates.some((candidate) => /^~[\\/]/.test(candidate.text));
  const home = needsHome ? await ensureHomeDir() : memoizedHomeDir;
  const prepared = limitPreparedPathCandidates(
    expandPathCandidateVariants(candidates, [])
      .map((variant) => preparePathCandidate(variant, normalizedCwd, home))
      .filter((candidate): candidate is PreparedPathCandidate => candidate !== null),
    LOCAL_PATH_PREWARM_MAX_CANDIDATES,
  );
  if (!prepared.length) return [];

  await resolveAndCacheLocalPathLookups(prepared.map((candidate) => candidate.lookupText));
  const remapped = prepared.map((candidate) => {
    const cached = readLocalPathResolutionCache(candidate.lookupText);
    return remapResolvedPathLink(candidate, cached.found ? cached.value : null);
  });
  return mergeResolvedPathLinkMatches(
    prepared.map((candidate) => candidate.sourceCandidate),
    remapped.map((result) => result.display),
    remapped.map((result) => result.activationPrefix),
    prepared.map((candidate) => candidate.resolutionPriority),
  );
}

function createLocalPathLink(
  term: Terminal,
  parts: ArtifactLinkPart[],
  bufferLineNumber: number,
  match: LocalFilePathLinkMatch,
  onActivate: (uri: string, event: MouseEvent) => void,
  activationUri = match.text,
): ILink | null {
  const start = mapWrappedStringOffset(term, parts, match.index, false);
  const end = mapWrappedStringOffset(term, parts, match.endIndex, true);
  const link: ILink = {
    range: {
      start: { x: start.cellX + 1, y: start.lineIndex + 1 },
      end: { x: Math.max(1, end.cellX), y: end.lineIndex + 1 },
    },
    text: match.text,
    activate: (event) => onActivate(activationUri, event),
  };
  return link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber ? link : null;
}

function sortLinksByRange(left: ILink, right: ILink): number {
  return left.range.start.y - right.range.start.y || left.range.start.x - right.range.start.x;
}

export function registerArtifactLinkProvider(
  term: Terminal,
  sessionId: string,
  onActivate: (uri: string, event: MouseEvent) => void,
  getCwd?: () => string | undefined,
) {
  let disposed = false;
  type RowPathData = {
    parts: ArtifactLinkPart[];
    filePathMatches: LocalFilePathLinkMatch[];
    prepared: PreparedPathCandidate[];
    needsHome: boolean;
  };
  type RowLinkCollection = {
    links: ILink[];
    missing: string[];
    fallbackLinks: ILink[];
    needsHome: boolean;
  };

  const collectRowPathData = (bufferLineNumber: number): RowPathData | null => {
    const buffer = term.buffer.active;
    const targetLineIndex = bufferLineNumber - 1;
    if (targetLineIndex < 0 || targetLineIndex >= buffer.length) return null;

    let firstLineIndex = targetLineIndex;
    let wrappedBefore = 0;
    while (
      firstLineIndex > 0 &&
      wrappedBefore < ARTIFACT_LINK_MAX_WRAPPED_LINES &&
      buffer.getLine(firstLineIndex)?.isWrapped
    ) {
      firstLineIndex--;
      wrappedBefore++;
    }
    firstLineIndex = Math.max(0, firstLineIndex - ARTIFACT_LINK_CONTEXT_LINES);
    let lastLineIndex = targetLineIndex;
    let wrappedAfter = 0;
    while (
      lastLineIndex + 1 < buffer.length &&
      wrappedAfter < ARTIFACT_LINK_MAX_WRAPPED_LINES &&
      buffer.getLine(lastLineIndex + 1)?.isWrapped
    ) {
      lastLineIndex++;
      wrappedAfter++;
    }
    lastLineIndex = Math.min(buffer.length - 1, lastLineIndex + ARTIFACT_LINK_CONTEXT_LINES);

    let candidateScanTail = "";
    let hasCandidate = false;
    for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
      const scanText = `${candidateScanTail}${buffer.getLine(lineIndex)?.translateToString(true) ?? ""}`;
      if (hasArtifactLinkCandidate(scanText)) {
        hasCandidate = true;
        break;
      }
      candidateScanTail = scanText.slice(-16);
    }
    if (!hasCandidate) return null;

    const parts: ArtifactLinkPart[] = [];
    let segmentText = "";
    let segmentJoinBlocked = false;
    let hardContinuationLines = 0;
    let previousLineWrittenCells = 0;
    let previousLineTotalCells = 0;
    for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
      const line = buffer.getLine(lineIndex);
      const isCurrentLineWrapped = Boolean(line?.isWrapped);
      const nextIsWrapped = Boolean(buffer.getLine(lineIndex + 1)?.isWrapped);
      const rawLineText = line?.translateToString(false) ?? "";
      const nextLineText = buffer.getLine(lineIndex + 1)?.translateToString(true) ?? "";
      const writtenExtent = measureWrittenLineExtent(line, rawLineText);
      const writtenLineText = rawLineText.slice(0, writtenExtent.textLength);
      let lineText = nextIsWrapped
        ? normalizeSoftWrappedArtifactLine(
            // Pass the written prefix, not the padded row: a wide glyph that
            // did not fit in the last column leaves a blank cell behind, and
            // treating that as a word gap injects a space into the path.
            writtenLineText,
            nextLineText,
          )
        // A hard-wrapped path can split at a real space. Preserve written
        // trailing spaces while still excluding xterm's unwritten row padding.
        : writtenLineText;
      let sourceOffset = 0;
      if (lineIndex > firstLineIndex) {
        const canJoinSegment = !segmentJoinBlocked;
        const isSoftContinuation = canJoinSegment && isCurrentLineWrapped;
        const hardContinuation = stripHardContinuationPrefix(lineText);
        // Agent TUIs may wrap inside a reserved right margin instead of the
        // terminal edge. Disk resolution below trims any overlong join back to
        // the longest prefix that actually exists.
        const wrappedFullRow = previousLineTotalCells > 0
          && previousLineWrittenCells >= previousLineTotalCells * ARTIFACT_LINK_MIN_WRAPPED_ROW_FILL;
        const isHardArtifactContinuation = canJoinSegment
          && !isCurrentLineWrapped
          && hardContinuationLines < ARTIFACT_LINK_MAX_HARD_CONTINUATION_LINES
          && wrappedFullRow
          && hasOpenArtifactPath(segmentText)
          && hardContinuation.text.length > 0;
        const joiner = isSoftContinuation || isHardArtifactContinuation ? "" : "\n";
        if (isHardArtifactContinuation) {
          lineText = hardContinuation.text;
          sourceOffset = hardContinuation.sourceOffset;
          hardContinuationLines++;
        }
        parts.push({
          text: joiner,
          nextLineIndex: lineIndex,
          hardBoundary: isHardArtifactContinuation,
        });
        if (joiner === "\n") {
          segmentText = "";
          segmentJoinBlocked = false;
          hardContinuationLines = 0;
        } else {
          segmentText += joiner;
          if (segmentText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
            segmentText = "";
            segmentJoinBlocked = true;
          }
        }
      }
      parts.push({ text: lineText, lineIndex, sourceOffset });
      if (segmentJoinBlocked || segmentText.length + lineText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
        segmentText = "";
        segmentJoinBlocked = true;
      } else {
        segmentText += lineText;
      }
      previousLineWrittenCells = writtenExtent.cellEnd;
      previousLineTotalCells = line?.length ?? 0;
    }

    const text = parts.map((part) => part.text).join("");
    let partOffset = 0;
    const hardBoundaryOffsets: number[] = [];
    for (const part of parts) {
      if (part.hardBoundary) hardBoundaryOffsets.push(partOffset);
      partOffset += part.text.length;
    }
    const filePathMatches = findLocalFilePathLinks(text);
    const candidates = [...filePathMatches, ...findBareLocalPathCandidates(text, [])];
    const needsHome = !homeDirSettled
      && candidates.some((candidate) => /^~[\\/]/.test(candidate.text));
    const cwd = getCwd?.()?.trim() || undefined;
    const prepared = limitPreparedPathCandidates(
      expandPathCandidateVariants(candidates, [...new Set(hardBoundaryOffsets)])
        .map((variant) => preparePathCandidate(variant, cwd, memoizedHomeDir))
        .filter((candidate): candidate is PreparedPathCandidate => candidate !== null),
      LOCAL_PATH_PREWARM_MAX_CANDIDATES,
    );
    return { parts, filePathMatches, prepared, needsHome };
  };

  const collectRowLinks = (bufferLineNumber: number): RowLinkCollection => {
    const data = collectRowPathData(bufferLineNumber);
    if (!data) return { links: [], missing: [], fallbackLinks: [], needsHome: false };

    const fallbackLinks = data.filePathMatches
      .map((match) => createLocalPathLink(term, data.parts, bufferLineNumber, match, onActivate))
      .filter((link): link is ILink => link !== null);
    const missing = new Set<string>();
    const resolved = data.prepared.map((candidate) => {
      const cached = readLocalPathResolutionCache(candidate.lookupText);
      if (!cached.found) missing.add(candidate.lookupText);
      return cached.found ? cached.value : null;
    });
    const remapped = data.prepared.map((candidate, index) =>
      remapResolvedPathLink(candidate, resolved[index]));
    const links = mergeResolvedPathLinkMatches(
      data.prepared.map((candidate) => candidate.sourceCandidate),
      remapped.map((result) => result.display),
      remapped.map((result) => result.activationPrefix),
      data.prepared.map((candidate) => candidate.resolutionPriority),
    )
      .map((match) => createLocalPathLink(
        term,
        data.parts,
        bufferLineNumber,
        match,
        onActivate,
        match.activationUri,
      ))
      .filter((link): link is ILink => link !== null)
      .sort(sortLinksByRange);
    return { links, missing: [...missing], fallbackLinks, needsHome: data.needsHome };
  };

  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const completeFromCurrentBuffer = (homeAttempted = false): void => {
        const first = collectRowLinks(bufferLineNumber);
        if (first.needsHome && !homeAttempted) {
          void ensureHomeDir().then(() => {
            if (!disposed) completeFromCurrentBuffer(true);
          });
          return;
        }
        if (first.missing.length === 0) {
          if (!disposed) callback(first.links.length > 0 ? first.links : undefined);
          return;
        }
        void resolveAndCacheLocalPathLookups(first.missing)
          .then(() => {
            if (disposed) return;
            const current = collectRowLinks(bufferLineNumber);
            callback(current.links.length > 0 ? current.links : undefined);
          })
          .catch((error) => {
            if (disposed) return;
            if (import.meta.env.DEV) {
              console.warn("[mycmux] failed to resolve local path links", error);
            }
            const current = collectRowLinks(bufferLineNumber);
            const fallback = current.fallbackLinks.filter(
              (link) => link.range.start.y === link.range.end.y,
            );
            callback(fallback.length > 0 ? fallback : undefined);
          });
      };
      completeFromCurrentBuffer();
    },
  });

  let prewarmTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let lastPrewarmSignature: string | null = null;
  const prewarmRenderedRows = async (): Promise<void> => {
    const buffer = term.buffer.active;
    const prewarmSignature = [
      getTerminalWriteCounter(sessionId),
      buffer.viewportY,
      buffer.baseY,
      buffer.length,
    ].join(":");
    if (prewarmSignature === lastPrewarmSignature) return;
    lastPrewarmSignature = prewarmSignature;

    const firstLineIndex = Math.max(0, buffer.viewportY - LOCAL_PATH_PREWARM_CONTEXT_LINES);
    const lastLineIndex = Math.min(
      buffer.length - 1,
      buffer.viewportY + Math.max(0, term.rows - 1) + LOCAL_PATH_PREWARM_CONTEXT_LINES,
    );
    const collectMissing = (limit: number): { missing: string[]; needsHome: boolean } => {
      const missing = new Set<string>();
      let needsHome = false;
      const lineIndexes: number[] = [];
      // Each scan covers 16 lines on either side, so a 16-line stride covers the full range.
      for (
        let lineIndex = firstLineIndex;
        lineIndex <= lastLineIndex;
        lineIndex += ARTIFACT_LINK_CONTEXT_LINES
      ) {
        lineIndexes.push(lineIndex);
      }
      if (
        lastLineIndex >= firstLineIndex
        && lineIndexes[lineIndexes.length - 1] !== lastLineIndex
      ) {
        lineIndexes.push(lastLineIndex);
      }
      for (const lineIndex of lineIndexes) {
        const bufferLineNumber = lineIndex + 1;
        const data = collectRowPathData(bufferLineNumber);
        if (!data) continue;
        needsHome ||= data.needsHome;
        for (const candidate of data.prepared) {
          if (readLocalPathResolutionCache(candidate.lookupText).found) continue;
          if (localPathResolutionInFlight.has(candidate.lookupText)) continue;
          missing.add(candidate.lookupText);
          if (missing.size >= limit) break;
        }
        if (missing.size >= limit) break;
      }
      return { missing: [...missing], needsHome };
    };

    const first = collectMissing(LOCAL_PATH_PREWARM_MAX_CANDIDATES);
    const homeRequest = first.needsHome ? ensureHomeDir() : null;
    if (first.missing.length > 0) {
      await resolveAndCacheLocalPathLookups(first.missing);
    }
    if (disposed || !homeRequest) return;
    const home = await homeRequest;
    if (disposed || !home) return;
    const remaining = LOCAL_PATH_PREWARM_MAX_CANDIDATES - first.missing.length;
    if (remaining > 0) {
      const second = collectMissing(remaining);
      if (second.missing.length > 0) {
        await resolveAndCacheLocalPathLookups(second.missing);
      }
    }
  };
  const renderDisposable = term.onRender(() => {
    if (prewarmTimer !== null) {
      globalThis.clearTimeout(prewarmTimer);
    }
    prewarmTimer = globalThis.setTimeout(() => {
      prewarmTimer = null;
      void prewarmRenderedRows().catch((error) => {
        if (import.meta.env.DEV) {
          console.warn("[mycmux] failed to prewarm local path links", error);
        }
      });
    }, LOCAL_PATH_PREWARM_DEBOUNCE_MS);
  });

  return {
    dispose() {
      disposed = true;
      if (prewarmTimer !== null) {
        globalThis.clearTimeout(prewarmTimer);
        prewarmTimer = null;
      }
      renderDisposable.dispose();
      provider.dispose();
    },
  };
}
