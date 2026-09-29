import type { PetSpriteState } from "../components/workspace/PetSprite";

export type PetTier = "calling" | "stuck" | "working" | "ready" | "resting";

export interface PetTierInput {
  tabType?: "terminal" | "web" | "browser" | "online";
  observed: boolean;
  agentStatus?: "working" | "waiting" | "done" | "idle";
  attentionKind?: "none" | "input" | "approval" | "rate_limited" | "error" | "done";
  attentionUnseen: boolean;
  attentionStateSince?: number;
  activity?: "streaming" | "running_silent" | "idle" | "unknown";
  backendLastOutputAt?: number;
  outputActive?: boolean;
  workingPatternVisible?: boolean;
  stallReason?: "no_output" | "queued_input" | "silent" | "pty_dead";
  now: number;
}

export const PET_OUTPUT_ACTIVE_WINDOW_MS = 15_000;
export const PET_DEMOTE_HOLD_MS = 3_000;

export function classifyPetTier(input: PetTierInput): PetTier {
  if (input.tabType === "web" || input.tabType === "browser" || input.tabType === "online") return "resting";
  if (input.observed && input.agentStatus === "waiting") return "calling";
  if (!input.observed && (input.attentionKind === "input" || input.attentionKind === "approval")) return "calling";
  if (input.attentionKind === "rate_limited" || input.attentionKind === "error") return "stuck";
  if (input.stallReason === "queued_input") return "calling";
  if (input.observed && input.workingPatternVisible) return "working";
  // Idle prompt redraws still produce PTY output; completion outranks output activity.
  if (input.attentionKind === "done") return input.attentionUnseen ? "ready" : "resting";
  if ((input.attentionKind === "none" || input.attentionKind === undefined)
    && input.attentionStateSince !== undefined
    && input.now - input.attentionStateSince <= PET_OUTPUT_ACTIVE_WINDOW_MS
    && input.activity !== "idle") return "working";
  if (input.stallReason === "no_output" || input.stallReason === "silent" || input.stallReason === "pty_dead") return "resting";
  if (input.outputActive || (input.backendLastOutputAt !== undefined
    && input.now - input.backendLastOutputAt <= PET_OUTPUT_ACTIVE_WINDOW_MS)) return "working";
  if (input.activity === "running_silent") return "working";
  return "resting";
}

const PET_PRIORITY: readonly PetTier[] = ["calling", "stuck", "working", "ready", "resting"];

export function aggregatePetTier(tiers: readonly PetTier[]): PetTier {
  return PET_PRIORITY.find((tier) => tiers.includes(tier)) ?? "resting";
}

export function petSpriteStateFor(tier: PetTier): PetSpriteState {
  return tier;
}
