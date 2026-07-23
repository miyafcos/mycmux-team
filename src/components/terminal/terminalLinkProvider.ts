import type { ILink, Terminal } from "@xterm/xterm";
import {
  getTerminalWriteCounter,
  registerTerminalCacheEvictionCleanup,
} from "./terminalCache";
import { homeDir } from "@tauri-apps/api/path";
import { resolveLocalPathLinks, type ResolvedLocalPathLink } from "../../lib/ipc";

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
const ARTIFACT_LINK_MAX_SEGMENT_CHARS = 8192;
const ARTIFACT_LINK_CACHE_MAX_ENTRIES = 64;
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
};

export type LocalFilePathLinkMatch = {
  text: string;
  index: number;
  endIndex: number;
};

export type ResolvedLocalPathLinkMatch = LocalFilePathLinkMatch & {
  activationUri: string;
};

type ArtifactLinkCacheValue = ILink[] | undefined | Promise<ILink[] | undefined>;

const artifactLinkCache = new Map<string, ArtifactLinkCacheValue>();

registerTerminalCacheEvictionCleanup(forgetArtifactLinkCacheForSession);

function rememberArtifactLinkCache(key: string, value: ArtifactLinkCacheValue): void {
  if (artifactLinkCache.has(key)) {
    artifactLinkCache.delete(key);
  }
  artifactLinkCache.set(key, value);
  if (artifactLinkCache.size <= ARTIFACT_LINK_CACHE_MAX_ENTRIES) return;
  const oldest = artifactLinkCache.keys().next().value;
  if (oldest !== undefined) {
    artifactLinkCache.delete(oldest);
  }
}

function forgetArtifactLinkCacheForSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of artifactLinkCache.keys()) {
    if (key.startsWith(prefix)) {
      artifactLinkCache.delete(key);
    }
  }
}

function cellXForStringOffset(line: ReturnType<Terminal["buffer"]["active"]["getLine"]>, offset: number): number {
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

function bareLocalPathCandidateEnd(text: string, start: number, nextStart: number | undefined): number {
  const limit = nextStart === undefined ? text.length : nextStart;
  const tail = text.slice(start, limit);
  const hardStop = tail.search(BARE_LOCAL_PATH_HARD_STOP_REGEX);
  return hardStop === -1 ? limit : start + hardStop;
}

function pathCandidateStarts(text: string): number[] {
  const starts = [
    ...text.matchAll(new RegExp(BARE_LOCAL_PATH_PREFIX_REGEX.source, BARE_LOCAL_PATH_PREFIX_REGEX.flags)),
    ...text.matchAll(new RegExp(RELATIVE_LOCAL_PATH_PREFIX_REGEX.source, RELATIVE_LOCAL_PATH_PREFIX_REGEX.flags)),
    ...text.matchAll(new RegExp(BARE_LOCAL_FILE_PREFIX_REGEX.source, BARE_LOCAL_FILE_PREFIX_REGEX.flags)),
  ].flatMap((match) => match.index === undefined ? [] : [match.index]);
  return [...new Set(starts)].sort((left, right) => left - right);
}

export function findBareLocalPathCandidates(
  text: string,
  occupiedMatches: LocalFilePathLinkMatch[] = findLocalFilePathLinks(text),
): LocalFilePathLinkMatch[] {
  const starts = pathCandidateStarts(text);

  const candidates: LocalFilePathLinkMatch[] = [];
  for (let startIndex = 0; startIndex < starts.length; startIndex++) {
    const index = starts[startIndex];
    const endIndex = bareLocalPathCandidateEnd(text, index, starts[startIndex + 1]);
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
  lookupText: string;
  lookupBase?: string;
  displayBase: string;
};

function isAbsoluteLocalPath(text: string): boolean {
  return /^file:\/\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\/[A-Za-z]\//.test(text);
}

function withTrailingPathSeparator(base: string): string {
  if (/[\\/]$/.test(base)) return base;
  return `${base}${/^[A-Za-z]:/.test(base) || base.includes("\\") ? "\\" : "/"}`;
}

function preparePathCandidate(
  candidate: LocalFilePathLinkMatch,
  cwd: string | undefined,
  home: string | undefined,
): PreparedPathCandidate | null {
  if (isAbsoluteLocalPath(candidate.text)) {
    return { candidate, lookupText: candidate.text, displayBase: "" };
  }
  if (/^~[\\/]/.test(candidate.text)) {
    if (!home) return null;
    const lookupBase = withTrailingPathSeparator(home);
    return {
      candidate,
      lookupText: `${lookupBase}${candidate.text.slice(2)}`,
      lookupBase,
      displayBase: candidate.text.slice(0, 2),
    };
  }
  if (!cwd) return null;
  const lookupBase = withTrailingPathSeparator(cwd);
  return {
    candidate,
    lookupText: `${lookupBase}${candidate.text}`,
    lookupBase,
    displayBase: "",
  };
}

function remapResolvedPathLink(
  prepared: PreparedPathCandidate,
  resolved: ResolvedLocalPathLink | null,
): { display: ResolvedLocalPathLink | null; activationPrefix?: string } {
  if (!resolved || !prepared.lookupBase) {
    return { display: resolved, activationPrefix: resolved?.existingPrefix };
  }
  const prefixMatches = resolved.existingPrefix.toLowerCase().startsWith(
    prepared.lookupBase.toLowerCase(),
  );
  if (!prefixMatches) return { display: null };
  const suffix = resolved.existingPrefix.slice(prepared.lookupBase.length);
  const existingPrefix = `${prepared.displayBase}${suffix}`;
  if (!existingPrefix || !prepared.candidate.text.startsWith(existingPrefix)) {
    return { display: null };
  }
  return {
    display: { existingPrefix, isDir: resolved.isDir },
    activationPrefix: resolved.existingPrefix,
  };
}

export function mergeResolvedPathLinkMatches(
  candidates: LocalFilePathLinkMatch[],
  resolvedLinks: Array<ResolvedLocalPathLink | null>,
  activationPrefixes: Array<string | undefined> = [],
): ResolvedLocalPathLinkMatch[] {
  const matches: ResolvedLocalPathLinkMatch[] = [];
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
      text: resolved.existingPrefix,
      index: candidate.index,
      endIndex: candidate.index + resolved.existingPrefix.length,
      activationUri: activationUriForResolvedLocalPath(
        activationPrefixes[index] ?? resolved.existingPrefix,
        resolved,
      ),
    });
  }

  matches.sort((left, right) => right.text.length - left.text.length || left.index - right.index);
  const merged: ResolvedLocalPathLinkMatch[] = [];
  for (const match of matches) {
    if (merged.some((existing) => rangesOverlap(match, existing))) continue;
    merged.push(match);
  }
  return merged.sort((left, right) => left.index - right.index || left.endIndex - right.endIndex);
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
  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const targetLineIndex = bufferLineNumber - 1;
      if (targetLineIndex < 0 || targetLineIndex >= buffer.length) {
        if (!disposed) callback(undefined);
        return;
      }

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

      const writeCounter = getTerminalWriteCounter(sessionId);
      const cwd = getCwd?.()?.trim() || undefined;
      const cacheKey = [
        sessionId,
        writeCounter,
        cwd ?? "",
        bufferLineNumber,
        firstLineIndex,
        lastLineIndex,
        buffer.length,
        buffer.viewportY,
        buffer.baseY,
      ].join(":");
      if (artifactLinkCache.has(cacheKey)) {
        const cached = artifactLinkCache.get(cacheKey);
        if (cached instanceof Promise) {
          cached.then((result) => {
            if (!disposed) callback(result);
          });
        } else if (!disposed) {
          callback(cached);
        }
        return;
      }

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
      if (!hasCandidate) {
        rememberArtifactLinkCache(cacheKey, undefined);
        if (!disposed) callback(undefined);
        return;
      }

      const parts: ArtifactLinkPart[] = [];
      let segmentText = "";
      let segmentJoinBlocked = false;
      let hardContinuationLines = 0;
      let previousLineReachedVisualEnd = false;
      for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
        const line = buffer.getLine(lineIndex);
        const isCurrentLineWrapped = Boolean(line?.isWrapped);
        const nextIsWrapped = Boolean(buffer.getLine(lineIndex + 1)?.isWrapped);
        const rawLineText = line?.translateToString(false) ?? "";
        const trimmedLineText = line?.translateToString(true) ?? "";
        const nextLineText = buffer.getLine(lineIndex + 1)?.translateToString(true) ?? "";
        let lineText = nextIsWrapped
          ? normalizeSoftWrappedArtifactLine(rawLineText, nextLineText)
          : trimmedLineText;
        let sourceOffset = 0;
        if (lineIndex > firstLineIndex) {
          const canJoinSegment = !segmentJoinBlocked;
          const isSoftContinuation = canJoinSegment && isCurrentLineWrapped;
          const hardContinuation = stripHardContinuationPrefix(lineText);
          const isHardArtifactContinuation = canJoinSegment
            && !isCurrentLineWrapped
            && hardContinuationLines < ARTIFACT_LINK_MAX_HARD_CONTINUATION_LINES
            && previousLineReachedVisualEnd
            && hasOpenArtifactPath(segmentText)
            && hardContinuation.text.length > 0;
          const joiner = isSoftContinuation || isHardArtifactContinuation ? "" : "\n";
          if (isHardArtifactContinuation) {
            lineText = hardContinuation.text;
            sourceOffset = hardContinuation.sourceOffset;
            hardContinuationLines++;
          }
          parts.push({ text: joiner, nextLineIndex: lineIndex });
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
        previousLineReachedVisualEnd = rawLineText.length > 0 && !/\s$/.test(rawLineText);
      }
      const text = parts.map((part) => part.text).join("");
      const filePathMatches = findLocalFilePathLinks(text);
      const fallbackLinks: ILink[] = [];
      for (const match of filePathMatches) {
        const link = createLocalPathLink(term, parts, bufferLineNumber, match, onActivate);
        if (link) {
          fallbackLinks.push(link);
        }
      }
      const bareCandidates = findBareLocalPathCandidates(text, []);
      const candidates = [...filePathMatches, ...bareCandidates];
      if (candidates.length > 0) {
        const needsHome = candidates.some((candidate) => /^~[\\/]/.test(candidate.text));
        const homePromise = needsHome ? homeDir().catch(() => undefined) : Promise.resolve(undefined);
        const resultPromise = homePromise
          .then((home) => {
            const prepared = candidates
              .map((candidate) => preparePathCandidate(candidate, cwd, home))
              .filter((candidate): candidate is PreparedPathCandidate => candidate !== null);
            if (prepared.length === 0) {
              return { prepared, resolvedLinks: [] as Array<ResolvedLocalPathLink | null> };
            }
            return resolveLocalPathLinks(prepared.map((candidate) => candidate.lookupText))
              .then((resolvedLinks) => ({ prepared, resolvedLinks }));
          })
          .then(({ prepared, resolvedLinks }) => {
            const remapped = prepared.map((candidate, index) =>
              remapResolvedPathLink(candidate, resolvedLinks[index] ?? null));
            const links: ILink[] = [];
            for (const match of mergeResolvedPathLinkMatches(
              prepared.map((candidate) => candidate.candidate),
              remapped.map((result) => result.display),
              remapped.map((result) => result.activationPrefix),
            )) {
              const link = createLocalPathLink(
                term,
                parts,
                bufferLineNumber,
                match,
                onActivate,
                match.activationUri,
              );
              if (link) {
                links.push(link);
              }
            }
            links.sort(sortLinksByRange);
            const result = links.length > 0 ? links : undefined;
            if (!disposed) rememberArtifactLinkCache(cacheKey, result);
            return result;
          })
          .catch((error) => {
            if (import.meta.env.DEV) {
              console.warn("[mycmux] failed to resolve local path links", error);
            }
            const singleLineFallbackLinks = fallbackLinks.filter(
              (link) => link.range.start.y === link.range.end.y,
            );
            const result = singleLineFallbackLinks.length > 0 ? singleLineFallbackLinks : undefined;
            if (!disposed) rememberArtifactLinkCache(cacheKey, result);
            return result;
          });
        rememberArtifactLinkCache(cacheKey, resultPromise);
        resultPromise.then((result) => {
          if (disposed) return;
          callback(getTerminalWriteCounter(sessionId) === writeCounter ? result : undefined);
        });
        return;
      }
      const result = fallbackLinks.length > 0 ? fallbackLinks : undefined;
      rememberArtifactLinkCache(cacheKey, result);
      if (!disposed) callback(result);
    },
  });
  return {
    dispose() {
      disposed = true;
      provider.dispose();
      forgetArtifactLinkCacheForSession(sessionId);
    },
  };
}
