import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  applySweep,
  buildJudgePrompt,
  parseJudgeOutput,
  scanTabs,
  type SweepLockReason,
  type SweepReport,
  type SweepTab,
  type Verdict,
} from "./tabSweep";

interface TabSweepPanelProps {
  closing?: boolean;
  onClose: () => void;
  onDeadCountChange?: (count: number) => void;
}

const lockReasonLabels: Record<SweepLockReason, string> = {
  queued_input: "未送信の指示あり",
  recent_output: "5分以内に出力",
  active: "表示中",
  working: "作業中",
  buffer_unavailable: "画面を確認できない",
  not_at_prompt: "プロンプト待機ではない",
  unsupported_tab: "対象外のタブ",
};

const verdictLabels: Record<Exclude<Verdict["verdict"], "unknown">, string> = {
  done_waiting: "完了待機",
  queued_input: "未送信あり",
  working: "作業中",
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

function ActionButton({
  children,
  danger = false,
  disabled = false,
  onClick,
  ariaLabel,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ padding: "12px 16px", borderBottom: "1px solid var(--cmux-border-hairline)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 650, color: "var(--cmux-text)" }}>{title}</h3>
        {action}
      </div>
      <div style={{ display: "grid", gap: 6 }}>{children}</div>
    </section>
  );
}

function TabIdentity({ tab, detail }: { tab: SweepTab; detail?: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--cmux-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tab.label?.trim() || "無名タブ"}
      </div>
      <div style={{ marginTop: 2, fontSize: 10, color: "var(--cmux-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tab.workspaceName}{tab.cwd ? ` · ${tab.cwd}` : ""}
      </div>
      {detail}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <div style={{ color: "var(--cmux-text-tertiary)", fontSize: 11, padding: "4px 0" }}>{children}</div>;
}

function verdictInputKey(tab: SweepTab): string {
  return JSON.stringify([tab.category, tab.unnamed, tab.label ?? "", tab.cwd ?? "", tab.tail]);
}

export function TabSweepPanel({ closing = false, onClose, onDeadCountChange }: TabSweepPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const verdictInputsRef = useRef(new Map<string, string>());
  const [report, setReport] = useState<SweepReport | null>(null);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [judged, setJudged] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [judging, setJudging] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState("タブを確認しています…");

  const rescan = useCallback(async (clearJudge = true): Promise<boolean> => {
    setScanning(true);
    try {
      const next = await scanTabs();
      setReport(next);
      onDeadCountChange?.(next.dead.length);
      if (clearJudge) {
        verdictInputsRef.current.clear();
        setVerdicts([]);
        setJudged(false);
      } else {
        const currentById = new Map(next.tabs.map((tab) => [tab.id, tab]));
        setVerdicts((current) => current.filter((verdict) => {
          const tab = currentById.get(verdict.id);
          return tab !== undefined
            && verdictInputsRef.current.get(verdict.id) === verdictInputKey(tab);
        }));
      }
      setStatus("確認完了");
      return true;
    } catch (error) {
      setStatus(`確認できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setScanning(false);
    }
  }, [onDeadCountChange]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!closing) {
      panelRef.current?.focus();
      void rescan();
    }
  }, [closing, rescan]);

  useEffect(() => {
    if (closing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panelRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
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
  }, [closing, onClose]);

  const verdictById = useMemo(
    () => new Map(verdicts.map((verdict) => [verdict.id, verdict])),
    [verdicts],
  );
  const doneCandidates = report?.candidates.filter(
    (tab) => verdictById.get(tab.id)?.verdict === "done_waiting",
  ) ?? [];
  const labelSuggestions = report?.unnamed.flatMap((tab) => {
    const label = verdictById.get(tab.id)?.label;
    return label ? [{ tab, label }] : [];
  }) ?? [];
  const busy = scanning || judging || applying;

  const runJudge = async () => {
    if (!report || busy) return;
    setJudging(true);
    setStatus("AIで判定しています…");
    const judgeTabs = [...new Map(
      [...report.candidates, ...report.unnamed].map((tab) => [tab.id, tab]),
    ).values()];
    const ids = judgeTabs.map((tab) => tab.id);
    verdictInputsRef.current = new Map(
      judgeTabs.map((tab) => [tab.id, verdictInputKey(tab)]),
    );
    try {
      const raw = await invoke<string>("run_tab_sweep_judge", {
        prompt: buildJudgePrompt(report.candidates, report.unnamed),
      });
      setVerdicts(parseJudgeOutput(raw, ids));
      setJudged(true);
      setStatus("AI判定が完了しました");
    } catch (error) {
      setVerdicts(parseJudgeOutput("", ids));
      setJudged(true);
      setStatus(`AI判定に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setJudging(false);
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
        setStatus(result.errors.length > 0
          ? `${completion(result)}（${result.errors.length}件は処理できませんでした）`
          : completion(result));
      }
    } catch (error) {
      setStatus(`処理できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--cmux-backdrop)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id="tab-sweep-panel"
        className={`cmux-overlay-panel${closing ? " is-closing" : ""}`}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="タブ掃除"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 32px))",
          height: "min(680px, calc(100vh - 64px))",
          background: "var(--cmux-popover)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 10,
          boxShadow: "var(--cmux-shadow-dialog)",
          color: "var(--cmux-text)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>タブ掃除</div>
            <div role="status" aria-live="polite" style={{ marginTop: 2, fontSize: 10, color: "var(--cmux-text-secondary)" }}>{status}</div>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose} style={{ ...actionButtonStyle, padding: "3px 7px", background: "transparent" }}>×</button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <Section
            title={`① 即掃除できる${report ? ` (${report.dead.length})` : ""}`}
            action={(
              <ActionButton
                danger
                disabled={busy || !report || report.dead.length === 0}
                onClick={() => void applyAndRefresh(
                  { closeDeadTabIds: report?.dead.map((tab) => tab.id) ?? [] },
                  (result) => `${result.closed}件閉じました`,
                )}
              >
                全部閉じる
              </ActionButton>
            )}
          >
            {report?.dead.map((tab) => <TabIdentity key={tab.id} tab={tab} />)}
            {report && report.dead.length === 0 && <EmptyRow>ありません</EmptyRow>}
          </Section>

          <Section
            title={`② AI 判定候補${report ? ` (${report.candidates.length})` : ""}`}
            action={(
              <div style={{ display: "flex", gap: 6 }}>
                {judged && (
                  <ActionButton
                    disabled={busy || doneCandidates.length === 0}
                    onClick={() => void applyAndRefresh(
                      {
                        closeCandidateTabIds: doneCandidates.map((tab) => tab.id),
                        verdicts,
                      },
                      (result) => `${result.closed}件閉じました`,
                    )}
                  >
                    完了判定をまとめて閉じる
                  </ActionButton>
                )}
                <ActionButton disabled={busy || !report || (report.candidates.length === 0 && report.unnamed.length === 0)} onClick={() => void runJudge()}>
                  AI判定を実行
                </ActionButton>
              </div>
            )}
          >
            {report?.candidates.map((tab) => {
              const verdict = verdictById.get(tab.id);
              return (
                <div key={tab.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
                  <TabIdentity
                    tab={tab}
                    detail={verdict && verdict.verdict !== "unknown" ? (
                      <div style={{ marginTop: 3, fontSize: 10, color: "var(--cmux-accent)" }}>{verdictLabels[verdict.verdict]}</div>
                    ) : undefined}
                  />
                  {judged && (
                    <ActionButton
                      disabled={busy || verdict?.verdict !== "done_waiting"}
                      ariaLabel={`${tab.label?.trim() || "無名タブ"}を閉じる`}
                      onClick={() => void applyAndRefresh(
                        { closeCandidateTabIds: [tab.id], verdicts },
                        (result) => `${result.closed}件閉じました`,
                      )}
                    >
                      閉じる
                    </ActionButton>
                  )}
                </div>
              );
            })}
            {report && report.candidates.length === 0 && <EmptyRow>ありません</EmptyRow>}
          </Section>

          <Section title={`③ ロック中${report ? ` (${report.locked.length})` : ""}`}>
            {report?.locked.map((tab) => (
              <TabIdentity
                key={tab.id}
                tab={tab}
                detail={(
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {tab.lockReasons.map((reason) => (
                      <span key={reason} style={{ padding: "2px 6px", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-text-secondary)", fontSize: 9 }}>
                        {lockReasonLabels[reason]}
                      </span>
                    ))}
                  </div>
                )}
              />
            ))}
            {report && report.locked.length === 0 && <EmptyRow>ありません</EmptyRow>}
          </Section>

          {judged && (
            <Section
              title={`④ 無名タブのラベル案 (${labelSuggestions.length})`}
              action={(
                <ActionButton
                  disabled={busy || labelSuggestions.length === 0}
                  onClick={() => void applyAndRefresh(
                    { renames: labelSuggestions.map(({ tab, label }) => ({ id: tab.id, label })) },
                    (result) => `${result.renamed}件にラベルを付けました`,
                  )}
                >
                  全部適用
                </ActionButton>
              )}
            >
              {labelSuggestions.map(({ tab, label }) => (
                <div key={tab.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 10, alignItems: "center" }}>
                  <TabIdentity tab={tab} />
                  <span style={{ fontSize: 11, color: "var(--cmux-accent)" }}>{label}</span>
                  <ActionButton
                    disabled={busy}
                    ariaLabel={`${tab.label?.trim() || "無名タブ"}に${label}を適用`}
                    onClick={() => void applyAndRefresh(
                      { renames: [{ id: tab.id, label }] },
                      (result) => `${result.renamed}件にラベルを付けました`,
                    )}
                  >
                    適用
                  </ActionButton>
                </div>
              ))}
              {labelSuggestions.length === 0 && <EmptyRow>提案はありません</EmptyRow>}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
