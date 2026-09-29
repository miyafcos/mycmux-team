import { useSettingsStore } from "../../../stores/settingsStore";
import { formatShortcutLabel } from "../../../lib/keybindings";
import { useKeybindingStore } from "../../../stores/keybindingStore";
import { checkboxLabelStyle, dialogButtonStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";

interface ResumeTabProps {
  onOpenCrsmPalette?: () => void;
  onClose: () => void;
}

// Ported from SettingsMenu.tsx's Resume button + CrsmPaletteSection, with
// the visibility filter labels translated to Japanese (product names
// Claude Code / Codex / Hybrid stay as-is).
export function ResumeTab({ onOpenCrsmPalette, onClose }: ResumeTabProps) {
  const showClaude = useSettingsStore((s) => s.crsmShowClaude);
  const showCodex = useSettingsStore((s) => s.crsmShowCodex);
  const showClaudeCodex = useSettingsStore((s) => s.crsmShowClaudeCodex);
  const hideSessionsWithoutUserMessages = useSettingsStore((s) => s.hideSessionsWithoutUserMessages);
  const setShowClaude = useSettingsStore((s) => s.setCrsmShowClaude);
  const setShowCodex = useSettingsStore((s) => s.setCrsmShowCodex);
  const setShowClaudeCodex = useSettingsStore((s) => s.setCrsmShowClaudeCodex);
  const setHideSessionsWithoutUserMessages = useSettingsStore(
    (s) => s.setHideSessionsWithoutUserMessages,
  );
  const crsmPaletteShortcut = useKeybindingStore((s) => formatShortcutLabel(s.keybindings["crsm.palette"]));

  const rows: Array<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = [
    { label: "Claude Code", checked: showClaude, onChange: setShowClaude },
    { label: "Codex", checked: showCodex, onChange: setShowCodex },
    { label: "Hybrid (Claude+Codex)", checked: showClaudeCodex, onChange: setShowClaudeCodex },
    {
      label: "ユーザー発言のないセッションを隠す",
      checked: hideSessionsWithoutUserMessages,
      onChange: setHideSessionsWithoutUserMessages,
    },
  ];

  return (
    <div>
      {onOpenCrsmPalette && (
        <button
          onClick={() => {
            onOpenCrsmPalette();
            onClose();
          }}
          style={{
            ...dialogButtonStyle,
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Resume（セッション再開）</span>
          <span style={{ color: "var(--cmux-text-dim, rgba(255,255,255,0.55))", fontSize: 11 }}>{crsmPaletteShortcut}</span>
        </button>
      )}

      <div style={dividerStyle} />

      <div style={sectionHeadingStyle}>表示フィルタ</div>
      {rows.map((row) => (
        <label key={row.label} style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={row.checked}
            onChange={(e) => row.onChange(e.target.checked)}
          />
          <span>{row.label}</span>
        </label>
      ))}
    </div>
  );
}
