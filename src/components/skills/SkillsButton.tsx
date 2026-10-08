import { useCallback, useState } from "react";
import { LibraryBig } from "lucide-react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { SkillsPanel } from "./SkillsPanel";
import { createReadOnlySkillsApi } from "../agentDesign/readOnlySkillsApi";
import { agentDesignApi } from "../../lib/agentDesignApi";
import { skillsStrings as s } from "./skillsStrings";

export function SkillsButton() {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const [api] = useState(() => {
    const shelf = createReadOnlySkillsApi();
    return { ...shelf, refresh: async () => {
      // A direct first visit must establish the same catalogue as AgentDesignView.
      if (!agentDesignApi.peek() && !await agentDesignApi.cached()) await agentDesignApi.refresh();
      return shelf.refresh();
    } };
  });
  const close = useCallback(() => setOpen(false), []);
  return <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center", flexShrink: 0 }}>
    <button type="button" className="cmux-title-btn" title={s.title} aria-label={s.title}
      aria-haspopup="dialog" aria-expanded={open} aria-controls="skills-panel" onClick={() => setOpen(value => !value)}
      style={{ background: "none", border: "none", color: "var(--cmux-text-secondary)", cursor: "pointer",
        padding: "3px 6px", borderRadius: 3, display: "flex", alignItems: "center" }}><LibraryBig size={12} strokeWidth={2} /></button>
    {mounted && <SkillsPanel open={open} closing={closing} onClose={close} api={api} readOnly />}
  </div>;
}
