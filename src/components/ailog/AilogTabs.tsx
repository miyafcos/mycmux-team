import { useId } from "react";
import { useAilogStore, type AilogSection } from "../../stores/ailogStore";
import { subtleButtonStyle } from "./ui";

export const AILOG_SECTIONS: { id: AilogSection; label: string }[] = [
  { id: "breakdown", label: "内訳" }, { id: "comparison", label: "比較" },
  { id: "sessions", label: "セッション" }, { id: "rework", label: "手戻り" },
  { id: "handoffs", label: "モデル切替" }, { id: "activity", label: "活動時間" },
];

export function AilogTabs({ children }: { children: (section: AilogSection) => React.ReactNode }) {
  const section = useAilogStore(state => state.activeSection);
  const select = useAilogStore(state => state.setActiveSection);
  const id = useId();
  return <div>
    <div role="tablist" aria-label="分析の見出し" style={{ display: "flex", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--cmux-border)", paddingBottom: 8 }}>
      {AILOG_SECTIONS.map((tab, index) => <button key={tab.id} type="button" role="tab"
        id={id + "-" + tab.id} aria-selected={section === tab.id} aria-controls={id + "-panel"}
        tabIndex={section === tab.id ? 0 : -1}
        onClick={() => select(tab.id)}
        onKeyDown={event => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? AILOG_SECTIONS.length - 1
            : event.key === "ArrowRight" ? (index + 1) % AILOG_SECTIONS.length
            : event.key === "ArrowLeft" ? (index + AILOG_SECTIONS.length - 1) % AILOG_SECTIONS.length : -1;
          if (next < 0) return;
          event.preventDefault();
          select(AILOG_SECTIONS[next].id);
          document.getElementById(id + "-" + AILOG_SECTIONS[next].id)?.focus();
        }}
        style={{ ...subtleButtonStyle, background: section === tab.id ? "var(--cmux-selected)" : "transparent", borderColor: section === tab.id ? "var(--cmux-accent)" : "var(--cmux-border)" }}>{tab.label}</button>)}
    </div>
    <div id={id + "-panel"} role="tabpanel" aria-labelledby={id + "-" + section} tabIndex={0} style={{ minHeight: 300, paddingTop: 12 }}>
      {children(section)}
    </div>
  </div>;
}
