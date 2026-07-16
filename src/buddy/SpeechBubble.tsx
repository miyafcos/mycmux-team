import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { BuddySpeech } from "./core/types";

const AUTO_HIDE_MS = 60_000;

interface SpeechBubbleProps {
  speech: BuddySpeech | null;
  loading: boolean;
  onDismiss?: () => void;
}

export function SpeechBubble({ speech, loading, onDismiss }: SpeechBubbleProps) {
  const [activeSpeech, setActiveSpeech] = useState<BuddySpeech | null>(speech);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setActiveSpeech(speech);
  }, [speech]);

  useEffect(() => {
    if (loading || !activeSpeech) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setActiveSpeech(null);
      onDismiss?.();
    }, AUTO_HIDE_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [activeSpeech, loading, onDismiss]);

  const handleDismiss = (): void => {
    setActiveSpeech(null);
    onDismiss?.();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    pointerDownPos.current = { x: event.clientX, y: event.clientY };
  };

  const handleBubbleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const down = pointerDownPos.current;
    pointerDownPos.current = null;
    if (down && Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y) > 4) {
      return;
    }
    if (window.getSelection()?.toString().trim()) {
      return;
    }
    handleDismiss();
  };

  return (
    <AnimatePresence>
      {activeSpeech ? (
        <motion.div
          key={activeSpeech.id}
          ref={bubbleRef}
          className="buddy-widget__bubble"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          onPointerDown={handlePointerDown}
          onClick={handleBubbleClick}
        >
          <button
            type="button"
            className="buddy-widget__bubble-close"
            aria-label="閉じる"
            onClick={handleDismiss}
          >
            ×
          </button>
          <div className="buddy-widget__bubble-text">{activeSpeech.text}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
