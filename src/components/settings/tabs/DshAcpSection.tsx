import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  answerDshPermission, cancelDshPrompt, closeDshSession, getDshExperimentStatus,
  sendDshPrompt, setDshExperimentEnabled, startDshExperiment, stopDshOwnedProcess,
  type DshRunRef, type DshState,
} from "../../../lib/agentAdapterApi";
import { useSettingsStore } from "../../../stores/settingsStore";

const box: CSSProperties = {
  display: "grid", gap: "var(--cmux-space-4)", padding: "var(--cmux-space-6)",
  marginTop: "var(--cmux-space-6)", border: "1px solid var(--cmux-border-hairline)",
  borderRadius: "var(--cmux-radius-card)", fontSize: "var(--cmux-font-size-sm)",
  lineHeight: "var(--cmux-line-height-ui)", color: "var(--cmux-text)", overflowWrap: "anywhere",
};
const field: CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: "inherit" };
const button: CSSProperties = { fontSize: "inherit", padding: "var(--cmux-space-2) var(--cmux-space-4)" };
const phases: Record<string, string> = {
  submitted: "送信済み（受理は未確認）", observed: "更新を観測", settled: "静止を確認",
  cancelled: "中断を確認", rejected: "拒否", unknown: "不明（自動再送しません）",
};
const time = (value: number | null) => value === null ? "未確認" : new Date(value).toLocaleTimeString();
function visibleText(value: string) {
  return value.split("\n").map((line) => /API_KEY|ACCESS_TOKEN|AUTHORIZATION|PASSWORD|CLIENT_SECRET|BEARER |CREDENTIAL/i.test(line)
    ? "[非表示]" : line.replace(/sk-[^\s]+|ghp_[^\s]+|github_pat_[^\s]+|eyJ[^\s]+/g, "[非表示]")).join("\n");
}

/** Only the opt-in switch is visible while disabled. Opening settings never launches dsh. */
export function DshAcpSection() {
  const enabled = useSettingsStore((s) => s.dshAcpExperimentEnabled === true);
  const executable = useSettingsStore((s) => s.dshAcpExecutablePath);
  const dshHome = useSettingsStore((s) => s.dshAcpHomePath);
  const saved = useSettingsStore((s) => s.dshAcpSavedRun);
  const [snapshot, setSnapshot] = useState<DshState | null>(null);
  const [cwd, setCwd] = useState(saved?.cwd ?? "");
  const [text, setText] = useState("Do not use tools or change files. Reply with exactly MYCMUX_DSH_OK.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const owned = useRef<DshRunRef | null>(null);
  const running = useRef(false);
  const polling = useRef(false);
  const previousEnabled = useRef(false);
  const revision = useRef(0);
  const sendId = useRef<string | null>(null);

  const receive = (next: DshState) => {
    if (next.version !== 1) throw new Error("Unsupported dsh experiment version");
    if (!mounted.current) {
      if (next.run && next.process === "running") void stopDshOwnedProcess(next.run).catch(() => {});
      return;
    }
    if (next.delivery?.settledAtMs != null && ["settled", "cancelled", "rejected"].includes(next.delivery.status)) sendId.current = null;
    owned.current = next.process === "running" ? next.run : null;
    setSnapshot(next);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
      const run = owned.current;
      owned.current = null;
      if (run) void stopDshOwnedProcess(run).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!enabled) {
      if (previousEnabled.current) {
        void setDshExperimentEnabled(false).then(receive).catch(() => {
          if (mounted.current) setError("試験の停止を確認できませんでした。状態を再確認してください。");
        });
      }
      previousEnabled.current = false;
      return;
    }
    previousEnabled.current = true;
    let cancelled = false;
    const refresh = async () => {
      if (polling.current) return;
      const requestRevision = revision.current;
      polling.current = true;
      try {
        const next = await getDshExperimentStatus();
        if (!cancelled && mounted.current && requestRevision === revision.current) receive(next);
      } catch {
        if (!cancelled && mounted.current) setError("試験の状態を確認できませんでした。");
      } finally { polling.current = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);

  const runAction = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try { await work(); }
    catch {
      if (mounted.current) setError("操作の結果を確認できませんでした。状態を再確認してください。送信は自動で繰り返しません。");
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggle = (next: boolean) => void runAction(async () => {
    receive(await setDshExperimentEnabled(next));
    if (!mounted.current) return;
    previousEnabled.current = next;
    useSettingsStore.getState().setDshAcpExperimentEnabled(next);
  });
  const connect = (resume: boolean) => void runAction(async () => {
    await setDshExperimentEnabled(true);
    if (!mounted.current) return;
    const current = await startDshExperiment({ executable: executable.trim(), cwd: resume ? saved!.cwd : cwd.trim(),
      dshHome: dshHome.trim() || null, resume: resume ? saved : null });
    receive(current);
    if (mounted.current && current.run?.convId) useSettingsStore.getState().setDshAcpSavedRun(current.run);
    sendId.current = null;
  });
  const send = () => void runAction(async () => {
    if (!snapshot?.run || snapshot.activity !== "quiescent" || snapshot.sessionClosed) return;
    sendId.current ??= crypto.randomUUID();
    const receipt = await sendDshPrompt({ expectedRun: snapshot.run, operationId: sendId.current, text });
    if (mounted.current) setSnapshot((prior) => prior ? { ...prior, activity: "pending", confidence: "inferred", delivery: receipt } : prior);
    receive(await getDshExperimentStatus());
  });

  const connected = snapshot?.process === "running";
  const active = connected && !snapshot.sessionClosed && snapshot.activity === "pending";
  const ready = connected && !snapshot.sessionClosed && snapshot.activity === "quiescent";
  const receipt = snapshot?.delivery;
  const switchControl = <label style={{ fontSize: "var(--cmux-font-size-sm)" }}>
    <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => toggle(event.target.checked)} />
    DeepSeek Harness の接続試験を使う（既定はオフ）
  </label>;
  if (!enabled) return <>{switchControl}{error && <div role="alert">{error}</div>}</>;

  return <section aria-label="DeepSeek Harness の接続試験" aria-busy={busy} style={box}>
    {switchControl}
    <h3 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>DeepSeek Harness の接続試験</h3>
    <p style={{ margin: 0 }}>用意した固定版を使います。接続時の取得は行いません。認証とモデルは dsh 本人の設定で管理してください。</p>
    <label>実行ファイル（絶対パス）
      <input aria-label="dsh 実行ファイル" style={field} value={executable} disabled={busy || connected}
        onChange={(event) => useSettingsStore.getState().setDshAcpExecutablePath(event.target.value)} spellCheck={false} />
    </label>
    <div>profile：acp / 必要な版：{snapshot?.requiredExecutableVersion ?? "0.2.0-rc.2"} / 確認した実行ファイルの版：{snapshot?.executableVersion ?? "未確認"}</div>
    <div>ACP の内部版：{snapshot?.agentInfoVersion ?? "未確認"}（実行ファイルの版とは別です） / 実配布版の ACP と Windows：未確認</div>
    <label>DSH_HOME（場所への参照・省略可）
      <input aria-label="dsh 設定フォルダの参照" style={field} value={dshHome} disabled={busy || connected}
        onChange={(event) => useSettingsStore.getState().setDshAcpHomePath(event.target.value)} spellCheck={false} />
    </label>
    <label>作業フォルダ（絶対パス）
      <input aria-label="dsh 作業フォルダ" style={field} value={cwd} disabled={busy || connected}
        onChange={(event) => setCwd(event.target.value)} spellCheck={false} />
    </label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-3)" }}>
      <button style={button} disabled={busy || connected || !cwd.trim() || !executable.trim()} onClick={() => connect(false)}>新しい会話に接続</button>
      <button style={button} disabled={busy || connected || !saved?.convId || !executable.trim()} onClick={() => connect(true)}>保存した会話を再開</button>
      <button style={button} disabled={busy || !connected || snapshot.sessionClosed || snapshot.activity === "unknown"}
        onClick={() => void runAction(async () => { receive(await closeDshSession(snapshot!.run!)); })}>会話を閉じる</button>
      <button style={button} disabled={busy || !snapshot?.run}
        onClick={() => void runAction(async () => { receive(await stopDshOwnedProcess(snapshot!.run)); })}>接続プロセスを止める</button>
    </div>
    {saved?.convId && <div>保存した会話 ID：{visibleText(saved.convId)} / 作業フォルダ：{saved.cwd}</div>}
    <label>試験のメッセージ
      <textarea aria-label="dsh 試験のメッセージ" style={{ ...field, minHeight: 76 }} value={text} maxLength={16384}
        disabled={busy || !ready} onChange={(event) => setText(event.target.value)} />
    </label>
    <div>
      <button style={button} disabled={busy || !ready || !text.trim() || sendId.current !== null} onClick={send}>1 件送信</button>
      <button style={button} disabled={busy || !active || !!receipt?.cancelRequested}
        onClick={() => void runAction(async () => { receive(await cancelDshPrompt(snapshot!.run!)); })}>ターンを中断</button>
    </div>
    {snapshot?.permissions.map((permission) => <div key={permission.permissionId} role="group" aria-label="dsh の権限確認">
      <span>この操作を 1 回だけ許可しますか。</span>
      {(["allow", "reject"] as const).map((choice) => <button key={choice} style={button}
        disabled={busy || !active || !(choice === "allow" ? permission.allowAvailable : permission.rejectAvailable)}
        onClick={() => void runAction(async () => { receive(await answerDshPermission({ expectedRun: snapshot.run!,
          permissionId: permission.permissionId, choice })); })}>{choice === "allow" ? "1 回許可" : "拒否"}</button>)}
    </div>)}
    <div role="status">接続：{connected ? "接続中" : snapshot?.process === "exited" ? "停止済み" : snapshot?.process === "unknown" ? "停止は未確認" : "未接続"} /
      状態：{snapshot?.activity === "pending" ? "作業中（要求からの推定）" : snapshot?.activity === "quiescent" ? "静止を確認" : "不明"}
      {receipt && <>
        <div>{phases[receipt.status] ?? "不明"} / 送信 ID：{receipt.operationId}</div>
        <div>送信：{time(receipt.submittedAtMs)} / 受理：未確認（独立した返答なし） / 更新：{time(receipt.observedAtMs)} / 静止：{time(receipt.settledAtMs)}</div>
        {receipt.cancelRequested && <div>中断を要求済み。対応する返答で中断を確認します。</div>}
      </>}
    </div>
    <p style={{ margin: 0 }}>読み取りはこの接続で受けた更新だけです。過去の履歴は未取得です。
      静止は作業全体の完了ではありません。不明な送信は自動で繰り返しません。
      一般の質問・分岐・途中指示・履歴の再取得は未対応、使用量は未確認です。</p>
    {snapshot?.read?.updates.map((update) => update.text && <pre key={update.sequence}
      style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: "inherit" }}>{visibleText(update.text)}</pre>)}
    {(snapshot?.read?.truncated || snapshot?.read?.gap) && <div>表示の上限で更新を省略しています。更新の列に欠落があります。</div>}
    {(error || snapshot?.error) && <div role="alert">{error || visibleText(snapshot!.error!)}</div>}
    <button style={button} disabled={busy} onClick={() => void runAction(async () => { receive(await getDshExperimentStatus()); })}>試験の状態を再確認</button>
  </section>;
}
