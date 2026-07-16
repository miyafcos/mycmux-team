import type { BuddyDomEvents } from "../adapters/dom-events";
import type { HostBridge } from "../adapters/host-bridge";

export interface BuddyConfig {
  persona: {
    stylePreset: "kurisu-work" | "neutral" | "custom";
    systemPrompt: string;
    steinsQuotes: {
      enabled: boolean;
      chance: number;
      minGapMinutes: number;
    };
  };
  cadence: {
    cooldownMinutes: number;
    debounceSeconds: number;
    fastLaneDebounceSeconds: number;
    intervalMinutes: number;
    idleDecaySeconds: number;
    dialogueHistoryLimit: number;
  };
  keystroke: {
    enabled: boolean;
    minCharsForLLM: number;
    sleepyAfterMinutes: number;
    triggersEvaluation: boolean;
  };
  reactions: {
    enabled: boolean;
    intensity: "full" | "calm" | "minimal";
    minIntervalSeconds: number;
    allowStrong: boolean;
    idleSelfActions: boolean;
    glitchEasterEgg: boolean;
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
  skin: {
    mode: "svg" | "codex-pet" | "live2d";
    petName?: string;
    modelUrl?: string;
  };
}

export const DEFAULT_LIVE2D_MODEL_URL = "/models/hiyori/Hiyori.model3.json";

const defaults: BuddyConfig = {
  persona: {
    stylePreset: "kurisu-work",
    systemPrompt: "",
    steinsQuotes: {
      enabled: true,
      chance: 0.15,
      minGapMinutes: 60,
    },
  },
  cadence: {
    cooldownMinutes: 3,
    debounceSeconds: 8,
    fastLaneDebounceSeconds: 2,
    intervalMinutes: 7,
    idleDecaySeconds: 60,
    dialogueHistoryLimit: 6,
  },
  keystroke: {
    enabled: true,
    minCharsForLLM: 12,
    sleepyAfterMinutes: 5,
    triggersEvaluation: false,
  },
  reactions: {
    enabled: true,
    intensity: "calm",
    minIntervalSeconds: 8,
    allowStrong: true,
    idleSelfActions: true,
    glitchEasterEgg: false,
  },
  output: {
    maxTextChars: 620,
  },
  profile: {
    maxChars: 1200,
  },
  avatar: {
    inkColor: "var(--buddy-ink, #2c2218)",
    blushColor: "var(--buddy-blush, #ff9aa8)",
    sparkColor: "var(--buddy-spark, #ffd45e)",
    sweatColor: "var(--buddy-sweat, #7bc1ff)",
  },
  skin: {
    mode: "svg",
  },
};

let current: BuddyConfig = clone(defaults);
let loaded = false;

export async function loadBuddyConfig(host: HostBridge, events: BuddyDomEvents): Promise<void> {
  try {
    const raw = await host.invoke<string>("load_buddy_settings");
    if (!raw || !raw.trim()) {
      current = clone(defaults);
      loaded = true;
      notifyUpdated(events);
      return;
    }
    const parsed = JSON.parse(raw) as Partial<BuddyConfig>;
    current = merge(defaults, parsed);
    loaded = true;
    notifyUpdated(events);
  } catch (error) {
    console.warn("[buddy] failed to load settings, using defaults:", error);
    current = clone(defaults);
    loaded = true;
    notifyUpdated(events);
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
    if (override.persona.steinsQuotes) {
      out.persona.steinsQuotes = { ...base.persona.steinsQuotes, ...override.persona.steinsQuotes };
    }
  }
  if (override.cadence) {
    out.cadence = { ...out.cadence, ...override.cadence };
  }
  if (override.keystroke) {
    out.keystroke = { ...out.keystroke, ...override.keystroke };
  }
  if (override.reactions) {
    out.reactions = { ...out.reactions, ...override.reactions };
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
  if (override.skin) {
    out.skin = { ...out.skin, ...override.skin };
    if (out.skin.mode !== "codex-pet" && out.skin.mode !== "live2d") {
      out.skin.mode = "svg";
    }
    if (out.skin.mode !== "codex-pet") {
      delete out.skin.petName;
    }
    if (out.skin.mode === "live2d") {
      const modelUrl = typeof out.skin.modelUrl === "string" ? out.skin.modelUrl.trim() : "";
      out.skin.modelUrl = modelUrl || DEFAULT_LIVE2D_MODEL_URL;
    } else {
      delete out.skin.modelUrl;
    }
  }
  return out;
}

export type ReactionsConfig = BuddyConfig["reactions"];

function notifyUpdated(events: BuddyDomEvents): void {
  events.dispatchBuddyConfigUpdated();
}
