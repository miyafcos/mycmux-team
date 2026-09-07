import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  claudeSkillsInstall, claudeSkillsStatus,
  type ClaudeSkillsInstallResult, type ClaudeSkillsStatus, type SkillState,
} from "../../../lib/claudeSkillsApi";

// Keep copy together, following launcherTabStrings without adding an out-of-scope file.
const strings = {
  title: "Claude Code スキル",
  labels: { "not-installed": "未導入", latest: "最新", outdated: "更新あり", "locally-modified": "ローカル改変" },
  descriptions: {
    "session-dispatch": "指示書を作り、可視タブへの委譲と完了を確認",
    "mycmux-bridge": "タブの状態を読み、メッセージや質問回答を渡す",
    oracmux: "引き継ぎ文書を作り、Web ペインで相談",
  } as Record<string, string>,
  install: "導入", update: "更新", replace: "退避して置き換える",
  confirm: "旧フォルダを `.bak-*` に退避して置き換えます",
  execute: "実行", cancel: "やめる", busy: "導入中…", loading: "確認中…",
  readme: "使い方 (README)", retry: "再確認",
  python: "Python は python.org から 3.10 以上を導入してください。",
  claude: "Claude Code の導入: npm install -g @anthropic-ai/claude-code",
};
const readme = "https://github.com/miyafcos/mycmux-team/blob/master/skills/claude/README.md";
const chipStyle: CSSProperties = {
  borderRadius: "var(--cmux-radius-pill)", padding: "var(--cmux-space-1) var(--cmux-space-3)",
  background: "var(--cmux-surface-raised)", color: "var(--cmux-text)",
  fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap", display: "inline-block",
};
const buttonStyle: CSSProperties = { padding: "var(--cmux-space-2) var(--cmux-space-4)", fontSize: "var(--cmux-font-size-sm)" };
function Chip({ state }: { state: SkillState }) {
  return <span style={chipStyle}>{strings.labels[state]}</span>;
}
export function ClaudeSkillsSection() {
  const [status, setStatus] = useState<ClaudeSkillsStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<ClaudeSkillsInstallResult | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const refresh = async () => {
    try {
      const next = await claudeSkillsStatus();
      if (mounted.current) { setStatus(next); setError(""); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, []);
  const run = async (state: SkillState, force: boolean) => {
    if (!status || running.current) return;
    running.current = true;
    setBusy(true);
    setConfirm(false);
    setError("");
    setResult(null);
    try {
      const next = await claudeSkillsInstall(status.skills.filter((skill) => skill.state === state).map((skill) => skill.name), force);
      if (mounted.current) setResult(next);
      await refresh();
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const has = (state: SkillState) => status?.skills.some((skill) => skill.state === state) || status?.cli.state === state;
  return (
    <section aria-label={strings.title} aria-busy={busy} style={{
      display: "grid", gap: "var(--cmux-space-5)", padding: "var(--cmux-space-6)",
      border: "1px solid var(--cmux-border-hairline)", borderRadius: "var(--cmux-radius-card)",
      fontSize: "var(--cmux-font-size-sm)", lineHeight: "var(--cmux-line-height-ui)",
      color: "var(--cmux-text)", overflowWrap: "anywhere", opacity: busy ? 0.5 : 1,
    }}>
      <h3 style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-4)", fontSize: "var(--cmux-font-size-md)" }}>
        {strings.title}{has("outdated") && <Chip state="outdated" />}
      </h3>
      {!status && !error && <div>{strings.loading}</div>}
      {status && <>
        <div>
          <div>{status.prereq.claude.found ? "○" : "×"} Claude Code: {status.prereq.claude.detail}</div>
          {!status.prereq.claude.found && <div>{strings.claude}</div>}
          <div>{status.prereq.python.found ? "○" : "×"} Python: {status.prereq.python.detail}</div>
          {!status.prereq.python.found && <div>{strings.python}</div>}
        </div>
        <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", textAlign: "left" }}>
          <thead><tr><th style={{ width: "30%" }}>名前</th><th>用途</th><th style={{ width: "28%" }}>状態</th></tr></thead>
          <tbody>
            {status.skills.map((skill) => <tr key={skill.name}>
              <td style={{ padding: "var(--cmux-space-2)" }}>{skill.name}</td>
              <td style={{ padding: "var(--cmux-space-2)" }}>{strings.descriptions[skill.name]}</td>
              <td><Chip state={skill.state} /></td>
            </tr>)}
            <tr><td style={{ padding: "var(--cmux-space-2)" }}>agent CLI</td><td>スキル共通の操作ツール</td><td><Chip state={status.cli.state} /></td></tr>
          </tbody>
        </table>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cmux-space-4)" }}>
          {has("not-installed") && <button style={buttonStyle} disabled={busy} onClick={() => void run("not-installed", false)}>{strings.install}</button>}
          {has("outdated") && <button style={buttonStyle} disabled={busy} onClick={() => void run("outdated", false)}>{strings.update}</button>}
          {has("locally-modified") && <button style={buttonStyle} disabled={busy} onClick={() => setConfirm(true)}>{strings.replace}</button>}
          {busy && <span role="status">{strings.busy}</span>}
        </div>
        {confirm && <div>
          <div>{strings.confirm}</div>
          <div style={{ display: "flex", gap: "var(--cmux-space-4)" }}>
            <button style={buttonStyle} disabled={busy} onClick={() => void run("locally-modified", true)}>{strings.execute}</button>
            <button style={buttonStyle} disabled={busy} onClick={() => setConfirm(false)}>{strings.cancel}</button>
          </div>
        </div>}
      </>}
      {result && <div role="status">
        <div>導入・更新 {result.installed.length} 件 / 変更なし {result.skipped.length} 件 / エラー {result.errors.length} 件</div>
        {result.backups.length > 0 && <div>退避: {result.backups.map((path) => path.split(/[\\/]/).pop()).join("、")}</div>}
        {result.errors.length > 0 && <div role="alert">{result.errors.join(" / ")}</div>}
      </div>}
      {error && <div role="alert">{error} <button style={buttonStyle} disabled={busy} onClick={() => void refresh()}>{strings.retry}</button></div>}
      <a href={readme} onClick={(event) => { event.preventDefault(); void open(readme).catch((cause) => setError(String(cause))); }}
        style={{ color: "var(--cmux-accent-text)" }}>{strings.readme}</a>
    </section>
  );
}
