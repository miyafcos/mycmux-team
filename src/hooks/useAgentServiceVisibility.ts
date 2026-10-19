import { useCallback } from "react";
import { isAgentServiceVisible } from "../lib/agentServiceVisibility";
import { useSettingsStore } from "../stores/settingsStore";
import { useAgentServiceDetectionStore } from "../stores/agentServiceDetectionStore";

const EMPTY_VISIBILITY: Record<string, boolean> = {};

export function useAgentServiceVisibility(): (target: string) => boolean {
  const saved = useSettingsStore((state) => state.agentServiceVisibility) ?? EMPTY_VISIBILITY;
  const detection = useAgentServiceDetectionStore((state) => state.detection);
  return useCallback((target: string) => isAgentServiceVisible(target, saved, detection), [saved, detection]);
}
