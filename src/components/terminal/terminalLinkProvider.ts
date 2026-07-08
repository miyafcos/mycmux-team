import type { ILink, Terminal } from "@xterm/xterm";
import {
  getTerminalWriteCounter,
  registerTerminalCacheEvictionCleanup,
} from "./terminalCache";

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

const artifactLinkCache = new Map<string, ILink[] | undefined>();

registerTerminalCacheEvictionCleanup(forgetArtifactLinkCacheForSession);

function rememberArtifactLinkCache(key: string, value: ILink[] | undefined): void {
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

export function registerArtifactLinkProvider(
  term: Terminal,
  sessionId: string,
  onActivate: (uri: string, event: MouseEvent) => void,
) {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const targetLineIndex = bufferLineNumber - 1;
      if (targetLineIndex < 0 || targetLineIndex >= buffer.length) {
        callback(undefined);
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

      const cacheKey = [
        sessionId,
        getTerminalWriteCounter(sessionId),
        bufferLineNumber,
        firstLineIndex,
        lastLineIndex,
        buffer.length,
        buffer.viewportY,
        buffer.baseY,
      ].join(":");
      if (artifactLinkCache.has(cacheKey)) {
        callback(artifactLinkCache.get(cacheKey));
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
        callback(undefined);
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
      const regex = new RegExp(ARTIFACT_LINK_REGEX.source, ARTIFACT_LINK_REGEX.flags);
      const links: ILink[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        const uri = match[0];
        const start = mapWrappedStringOffset(term, parts, match.index, false);
        const end = mapWrappedStringOffset(term, parts, match.index + uri.length, true);
        const link: ILink = {
          range: {
            start: { x: start.cellX + 1, y: start.lineIndex + 1 },
            end: { x: Math.max(1, end.cellX), y: end.lineIndex + 1 },
          },
          text: uri,
          activate: (event) => onActivate(uri, event),
        };
        if (link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber) {
          links.push(link);
        }
      }
      const result = links.length > 0 ? links : undefined;
      rememberArtifactLinkCache(cacheKey, result);
      callback(result);
    },
  });
}
