import { useRef, useState } from "react";

import { SUMMARY_RANGE_PRESETS, type SummaryRangePreset } from "../../lib/ailog";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useAilogJobStore } from "../../stores/useAilogJobStore";
import { ButtonGroup, subtleButtonStyle } from "./ui";

export function PanelMenu({
  summaryPreset,
  onSummaryPreset,
  aiDisabledReason,
  onStartSummarize,
}: {
  summaryPreset: SummaryRangePreset;
  onSummaryPreset: (preset: SummaryRangePreset) => void;
  aiDisabledReason?: string;
  onStartSummarize: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const index = useAilogJobStore((state) => state.index);
  const summarize = useAilogJobStore((state) => state.summarize);
  const startIndex = useAilogJobStore((state) => state.startIndex);
  const cancelIndex = useAilogJobStore((state) => state.cancelIndex);
  const cancelSummarize = useAilogJobStore((state) => state.cancelSummarize);
  const running = index.status?.running ?? false;
  const summarizing = summarize.status?.running ?? false;

  useDismissOnOutside(open, rootRef, () => setOpen(false));

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="その他の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ ...subtleButtonStyle, padding: "3px 8px" }}
      >
        ⋮
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 20,
            minWidth: 220,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            border: "1px solid var(--cmux-border)",
            borderRadius: 8,
            background: "var(--cmux-popover)",
            boxShadow: "var(--cmux-shadow-dropdown)",
          }}
        >
          {running ? (
            <button type="button" role="menuitem" onClick={() => void cancelIndex()} style={menuItemStyle}>
              インデックスを中断
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => void startIndex(true)}
              disabled={summarizing}
              style={{ ...menuItemStyle, opacity: summarizing ? 0.5 : 1 }}
            >
              再インデックス（全量）
            </button>
          )}
          {summarizing ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => void cancelSummarize(summaryPreset)}
              style={{ ...menuItemStyle, color: "var(--cmux-red)" }}
            >
              要約を中断
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={onStartSummarize}
              disabled={running || aiDisabledReason !== undefined}
              title={aiDisabledReason}
              style={{ ...menuItemStyle, opacity: running || aiDisabledReason !== undefined ? 0.5 : 1 }}
            >
              要約を実行
            </button>
          )}
          <div style={{ padding: "4px 6px 0" }}>
            <ButtonGroup
              ariaLabel="要約対象期間"
              value={summaryPreset}
              onChange={onSummaryPreset}
              options={SUMMARY_RANGE_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))}
            />
          </div>
          <div
            style={{
              marginTop: 2,
              padding: "6px 6px 2px",
              borderTop: "1px solid var(--cmux-border-hairline)",
              color: "var(--cmux-text-tertiary)",
              fontSize: "var(--cmux-font-size-xs)",
              lineHeight: 1.5,
            }}
          >
            単価設定は 設定 → アカウント・使用量
          </div>
        </div>
      ) : null}
    </div>
  );
}

const menuItemStyle = {
  ...subtleButtonStyle,
  width: "100%",
  textAlign: "left" as const,
  whiteSpace: "normal" as const,
};
