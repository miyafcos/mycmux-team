import { useCallback, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { SkillsIcon } from "../icons/ChromeIcons";
import { AgentDesignPanel } from "./AgentDesignPanel";
import { agentDesignStrings as s } from "./agentDesignStrings";
export function AgentDesignButton() {
  const [open, setOpen] = useState(false); const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const close = useCallback(() => setOpen(false), []);
  return <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
    <button type="button" className="cmux-title-btn" title={s.title} aria-label={s.title} aria-haspopup="dialog" aria-expanded={open} aria-controls="agent-design-panel" onClick={() => setOpen(v => !v)}
      style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer", padding: "3px 6px", borderRadius: 3, display: "flex", alignItems: "center" }}><SkillsIcon size={12} /></button>
    {mounted && <AgentDesignPanel open={open} closing={closing} onClose={close} />}
  </div>;
}
