import { useEffect, useRef, useState } from "react";
import type { FeedbackImage } from "../../lib/ipc";
import { captureFeedbackMain } from "./feedbackApi";
import { FeedbackDialog } from "./FeedbackDialog";
import { normalizeFeedbackImage } from "./feedbackImages";
import { feedbackStrings as strings } from "./feedbackStrings";

export function FeedbackButton() {
  const [opening, setOpening] = useState(false);
  const [dialog, setDialog] = useState<{ images: FeedbackImage[]; captureMessage: string } | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function open() {
    if (pending.current || dialog) return;
    pending.current = true; setOpening(true);
    const images: FeedbackImage[] = [];
    let captureMessage = "";
    try {
      const png = await captureFeedbackMain();
      images.push(await normalizeFeedbackImage(`data:image/png;base64,${png}`));
    } catch (reason) {
      captureMessage = reason === strings.captureUnsupported ? strings.captureUnsupported : strings.captureFailed;
    }
    if (active.current) {
      // The overlay is deliberately absent until native capture and normalization finish.
      setDialog({ images, captureMessage }); setOpening(false);
    }
    pending.current = false;
  }
  return <>
    <button type="button" className="cmux-title-btn" aria-label={strings.open} title={strings.open}
      disabled={opening} onClick={() => { void open(); }}
      style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: opening ? "wait" : "pointer",
        padding: "3px 6px", display: "flex", alignItems: "center" }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m2 6 10 7L22 6" />
      </svg>
    </button>
    {dialog && <FeedbackDialog initialImages={dialog.images} captureMessage={dialog.captureMessage} onClose={() => setDialog(null)} />}
  </>;
}
