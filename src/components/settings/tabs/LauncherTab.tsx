import { useSettingsStore } from "../../../stores/settingsStore";
import { AGENT_CATALOG } from "../../../lib/agentCatalog";
import { shortLabel } from "../../workspace/launcherModel";
import { AgentKindIcon } from "../../icons/AgentIcons";
import { checkboxLabelStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";

// What a new tab offers. Built-in rows are hidden, never deleted: unchecking is
// reversible and a row that disappeared for good would have to be re-added by
// hand. Section keys ("dev" / "anken" / "resume") live in the same list as the
// catalog targets, so one array covers both.
const SECTIONS: Array<{ id: string; label: string; note: string }> = [
  { id: "resume", label: "続きから", note: "このPCの履歴から再開する行。中身の絞り込みは「このPCの履歴から再開」タブと共通" },
  { id: "dev", label: "開発", note: "~/.mycmux/launch-roots.txt の開発フォルダ" },
  { id: "anken", label: "案件", note: "同ファイルの「案件:」行" },
];

const ICON_FOR: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  "claude-codex": "claude-codex",
  "claude-codex-open": "claude-codex",
  grok: "grok",
  agy: "antigravity",
  "web-chatgpt": "codex",
  "web-gemini": "gemini",
  "web-grok": "grok",
  "web-claude": "claude",
  "web-notebooklm": "notebooklm",
};

export function LauncherTab() {
  const hiddenIds = useSettingsStore((s) => s.launcherHiddenIds);
  const setHiddenIds = useSettingsStore((s) => s.setLauncherHiddenIds);
  const hidden = new Set(hiddenIds);

  const toggle = (id: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    setHiddenIds([...next]);
  };

  const agents = AGENT_CATALOG.filter((e) => e.kind === "agent");
  const webs = AGENT_CATALOG.filter((e) => e.kind === "web");

  const row = (id: string, label: string, iconKind?: string, note?: string) => (
    <label key={id} style={{ ...checkboxLabelStyle, alignItems: "flex-start" }}>
      <input
        type="checkbox"
        checked={!hidden.has(id)}
        onChange={(event) => toggle(id, event.target.checked)}
      />
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {iconKind ? <AgentKindIcon kind={iconKind} size={16} /> : null}
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block" }}>{label}</span>
          {note ? (
            <span style={{ display: "block", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>
              {note}
            </span>
          ) : null}
        </span>
      </span>
    </label>
  );

  return (
    <div>
      <div style={sectionHeadingStyle}>新規に起動</div>
      {agents.map((e) => row(e.target, shortLabel(e), ICON_FOR[e.target], e.label))}

      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>Web</div>
      {webs.map((e) => row(e.target, shortLabel(e), ICON_FOR[e.target]))}

      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>セクション</div>
      {SECTIONS.map((s) => row(s.id, s.label, undefined, s.note))}
    </div>
  );
}
