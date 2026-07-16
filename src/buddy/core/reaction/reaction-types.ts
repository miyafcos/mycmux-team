export type ReactionKind =
  | "notice"
  | "watch"
  | "focus"
  | "impressed"
  | "exasperated"
  | "concerned"
  | "alarmed"
  | "drowsy";

export type ReactionStrength = "subtle" | "mid" | "strong";

export interface BuddyReaction {
  id: number;
  kind: ReactionKind;
  strength: ReactionStrength;
  durationMs: number;
  bodyKick?: boolean;
}

export interface ReactionCategoryMeta {
  kind: ReactionKind;
  strength: ReactionStrength;
  durationRange: [number, number];
  fadeIn: number;
  fadeOut: number;
  bodyKick: boolean;
}
