/**
 * Failed commands and heavily rewritten files. Fetches only while this block
 * is mounted (the parent keeps it behind DeferredDetails).
 */

import { useEffect } from "react";

import {
  formatCount,
  type FileRankingRow,
  type ReworkRankingsReport,
  type ToolRankingRow,
} from "../../lib/ailog";
import { useAilogStore } from "../../stores/ailogStore";
import { EmptyState, SkeletonBlock, VScrollBox, noteStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle, subtleButtonStyle } from "./ui";

/** Backend `rework_rankings` already truncates to this; the UI discloses the cap. */
export const REWORK_RANKINGS_TOP_N = 10;

export const REWORK_RANKINGS_CAP_NOTE = `上位${REWORK_RANKINGS_TOP_N}件を表示しています`;

export const REWORK_COMMAND_SCOPE_NOTE =
  "この期間に失敗したコマンドです。モデルを絞っているときは、そのモデルの実行だけを数えます。";

export const REWORK_FILE_SCOPE_NOTE =
  "該当セッション全体の累積編集回数です。期間内に1ターンでもあったセッションについて、期間外の編集も含みます。";

export const PATH_DISPLAY_MAX = 48;

export function truncateTailPath(path: string, max = PATH_DISPLAY_MAX): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

function commandLabel(row: ToolRankingRow): string {
  return row.target ? `${row.name} · ${row.target}` : row.name;
}

function commandRowKey(row: ToolRankingRow): string {
  return JSON.stringify([row.name, row.target ?? ""]);
}

function CommandTable({ rows }: { rows: ToolRankingRow[] }) {
  const shown = rows.slice(0, REWORK_RANKINGS_TOP_N);
  if (shown.length === 0) {
    return <div style={noteStyle}>この期間に失敗したコマンドはありません。</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", fontWeight: 600 }}>
        失敗の多いコマンド
      </div>
      <div style={noteStyle}>{REWORK_COMMAND_SCOPE_NOTE}</div>
      <VScrollBox maxHeight={240}>
        <table style={tableStyle}>
          <colgroup>
            <col style={{ width: "70%" }} />
            <col style={{ width: "30%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thLeftStyle}>コマンド</th>
              <th style={thStyle}>失敗 / 実行</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={commandRowKey(row)} data-testid="rework-command-row">
                <td style={tdLeftStyle} title={commandLabel(row)} data-testid="rework-command-label">
                  {commandLabel(row)}
                </td>
                <td style={tdStyle} data-testid="rework-command-counts">
                  {`${formatCount(row.failures)} / ${formatCount(row.executions)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </VScrollBox>
      <div style={noteStyle} data-testid="rework-command-cap-note">{REWORK_RANKINGS_CAP_NOTE}</div>
    </div>
  );
}

function FileTable({ rows }: { rows: FileRankingRow[] }) {
  const shown = rows.slice(0, REWORK_RANKINGS_TOP_N);
  if (shown.length === 0) {
    return <div style={noteStyle}>繰り返し編集されたファイルはありません。</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", fontWeight: 600 }}>
        書き直しの多いファイル
      </div>
      <div style={noteStyle}>{REWORK_FILE_SCOPE_NOTE}</div>
      <VScrollBox maxHeight={240}>
        <table style={tableStyle}>
          <colgroup>
            <col style={{ width: "58%" }} />
            <col style={{ width: "21%" }} />
            <col style={{ width: "21%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thLeftStyle}>ファイル</th>
              <th style={thStyle}>編集回数</th>
              <th style={thStyle}>セッション</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.path} data-testid="rework-file-row">
                <td style={tdLeftStyle} title={row.path} data-testid="rework-file-path">
                  {truncateTailPath(row.path)}
                </td>
                <td style={tdStyle}>{formatCount(row.editCount)}</td>
                <td style={tdStyle}>{formatCount(row.sessionCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VScrollBox>
      <div style={noteStyle} data-testid="rework-file-cap-note">{REWORK_RANKINGS_CAP_NOTE}</div>
    </div>
  );
}

export function ReworkRankingsTables({ report }: { report: ReworkRankingsReport }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <CommandTable rows={report.failedCommands} />
      <FileTable rows={report.rewrittenFiles} />
    </div>
  );
}

export function ReworkRankings() {
  const refreshReworkRankings = useAilogStore((state) => state.refreshReworkRankings);
  const setReworkRankingsOpen = useAilogStore((state) => state.setReworkRankingsOpen);
  const report = useAilogStore((state) => state.reworkRankings);
  const loading = useAilogStore((state) => state.reworkRankingsLoading);
  const error = useAilogStore((state) => state.reworkRankingsError);
  const preset = useAilogStore((state) => state.preset);
  const customFrom = useAilogStore((state) => state.customFrom);
  const customTo = useAilogStore((state) => state.customTo);
  const includeSidechain = useAilogStore((state) => state.includeSidechain);
  const selection = useAilogStore((state) => state.selection);

  useEffect(() => {
    setReworkRankingsOpen(true);
    return () => setReworkRankingsOpen(false);
  }, [setReworkRankingsOpen]);

  useEffect(() => {
    void refreshReworkRankings();
  }, [refreshReworkRankings, preset, customFrom, customTo, includeSidechain, selection]);

  if (error) {
    return (
      <EmptyState
        kind="error"
        message={error}
        onPrimary={() => void refreshReworkRankings({ force: true })}
      />
    );
  }
  if (loading && !report) {
    return <SkeletonBlock height={140} label="つまずいた場所を読み込み中" />;
  }
  if (!report) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
        <div style={noteStyle}>この期間の記録をまだ読み込んでいません。</div>
        <button type="button" onClick={() => void refreshReworkRankings({ force: true })} style={subtleButtonStyle}>
          読み込む
        </button>
      </div>
    );
  }
  return <ReworkRankingsTables report={report} />;
}
