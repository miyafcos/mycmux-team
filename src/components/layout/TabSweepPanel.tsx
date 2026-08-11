import { invoke } from "@tauri-apps/api/core";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { OverlayShell } from "../common/OverlayShell";
import {
  applySweep,
  applyVerdictSelection,
  buildJudgePrompt,
  buildSweepRows,
  formatJudgeError,
  formatLastOutputAge,
  formatSweepCompletion,
  initialSweepSelection,
  lastMeaningfulTailLine,
  parseJudgeOutputResult,
  retainSweepSelection,
  scanTabs,
  shortenCwdFromStart,
  splitSweepSelection,
  toggleSweepSelection,
  type SweepCategory,
  type SweepLockReason,
  type SweepReport,
  type SweepRow,
  type SweepTab,
  type Verdict,
} from "./tabSweep";

interface TabSweepPanelProps {
  open: boolean;
  visible: boolean;
  closing?: boolean;
  onClose: () => void;
}

const lockReasonLabels: Record<SweepLockReason, string> = {
  queued_input: "未送信の指示あり",
  recent_output: "5分以内に出力",
  active: "表示中",
  working: "作業中",
  buffer_unavailable: "画面を確認できない",
  not_at_prompt: "待機プロンプトを確認できない",
  unsupported_tab: "対象外のタブ",
};

const verdictLabels: Record<Exclude<Verdict["verdict"], "unknown">, string> = {
  done_waiting: "完了待機",
  queued_input: "未送信あり",
  working: "作業中",
};

const groupLabels: Record<SweepCategory, string> = {
  DEAD: "プロセス終了済み",
  CANDIDATE: "入力待ちの候補",
  LOCKED: "ロック中（閉じられません）",
};

const actionButtonStyle: CSSProperties = {
  border: "1px solid var(--cmux-border)",
  borderRadius: 5,
  background: "var(--cmux-hover)",
  color: "var(--cmux-text)",
  padding: "5px 9px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const chipStyle: CSSProperties = {
  padding: "2px 6px",
  borderRadius: 999,
  background: "var(--cmux-hover)",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-xs)",
};

function ActionButton({
  children,
  danger = false,
  disabled = false,
  onClick,
  ariaLabel,
  buttonRef,
  primary = false,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      ref={buttonRef}
      data-tab-sweep-primary={primary ? "true" : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        ...actionButtonStyle,
        ...(danger ? { color: "var(--cmux-red)", borderColor: "color-mix(in srgb, var(--cmux-red) 45%, var(--cmux-border))" } : {}),
        ...(disabled ? { cursor: "default", opacity: 0.4 } : {}),
      }}
    >
      {children}
    </button>
  );
}

function TabIdentity({
  tab,
  scannedAt,
  detail,
  showActivity = false,
}: {
  tab: SweepTab;
  scannedAt: number;
  detail?: ReactNode;
  showActivity?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--cmux-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tab.label?.trim() || "無名タブ"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, marginTop: 2, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>
        <span style={{ flex: "none" }}>{tab.workspaceName}</span>
        {tab.cwd ? <span aria-hidden="true">·</span> : null}
        {tab.cwd ? (
          <span
            title={tab.cwd}
            aria-label={`作業フォルダ: ${tab.cwd}`}
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {shortenCwdFromStart(tab.cwd)}
          </span>
        ) : null}
      </div>
      {showActivity ? (
        <div style={{ display: "flex", gap: 8, minWidth: 0, marginTop: 3, color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)" }}>
          <span style={{ flex: "none" }}>{formatLastOutputAge(tab.lastOutputAt, scannedAt)}</span>
          <span aria-label={`画面末尾: ${lastMeaningfulTailLine(tab.tail)}`} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {lastMeaningfulTailLine(tab.tail)}
          </span>
        </div>
      ) : null}
      {detail}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-label="タブを確認中" style={{ display: "grid", gap: 6, padding: "12px 16px" }}>
      {["72%", "55%"].map((width) => (
        <div key={width} style={{ width, height: 18, borderRadius: 4, background: "var(--cmux-hover)", opacity: 0.65 }} />
      ))}
    </div>
  );
}

function verdictInputKey(tab: SweepTab): string {
  return JSON.stringify([tab.category, tab.unnamed, tab.label ?? "", tab.cwd ?? "", tab.tail]);
}

function tabName(tab: SweepTab): string {
  return tab.label?.trim() || "無名タブ";
}

export function TabSweepPanel({ open, visible, closing = false, onClose }: TabSweepPanelProps) {
  const verdictInputsRef = useRef(new Map<string, string>());
  const activeJudgeRequestRef = useRef<string | null>(null);
  const focusOnOpenRef = useRef(false);
  const [report, setReport] = useState<SweepReport | null>(null);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [judged, setJudged] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [judging, setJudging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState("タブを確認しています…");
  const [judgeStartedAt, setJudgeStartedAt] = useState<number | null>(null);
  const [judgeTargetCount, setJudgeTargetCount] = useState(0);
  const [judgeElapsedSeconds, setJudgeElapsedSeconds] = useState(0);
  const [judgeErrorDetail, setJudgeErrorDetail] = useState<string | null>(null);

  const rescan = useCallback(async (clearJudge = true): Promise<boolean> => {
    setScanning(true);
    try {
      const next = await scanTabs();
      const nextRows = buildSweepRows(next);
      setReport(next);
      if (clearJudge) {
        verdictInputsRef.current.clear();
        setVerdicts([]);
        setJudged(false);
        setJudgeErrorDetail(null);
        setSelection(initialSweepSelection(nextRows));
      } else {
        const currentById = new Map(next.tabs.map((tab) => [tab.id, tab]));
        setVerdicts((current) => current.filter((verdict) => {
          const tab = currentById.get(verdict.id);
          return tab !== undefined
            && verdictInputsRef.current.get(verdict.id) === verdictInputKey(tab);
        }));
        setSelection((current) => retainSweepSelection(current, nextRows));
      }
      setStatus("確認完了");
      return true;
    } catch (error) {
      setStatus(`確認できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    focusOnOpenRef.current = true;
  }, [open]);

  useEffect(() => {
    if (!open || judging) return;
    void rescan(true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || scanning || !focusOnOpenRef.current) return;
    const panel = document.getElementById("tab-sweep-panel");
    const primary = panel?.querySelector<HTMLButtonElement>(
      'button[data-tab-sweep-primary="true"]:not(:disabled)',
    );
    (primary ?? panel)?.focus();
    focusOnOpenRef.current = false;
  }, [open, report, scanning]);

  useEffect(() => {
    if (!judging || judgeStartedAt === null) return;
    const update = () => setJudgeElapsedSeconds(Math.max(0, Math.floor((Date.now() - judgeStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [judgeStartedAt, judging]);

  useEffect(() => {
    if (!open || closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = document.getElementById("tab-sweep-panel");
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      // Wrapping follows DOM order; the primary button is only the entry point.
      // (The primary is the footer's close button, which is also the last
      // focusable — using it as the wrap anchor would pin Tab on that one node.)
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const entry = panel.querySelector<HTMLElement>(
        'button[data-tab-sweep-primary="true"]:not(:disabled)',
      ) ?? first;
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : entry).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closing, open]);

  const rows = useMemo(() => buildSweepRows(report), [report]);
  const verdictById = useMemo(
    () => new Map(verdicts.map((verdict) => [verdict.id, verdict])),
    [verdicts],
  );
  const busy = scanning || judging || applying;
  const scannedAt = report?.scannedAt ?? Date.now();
  const selectedCount = useMemo(() => {
    const { deadIds, candidateIds } = splitSweepSelection(selection, rows);
    return deadIds.length + candidateIds.length;
  }, [rows, selection]);
  const judgeableCount = rows.filter(
    (row) => row.kind === "CANDIDATE" || (row.kind !== "DEAD" && row.tab.unnamed),
  ).length;

  const runJudge = async () => {
    if (!report || busy) return;
    const judgeTabs = [...new Map(
      [...report.candidates, ...report.unnamed].map((tab) => [tab.id, tab]),
    ).values()];
    const requestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeJudgeRequestRef.current = requestId;
    setJudging(true);
    setJudged(false);
    setJudgeErrorDetail(null);
    setJudgeStartedAt(Date.now());
    setJudgeElapsedSeconds(0);
    setJudgeTargetCount(judgeTabs.length);
    setStatus(`${judgeTabs.length}件を判定しています`);
    const ids = judgeTabs.map((tab) => tab.id);
    verdictInputsRef.current = new Map(
      judgeTabs.map((tab) => [tab.id, verdictInputKey(tab)]),
    );
    try {
      const raw = await invoke<string>("run_tab_sweep_judge", {
        prompt: buildJudgePrompt(report.candidates, report.unnamed),
        requestId,
      });
      if (activeJudgeRequestRef.current !== requestId) return;
      const parsed = parseJudgeOutputResult(raw, ids);
      if (!parsed.valid) {
        const error = formatJudgeError({ code: "parse_failed", detail: "judge output was not a complete valid JSON array" });
        setVerdicts([]);
        setJudged(false);
        setJudgeErrorDetail(error.raw);
        setStatus(error.summary);
        return;
      }
      setVerdicts(parsed.verdicts);
      setJudged(true);
      // The judge only proposes ticks — it never removes the user's own choices
      // and never gates the close button.
      setSelection((current) => applyVerdictSelection(current, rows, parsed.verdicts));
      setStatus("AI判定が完了しました。チェックは自由に変えられます");
    } catch (error) {
      if (activeJudgeRequestRef.current !== requestId) return;
      const presentation = formatJudgeError(error);
      setVerdicts([]);
      setJudged(false);
      setJudgeErrorDetail(presentation.raw);
      setStatus(presentation.summary);
    } finally {
      if (activeJudgeRequestRef.current === requestId) {
        activeJudgeRequestRef.current = null;
        setJudging(false);
        setJudgeStartedAt(null);
      }
    }
  };

  const cancelJudge = async () => {
    const requestId = activeJudgeRequestRef.current;
    if (!requestId) return;
    activeJudgeRequestRef.current = null;
    setStatus("判定を中止しています…");
    try {
      await invoke<boolean>("abort_tab_sweep_judge", { requestId });
      setStatus("判定を中止しました。必要なら再実行してください。");
    } catch (error) {
      const presentation = formatJudgeError(error);
      setStatus(presentation.summary);
      setJudgeErrorDetail(presentation.raw);
    } finally {
      setJudging(false);
      setJudgeStartedAt(null);
      setJudged(false);
      setVerdicts([]);
    }
  };

  const applyAndRefresh = async (
    plan: Parameters<typeof applySweep>[0],
    completion: (result: Awaited<ReturnType<typeof applySweep>>) => string,
  ) => {
    if (busy) return;
    setApplying(true);
    try {
      const result = await applySweep(plan);
      const refreshed = await rescan(false);
      if (refreshed) {
        setStatus(formatSweepCompletion(completion(result), result));
      }
    } catch (error) {
      setStatus(`処理できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  const closeSelected = () => {
    const { deadIds, candidateIds } = splitSweepSelection(selection, rows);
    if (deadIds.length + candidateIds.length === 0) return;
    void applyAndRefresh(
      // Candidates go through the manual channel: the two-scan safety check in
      // applySweep still runs, but no verdict is required to close them.
      { closeDeadTabIds: deadIds, manualCloseCandidateTabIds: candidateIds },
      (result) => `${result.closed}件閉じました`,
    );
  };

  if (!visible) return null;

  let renderedGroup: SweepCategory | null = null;

  return (
    <OverlayShell
      open={open}
      closing={closing}
      onClose={onClose}
      size="full"
      ariaLabel="タブ掃除"
      id="tab-sweep-panel"
    >
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>タブ掃除</div>
            <div role="status" aria-live="polite" title={status} style={{ marginTop: 2, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {judging ? `${judgeTargetCount}件を判定中 · ${judgeElapsedSeconds}秒経過` : status}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flex: "none" }}>
            <ActionButton
              disabled={busy}
              primary={rows.length === 0}
              onClick={() => void rescan(true)}
            >
              再確認
            </ActionButton>
            <button type="button" tabIndex={-1} aria-label="閉じる" onClick={onClose} style={{ ...actionButtonStyle, padding: "3px 7px", background: "transparent" }}>×</button>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {judgeErrorDetail ? (
            <details style={{ margin: "10px 16px 0", padding: "8px 10px", border: "1px solid var(--cmux-border)", borderRadius: 6, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
              <summary style={{ cursor: "pointer" }}>エラーの詳細</summary>
              <pre style={{ margin: "8px 0 0", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{judgeErrorDetail}</pre>
            </details>
          ) : null}
          {scanning && !report ? <SkeletonRows /> : null}
          {report && rows.length === 0 ? (
            <div role="status" style={{ padding: "12px 16px", color: "var(--cmux-text-secondary)", fontSize: 11 }}>
              掃除できるタブはありません
            </div>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: "8px 12px", padding: "4px 16px 12px" }}>
            {rows.map((row: SweepRow) => {
              const { tab, kind, selectable } = row;
              const checked = selection.has(tab.id);
              const verdict = verdictById.get(tab.id);
              const suggestedLabel = tab.unnamed ? verdict?.label : undefined;
              const groupHeader = renderedGroup === kind ? null : (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    marginTop: renderedGroup === null ? 8 : 14,
                    marginBottom: 4,
                    fontSize: "var(--cmux-font-size-xs)",
                    letterSpacing: "0.06em",
                    color: "var(--cmux-text-tertiary)",
                    borderBottom: "1px solid var(--cmux-border-hairline)",
                    paddingBottom: 3,
                  }}
                >
                  {groupLabels[kind]}
                </div>
              );
              renderedGroup = kind;
              return (
                <Fragment key={tab.id}>
                  {groupHeader}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto minmax(0, 1fr)",
                      gap: 9,
                      alignItems: "start",
                      padding: 10,
                      border: "1px solid var(--cmux-border)",
                      borderRadius: 8,
                      background: "var(--cmux-surface-raised)",
                      opacity: selectable ? 1 : 0.66,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectable && checked}
                      disabled={!selectable || busy}
                      aria-label={selectable
                        ? `${tabName(tab)}を閉じる対象にする`
                        : `${tabName(tab)}は${tab.lockReasons.map((reason) => lockReasonLabels[reason]).join("・")}のため閉じられません`}
                      onChange={(event) => setSelection(
                        (current) => toggleSweepSelection(current, tab.id, event.target.checked),
                      )}
                      style={{ marginTop: 2, cursor: selectable && !busy ? "pointer" : "default" }}
                    />
                    <TabIdentity
                      tab={tab}
                      scannedAt={scannedAt}
                      showActivity={kind !== "DEAD"}
                      detail={(
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 4 }}>
                          {kind === "DEAD" ? <span style={chipStyle}>プロセス終了済み</span> : null}
                          {kind === "LOCKED"
                            ? tab.lockReasons.map((reason) => (
                              <span key={reason} style={chipStyle}>{lockReasonLabels[reason]}</span>
                            ))
                            : null}
                          {verdict && verdict.verdict !== "unknown" ? (
                            <span style={{ ...chipStyle, color: "var(--cmux-accent-text)" }}>{verdictLabels[verdict.verdict]}</span>
                          ) : null}
                          {suggestedLabel ? (
                            <>
                              <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-accent-text)" }}>{`ラベル案: ${suggestedLabel}`}</span>
                              <ActionButton
                                disabled={busy}
                                ariaLabel={`${tabName(tab)}に${suggestedLabel}を適用`}
                                onClick={() => void applyAndRefresh(
                                  { renames: [{ id: tab.id, label: suggestedLabel }] },
                                  (result) => `${result.renamed}件にラベルを付けました`,
                                )}
                              >
                                適用
                              </ActionButton>
                            </>
                          ) : null}
                        </div>
                      )}
                    />
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>

        <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--cmux-border)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {judging ? (
                <ActionButton danger onClick={() => void cancelJudge()}>中止</ActionButton>
              ) : (
                <ActionButton
                  disabled={busy || judgeableCount === 0}
                  onClick={() => void runJudge()}
                >
                  {judgeErrorDetail ? "AI判定を再実行" : judged ? "AIに選ばせ直す" : "AIに選ばせる"}
                </ActionButton>
              )}
            </div>
            <div style={{ fontSize: "var(--cmux-font-size-xs)", lineHeight: 1.35, color: "var(--cmux-text-tertiary)" }}>
              各タブの画面末尾8行と作業フォルダを Claude (haiku) に送って判定します（チェックの提案のみ）
            </div>
            <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
              閉じたタブは Ctrl+Shift+T で復元できます（会話も再開されます）
            </div>
          </div>
          <ActionButton
            danger
            primary={selectedCount > 0}
            disabled={busy || selectedCount === 0}
            ariaLabel={`選択した${selectedCount}件のタブを閉じる。Ctrl+Shift+Tで復元できます`}
            onClick={closeSelected}
          >
            {`選択した${selectedCount}件を閉じる`}
          </ActionButton>
        </footer>
    </OverlayShell>
  );
}
