import type { PetLayout } from "../../sprite-skin";
import type { BuddyMood } from "../types";
import type { ReactionKind } from "./reaction-types";

export interface ExpressionPool {
  subtle: string[];
  mid: string[];
  strong: string[];
}

export const POOL_BY_KIND: Record<ReactionKind, string[]> = {
  notice: ["glance", "neutral_blink", "look_up"],
  watch: ["neutral", "soft_smile", "glance"],
  focus: ["thinking", "analyzing", "thinking_blink"],
  impressed: ["soft_smile", "smile", "proud", "wink"],
  exasperated: ["exasperated", "sharp", "pout"],
  concerned: ["worried", "thinking_hard", "look_up"],
  alarmed: ["surprised_strong", "sharp"],
  drowsy: ["sleepy", "yawn"],
};

export const REACTION_MOOD: Record<ReactionKind, BuddyMood> = {
  notice: "idle",
  watch: "idle",
  focus: "thinking",
  impressed: "applaud",
  exasperated: "tsukkomi",
  concerned: "thinking",
  alarmed: "tsukkomi",
  drowsy: "idle",
};

export function resolveReaction(
  layout: PetLayout | null,
  kind: ReactionKind,
  lastExpression: string | null,
): { kind: "expression"; name: string } | { kind: "mood"; mood: BuddyMood } {
  if (!layout) {
    return { kind: "mood", mood: REACTION_MOOD[kind] };
  }

  const pool = POOL_BY_KIND[kind];
  const candidates = pool.filter((name) => hasExpression(layout, name));
  const available =
    candidates.length > 1 && lastExpression
      ? candidates.filter((name) => name !== lastExpression)
      : candidates;
  const picked = randomChoice(available.length > 0 ? available : candidates);

  if (picked) {
    return { kind: "expression", name: picked };
  }

  if (hasExpression(layout, "neutral")) {
    return { kind: "expression", name: "neutral" };
  }

  const first = Object.keys(layout.expressions).find((name) => hasExpression(layout, name));
  return { kind: "expression", name: first ?? "neutral" };
}

function hasExpression(layout: PetLayout, name: string): boolean {
  const [index] = layout.expressions[name] ?? [];
  return typeof index === "number" && Number.isFinite(index);
}

function randomChoice<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}
