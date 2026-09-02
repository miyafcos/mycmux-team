/**
 * Turning composed text into the keystrokes a pane's program expects.
 *
 * A pane runs one of three things and each takes multi-line input differently:
 * Claude Code accepts a bracketed paste, Codex wants its Shift+Enter key report
 * per line, and a bare shell executes every newline it receives. Getting this
 * wrong in a shell runs half-written commands, so the shell case folds newlines
 * into spaces and says so rather than guessing.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CODEX_SHIFT_ENTER = "\x1b[13;2u";
const SUBMIT = "\r";

export type ComposerTarget = "claude" | "codex" | "shell";

export interface ComposerTargetInput {
  command: string;
  args?: readonly string[];
  agentId?: string;
  agentKind?: string;
  launchEnv?: Record<string, string>;
  processTitle?: string;
}

function baseName(value: string): string {
  return value
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat|com)$/i, "")
    .toLowerCase() ?? "";
}

export function resolveComposerTarget(input: ComposerTargetInput): ComposerTarget {
  const { command, args = [], agentId, agentKind, launchEnv, processTitle } = input;
  const declared = [
    agentKind,
    agentId,
    launchEnv?.MYCMUX_AGENT_KIND,
    launchEnv?.MYCMUX_RESUME,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (declared.includes("codex")) return "codex";
  // claude-codex drives the Claude Code TUI, so it takes Claude's input shape.
  if (declared.some((value) => value === "claude" || value === "claude-codex" || value === "grok")) return "claude";

  const names = [baseName(command), ...args.map(baseName)];
  if (processTitle) names.push(baseName(processTitle));
  if (names.includes("codex")) return "codex";
  if (names.includes("claude")) return "claude";
  if (names.includes("grok")) return "claude";
  return "shell";
}

/**
 * What the composer should call the program it is typing into.
 *
 * This is deliberately separate from ComposerTarget: that one is the *input
 * shape*, and several agents share one shape. Grok Build and claude-codex both
 * take Claude's bracketed paste, but labelling their composer "Claude" tells the
 * operator they are talking to the wrong agent.
 */
export type ComposerAgentLabelKind = ComposerTarget | "grok" | "claude-codex";

export function resolveComposerAgentLabelKind(input: ComposerTargetInput): ComposerAgentLabelKind {
  const { command, args = [], agentId, agentKind, launchEnv, processTitle } = input;
  const declared = [
    agentKind,
    agentId,
    launchEnv?.MYCMUX_AGENT_KIND,
    launchEnv?.MYCMUX_RESUME,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (declared.includes("grok")) return "grok";
  if (declared.includes("claude-codex")) return "claude-codex";

  const names = [baseName(command), ...args.map(baseName)];
  if (processTitle) names.push(baseName(processTitle));
  if (names.includes("grok")) return "grok";
  if (names.includes("claude-codex")) return "claude-codex";

  return resolveComposerTarget(input);
}

/** True when the pane runs an agent TUI rather than a plain shell. */
export function startsAsAgentTui(input: ComposerTargetInput): boolean {
  return resolveComposerTarget(input) !== "shell";
}

/** The bytes Shift+Enter should produce for this pane: a newline, not a submit. */
export function shiftEnterSequence(input: ComposerTargetInput): string {
  return resolveComposerTarget(input) === "codex" ? CODEX_SHIFT_ENTER : `${PASTE_START}\n${PASTE_END}`;
}

export function normalizeComposerText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export interface ComposerPayload {
  /** The text keystrokes, without the submit key. Empty when there is nothing to send. */
  body: string;
  /**
   * Sent after the body, as its own write, so a failed body never submits alone.
   *
   * Every target submits with CR today, which is why the composers hand the body
   * to `pane.send_text` with `enter: true` and let it own the submit key: that
   * route waits for the body to echo before pressing it. A target that submits
   * with anything else cannot use `enter: true` and needs its own path.
   */
  submitKey: string;
  /** True when newlines were folded away because the target could not take them. */
  foldedNewlines: boolean;
}

export function buildComposerPayload(args: { text: string; target: ComposerTarget }): ComposerPayload {
  const text = normalizeComposerText(args.text);
  if (!text) return { body: "", submitKey: "", foldedNewlines: false };

  switch (args.target) {
    case "claude":
      return { body: `${PASTE_START}${text}${PASTE_END}`, submitKey: SUBMIT, foldedNewlines: false };
    case "codex":
      return {
        body: text.split("\n").join(CODEX_SHIFT_ENTER),
        submitKey: SUBMIT,
        foldedNewlines: false,
      };
    case "shell": {
      const folded = text.split("\n").join(" ");
      return { body: folded, submitKey: SUBMIT, foldedNewlines: folded !== text };
    }
  }
}

export type ComposerKeyIntent = "submit" | "newline" | "close" | "none";

export interface ComposerKeyEvent {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function composerKeyIntent(event: ComposerKeyEvent): ComposerKeyIntent {
  // The Enter that commits an IME conversion arrives as a keydown too. Treating
  // it as anything but "none" sends half-typed Japanese to the pane.
  if (event.isComposing || event.keyCode === 229) return "none";
  if (event.key === "Escape") return "close";
  if (event.key !== "Enter") return "none";
  if (event.ctrlKey || event.altKey || event.metaKey) return "none";
  return event.shiftKey ? "newline" : "submit";
}
