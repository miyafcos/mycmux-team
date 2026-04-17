import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { getBuddyConfig } from "./agent/config";
import type { BuddyMood } from "./agent/types";

interface BuddyAvatarProps {
  mood: BuddyMood;
  size: number;
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

function useBlink(mood: BuddyMood): boolean {
  const [blinking, setBlinking] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const schedule = (): void => {
      const nextMs = 3200 + Math.random() * 4800;
      timerRef.current = window.setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        window.setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          if (Math.random() < 0.18) {
            window.setTimeout(() => {
              if (cancelled) return;
              setBlinking(true);
              window.setTimeout(() => {
                if (!cancelled) setBlinking(false);
                schedule();
              }, 110);
            }, 170);
          } else {
            schedule();
          }
        }, 120);
      }, nextMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [mood]);

  return blinking;
}

function useGaze(mood: BuddyMood): { dx: number; dy: number } {
  const [gaze, setGaze] = useState({ dx: 0, dy: 0 });
  useEffect(() => {
    let cancelled = false;
    let timerId: number;
    const schedule = (): void => {
      const nextMs = 2000 + Math.random() * 3000;
      timerId = window.setTimeout(() => {
        if (cancelled) return;
        if (mood === "thinking") {
          setGaze({ dx: (Math.random() - 0.5) * 1.4, dy: -0.8 - Math.random() * 0.8 });
        } else if (mood === "sleepy") {
          setGaze({ dx: (Math.random() - 0.5) * 0.8, dy: 0.6 });
        } else {
          const pool = [-1.3, -0.6, 0, 0, 0.6, 1.3];
          setGaze({ dx: pool[Math.floor(Math.random() * pool.length)], dy: (Math.random() - 0.5) * 0.6 });
        }
        schedule();
      }, nextMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [mood]);
  return gaze;
}

export function BuddyAvatar({ mood, size }: BuddyAvatarProps) {
  const avatarCfg = getBuddyConfig().avatar;
  const colors: AvatarColors = {
    ink: avatarCfg.inkColor,
    blush: avatarCfg.blushColor,
    spark: avatarCfg.sparkColor,
    sweat: avatarCfg.sweatColor,
  };
  const blinking = useBlink(mood);
  const gaze = useGaze(mood);
  return (
    <motion.svg
      className="buddy__avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      animate={bodyAnimationByMood[mood]}
      transition={bodyTransitionByMood[mood]}
      style={{ display: "block" }}
    >
      <motion.g
        animate={{ scale: [1, 1.018, 1] }}
        transition={{ duration: 3.6, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }}
        style={{ transformOrigin: "50px 62px" }}
      >
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`eyes-${mood}`}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={crossfade}
        >
          <Eyes mood={mood} colors={colors} blinking={blinking} gaze={gaze} />
        </motion.g>
      </AnimatePresence>
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`mouth-${mood}`}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={crossfade}
        >
          <Mouth mood={mood} colors={colors} />
        </motion.g>
      </AnimatePresence>
      <AnimatePresence mode="popLayout">
        <motion.g
          key={`accessory-${mood}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={crossfade}
        >
          <Accessory mood={mood} colors={colors} />
        </motion.g>
      </AnimatePresence>
      </motion.g>
    </motion.svg>
  );
}

function Eyes({
  mood,
  colors,
  blinking,
  gaze,
}: {
  mood: BuddyMood;
  colors: AvatarColors;
  blinking: boolean;
  gaze: { dx: number; dy: number };
}) {
  const INK = colors.ink;

  // Shapes that are strokes only (applaud / tsukkomi-left / thinking-special) bypass blink & gaze
  if (mood === "applaud") {
    return (
      <g stroke={INK} strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d={`M ${leftEyeX - 5} ${eyeY + 2} Q ${leftEyeX} ${eyeY - 5} ${leftEyeX + 5} ${eyeY + 2}`} />
        <path d={`M ${rightEyeX - 5} ${eyeY + 2} Q ${rightEyeX} ${eyeY - 5} ${rightEyeX + 5} ${eyeY + 2}`} />
      </g>
    );
  }

  const scaleY = blinking ? 0.08 : 1;
  const dx = gaze.dx;
  const dy = gaze.dy;
  const blinkStyle = {
    transform: `translate(${dx}px, ${dy}px) scaleY(${scaleY})`,
    transformOrigin: `50px ${eyeY}px`,
    transition: "transform 110ms ease-out",
  } as const;

  if (mood === "tsukkomi") {
    return (
      <g style={blinkStyle}>
        <path d={`M ${leftEyeX - 6} ${eyeY - 1} L ${leftEyeX + 6} ${eyeY + 2}`} stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
        <ellipse cx={rightEyeX} cy={eyeY} rx="3" ry="3.8" fill={INK} />
      </g>
    );
  }
  if (mood === "listening") {
    return (
      <g fill={INK} style={blinkStyle}>
        <ellipse cx={leftEyeX + 1.5} cy={eyeY} rx="2.8" ry="3.4" />
        <ellipse cx={rightEyeX + 1.5} cy={eyeY} rx="2.8" ry="3.4" />
        <circle cx={leftEyeX + 2.5} cy={eyeY - 0.8} r="0.9" fill="#fff8ef" />
        <circle cx={rightEyeX + 2.5} cy={eyeY - 0.8} r="0.9" fill="#fff8ef" />
      </g>
    );
  }
  if (mood === "thinking") {
    return (
      <g fill={INK} style={blinkStyle}>
        <ellipse cx={leftEyeX} cy={eyeY} rx="2.2" ry="2.6" />
        <ellipse cx={rightEyeX} cy={eyeY} rx="2.2" ry="2.6" />
      </g>
    );
  }
  if (mood === "curious") {
    return (
      <g style={blinkStyle}>
        <ellipse cx={leftEyeX} cy={eyeY} rx="3.4" ry="4.0" fill={INK} />
        <ellipse cx={rightEyeX} cy={eyeY - 1.2} rx="3.4" ry="4.2" fill={INK} />
        <circle cx={leftEyeX + 1.1} cy={eyeY - 1.6} r="1.1" fill="#fff8ef" />
        <circle cx={rightEyeX + 1.1} cy={eyeY - 2.8} r="1.1" fill="#fff8ef" />
      </g>
    );
  }
  if (mood === "amused") {
    return (
      <g stroke={INK} strokeWidth="2.6" strokeLinecap="round" fill="none" style={blinkStyle}>
        <path d={`M ${leftEyeX - 5} ${eyeY} Q ${leftEyeX} ${eyeY + 4} ${leftEyeX + 5} ${eyeY}`} />
        <path d={`M ${rightEyeX - 5} ${eyeY} Q ${rightEyeX} ${eyeY + 4} ${rightEyeX + 5} ${eyeY}`} />
      </g>
    );
  }
  if (mood === "alert") {
    return (
      <g style={blinkStyle}>
        <ellipse cx={leftEyeX} cy={eyeY} rx="4" ry="4.6" fill="#fff8ef" stroke={INK} strokeWidth="1.2" />
        <ellipse cx={rightEyeX} cy={eyeY} rx="4" ry="4.6" fill="#fff8ef" stroke={INK} strokeWidth="1.2" />
        <circle cx={leftEyeX + gaze.dx * 0.3} cy={eyeY + gaze.dy * 0.3} r="1.8" fill={INK} />
        <circle cx={rightEyeX + gaze.dx * 0.3} cy={eyeY + gaze.dy * 0.3} r="1.8" fill={INK} />
      </g>
    );
  }
  if (mood === "sleepy") {
    return (
      <g fill={INK} style={{ ...blinkStyle, transform: `translate(${dx}px, ${dy + 0.6}px) scaleY(${scaleY * 0.42})` }}>
        <ellipse cx={leftEyeX} cy={eyeY} rx="3.2" ry="3.6" />
        <ellipse cx={rightEyeX} cy={eyeY} rx="3.2" ry="3.6" />
      </g>
    );
  }
  return (
    <g style={blinkStyle}>
      <ellipse cx={leftEyeX} cy={eyeY} rx="3" ry="3.8" fill={INK} />
      <ellipse cx={rightEyeX} cy={eyeY} rx="3" ry="3.8" fill={INK} />
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
        <path d="M 39 63 Q 50 78 61 63 Z" stroke={stroke} strokeWidth={strokeWidth} fill={colors.ink} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M 41 64 L 59 64" stroke="#fff8ef" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    );
  }
  if (mood === "tsukkomi") {
    return <path d="M 41 70 Q 50 62 59 70" stroke={stroke} strokeWidth={strokeWidth + 0.2} fill="none" strokeLinecap="round" />;
  }
  if (mood === "listening") {
    return <ellipse cx="50" cy="67" rx="3.5" ry="2.5" stroke={stroke} strokeWidth={strokeWidth} fill="none" />;
  }
  if (mood === "thinking") {
    return <path d="M 43 67 Q 48 70 53 66 T 58 68" stroke={stroke} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />;
  }
  if (mood === "curious") {
    return <ellipse cx="50" cy="68" rx="2.2" ry="2.8" stroke={stroke} strokeWidth={strokeWidth} fill="none" />;
  }
  if (mood === "amused") {
    return <path d="M 40 63 Q 50 72 60 63" stroke={stroke} strokeWidth={strokeWidth + 0.2} fill="none" strokeLinecap="round" />;
  }
  if (mood === "alert") {
    return <path d="M 42 68 Q 46 64 50 68 Q 54 64 58 68" stroke={stroke} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />;
  }
  if (mood === "sleepy") {
    return <path d="M 45 68 Q 50 69 55 68" stroke={stroke} strokeWidth={strokeWidth - 0.4} fill="none" strokeLinecap="round" />;
  }
  return <path d="M 43 64 Q 50 70 57 64" stroke={stroke} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" />;
}

function Accessory({ mood, colors }: { mood: BuddyMood; colors: AvatarColors }) {
  if (mood === "listening") {
    return (
      <motion.g animate={{ opacity: [0.3, 0.7, 0.3] }} transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}>
        <path d="M 82 40 Q 86 44 82 48" stroke={colors.ink} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        <path d="M 86 38 Q 92 44 86 50" stroke={colors.ink} strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </motion.g>
    );
  }
  if (mood === "thinking") {
    return (
      <motion.g animate={{ opacity: [0.4, 1, 0.4], y: [0, -2, 0] }} transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}>
        <circle cx="78" cy="24" r="2.6" fill={colors.ink} />
        <circle cx="85" cy="18" r="1.8" fill={colors.ink} />
        <circle cx="91" cy="13" r="1.2" fill={colors.ink} />
      </motion.g>
    );
  }
  if (mood === "tsukkomi") {
    return (
      <motion.g animate={{ opacity: [0.7, 1, 0.7] }} transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}>
        <path d="M 82 28 Q 85 34 82 38 Q 79 34 82 28 Z" fill={colors.sweat} stroke={colors.ink} strokeWidth="0.8" strokeLinejoin="round" />
      </motion.g>
    );
  }
  if (mood === "applaud") {
    return (
      <g>
        <ellipse cx={leftEyeX - 6} cy={eyeY + 12} rx="5" ry="2.6" fill={colors.blush} opacity="0.75" />
        <ellipse cx={rightEyeX + 6} cy={eyeY + 12} rx="5" ry="2.6" fill={colors.blush} opacity="0.75" />
        <motion.g animate={{ scale: [1, 1.18, 1] }} transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }} style={{ transformOrigin: "50px 50px" }}>
          <path d="M 16 26 L 20 22 L 20 30 Z" fill={colors.spark} transform="rotate(-18 18 26)" />
          <path d="M 80 26 L 84 22 L 84 30 Z" fill={colors.spark} transform="rotate(18 82 26)" />
        </motion.g>
      </g>
    );
  }
  if (mood === "curious") {
    return (
      <motion.g animate={{ y: [0, -2, 0], opacity: [0.7, 1, 0.7] }} transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}>
        <text x="82" y="26" fontSize="14" fontWeight="700" fill={colors.ink} fontFamily="system-ui, sans-serif">?</text>
      </motion.g>
    );
  }
  if (mood === "amused") {
    return (
      <g>
        <ellipse cx={leftEyeX - 6} cy={eyeY + 13} rx="4" ry="2.2" fill={colors.blush} opacity="0.55" />
        <ellipse cx={rightEyeX + 6} cy={eyeY + 13} rx="4" ry="2.2" fill={colors.blush} opacity="0.55" />
      </g>
    );
  }
  if (mood === "alert") {
    return (
      <motion.g animate={{ scale: [1, 1.25, 1], opacity: [0.7, 1, 0.7] }} transition={{ duration: 0.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }} style={{ transformOrigin: "82px 26px" }}>
        <rect x="80" y="14" width="4" height="10" rx="1.5" fill="#e85149" />
        <circle cx="82" cy="28" r="2" fill="#e85149" />
      </motion.g>
    );
  }
  if (mood === "sleepy") {
    return (
      <motion.g animate={{ y: [0, -3, 0], opacity: [0.4, 0.9, 0.4] }} transition={{ duration: 2.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}>
        <text x="76" y="22" fontSize="9" fontWeight="700" fill={colors.ink} fontFamily="system-ui, sans-serif" opacity="0.7">z</text>
        <text x="82" y="16" fontSize="11" fontWeight="700" fill={colors.ink} fontFamily="system-ui, sans-serif" opacity="0.85">z</text>
        <text x="88" y="10" fontSize="13" fontWeight="700" fill={colors.ink} fontFamily="system-ui, sans-serif">z</text>
      </motion.g>
    );
  }
  return null;
}

const crossfade = { duration: 0.22, ease: "easeOut" as const };

const bodyAnimationByMood: Record<BuddyMood, Record<string, number[]>> = {
  idle: { y: [0, -4, 0] },
  listening: { y: [0, -2, 0], rotate: [0, 1, 0] },
  thinking: { rotate: [0, -2, 2, 0] },
  tsukkomi: { x: [0, -3, 3, 0] },
  applaud: { scale: [1, 1.06, 1], y: [0, -3, 0] },
  curious: { rotate: [0, -4, 4, 0], y: [0, -1, 0] },
  amused: { y: [0, -2, 0], rotate: [0, 2, -2, 0] },
  alert: { x: [0, -2, 2, -2, 2, 0], y: [0, -1, 0] },
  sleepy: { y: [0, -1.2, 0] },
};

const bodyTransitionByMood: Record<BuddyMood, { duration: number; ease: "easeInOut"; repeat: number }> = {
  idle: { duration: 4.2, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  listening: { duration: 3.0, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  thinking: { duration: 2.4, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  tsukkomi: { duration: 1.6, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  applaud: { duration: 1.8, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  curious: { duration: 2.0, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  amused: { duration: 1.4, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  alert: { duration: 0.9, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
  sleepy: { duration: 6.0, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
};
