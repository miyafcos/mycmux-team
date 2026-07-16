import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { BrowserDomEvents } from "./adapters/dom-events";
import { DEFAULT_LIVE2D_MODEL_URL, getBuddyConfig } from "./core/config";
import { REACTION_MOOD, resolveReaction } from "./core/reaction/reaction-expressions";
import type { BuddyMood, BuddyReaction } from "./core/types";
import { Live2DAvatar } from "./Live2DAvatar";
import { appendBuddyLog, loadPetLayout, loadPetSpritesheet, type PetLayout } from "./sprite-skin";

interface BuddyAvatarProps {
  mood: BuddyMood;
  reaction?: BuddyReaction | null;
  size: number;
  action?: CodexPetAction | null;
  speaking?: boolean;
}

interface AvatarColors {
  ink: string;
  blush: string;
  spark: string;
  sweat: string;
}

const leftEyeX = 37;
const rightEyeX = 63;
const eyeY = 48;
const PET_COLUMNS = 8;
const PET_ROWS = 9;
const PET_CELL_WIDTH = 192;
const PET_CELL_HEIGHT = 208;
const buddyDomEvents = new BrowserDomEvents();

export type CodexPetAction =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export function BuddyAvatar({ mood, reaction = null, size, action = null, speaking = false }: BuddyAvatarProps) {
  const [, setConfigVersion] = useState(0);

  useEffect(() => {
    const handleConfigUpdate = (): void => setConfigVersion((version) => version + 1);
    return buddyDomEvents.subscribeBuddyConfigUpdated(handleConfigUpdate);
  }, []);

  const skin = getBuddyConfig().skin;
  if (skin.mode === "codex-pet" && skin.petName) {
    return (
      <CodexPetSprite
        mood={mood}
        reaction={reaction}
        action={action}
        petName={skin.petName}
        size={size}
        speaking={speaking}
      />
    );
  }
  if (skin.mode === "live2d") {
    return (
      <Live2DAvatar
        mood={mood}
        reaction={reaction}
        modelUrl={skin.modelUrl ?? DEFAULT_LIVE2D_MODEL_URL}
        size={size}
        speaking={speaking}
        fallback={<BuddyFallbackAvatar mood={mood} reaction={reaction} size={size} />}
      />
    );
  }

  const effectiveMood = reaction ? REACTION_MOOD[reaction.kind] : mood;

  const avatarCfg = getBuddyConfig().avatar;
  const colors: AvatarColors = {
    ink: avatarCfg.inkColor,
    blush: avatarCfg.blushColor,
    spark: avatarCfg.sparkColor,
    sweat: avatarCfg.sweatColor,
  };
  return (
    <motion.svg
      className="buddy__avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      animate={bodyAnimationByMood[effectiveMood]}
      transition={bodyTransitionByMood[effectiveMood]}
      style={{ display: "block" }}
    >
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`eyes-${effectiveMood}`}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={crossfade}
        >
          <Eyes mood={effectiveMood} colors={colors} />
        </motion.g>
      </AnimatePresence>
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`mouth-${effectiveMood}`}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={crossfade}
        >
          <Mouth mood={effectiveMood} colors={colors} />
        </motion.g>
      </AnimatePresence>
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`accessory-${effectiveMood}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={crossfade}
        >
          <Accessory mood={effectiveMood} colors={colors} />
        </motion.g>
      </AnimatePresence>
    </motion.svg>
  );
}

function CodexPetSprite({
  mood,
  reaction = null,
  action,
  petName,
  size,
  speaking = false,
}: BuddyAvatarProps & { petName: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [layout, setLayout] = useState<PetLayout | null | undefined>(undefined);
  const [frame, setFrame] = useState(0);
  const effectiveMood = reaction ? REACTION_MOOD[reaction.kind] : mood;
  const directedExpression = useExpressionDirector(mood, speaking, layout ?? null, reaction);
  const petAction = action ?? petActionByMood[effectiveMood];
  const frameCount = petFrameCountByAction[petAction];

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    setLayout(undefined);
    Promise.all([loadPetSpritesheet(petName), loadPetLayout(petName)])
      .then(([url, petLayout]) => {
        if (!cancelled) {
          setImageUrl(url);
          setLayout(petLayout);
        }
      })
      .catch((error) => {
        void appendBuddyLog({
          event: "pet-sprite-load-failed",
          petName,
          error: String(error),
        });
        if (!cancelled) {
          setImageUrl(null);
          setLayout(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [petName]);

  const frameCountRef = useRef(frameCount);
  frameCountRef.current = frameCount;

  useEffect(() => {
    if (layout !== null) {
      return;
    }
    const timerId = window.setInterval(() => {
      setFrame((prev) => (prev + 1) % frameCountRef.current);
    }, 180);
    return () => window.clearInterval(timerId);
  }, [layout]);

  if (!imageUrl || layout === undefined) {
    return <BuddyFallbackAvatar mood={mood} reaction={reaction} size={size} />;
  }

  if (layout) {
    return (
      <FacePetSprite
        expression={directedExpression}
        imageUrl={imageUrl}
        layout={layout}
        petName={petName}
        size={size}
        speaking={speaking}
      />
    );
  }

  const row = petRowByAction[petAction];
  const visibleFrame = frame % frameCount;
  const cellWidth = Math.round(size * (PET_CELL_WIDTH / PET_CELL_HEIGHT));
  const cellHeight = size;
  const backgroundWidth = cellWidth * PET_COLUMNS;
  const backgroundHeight = cellHeight * PET_ROWS;

  return (
    <div
      className="buddy__sprite"
      title={petName}
      style={{
        width: cellWidth,
        height: cellHeight,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: `${backgroundWidth}px ${backgroundHeight}px`,
        backgroundPosition: `-${visibleFrame * cellWidth}px -${row * cellHeight}px`,
      }}
    />
  );
}

/**
 * Renders one face-expression cell as a single, persistent element. Only the
 * background-position changes as the expression changes — no element is
 * mounted/unmounted per frame, so the sprite cannot tear or wobble. Registered
 * cells make a hard cut between expressions look clean (and is correct for
 * lip-sync / blink frames).
 */
function FaceLayer({
  expression,
  imageUrl,
  layout,
  cellWidth,
  cellHeight,
  backgroundWidth,
  backgroundHeight,
  variant,
}: {
  expression: string;
  imageUrl: string;
  layout: PetLayout;
  cellWidth: number;
  cellHeight: number;
  backgroundWidth: number;
  backgroundHeight: number;
  variant: "fadein" | "fadeout" | "static";
}) {
  const expressionIndex = getExpressionIndex(layout, expression);
  const column = expressionIndex % layout.columns;
  const row = Math.floor(expressionIndex / layout.columns);
  const animation =
    variant === "fadein"
      ? "face-fadein 120ms ease-out both"
      : variant === "fadeout"
        ? "face-fadeout 120ms ease-out forwards"
        : "none";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: `${backgroundWidth}px ${backgroundHeight}px`,
        backgroundPosition: `-${column * cellWidth}px -${row * cellHeight}px`,
        backgroundRepeat: "no-repeat",
        animation,
      }}
    />
  );
}

function FacePetSprite({
  expression,
  imageUrl,
  layout,
  petName,
  size,
  speaking,
}: {
  expression: string;
  imageUrl: string;
  layout: PetLayout;
  petName: string;
  size: number;
  speaking: boolean;
}) {
  const cellWidth = Math.round(size * (layout.cell.w / layout.cell.h));
  const cellHeight = size;
  const backgroundWidth = cellWidth * layout.columns;
  const backgroundHeight = cellHeight * layout.rows;

  const lastExpressionRef = useRef(expression);
  const [trail, setTrail] = useState<string | null>(null);

  useEffect(() => {
    const prev = lastExpressionRef.current;
    if (prev === expression) return;
    lastExpressionRef.current = expression;
    if (speaking) {
      setTrail(null);
      return;
    }
    setTrail(prev);
    const timer = window.setTimeout(() => setTrail(null), 140);
    return () => window.clearTimeout(timer);
  }, [expression, speaking]);

  return (
    <div
      className="buddy__sprite buddy__sprite--face"
      title={`${petName}: ${expression}`}
      style={{
        position: "relative",
        width: cellWidth,
        height: cellHeight,
        transformOrigin: "center 80%",
        animation: "amadeus-life 5.6s ease-in-out infinite",
        willChange: "transform",
      }}
    >
      {trail && (
        <FaceLayer
          key={`trail-${trail}`}
          expression={trail}
          imageUrl={imageUrl}
          layout={layout}
          cellWidth={cellWidth}
          cellHeight={cellHeight}
          backgroundWidth={backgroundWidth}
          backgroundHeight={backgroundHeight}
          variant="fadeout"
        />
      )}
      <FaceLayer
        key={`current-${expression}`}
        expression={expression}
        imageUrl={imageUrl}
        layout={layout}
        cellWidth={cellWidth}
        cellHeight={cellHeight}
        backgroundWidth={backgroundWidth}
        backgroundHeight={backgroundHeight}
        variant={speaking ? "static" : "fadein"}
      />
    </div>
  );
}

function BuddyFallbackAvatar({ mood, reaction = null, size }: BuddyAvatarProps) {
  const effectiveMood = reaction ? REACTION_MOOD[reaction.kind] : mood;
  const avatarCfg = getBuddyConfig().avatar;
  const colors: AvatarColors = {
    ink: avatarCfg.inkColor,
    blush: avatarCfg.blushColor,
    spark: avatarCfg.sparkColor,
    sweat: avatarCfg.sweatColor,
  };

  return (
    <motion.svg
      className="buddy__avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      animate={bodyAnimationByMood[effectiveMood]}
      transition={bodyTransitionByMood[effectiveMood]}
      style={{ display: "block" }}
    >
      <Eyes mood={effectiveMood} colors={colors} />
      <Mouth mood={effectiveMood} colors={colors} />
      <Accessory mood={effectiveMood} colors={colors} />
    </motion.svg>
  );
}

const DEFAULT_EXPRESSION = "neutral";

/**
 * Drives which face-expression cell is shown: the mood expression with slow
 * idle drift, periodic blinks, and speech-synced mouth shapes. Returns the
 * current expression name (a single string — the renderer just swaps the
 * sprite's background-position to it).
 */
function useExpressionDirector(
  mood: BuddyMood,
  speaking: boolean,
  layout: PetLayout | null,
  reaction: BuddyReaction | null,
): string {
  const [expression, setExpression] = useState<string>(DEFAULT_EXPRESSION);
  const baseExpressionRef = useRef(DEFAULT_EXPRESSION);
  const lastExprRef = useRef<string | null>(DEFAULT_EXPRESSION);
  const reactionActiveRef = useRef(false);
  const commitExpressionRef = useRef((name: string, _mode?: "cut" | "fade"): void => {
    lastExprRef.current = name;
    setExpression(name);
  });

  commitExpressionRef.current = (name: string, _mode?: "cut" | "fade"): void => {
    lastExprRef.current = name;
    setExpression((current) => (current === name ? current : name));
  };

  useEffect(() => {
    if (!layout || speaking) {
      return;
    }

    let driftTimer: number | null = null;
    let chainTimer: number | null = null;

    const chooseBaseExpression = (): void => {
      const prev = baseExpressionRef.current;
      const nextExpression = pickMoodExpression(layout, mood);
      baseExpressionRef.current = nextExpression;
      if (reactionActiveRef.current) return;

      if (chainTimer !== null) {
        window.clearTimeout(chainTimer);
        chainTimer = null;
      }

      const mid = layout.transitions?.[`${prev}->${nextExpression}`];
      if (mid && prev !== nextExpression && hasExpression(layout, mid)) {
        commitExpressionRef.current(mid, "fade");
        chainTimer = window.setTimeout(() => {
          chainTimer = null;
          if (!reactionActiveRef.current) {
            commitExpressionRef.current(nextExpression, "fade");
          }
        }, 130);
      } else {
        commitExpressionRef.current(nextExpression);
      }
    };

    const scheduleDrift = (): void => {
      driftTimer = window.setTimeout(() => {
        chooseBaseExpression();
        scheduleDrift();
      }, randomBetween(3500, 7000));
    };

    chooseBaseExpression();
    scheduleDrift();

    return () => {
      if (driftTimer !== null) {
        window.clearTimeout(driftTimer);
      }
      if (chainTimer !== null) {
        window.clearTimeout(chainTimer);
      }
    };
  }, [layout, mood, speaking]);

  useEffect(() => {
    if (!layout || speaking) return;

    const lookaway = layout.ambient?.lookaway;
    if (!lookaway) return;
    const cells = Array.isArray(lookaway) ? lookaway : [lookaway];
    const usable = cells.filter((name) => hasExpression(layout, name));
    if (usable.length === 0) return;

    let lookawayTimer: number | null = null;
    let restoreTimer: number | null = null;
    let lastChoice: string | null = null;

    const scheduleLookaway = (): void => {
      lookawayTimer = window.setTimeout(() => {
        if (reactionActiveRef.current) {
          scheduleLookaway();
          return;
        }
        const pool = usable.length > 1 ? usable.filter((n) => n !== lastChoice) : usable;
        const name = pool[Math.floor(Math.random() * pool.length)];
        lastChoice = name;
        commitExpressionRef.current(name, "fade");
        restoreTimer = window.setTimeout(() => {
          if (!reactionActiveRef.current) {
            commitExpressionRef.current(baseExpressionRef.current, "fade");
          }
          scheduleLookaway();
        }, randomBetween(800, 1300));
      }, randomBetween(4500, 9500));
    };

    scheduleLookaway();

    return () => {
      if (lookawayTimer !== null) window.clearTimeout(lookawayTimer);
      if (restoreTimer !== null) window.clearTimeout(restoreTimer);
    };
  }, [layout, speaking]);

  useEffect(() => {
    if (speaking) {
      return;
    }

    let reactionTimer: number | null = null;
    if (!reaction) {
      reactionActiveRef.current = false;
      return;
    }

    const resolved = resolveReaction(layout, reaction.kind, lastExprRef.current);
    if (resolved.kind === "expression") {
      reactionActiveRef.current = true;
      commitExpressionRef.current(resolved.name, "fade");
    }

    reactionTimer = window.setTimeout(() => {
      reactionActiveRef.current = false;
    }, reaction.durationMs);

    return () => {
      if (reactionTimer !== null) {
        window.clearTimeout(reactionTimer);
      }
    };
  }, [reaction?.id, speaking, layout]);

  useEffect(() => {
    if (!layout || !speaking) {
      return;
    }

    let talkTimer: number | null = null;

    const updateMouth = (): void => {
      commitExpressionRef.current(pickTalkingExpression(layout, mood));
      talkTimer = window.setTimeout(updateMouth, randomBetween(90, 150));
    };

    updateMouth();

    return () => {
      if (talkTimer !== null) {
        window.clearTimeout(talkTimer);
      }
    };
  }, [layout, speaking, mood]);

  useEffect(() => {
    if (!layout || speaking) {
      return;
    }

    let blinkTimer: number | null = null;
    let restoreTimer: number | null = null;

    const scheduleBlink = (): void => {
      blinkTimer = window.setTimeout(() => {
        runBlink(Math.random() < 0.16);
      }, randomBetween(2500, 6000));
    };

    const runBlink = (allowSecondBlink: boolean): void => {
      const blinkExpression = `${baseExpressionRef.current}_blink`;
      if (!hasExpression(layout, blinkExpression)) {
        scheduleBlink();
        return;
      }

      if (reactionActiveRef.current) return;
      commitExpressionRef.current(blinkExpression);
      restoreTimer = window.setTimeout(() => {
        if (reactionActiveRef.current) {
          scheduleBlink();
          return;
        }
        commitExpressionRef.current(baseExpressionRef.current);
        if (allowSecondBlink) {
          blinkTimer = window.setTimeout(() => runBlink(false), randomBetween(170, 260));
          return;
        }
        scheduleBlink();
      }, 110);
    };

    scheduleBlink();

    return () => {
      if (blinkTimer !== null) {
        window.clearTimeout(blinkTimer);
      }
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer);
      }
    };
  }, [layout, speaking]);

  return expression;
}

function pickMoodExpression(layout: PetLayout, mood: BuddyMood): string {
  const moodExpressions = layout.moods[mood] ?? layout.moods.idle ?? [DEFAULT_EXPRESSION];
  return pickExpressionName(layout, moodExpressions) ?? pickFirstExpression(layout);
}

function pickTalkingExpression(layout: PetLayout, mood: BuddyMood): string {
  const talking = layout.talking;
  const moodSet =
    mood === "applaud"
      ? talking.smile_labels
      : mood === "tsukkomi"
        ? talking.sharp_labels
        : mood === "thinking"
          ? talking.thinking_labels
          : undefined;
  const set = (moodSet ?? talking.labels ?? []).filter((name) => hasExpression(layout, name));
  if (set.length === 0) {
    return pickFirstExpression(layout);
  }
  // Bias toward the medium-open mouth shape (index 2 in a [rest, s, m, l] set).
  if (set.length >= 3 && Math.random() < 0.46) {
    return set[2];
  }
  return randomChoice(set) ?? pickFirstExpression(layout);
}

function pickExpressionName(layout: PetLayout, names: string[]): string | null {
  return randomChoice(names.filter((name) => hasExpression(layout, name)));
}

function pickFirstExpression(layout: PetLayout): string {
  if (hasExpression(layout, DEFAULT_EXPRESSION)) {
    return DEFAULT_EXPRESSION;
  }
  return Object.keys(layout.expressions).find((name) => hasExpression(layout, name)) ?? DEFAULT_EXPRESSION;
}

function hasExpression(layout: PetLayout, name: string): boolean {
  const [index] = layout.expressions[name] ?? [];
  return typeof index === "number" && Number.isFinite(index);
}

function getExpressionIndex(layout: PetLayout, name: string): number {
  const [index] = layout.expressions[name] ?? [];
  if (typeof index === "number" && Number.isFinite(index)) {
    return clampExpressionIndex(layout, index);
  }

  const [fallbackIndex] =
    layout.expressions[DEFAULT_EXPRESSION] ??
    Object.values(layout.expressions).find((indices) => typeof indices[0] === "number") ??
    [0];
  return clampExpressionIndex(layout, fallbackIndex);
}

function clampExpressionIndex(layout: PetLayout, index: number): number {
  const availableCells = Math.max(1, Math.min(layout.count, layout.columns * layout.rows));
  return Math.max(0, Math.min(availableCells - 1, Math.floor(index)));
}

function randomChoice<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const petActionByMood: Record<BuddyMood, CodexPetAction> = {
  idle: "idle",
  thinking: "review",
  tsukkomi: "failed",
  applaud: "waving",
};

const petRowByAction: Record<CodexPetAction, number> = {
  idle: 0,
  "running-right": 1,
  "running-left": 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
};

const petFrameCountByAction: Record<CodexPetAction, number> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

function Eyes({ mood, colors }: { mood: BuddyMood; colors: AvatarColors }) {
  const ink = colors.ink;
  if (mood === "applaud") {
    return (
      <g stroke={ink} strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d={`M ${leftEyeX - 5} ${eyeY + 2} Q ${leftEyeX} ${eyeY - 5} ${leftEyeX + 5} ${eyeY + 2}`} />
        <path d={`M ${rightEyeX - 5} ${eyeY + 2} Q ${rightEyeX} ${eyeY - 5} ${rightEyeX + 5} ${eyeY + 2}`} />
      </g>
    );
  }

  if (mood === "tsukkomi") {
    return (
      <g>
        <path
          d={`M ${leftEyeX - 6} ${eyeY - 1} L ${leftEyeX + 6} ${eyeY + 2}`}
          stroke={ink}
          strokeWidth="2.8"
          strokeLinecap="round"
        />
        <ellipse cx={rightEyeX} cy={eyeY} rx="3" ry="3.8" fill={ink} />
      </g>
    );
  }

  if (mood === "thinking") {
    return (
      <g fill={ink}>
        <ellipse cx={leftEyeX} cy={eyeY} rx="2.2" ry="2.6" />
        <ellipse cx={rightEyeX} cy={eyeY} rx="2.2" ry="2.6" />
      </g>
    );
  }

  return (
    <g>
      <ellipse cx={leftEyeX} cy={eyeY} rx="3" ry="3.8" fill={ink} />
      <ellipse cx={rightEyeX} cy={eyeY} rx="3" ry="3.8" fill={ink} />
      <circle cx={leftEyeX + 1} cy={eyeY - 1.4} r="1" fill="#fff8ef" />
      <circle cx={rightEyeX + 1} cy={eyeY - 1.4} r="1" fill="#fff8ef" />
    </g>
  );
}

function Mouth({ mood, colors }: { mood: BuddyMood; colors: AvatarColors }) {
  const stroke = colors.ink;
  const strokeWidth = 2.3;

  if (mood === "applaud") {
    return (
      <g>
        <path
          d="M 39 63 Q 50 78 61 63 Z"
          stroke={stroke}
          strokeWidth={strokeWidth}
          fill={colors.ink}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M 41 64 L 59 64" stroke="#fff8ef" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    );
  }

  if (mood === "tsukkomi") {
    return (
      <path
        d="M 41 70 Q 50 62 59 70"
        stroke={stroke}
        strokeWidth={strokeWidth + 0.2}
        fill="none"
        strokeLinecap="round"
      />
    );
  }

  if (mood === "thinking") {
    return (
      <path
        d="M 43 67 Q 48 70 53 66 T 58 68"
        stroke={stroke}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
      />
    );
  }

  return (
    <path
      d="M 43 64 Q 50 70 57 64"
      stroke={stroke}
      strokeWidth={strokeWidth}
      fill="none"
      strokeLinecap="round"
    />
  );
}

function Accessory({ mood, colors }: { mood: BuddyMood; colors: AvatarColors }) {
  if (mood === "thinking") {
    return (
      <motion.g
        animate={{ opacity: [0.4, 1, 0.4], y: [0, -2, 0] }}
        transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
      >
        <circle cx="78" cy="24" r="2.6" fill={colors.ink} />
        <circle cx="85" cy="18" r="1.8" fill={colors.ink} />
        <circle cx="91" cy="13" r="1.2" fill={colors.ink} />
      </motion.g>
    );
  }

  if (mood === "tsukkomi") {
    return (
      <motion.g
        animate={{ opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
      >
        <path
          d="M 82 28 Q 85 34 82 38 Q 79 34 82 28 Z"
          fill={colors.sweat}
          stroke={colors.ink}
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
      </motion.g>
    );
  }

  if (mood === "applaud") {
    return (
      <g>
        <ellipse cx={leftEyeX - 6} cy={eyeY + 12} rx="5" ry="2.6" fill={colors.blush} opacity="0.75" />
        <ellipse cx={rightEyeX + 6} cy={eyeY + 12} rx="5" ry="2.6" fill={colors.blush} opacity="0.75" />
        <motion.g
          animate={{ scale: [1, 1.18, 1] }}
          transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
          style={{ transformOrigin: "50px 50px" }}
        >
          <path d="M 16 26 L 20 22 L 20 30 Z" fill={colors.spark} transform="rotate(-18 18 26)" />
          <path d="M 80 26 L 84 22 L 84 30 Z" fill={colors.spark} transform="rotate(18 82 26)" />
        </motion.g>
      </g>
    );
  }

  return null;
}

const crossfade = { duration: 0.22, ease: "easeOut" as const };

const bodyAnimationByMood: Record<BuddyMood, Record<string, number[]>> = {
  idle: { y: [0, -4, 0] },
  thinking: { rotate: [0, -2, 2, 0] },
  tsukkomi: { x: [0, -3, 3, 0] },
  applaud: { scale: [1, 1.06, 1], y: [0, -3, 0] },
};

const bodyTransitionByMood: Record<
  BuddyMood,
  { duration: number; ease: "easeInOut"; repeat: number }
> = {
  idle: { duration: 4.2, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  thinking: { duration: 2.4, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  tsukkomi: { duration: 1.6, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  applaud: { duration: 1.8, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
};
