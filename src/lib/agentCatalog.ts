/**
 * What the launcher can start, and which model / effort each entry accepts.
 *
 * The launcher owns the actual spawn (`src-tauri/src/launcher.ps1` and
 * `launcher.sh`). This file is the GUI-side mirror of its menu so a workspace
 * can be created with a pane already pointed at a specific agent instead of
 * dropping into the launcher's own list. Both sides dispatch on
 * `MYCMUX_LAUNCH_TARGET`, so `target` is the contract between them —
 * `tests/test_launcher_catalog_contract.py` fails when an entry exists on one
 * side only, which is how the old `BUILT_IN_AGENTS` list silently drifted into
 * offering a sunset Gemini CLI while never offering claude-codex or agy.
 */
import type { AgentSessionKind } from "../types";

export interface ModelChoice {
  /** Passed to the CLI verbatim. */
  value: string;
  label: string;
}

export interface AgentCatalogEntry {
  /** The `MYCMUX_LAUNCH_TARGET` value both launchers dispatch on. */
  target: string;
  /** Kept identical to the launcher's own menu row. */
  label: string;
  /** "web" entries open a child webview instead of a PTY. */
  kind: "agent" | "web";
  /**
   * The executable the launcher ends up running. Two targets can share one
   * (claude-codex serves both its backends), and it is what decides which
   * model / effort flags apply — the contract test walks it against the
   * translation arms in both launchers.
   */
  cli?: string;
  /** Session identity mycmux tracks; absent for CLIs it does not track. */
  agentKind?: AgentSessionKind;
  /** Empty means the CLI takes no model flag (or we have no vetted list). */
  models: readonly ModelChoice[];
  /** Empty means the CLI takes no effort flag. */
  efforts: readonly string[];
}

/** Claude Code and its fork: `--effort low|medium|high|xhigh|max`. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/**
 * Codex reasoning effort has a sixth step ("none") the Claude CLIs lack, and
 * since GPT-6 Astra (Codex CLI 0.153, 2026-09) a seventh: "ultra" = maximum
 * reasoning with automatic task delegation to internal sub-agents.
 */
const CODEX_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** grok and agy both document three steps. */
const SHORT_EFFORTS = ["low", "medium", "high"] as const;

/**
 * Aliases rather than pinned ids: `claude --model` resolves "opus" to the
 * current Opus, so the list does not go stale every model release.
 */
const CLAUDE_MODELS: readonly ModelChoice[] = [
  { value: "fable", label: "Fable (flagship)" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * GPT-6 Astra (GA 2026-09-03) took the flagship seat on 2026-09-05; the 5.6
 * tiers stay selectable as the cost lane (terra), the scan lane (luna) and the
 * fallback when Astra is rate-limited (sol).
 */
const CODEX_MODELS: readonly ModelChoice[] = [
  { value: "gpt-6-astra", label: "Astra (flagship)" },
  { value: "gpt-5.6-sol", label: "Sol (5.6 fallback)" },
  { value: "gpt-5.6-terra", label: "Terra (standard)" },
  { value: "gpt-5.6-luna", label: "Luna (light)" },
];

/** From `agy models` — the effort is baked into most of these ids. */
const AGY_MODELS: readonly ModelChoice[] = [
  { value: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { value: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { value: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
];

const NO_CHOICES: readonly ModelChoice[] = [];
const NO_EFFORTS: readonly string[] = [];

/**
 * Ordered as the launcher lists them. Resume rows are deliberately absent: a
 * brand-new workspace has no session to resume, and picking one here would only
 * ever resume whatever the CLI happened to touch last.
 */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    target: "claude",
    label: "Claude Code",
    kind: "agent",
    cli: "claude",
    agentKind: "claude",
    models: CLAUDE_MODELS,
    efforts: CLAUDE_EFFORTS,
  },
  {
    target: "codex",
    label: "Codex",
    kind: "agent",
    cli: "codex",
    agentKind: "codex",
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
  },
  {
    target: "claude-codex",
    label: "claude-codex (Codex Models)",
    kind: "agent",
    cli: "claude-codex",
    agentKind: "claude-codex",
    models: CODEX_MODELS,
    efforts: CLAUDE_EFFORTS,
  },
  {
    target: "grok",
    label: "Grok Build",
    kind: "agent",
    cli: "grok",
    agentKind: "grok",
    // grok takes `-m <MODEL>` but publishes no id list through --help; the
    // custom field carries whatever the account is entitled to.
    models: NO_CHOICES,
    efforts: SHORT_EFFORTS,
  },
  {
    target: "claude-codex-open",
    label: "claude-codex (Open Models)",
    kind: "agent",
    cli: "claude-codex",
    agentKind: "claude-codex",
    models: NO_CHOICES,
    efforts: CLAUDE_EFFORTS,
  },
  {
    target: "agy",
    label: "Antigravity (agy)",
    kind: "agent",
    cli: "agy",
    models: AGY_MODELS,
    efforts: SHORT_EFFORTS,
  },
  // Hermes picks its provider and model with `hermes model`, so mycmux passes
  // no model / effort flags and the entry carries no `cli` translation arm.
  {
    target: "hermes",
    label: "Hermes",
    kind: "agent",
    models: NO_CHOICES,
    efforts: NO_EFFORTS,
  },
  // Web rows open a child webview, not a PTY, so they carry no launch flags.
  // They stay in the catalog because the contract test walks this list against
  // both launchers, and dropping them would let the two menus drift again.
  { target: "web-chatgpt", label: "ChatGPT (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
  { target: "web-gemini", label: "Gemini (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
  { target: "web-grok", label: "Grok (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
  { target: "web-claude", label: "Claude.ai (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
  { target: "web-notebooklm", label: "NotebookLM (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
  { target: "web-browser", label: "Browser (Web)", kind: "web", models: NO_CHOICES, efforts: NO_EFFORTS },
];

/** Entries a workspace pane can be opened with (web rows need a webview). */
export const LAUNCHABLE_AGENTS: readonly AgentCatalogEntry[] = AGENT_CATALOG.filter(
  (entry) => entry.kind === "agent",
);

export function getCatalogEntry(target: string | undefined): AgentCatalogEntry | undefined {
  if (!target) return undefined;
  return AGENT_CATALOG.find((entry) => entry.target === target);
}

/** Leave the choice to the launcher's own menu — what a pane does today. */
export const LAUNCHER_MENU_TARGET = "";
/** Skip the launcher and start the plain system shell. */
export const SHELL_TARGET = "shell";

/**
 * A pane's launch choice. An empty `target` means the pane opens the launcher
 * menu, which is what every pane does today when nothing is picked.
 */
export interface PaneLaunchSpec {
  target?: string;
  model?: string;
  effort?: string;
}

/**
 * Model and effort reach the CLI as command-line flags, so a value is only
 * accepted when it cannot be mistaken for one. The leading character is forced
 * to be alphanumeric: `--model -x` would otherwise hand the CLI a second flag,
 * and the POSIX launcher builds its command as a string before `eval`.
 * Mirrors `sanitized_model` in src-tauri/src/ai/mod.rs.
 */
const LAUNCH_SPEC_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidLaunchSpecValue(value: string | undefined | null): boolean {
  return typeof value === "string" && LAUNCH_SPEC_VALUE.test(value);
}

/** Returns the value when it is safe to pass through, otherwise undefined. */
export function sanitizeLaunchSpecValue(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return isValidLaunchSpecValue(trimmed) ? trimmed : undefined;
}

/**
 * Builds the launch env for a pane, or undefined when the pane should just show
 * the launcher menu. Model and effort ride along only with a target: on their
 * own they would be read by nothing, since `requiresLauncherDispatch` keys off
 * MYCMUX_LAUNCH_TARGET.
 */
export function buildLaunchSpecEnv(
  spec: PaneLaunchSpec | undefined,
): Record<string, string> | undefined {
  const target = spec?.target?.trim();
  if (!target) return undefined;
  const entry = getCatalogEntry(target);
  if (!entry || entry.kind !== "agent") return undefined;

  const env: Record<string, string> = { MYCMUX_LAUNCH_TARGET: target };
  const model = sanitizeLaunchSpecValue(spec?.model);
  if (model) env.MYCMUX_LAUNCH_MODEL = model;
  const effort = sanitizeLaunchSpecValue(spec?.effort);
  if (effort) env.MYCMUX_LAUNCH_EFFORT = effort;
  return env;
}
