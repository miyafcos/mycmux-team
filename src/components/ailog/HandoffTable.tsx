/**
 * Consecutive model switches. Fetches only while this block is mounted
 * (the parent keeps it behind DeferredDetails).
 */

import { useEffect } from "react";

import { formatCount, type Handoff, type HandoffsReport } from "../../lib/ailog";
import { useAilogStore } from "../../stores/ailogStore";
import { EmptyState, SkeletonBlock, VScrollBox, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle, subtleButtonStyle } from "./ui";

export const HANDOFF_SECTION_SUMMARY = "モデルの切り替え";

function HandoffRows({ rows }: { rows: Handoff[] }) {
  if (rows.length === 0) {
    return <EmptyState kind="no-data" />;
  }
  return (
    <VScrollBox maxHeight={240}>
      <table style={tableStyle} data-testid="ailog-handoffs-table">
        <thead>
          <tr>
            <th scope="col" style={thLeftStyle}>切り替え前</th>
            <th scope="col" style={thLeftStyle}>切り替え後</th>
            <th scope="col" style={thStyle}>回数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.from}->${row.to}`} data-testid="ailog-handoff-row">
              <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}>{row.from}</th>
              <td style={tdLeftStyle}>{row.to}</td>
              <td style={tdStyle}>{formatCount(row.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </VScrollBox>
  );
}

export function HandoffTables({ report }: { report: HandoffsReport }) {
  return <HandoffRows rows={report.handoffs} />;
}

export function HandoffPanelBody({
  report,
  loading,
  error,
  onRetry,
}: {
  report: HandoffsReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return <EmptyState kind="error" message={error} onPrimary={onRetry} />;
  }
  if (loading && !report) {
    return <SkeletonBlock height={140} label="集計を読み込み中" />;
  }
  if (!report) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
        <div style={noteStyle}>この期間の記録をまだ読み込んでいません。</div>
        <button type="button" onClick={onRetry} style={subtleButtonStyle}>
          読み込む
        </button>
      </div>
    );
  }
  return <HandoffTables report={report} />;
}

export function HandoffTable() {
  const refreshModelHandoffs = useAilogStore((state) => state.refreshModelHandoffs);
  const setHandoffsOpen = useAilogStore((state) => state.setHandoffsOpen);
  const report = useAilogStore((state) => state.handoffs);
  const loading = useAilogStore((state) => state.handoffsLoading);
  const error = useAilogStore((state) => state.handoffsError);
  const preset = useAilogStore((state) => state.preset);
  const customFrom = useAilogStore((state) => state.customFrom);
  const customTo = useAilogStore((state) => state.customTo);
  const includeSidechain = useAilogStore((state) => state.includeSidechain);
  const selection = useAilogStore((state) => state.selection);
  const granularity = useAilogStore((state) => state.granularity);

  useEffect(() => {
    setHandoffsOpen(true);
    return () => setHandoffsOpen(false);
  }, [setHandoffsOpen]);

  useEffect(() => {
    void refreshModelHandoffs();
  }, [refreshModelHandoffs, preset, customFrom, customTo, includeSidechain, selection, granularity]);

  return (
    <HandoffPanelBody
      report={report}
      loading={loading}
      error={error}
      onRetry={() => void refreshModelHandoffs({ force: true })}
    />
  );
}
