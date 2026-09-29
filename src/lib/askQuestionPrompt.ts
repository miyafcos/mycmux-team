import { invoke } from "@tauri-apps/api/core";

import type { AskScreen } from "./askQuestionScan";

const HOOK_ATTENTION_PREFIX = "agent-hook:";

export function hookLaunchId(attentionId: string): string | undefined {
  if (!attentionId.startsWith(HOOK_ATTENTION_PREFIX)) return undefined;
  const separator = attentionId.indexOf(":", HOOK_ATTENTION_PREFIX.length);
  if (separator < 0) return undefined;
  const launchId = attentionId.slice(HOOK_ATTENTION_PREFIX.length, separator);
  return launchId || undefined;
}

export function askPromptId(
  sessionId: string,
  attentionId: string,
  screen: AskScreen,
): string {
  const activeTab = screen.tabs.find((tab) => tab.active)?.label ?? "";
  return JSON.stringify([
    sessionId,
    attentionId,
    screen.kind,
    activeTab,
    screen.question,
  ]);
}

export function tryAnswerPrompt(ptySessionId: string, promptId: string): Promise<boolean> {
  return invoke<boolean>("agent_prompt_try_answer", { ptySessionId, promptId });
}

export function isCurrentPromptLaunch(
  ptySessionId: string,
  launchId: string,
): Promise<boolean> {
  return invoke<boolean>("agent_prompt_is_current_launch", { ptySessionId, launchId });
}
