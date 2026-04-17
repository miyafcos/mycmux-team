import { invoke } from "@tauri-apps/api/core";

export interface BuddyConfig {
  persona: {
    systemPrompt: string;
  };
  cadence: {
    cooldownMinutes: number;
    debounceSeconds: number;
    idleDecaySeconds: number;
    dialogueHistoryLimit: number;
  };
  keystroke: {
    enabled: boolean;
    minCharsForLLM: number;
    sleepyAfterMinutes: number;
  };
  output: {
    maxTextChars: number;
  };
  profile: {
    maxChars: number;
  };
  avatar: {
    inkColor: string;
    blushColor: string;
    sparkColor: string;
    sweatColor: string;
  };
}

const defaults: BuddyConfig = {
  persona: {
    systemPrompt: "",
  },
  cadence: {
    cooldownMinutes: 2,
    debounceSeconds: 3,
    idleDecaySeconds: 20,
    dialogueHistoryLimit: 8,
  },
  keystroke: {
    enabled: true,
    minCharsForLLM: 12,
    sleepyAfterMinutes: 5,
  },
  output: {
    maxTextChars: 500,
  },
  profile: {
    maxChars: 1200,
  },
  avatar: {
    inkColor: "#2c2218",
    blushColor: "#ff9aa8",
    sparkColor: "#ffd45e",
    sweatColor: "#7bc1ff",
  },
};

let current: BuddyConfig = clone(defaults);
let loaded = false;

export async function loadBuddyConfig(): Promise<void> {
  try {
    const raw = await invoke<string>("load_buddy_settings");
    if (!raw || !raw.trim()) {
      current = clone(defaults);
      loaded = true;
      return;
    }
    const parsed = JSON.parse(raw) as Partial<BuddyConfig>;
    current = merge(defaults, parsed);
    loaded = true;
  } catch (error) {
    console.warn("[buddy] failed to load settings, using defaults:", error);
    current = clone(defaults);
    loaded = true;
  }
}

export function getBuddyConfig(): BuddyConfig {
  if (!loaded) {
    return current;
  }
  return current;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function merge(base: BuddyConfig, override: Partial<BuddyConfig>): BuddyConfig {
  const out = clone(base);
  if (override.persona) {
    out.persona = { ...out.persona, ...override.persona };
  }
  if (override.cadence) {
    out.cadence = { ...out.cadence, ...override.cadence };
  }
  if (override.keystroke) {
    out.keystroke = { ...out.keystroke, ...override.keystroke };
  }
  if (override.output) {
    out.output = { ...out.output, ...override.output };
  }
  if (override.profile) {
    out.profile = { ...out.profile, ...override.profile };
  }
  if (override.avatar) {
    out.avatar = { ...out.avatar, ...override.avatar };
  }
  return out;
}
