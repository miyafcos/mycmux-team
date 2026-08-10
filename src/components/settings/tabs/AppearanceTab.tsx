import { useThemeStore } from "../../../stores/themeStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getTheme } from "../../theme/themeDefinitions";
import { ThemePicker } from "../../theme/ThemePicker";
import { ThemeTweakPanel } from "../../theme/ThemeTweakPanel";
import { checkboxLabelStyle, sectionHeadingStyle } from "../tabStyles";

// Ported from ThemeSwitcher.tsx verbatim (same store wiring, same
// ThemeTweakPanel props) — this tab absorbs ThemeSwitcher's sole
// responsibility now that the dialog itself owns the modal shell.
export function AppearanceTab() {
  const currentId = useThemeStore((s) => s.themeId);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const fontFamily = useThemeStore((s) => s.fontFamily);
  const setFontFamily = useThemeStore((s) => s.setFontFamily);
  const lineHeight = useThemeStore((s) => s.lineHeight);
  const setLineHeight = useThemeStore((s) => s.setLineHeight);
  const themeTweaks = useThemeStore((s) => s.themeTweaks);
  const setThemeTweakColor = useThemeStore((s) => s.setThemeTweakColor);
  const applyThemeTweakPreset = useThemeStore((s) => s.applyThemeTweakPreset);
  const setThemeBackground = useThemeStore((s) => s.setThemeBackground);
  const clearThemeTweakColor = useThemeStore((s) => s.clearThemeTweakColor);
  const resetThemeTweaks = useThemeStore((s) => s.resetThemeTweaks);
  const terminalRenderer = useSettingsStore((s) => s.terminalRenderer);
  const setTerminalRenderer = useSettingsStore((s) => s.setTerminalRenderer);

  const baseTheme = getTheme(currentId);
  const changedCount = Object.keys(themeTweaks.colors).length;

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flexShrink: 0, padding: "18px 18px 0" }}>
        <div style={sectionHeadingStyle}>ターミナルの描画方式</div>
        <label style={checkboxLabelStyle}>
          <input
            type="radio"
            name="terminal-renderer"
            checked={terminalRenderer === "auto"}
            onChange={() => setTerminalRenderer("auto")}
          />
          <span>自動（推奨）— 背景を透過させない構成では GPU 描画</span>
        </label>
        <label style={checkboxLabelStyle}>
          <input
            type="radio"
            name="terminal-renderer"
            checked={terminalRenderer === "dom"}
            onChange={() => setTerminalRenderer("dom")}
          />
          <span>標準描画（安定性優先）</span>
        </label>
        <label style={checkboxLabelStyle}>
          <input
            type="radio"
            name="terminal-renderer"
            checked={terminalRenderer === "webgl"}
            onChange={() => setTerminalRenderer("webgl")}
          />
          <span>GPU描画（高速・環境依存）</span>
        </label>
        <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.6, color: "var(--cmux-text-dim)" }}>
          自動では、背景メディアがなく不透明度100%のときGPU描画を使い、それ以外は標準描画へ切り替えます。GPU描画で文字が暗い・崩れる・重い場合は標準描画へ戻してください。
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ThemeTweakPanel
          topSlot={<ThemePicker />}
          baseTheme={baseTheme}
          themeTweaks={themeTweaks}
          changedCount={changedCount}
          fontSize={fontSize}
          fontFamily={fontFamily}
          lineHeight={lineHeight}
          setFontSize={setFontSize}
          setFontFamily={setFontFamily}
          setLineHeight={setLineHeight}
          setThemeTweakColor={setThemeTweakColor}
          applyThemeTweakPreset={applyThemeTweakPreset}
          setThemeBackground={setThemeBackground}
          clearThemeTweakColor={clearThemeTweakColor}
          resetThemeTweaks={resetThemeTweaks}
        />
      </div>
    </div>
  );
}
