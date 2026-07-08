import type { ILink, Terminal } from "@xterm/xterm";
import {
  getTerminalWriteCounter,
  registerTerminalCacheEvictionCleanup,
} from "./terminalCache";
import { resolveLocalPathLinks, type ResolvedLocalPathLink } from "../../lib/ipc";

export const HTTP_LINK_REGEX = /https?:\/\/[^\s"'<>+\uFF0B]+[^\s"'<>+\uFF0B.,!?;:)}\]]/i;
const ARTIFACT_EXTENSION_PATTERN = String.raw`html?|markdown|md|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm`;
const GENERIC_FILE_EXTENSION_PATTERN = String.raw`[A-Za-z0-9][A-Za-z0-9_~-]{0,9}`;
const GENERIC_FILE_EXTENSION_SUFFIX_PATTERN = String.raw`${GENERIC_FILE_EXTENSION_PATTERN}(?:\.${GENERIC_FILE_EXTENSION_PATTERN})*`;
const ARTIFACT_LINK_TERMINATOR_PATTERN = String.raw`(?=$|[\s"'<>+\uFF0B.,!?;:)}\]\uFF08\uFF09\u30FB\u3002\u3001\uFF0C])`;
const MSYS_DRIVE_PREFIX_PATTERN = String.raw`(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/`;
const ARTIFACT_LINK_REGEX = new RegExp(
  String.raw`(?:file:\/\/\/[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|[A-Za-z]:[\\/](?![\\/])[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|${MSYS_DRIVE_PREFIX_PATTERN}[^\r\n"'<>+\uFF0B]*?\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})|file:\/\/\/[^\r\n"'<>+\uFF0B]*?[\\/]|[A-Za-z]:[\\/](?![\\/])(?:[^\r\n"'<>+\uFF0B]*?[\\/])?|${MSYS_DRIVE_PREFIX_PATTERN}[^\r\n"'<>+\uFF0B]*?[\\/])${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "gi",
);
const COMPLETE_ARTIFACT_EXTENSION_REGEX = new RegExp(
  String.raw`\.(?:${GENERIC_FILE_EXTENSION_SUFFIX_PATTERN})${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "i",
);
const PREVIEW_ARTIFACT_EXTENSION_REGEX = new RegExp(
  String.raw`\.(?:${ARTIFACT_EXTENSION_PATTERN})${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "i",
);
const ARTIFACT_LINK_CONTEXT_LINES = 16;
const ARTIFACT_LINK_MAX_WRAPPED_LINES = 64;
const ARTIFACT_LINK_MAX_SEGMENT_CHARS = 8192;
const ARTIFACT_LINK_CACHE_MAX_ENTRIES = 64;
const ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX =
  /(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/)/i;
const BARE_LOCAL_PATH_PREFIX_REGEX =
  /file:\/\/\/|(?<![A-Za-z0-9._\\/:])[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\//gi;
const BARE_LOCAL_PATH_HARD_STOP_REGEX = /[\r\n"'<>+\uFF0B\uFF08\uFF09\u300C\u300D]/;

type ArtifactLinkPart = {
  text: string;
  lineIndex?: number;
  nextLineIndex?: number;
};

export type LocalFilePathLinkMatch = {
  text: string;
  index: number;
  endIndex: number;
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
      return { lineIndex, cellX: cellXForStringOffset(line, localOffset) };
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
  return !COMPLETE_ARTIFACT_EXTENSION_REGEX.test(tail);
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

export function findBareLocalPathCandidates(
  text: string,
  occupiedMatches: LocalFilePathLinkMatch[] = findLocalFilePathLinks(text),
): LocalFilePathLinkMatch[] {
  const prefixRegex = new RegExp(BARE_LOCAL_PATH_PREFIX_REGEX.source, BARE_LOCAL_PATH_PREFIX_REGEX.flags);
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = prefixRegex.exec(text))) {
    starts.push(match.index);
  }

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
  return text.includes("file:///") || ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX.test(text);
}

function looksLikeArtifactContinuation(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && !/^[|>*#-]\s/.test(trimmed);
}

function artifactContinuationJoiner(previousText: string, nextText: string): string {
  const previous = previousText.trimEnd();
  const next = nextText.trimStart();
  if (!previous || !next) return "";
  if (next.startsWith("/") || next.startsWith("\\") || previous.endsWith("/") || previous.endsWith("\\")) return "";
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return "";
  return " ";
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
      const cacheKey = [
        sessionId,
        writeCounter,
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
      let previousText = "";
      let segmentJoinBlocked = false;
      for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
        const line = buffer.getLine(lineIndex);
        const isCurrentLineWrapped = Boolean(line?.isWrapped);
        if (!isCurrentLineWrapped) {
          segmentJoinBlocked = false;
        }
        const nextIsWrapped = Boolean(buffer.getLine(lineIndex + 1)?.isWrapped);
        const rawLineText = line?.translateToString(false) ?? "";
        const trimmedLineText = line?.translateToString(true) ?? "";
        const nextLineText = buffer.getLine(lineIndex + 1)?.translateToString(true) ?? "";
        const lineText = nextIsWrapped
          ? normalizeSoftWrappedArtifactLine(rawLineText, nextLineText)
          : trimmedLineText;
        if (lineIndex > firstLineIndex) {
          const canJoinSegment = !segmentJoinBlocked;
          const isSoftContinuation = canJoinSegment && isCurrentLineWrapped;
          const isHardArtifactContinuation =
            canJoinSegment && hasOpenArtifactPath(segmentText) && looksLikeArtifactContinuation(lineText);
          const joiner = isSoftContinuation
            ? ""
            : isHardArtifactContinuation
              ? artifactContinuationJoiner(previousText, lineText)
              : "\n";
          parts.push({ text: joiner, nextLineIndex: lineIndex });
          if (joiner === "\n") {
            segmentText = "";
          } else {
            segmentText += joiner;
            if (segmentText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
              segmentText = "";
              segmentJoinBlocked = true;
            }
          }
        }
        parts.push({ text: lineText, lineIndex });
        if (segmentJoinBlocked || segmentText.length + lineText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
          segmentText = "";
          previousText = "";
          segmentJoinBlocked = true;
        } else {
          segmentText += lineText;
          previousText = lineText;
        }
      }
      const text = parts.map((part) => part.text).join("");
      const filePathMatches = findLocalFilePathLinks(text);
      const links: ILink[] = [];
      for (const match of filePathMatches) {
        const link = createLocalPathLink(term, parts, bufferLineNumber, match, onActivate);
        if (link) {
          links.push(link);
        }
      }
      const bareCandidates = findBareLocalPathCandidates(text, filePathMatches);
      if (bareCandidates.length > 0) {
        const resultPromise = resolveLocalPathLinks(bareCandidates.map((candidate) => candidate.text))
          .then((resolvedLinks) => {
            const merged = [...links];
            for (let index = 0; index < bareCandidates.length; index++) {
              const resolved = resolvedLinks[index];
              if (!resolved || !bareCandidates[index].text.startsWith(resolved.existingPrefix)) continue;
              const match: LocalFilePathLinkMatch = {
                text: resolved.existingPrefix,
                index: bareCandidates[index].index,
                endIndex: bareCandidates[index].index + resolved.existingPrefix.length,
              };
              const link = createLocalPathLink(
                term,
                parts,
                bufferLineNumber,
                match,
                onActivate,
                activationUriForResolvedLocalPath(resolved.existingPrefix, resolved),
              );
              if (link) {
                merged.push(link);
              }
            }
            merged.sort(sortLinksByRange);
            const result = merged.length > 0 ? merged : undefined;
            rememberArtifactLinkCache(cacheKey, result);
            return result;
          })
          .catch((error) => {
            if (import.meta.env.DEV) {
              console.warn("[mycmux] failed to resolve local path links", error);
            }
            const result = links.length > 0 ? links : undefined;
            rememberArtifactLinkCache(cacheKey, result);
            return result;
          });
        rememberArtifactLinkCache(cacheKey, resultPromise);
        resultPromise.then((result) => {
          if (disposed) return;
          callback(getTerminalWriteCounter(sessionId) === writeCounter ? result : undefined);
        });
        return;
      }
      const result = links.length > 0 ? links : undefined;
      rememberArtifactLinkCache(cacheKey, result);
      if (!disposed) callback(result);
    },
  });
  return {
    dispose() {
      disposed = true;
      provider.dispose();
    },
  };
}
