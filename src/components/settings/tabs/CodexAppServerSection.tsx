import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  closeCodexExperiment, codexExperimentCommand, getAgentAdapterCapabilities,
  getCodexExperimentStatus, setCodexExperimentEnabled, startCodexExperiment,
  type AdapterOperation, type CapabilitySnapshot, type ExperimentActionResult, type ExperimentSnapshot,
} from "../../../lib/agentAdapterApi";
import { useSettingsStore } from "../../../stores/settingsStore";

const box: CSSProperties = {
  display: "grid", gap: "var(--cmux-space-4)", padding: "var(--cmux-space-6)",
  border: "1px solid var(--cmux-border-hairline)", borderRadius: "var(--cmux-radius-card)",
  fontSize: "var(--cmux-font-size-sm)", lineHeight: "var(--cmux-line-height-ui)",
  color: "var(--cmux-text)", overflowWrap: "anywhere", marginTop: "var(--cmux-space-6)",
};
const button: CSSProperties = { padding: "var(--cmux-space-2) var(--cmux-space-4)", fontSize: "inherit" };
const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: "inherit" };
const operationLabels: Record<AdapterOperation, string> = {
  start: "起動", resume: "再開", fork: "分岐", send: "送信", steer: "途中指示",
  interrupt: "中断", readEvents: "出来事の読み取り", usage: "使用量",
};
const levelLabels = { enforced: "強制できる", requestedOnly: "頼むだけ", unsupported: "未対応", unverified: "未確認" };
const phaseLabels: Record<string, string> = {
  submitted: "送信済み", accepted: "受理", started: "開始", completed: "完了",
  interrupted: "中断完了", failed: "失敗", rejected: "拒否", unknown: "不明",
};
function timestamp(value: number | null) { return value === null ? "未確認" : new Date(value).toLocaleTimeString(); }

/** An explicit settings trial, separate from ordinary agent panes and their input. */
export function CodexAppServerSection() {
  const enabled = useSettingsStore((s) => s.codexAppServerExperimentEnabled === true);
  const setEnabled = useSettingsStore((s) => s.setCodexAppServerExperimentEnabled);
  const [snapshot, setSnapshot] = useState<ExperimentSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshot | null>(null);
  const [actionResult, setActionResult] = useState<ExperimentActionResult | null>(null);
  const [cwd, setCwd] = useState("");
  const [executable, setExecutable] = useState("");
  const [text, setText] = useState("Do not use tools or change files. Reply with exactly MYCMUX_O2_OK.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const running = useRef(false);
  const sendId = useRef<string | null>(null);
  const polling = useRef(false);

  const refresh = async () => {
    const [next, declarations] = await Promise.all([getCodexExperimentStatus(), getAgentAdapterCapabilities()]);
    if (next.version !== 1 || declarations.version !== 1) throw new Error("未対応の試験データの版です。");
    if (mounted.current) { setSnapshot(next); setCapabilities(declarations); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError("試験の状態を確認できませんでした。"); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (snapshot?.processState !== "running") return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void getCodexExperimentStatus().then((next) => {
        if (!cancelled && mounted.current) setSnapshot(next);
      }).catch(() => {
        if (!cancelled && mounted.current) setError("試験の状態を確認できませんでした。再確認してください。");
      }).finally(() => { polling.current = false; });
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [snapshot?.processState]);

  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try { await work(); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
    finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggle = (next: boolean) => void run(async () => {
    const current = await setCodexExperimentEnabled(next);
    setEnabled(next);
    if (mounted.current) { setSnapshot(current); setActionResult(null); }
    await refresh();
  });
  const connect = () => void run(async () => {
    await setCodexExperimentEnabled(true);
    const current = await startCodexExperiment(cwd.trim(), executable);
    if (mounted.current) { setSnapshot(current); setActionResult(null); }
    sendId.current = null;
    await refresh();
  });
  const command = (operation: "send" | "steer" | "interrupt") => void run(async () => {
    if (!enabled || snapshot?.processState !== "running") return;
    const expectedTurnId = snapshot.delivery?.turnId;
    if (operation !== "send" && !expectedTurnId) return;
    if (operation === "send") sendId.current ??= crypto.randomUUID();
    const result = await codexExperimentCommand({
      operation, operationId: operation === "send" ? sendId.current! : crypto.randomUUID(),
      ...(operation !== "send" ? { expectedTurnId: expectedTurnId! } : {}),
      ...(operation !== "interrupt" ? { text } : {}),
    });
    if (mounted.current) {
      setActionResult(result);
      if (result.error || result.control?.error) setError(result.error ?? result.control!.error!);
    }
    await refresh();
  });
  const connected = snapshot?.processState === "running";
  const delivery = snapshot?.delivery;
  const active = connected && delivery?.turnId && delivery.completedAtMs === null
    && ["accepted", "started"].includes(delivery.status);
  const adapter = capabilities?.adapters.find((entry) => entry.mode === "appServerStdioExperiment");

  return <section aria-label="Codex の接続試験" aria-busy={busy} style={box}>
    <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>Codex の接続試験</h3>
    <label>
      <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => toggle(event.target.checked)} />
      標準入出力の接続試験を使う（既定はオフ）
    </label>
    <p style={{ margin: 0 }}>
      Codex 0.160.0 で短い会話を 1 件試します。通常の Codex の使用枠を消費します。
      接続後に送信してください。受理・開始・完了を分けて表示します。
    </p>
    {enabled && <>
      <label>作業フォルダ（絶対パス）
        <input aria-label="試験の作業フォルダ" style={field} value={cwd} disabled={busy || connected}
          onChange={(event) => setCwd(event.target.value)} spellCheck={false} />
      </label>
      <details>
        <summary>Codex の実行ファイルを指定する</summary>
        <label>省略時は自動で探します。Windows ではネイティブの .exe を指定してください。
          <input aria-label="試験の Codex 実行ファイル" style={field} value={executable} disabled={busy || connected}
            onChange={(event) => setExecutable(event.target.value)} spellCheck={false} />
        </label>
      </details>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-3)" }}>
        <button style={button} disabled={busy || connected || !cwd.trim()} onClick={connect}>試験に接続</button>
        <button style={button} disabled={busy || !connected} onClick={() => void run(async () => {
          const current = await closeCodexExperiment();
          if (mounted.current) setSnapshot(current);
        })}>接続を閉じる</button>
      </div>
      {connected && <label>試験のメッセージ
        <textarea aria-label="試験のメッセージ" style={{ ...field, minHeight: 76 }} value={text} disabled={busy}
          onChange={(event) => setText(event.target.value)} maxLength={16384} />
      </label>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-3)" }}>
        <button style={button} disabled={busy || !connected || !text.trim() || !!delivery} onClick={() => command("send")}>1 件送信</button>
        <button style={button} disabled={busy || !active || !text.trim()} onClick={() => command("steer")}>途中指示</button>
        <button style={button} disabled={busy || !active} onClick={() => command("interrupt")}>ターンを中断</button>
      </div>
      <p style={{ margin: 0 }}>再開と分岐は未対応です。途中指示の受理は、その指示を使い終えたという意味ではありません。
        中断は完了の出来事を待って確認します。不明な送信は自動で再送しません。</p>
    </>}
    {snapshot && <div role="status">
      <div>接続：{connected ? "接続中" : snapshot.processState === "notStarted" ? "未接続" : "閉じています"} /
        状態：{({ active: "作業中", idle: "入力待ち", unknown: "未確認", notLoaded: "読み込み前", systemError: "エラー" } as Record<string, string>)[snapshot.agentState] ?? "未確認"}</div>
      {snapshot.cliVersion && <div>確認した版：{snapshot.cliVersion}</div>}
      {snapshot.threadId && <div>会話 ID：{snapshot.threadId}</div>}
      {delivery && <>
        <div>送信 ID：{delivery.operationId} / 要求 ID：{delivery.requestId}</div>
        <div>ターン ID：{delivery.turnId ?? "未確認"} / {phaseLabels[delivery.status] ?? "不明"}</div>
        <table style={{ fontSize: "inherit" }}><tbody>
          <tr><th scope="row">送信済み</th><td>{timestamp(delivery.submittedAtMs)}</td></tr>
          <tr><th scope="row">受理</th><td>{timestamp(delivery.acceptedAtMs)}</td></tr>
          <tr><th scope="row">開始</th><td>{timestamp(delivery.startedAtMs)}</td></tr>
          <tr><th scope="row">終了</th><td>{timestamp(delivery.completedAtMs)}</td></tr>
        </tbody></table>
      </>}
    </div>}
    {actionResult?.control && <div>操作 {actionResult.control.operationId}：{phaseLabels[actionResult.control.status] ?? "不明"}
      （実行結果は出来事で確認）</div>}
    {snapshot?.reply && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{snapshot.reply}</pre>}
    {snapshot?.replyTruncated && <div>応答は表示の上限で省略しています。</div>}
    {snapshot?.configuration.observed && <details>
      <summary>指定値と確認した適用値</summary>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "inherit" }}>{JSON.stringify(snapshot.configuration, null, 2)}</pre>
    </details>}
    {adapter && <details><summary>この接続でできること（確認した範囲）</summary>
      <table style={{ fontSize: "inherit", width: "100%" }}><tbody>
        {(Object.keys(operationLabels) as AdapterOperation[]).map((operation) => <tr key={operation}>
          <th scope="row" style={{ textAlign: "left" }}>{operationLabels[operation]}</th>
          <td>{levelLabels[adapter.operations[operation]?.level] ?? "未確認"}</td>
        </tr>)}
      </tbody></table>
      {adapter.testedScope.map((scope) => <p key={scope} style={{ margin: 0 }}>{scope}</p>)}
    </details>}
    {snapshot && <details><summary>使用量（料金は未確認）</summary>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "inherit" }}>{JSON.stringify(snapshot.usage, null, 2)}</pre>
    </details>}
    {!!snapshot?.events.length && <details><summary>出来事の列</summary>
      <ol style={{ margin: 0 }}>{snapshot.events.map((event) => <li key={event.sequence}>
        {timestamp(event.atMs)} {event.method} / {event.source} {event.operationId ?? ""}
      </li>)}</ol>
    </details>}
    {(error || snapshot?.error) && <div role="alert">{error || snapshot?.error}</div>}
    <button style={button} disabled={busy} onClick={() => void run(refresh)}>試験の状態を再確認</button>
  </section>;
}
