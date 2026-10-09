import { useAgentDormancyStore } from "../../stores/agentDormancyStore";

/** The existing sweep overlay is also the pressure review surface. */
export function AgentDormancyCandidates() {
  const proposals = useAgentDormancyStore((state) => state.proposals);
  const approvals = useAgentDormancyStore((state) => state.approvals);
  const sample = useAgentDormancyStore((state) => state.sample);
  const approve = useAgentDormancyStore((state) => state.approve);
  if (proposals.length === 0) return null;
  return <section aria-label="休止候補" style={{ padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)", fontSize: "var(--cmux-font-size-sm)" }}>
    <strong>休止候補・確認してからプロセスを終了</strong>
    <p>空きメモリ {sample.availableMemoryMiB ?? "不明"} MiB・全ペイン {sample.paneCount} 件。会話は再開できますが、プロセスの実行状態は戻りません。</p>
    <div style={{ display: "grid", gap: 8 }}>
      {proposals.map((proposal) => <div key={proposal.sessionId} style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-card)" }}>
        <div style={{ flex: 1 }}>
          <strong>{proposal.label}</strong> · {proposal.workspaceName}
          <div>{proposal.stage === "severe" ? "強いメモリ圧または席数の増加" : "メモリ圧または席数の増加"}・{proposal.idleMinutes}分間、作業の変化なし</div>
        </div>
        <button type="button" disabled={Boolean(approvals[proposal.sessionId])} onClick={() => approve(proposal.sessionId)}>
          {approvals[proposal.sessionId] ? "状態を再確認中…" : "確認して休止"}
        </button>
      </div>)}
    </div>
  </section>;
}
