/**
 * Which mark a tab shows, for every tab -- agent or Web.
 *
 * A Web tab holds no PTY, so the two things `resolveDisplayAgentKind` reads --
 * `agentKind` and the PTY command -- are both empty, and such a tab used to
 * fall back to a bare chip with no mark at all. The preset id is what the
 * launcher already dispatched on, so one map answers both surfaces and the tab
 * keeps the mark its launcher row showed.
 *
 * The vendor label is kept apart from the mark kind on purpose: the ChatGPT
 * preset borrows the Codex mark (same vendor), but a ChatGPT tab must not be
 * badged "Codex".
 */
import type { PaneTab } from "../types/workspace";
import { resolveDisplayAgentKind, type DisplayAgentKind } from "./agentDisplayKind";
import { agentKindColor, type AgentKindColor } from "./agentKindColors";

/** Everything `AgentKindIcon` can draw: the agent kinds plus the Web-only vendors. */
export type TabMarkKind = DisplayAgentKind | "gemini" | "notebooklm" | "browser";

export interface TabMark {
  /** The `kind` AgentKindIcon dispatches on. */
  kind: TabMarkKind;
  /** Vendor name for the badge and the accessible name. */
  label: string;
  color: AgentKindColor;
}

/**
 * Keyed by the preset ids `src-tauri/src/commands/webpane.rs` defines;
 * `tests/test_web_preset_mark_contract.py` keeps the two lists level.
 */
export const WEB_PRESET_MARKS: Record<string, { kind: TabMarkKind; label: string }> = {
  browser: { kind: "browser", label: "ブラウザ" },
  chatgpt: { kind: "codex", label: "ChatGPT" },
  gemini: { kind: "gemini", label: "Gemini" },
  grok: { kind: "grok", label: "Grok" },
  claude: { kind: "claude", label: "Claude" },
  notebooklm: { kind: "notebooklm", label: "NotebookLM" },
};

/** Marks the agent palette carries no entry for -- the Web-only vendors. */
const WEB_MARK_COLORS: Record<"gemini" | "notebooklm" | "browser", AgentKindColor> = {
  // Gemini's own violet, the middle stop of the mark's gradient.
  gemini: { fg: "#9b72cb", bg: "rgba(155, 114, 203, 0.10)" },
  // NotebookLM blue, lifted off Antigravity's #4285f4 so the two read apart.
  notebooklm: { fg: "#5b9bf8", bg: "rgba(91, 155, 248, 0.10)" },
  // The generic browser has no vendor: a neutral slate, not a brand colour.
  browser: { fg: "#9aa7b4", bg: "rgba(154, 167, 180, 0.10)" },
};

/** The badge text for an agent mark. Web tabs use their preset label instead. */
const AGENT_MARK_LABELS: Record<DisplayAgentKind, string> = {
  "claude": "Claude",
  "codex": "Codex",
  "claude-codex": "Hybrid",
  "grok": "Grok",
  "antigravity": "Antigravity",
  "hermes": "Hermes",
};

export function tabMarkColor(kind: TabMarkKind): AgentKindColor {
  return agentKindColor(kind) ?? WEB_MARK_COLORS[kind as keyof typeof WEB_MARK_COLORS];
}

export type TabMarkInput = Pick<
  PaneTab,
  "type" | "presetId" | "agentKind" | "commandArgv" | "launchEnv"
>;

/**
 * `agentKind` overrides the tab's own field where live metadata knows better
 * (the PTY reports what actually launched); it is ignored for Web tabs, which
 * have no session to report one.
 */
export function resolveTabMark(tab: TabMarkInput, agentKind?: string | null): TabMark | null {
  if (tab.type === "web") {
    // An unknown preset still gets the globe: a Web tab is never mark-less.
    const preset = WEB_PRESET_MARKS[tab.presetId ?? ""] ?? WEB_PRESET_MARKS.browser;
    return { ...preset, color: tabMarkColor(preset.kind) };
  }
  const kind = resolveDisplayAgentKind(
    agentKind ?? tab.agentKind,
    tab.commandArgv,
    tab.launchEnv?.MYCMUX_LAUNCH_TARGET,
  );
  if (!kind) return null;
  return { kind, label: AGENT_MARK_LABELS[kind], color: tabMarkColor(kind) };
}
