/**
 * Launcher chips track the installed provider catalogs. The desktop command
 * returns an empty list for an absent or unreadable catalog.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { AgentCatalogEntry, ModelChoice } from "./agentCatalog";

type ModelChoicesCommand = "claude_codex_model_choices" | "codex_model_choices";

async function loadModelChoices(command: ModelChoicesCommand): Promise<readonly ModelChoice[]> {
  try {
    const choices = await invoke<ModelChoice[]>(command);
    return Array.isArray(choices) ? choices : [];
  } catch {
    return [];
  }
}

/** The chips claude-codex publishes from its installed models.json. */
export function loadClaudeCodexModels(): Promise<readonly ModelChoice[]> {
  return loadModelChoices("claude_codex_model_choices");
}

const NO_MODELS: readonly ModelChoice[] = [];

function installedModelCommand(entry: AgentCatalogEntry | undefined): ModelChoicesCommand | undefined {
  if (entry?.cli === "codex") return "codex_model_choices";
  if (entry?.cli === "claude-codex") return "claude_codex_model_choices";
  return undefined;
}

/** Re-read the installed list when its picker opens, with the fixed list as fallback. */
export function useLaunchModels(entry: AgentCatalogEntry | undefined, opening = 0): readonly ModelChoice[] {
  const target = entry?.target;
  const command = installedModelCommand(entry);
  const request = useMemo(() => ({ target, command, opening }), [target, command, opening]);
  const [installed, setInstalled] = useState<Partial<Record<ModelChoicesCommand, {
    request: typeof request;
    choices: readonly ModelChoice[];
  }>>>({});

  useEffect(() => {
    const { command, target } = request;
    if (!command || !target) return;
    let alive = true;
    const load = command === "claude_codex_model_choices"
      ? loadClaudeCodexModels()
      : loadModelChoices(command);
    void load.then((choices) => {
      if (alive) setInstalled((current) => ({ ...current, [command]: { request, choices } }));
    });
    return () => {
      alive = false;
    };
  }, [request]);

  if (!entry) return NO_MODELS;
  const result = command ? installed[command] : undefined;
  // claude-codex keeps its previous list for the same target during a re-read.
  if (result?.choices.length && (command === "claude_codex_model_choices"
    ? result.request.target === target
    : result.request === request)) {
    return result.choices;
  }
  return entry.models;
}
