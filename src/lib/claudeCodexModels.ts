/**
 * claude-codex's model chips come from its own install, not from this bundle.
 *
 * `claude_codex_model_choices` (src-tauri/src/commands/claude_codex_models.rs)
 * reads `~/.claude-codex/config/models.json` on every call, so a model added
 * or removed on the claude-codex side reaches the chips the next time a panel
 * opens — the bundled list went stale the day OpenRouter delisted Union Alpha.
 * When the table cannot be read (claude-codex not installed, as on both Macs
 * in 2026-09) the catalog's own list stays in place.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AgentCatalogEntry, ModelChoice } from "./agentCatalog";

/** The chips the table names, or an empty list when it cannot be read. */
export async function loadClaudeCodexModels(): Promise<readonly ModelChoice[]> {
  try {
    const choices = await invoke<ModelChoice[]>("claude_codex_model_choices");
    return Array.isArray(choices) ? choices : [];
  } catch {
    return [];
  }
}

/** One stable empty list, so a caller's effect deps do not change every render. */
const NO_MODELS: readonly ModelChoice[] = [];

function readsInstalledModels(entry: AgentCatalogEntry | undefined): boolean {
  return entry?.cli === "claude-codex";
}

/**
 * The model choices a panel should offer for `entry`: the installed table for
 * claude-codex (re-read whenever the entry changes or the panel mounts), and
 * the catalog's list for everything else or when the table is unavailable.
 */
export function useLaunchModels(entry: AgentCatalogEntry | undefined): readonly ModelChoice[] {
  const [installed, setInstalled] = useState<{ target: string; choices: readonly ModelChoice[] } | null>(null);
  const target = entry?.target;
  const dynamic = readsInstalledModels(entry);

  useEffect(() => {
    if (!dynamic || !target) return;
    let alive = true;
    void loadClaudeCodexModels().then((choices) => {
      if (alive) setInstalled({ target, choices });
    });
    return () => {
      alive = false;
    };
  }, [dynamic, target]);

  if (!entry) return NO_MODELS;
  if (dynamic && installed?.target === entry.target && installed.choices.length > 0) {
    return installed.choices;
  }
  return entry.models;
}
