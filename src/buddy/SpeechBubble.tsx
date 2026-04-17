import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { BuddySpeech } from "./agent/types";

const AUTO_HIDE_MS = 60_000;

interface SpeechBubbleProps {
  speech: BuddySpeech | null;
  loading: boolean;
  onDismiss?: () => void;
}

export function SpeechBubble({ speech, loading, onDismiss }: SpeechBubbleProps) {
  const [activeSpeech, setActiveSpeech] = useState<BuddySpeech | null>(speech);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <AnimatePresence>
      {activeSpeech ? (
        <motion.div
          key={activeSpeech.id}
          ref={bubbleRef}
          className="buddy-widget__bubble"
          initial={{ opacity: 0, y: 18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
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
