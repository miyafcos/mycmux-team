import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { agentCloseDialogOptions } from "../../lib/agentCloseDialog";
import {
  formatProcessStartedAt,
  groupPaneLeftovers,
  getPaneProcessTrees,
  listPaneLeftoverProcesses,
  stopPaneLeftoverProcess,
  type PaneLeftoverProcess,
  type PaneLeftoverTree,
} from "../../lib/paneLeftovers";
import { getClosedPaneEntries } from "../../stores/closedPaneStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

const buttonStyle: CSSProperties = {
  border: "1px solid var(--cmux-border)", borderRadius: 5,
  background: "var(--cmux-hover)", color: "var(--cmux-text)",
  padding: "5px 9px", fontSize: 11, whiteSpace: "nowrap", cursor: "pointer",
};

const identity = (process: PaneLeftoverProcess) => `${process.pid}:${process.startedAt}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function PaneLeftoverProcesses({ active }: { active: boolean }) {
  const [processes, setProcesses] = useState<PaneLeftoverProcess[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const scanVersion = useRef(0);
  const stoppingRef = useRef(new Set<string>());
  const workspaces = useWorkspaceListStore((state) => state.workspaces);

  const refresh = useCallback(async () => {
    const version = ++scanVersion.current;
    setLoading(true);
    setScanError(null);
    try {
      const next = await listPaneLeftoverProcesses();
      if (version === scanVersion.current) setProcesses(next);
    } catch (error) {
      if (version === scanVersion.current) setScanError(errorMessage(error));
    } finally {
      if (version === scanVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
    return () => { scanVersion.current += 1; };
  }, [active, refresh]);

  const stop = async (tree: PaneLeftoverTree) => {
    const process = tree.root;
    const key = identity(process);
    if (stoppingRef.current.has(key)) return;
    stoppingRef.current.add(key);
    setStopping(new Set(stoppingRef.current));
    setErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const accepted = await confirm(
        `${process.name}\n${process.command}\n\nこのプロセスと子プロセスを止めますか？作業中の内容は失われることがあります。`,
        { ...agentCloseDialogOptions("プロセスを止めます"), okLabel: "止める" },
      );
      if (!accepted) return;
      await stopPaneLeftoverProcess(process);
      // Invalidate a scan started before the stop so it cannot restore the row.
      scanVersion.current += 1;
      const stopped = new Set([process, ...tree.descendants].map(identity));
      setProcesses((current) => current?.filter((row) => !stopped.has(identity(row))) ?? null);
      await refresh();
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: errorMessage(error) }));
    } finally {
      stoppingRef.current.delete(key);
      setStopping(new Set(stoppingRef.current));
    }
  };

  const groups = groupPaneLeftovers(processes ?? [], workspaces, getClosedPaneEntries());
  return (
    <section aria-labelledby="pane-leftover-heading" style={{ margin: "0 16px 12px", paddingTop: 12, borderTop: "1px solid var(--cmux-border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h2 id="pane-leftover-heading" style={{ margin: 0, fontSize: 13 }}>ペインの外で動いているプロセス</h2>
        <button type="button" style={{ ...buttonStyle, opacity: loading ? 0.5 : 1 }} disabled={loading || stopping.size > 0} onClick={() => void refresh()}>再読み込み</button>
      </div>
      <p style={{ margin: "6px 0 10px", fontSize: 11, color: "var(--cmux-text-secondary)", lineHeight: 1.5 }}>ペインの中から起動され、ペインの外で動き続けているプロセスです。常駐の見張りのように残しておくものもあるので、中身を見てから止めてください。</p>
      {loading ? <div role="status" style={{ fontSize: 11, marginBottom: 6 }}>{processes === null ? "確認中" : "更新中"}</div> : null}
      {scanError ? <div role="alert" style={{ fontSize: 11, color: "var(--cmux-red)", marginBottom: 6 }}>{`確認できませんでした: ${scanError}`}</div> : null}
      <div aria-busy={loading} data-pane-leftover-list="true" style={{ opacity: loading && processes !== null ? 0.45 : 1 }}>
        {processes !== null && groups.length === 0 ? <p style={{ margin: "6px 0", fontSize: 11 }}>ペインの外で動いているプロセスはありません。</p> : null}
        {groups.map((group) => (
          <div key={group.paneSessionId} data-pane-leftover-group={group.paneSessionId}>
            <h3 style={{ margin: "10px 0 4px", fontSize: 11, fontWeight: 600, overflowWrap: "anywhere" }}>{group.title}</h3>
            {getPaneProcessTrees(group.processes).map((tree) => {
              const process = tree.root;
              const key = identity(process);
              const busy = stopping.has(key);
              return (
                <div key={key} data-pane-leftover-pid={process.pid} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: "4px 10px", padding: "7px 0", borderBottom: "1px solid var(--cmux-border-hairline)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 10px", minWidth: 0, fontSize: 11 }}>
                    <strong style={{ overflowWrap: "anywhere" }}>{process.name}</strong>
                    <span style={{ color: "var(--cmux-text-secondary)" }}>{`起動 ${formatProcessStartedAt(process.startedAt)}`}</span>
                    {tree.descendants.length > 0 ? <span style={{ color: "var(--cmux-text-secondary)" }}>{`子プロセス ${tree.descendants.length} 件`}</span> : null}
                    <span style={{ color: "var(--cmux-text-secondary)" }}>{`メモリ ${(tree.memoryBytes / 1024 / 1024).toFixed(1)} MB`}</span>
                    <code style={{ flex: "1 1 200px", minWidth: 0, fontFamily: "var(--cmux-font-mono, monospace)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{process.command}</code>
                  </div>
                  <button type="button" aria-label={`${process.name}を止める`} disabled={busy || loading || !active} onClick={() => void stop(tree)} style={{ ...buttonStyle, color: "var(--cmux-red)", opacity: busy || loading ? 0.5 : 1 }}>{busy ? "停止中" : "止める"}</button>
                  {errors[key] ? <div role="alert" style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--cmux-red)", overflowWrap: "anywhere" }}>{errors[key]}</div> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
