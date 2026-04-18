/**
 * Display helpers for filesystem paths shown in the terminal UI.
 *
 * Keeps behaviour identical across Windows / POSIX so OSC 7 and sysinfo paths
 * render the same way regardless of which source delivered them.
 */

// Ordered most-specific first. The first match wins.
const HOME_PATTERNS: Array<[RegExp, string]> = [
  [/^\/home\/[^/]+/, "~"],
  [/^\/Users\/[^/]+/, "~"],
  [/^C:\\Users\\[^\\]+/i, "~"],
];

export function shortenPath(
  path: string | null | undefined,
  maxLen = 40,
): string {
  if (!path) return "";
  let p = path;
  for (const [re, replacement] of HOME_PATTERNS) {
    if (re.test(p)) {
      p = p.replace(re, replacement);
      break;
    }
  }
  if (p.length <= maxLen) return p;
  const tail = p.slice(p.length - (maxLen - 1));
  return "…" + tail;
}

/**
 * Pull the rightmost directory name from a path. Works for POSIX (/a/b/c → c)
 * and Windows (C:\a\b\c → c).
 */
export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const sep = trimmed.lastIndexOf("/") >= trimmed.lastIndexOf("\\") ? "/" : "\\";
  const idx = trimmed.lastIndexOf(sep);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Quote a filesystem path for insertion into a shell command line. Backslashes
 * are converted to forward slashes so Git Bash and Claude Code accept the
 * result verbatim. Embedded double-quotes get backslash-escaped — rare but it
 * keeps the insertion from silently breaking the user's command.
 */
export function quoteShellPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const escaped = normalized.replace(/"/g, '\\"');
  return `"${escaped}"`;
}
