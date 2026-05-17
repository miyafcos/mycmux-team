import { useThemeStore } from "../../stores/themeStore";
import { getTheme } from "./themeDefinitions";
import { ThemeTweakPanel } from "./ThemeTweakPanel";

interface ThemeSwitcherProps {
  onClose: () => void;
  onOpenKeybindings?: () => void;
}

export default function ThemeSwitcher({ onClose, onOpenKeybindings }: ThemeSwitcherProps) {
  const currentId = useThemeStore((s) => s.themeId);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const fontFamily = useThemeStore((s) => s.fontFamily);
  const setFontFamily = useThemeStore((s) => s.setFontFamily);
  const themeTweaks = useThemeStore((s) => s.themeTweaks);
  const setThemeTweakColor = useThemeStore((s) => s.setThemeTweakColor);
  const applyThemeTweakPreset = useThemeStore((s) => s.applyThemeTweakPreset);
  const setThemeBackground = useThemeStore((s) => s.setThemeBackground);
  const clearThemeTweakColor = useThemeStore((s) => s.clearThemeTweakColor);
  const resetThemeTweaks = useThemeStore((s) => s.resetThemeTweaks);

  const baseTheme = getTheme(currentId);
  const changedCount = Object.keys(themeTweaks.colors).length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--cmux-backdrop)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 900,
          maxWidth: "calc(100vw - 32px)",
          height: "min(820px, calc(100vh - 32px))",
          background: "var(--cmux-surface)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: "var(--cmux-text)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div
          style={{
            padding: "16px 18px 12px",
            borderBottom: "1px solid var(--cmux-border)",
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>外観調整</div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
              ベース: {baseTheme.name}
              {changedCount > 0 ? ` / 色調整 ${changedCount} 件` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              border: "1px solid var(--cmux-border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--cmux-text-secondary)",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            x
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <ThemeTweakPanel
            baseTheme={baseTheme}
            themeTweaks={themeTweaks}
            changedCount={changedCount}
            fontSize={fontSize}
            fontFamily={fontFamily}
            setFontSize={setFontSize}
            setFontFamily={setFontFamily}
            setThemeTweakColor={setThemeTweakColor}
            applyThemeTweakPreset={applyThemeTweakPreset}
            setThemeBackground={setThemeBackground}
            clearThemeTweakColor={clearThemeTweakColor}
            resetThemeTweaks={resetThemeTweaks}
          />
        </div>

        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--cmux-border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {onOpenKeybindings && (
            <button
              type="button"
              onClick={onOpenKeybindings}
              style={{
                background: "transparent",
                border: "1px solid var(--cmux-border)",
                borderRadius: 5,
                color: "var(--cmux-text-secondary)",
                padding: "6px 14px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              キーボードショートカット
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--cmux-border)",
              borderRadius: 5,
              color: "var(--cmux-text-secondary)",
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
