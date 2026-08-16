import { invoke } from "@tauri-apps/api/core";

export interface AutonomySettings {
  autoAdvance: boolean;
  attentionCards: boolean;
}

export interface AutonomySettingsInput {
  autoAdvance?: boolean;
  attentionCards?: boolean;
}

export function autonomyGetSettings(): Promise<AutonomySettings> {
  return invoke<AutonomySettings>("autonomy_get_settings");
}

export function autonomySetSettings(input: AutonomySettingsInput): Promise<AutonomySettings> {
  return invoke<AutonomySettings>("autonomy_set_settings", { input });
}
