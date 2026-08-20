import { useThemeStore } from "../../../stores/themeStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { appearanceStrings } from "../../../lib/appearanceStrings";
import { getTheme } from "../../theme/themeDefinitions";
import { ThemeFontPresetPicker } from "../../theme/ThemeFontSettings";
import { ThemePicker } from "../../theme/ThemePicker";
import { ThemeTweakPanel } from "../../theme/ThemeTweakPanel";
import { checkboxLabelStyle, sectionHeadingStyle } from "../tabStyles";

const QUICK_SIZE_OPTIONS = [
  { value: "small", label: appearanceStrings.sizeSmall },
  { value: "medium", label: appearanceStrings.sizeMedium },
  { value: "large", label: appearanceStrings.sizeLarge },
] as const;

export function AppearanceTab() {
  const currentId = useThemeStore((s) => s.themeId);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const fontFamily = useThemeStore((s) => s.fontFamily);
  const setFontFamily = useThemeStore((s) => s.setFontFamily);
  const lineHeight = useThemeStore((s) => s.lineHeight);
  const setLineHeight = useThemeStore((s) => s.setLineHeight);
  const uiDensity = useThemeStore((s) => s.uiDensity);
  const uiFontScale = useThemeStore((s) => s.uiFontScale);
  const applyQuickSize = useThemeStore((s) => s.applyQuickSize);
  const themeTweaks = useThemeStore((s) => s.themeTweaks);
  const setThemeTweakColor = useThemeStore((s) => s.setThemeTweakColor);
  const applyThemeTweakPreset = useThemeStore((s) => s.applyThemeTweakPreset);
  const setThemeBackground = useThemeStore((s) => s.setThemeBackground);
  const clearThemeTweakColor = useThemeStore((s) => s.clearThemeTweakColor);
  const resetThemeTweaks = useThemeStore((s) => s.resetThemeTweaks);
  const terminalRenderer = useSettingsStore((s) => s.terminalRenderer);
  const setTerminalRenderer = useSettingsStore((s) => s.setTerminalRenderer);
  const appearanceAdvancedOpen = useSettingsStore((s) => s.appearanceAdvancedOpen);
  const setAppearanceAdvancedOpen = useSettingsStore((s) => s.setAppearanceAdvancedOpen);

  const baseTheme = getTheme(currentId);
  const changedCount = Object.keys(themeTweaks.colors).length;
  const quickSize = QUICK_SIZE_OPTIONS.find(({ value }) => (
    (value === "small" && fontSize === 12 && uiFontScale === 0.95 && uiDensity === "compact")
    || (value === "medium" && fontSize === 14 && uiFontScale === 1 && uiDensity === "standard")
    || (value === "large" && fontSize === 16 && uiFontScale === 1.15 && uiDensity === "relaxed")
  ))?.value;

  return (
    <div style={{ height: "100%", minHeight: 0, overflowY: "auto", padding: 18 }}>
      <section
        style={{
          border: "1px solid var(--cmux-border)",
          borderRadius: 8,
          padding: 12,
          marginBottom: 14,
          background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div>
        <div style={sectionHeadingStyle}>{appearanceStrings.quickTitle}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
            {appearanceStrings.quickNote}
          </div>
        </div>
        <ThemePicker />
        <div>
          <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)", marginBottom: 8 }}>
            {appearanceStrings.sizeLabel}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 4,
              padding: 3,
              border: "1px solid var(--cmux-border)",
              borderRadius: 7,
              background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
            }}
          >
            {QUICK_SIZE_OPTIONS.map(({ value, label }) => {
              const active = quickSize === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyQuickSize(value)}
                  style={{
                    height: 28,
                    border: "none",
                    borderRadius: 5,
                    background: active ? "var(--cmux-selected)" : "transparent",
                    color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {!quickSize && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
              {appearanceStrings.sizeCustom}
            </div>
          )}
        </div>
        <ThemeFontPresetPicker
          fontSize={fontSize}
          fontFamily={fontFamily}
          lineHeight={lineHeight}
          setFontSize={setFontSize}
          setFontFamily={setFontFamily}
          setLineHeight={setLineHeight}
        />
      </section>

      <section>
        <button
          type="button"
          aria-expanded={appearanceAdvancedOpen}
          aria-controls="appearance-advanced"
          onClick={() => setAppearanceAdvancedOpen(!appearanceAdvancedOpen)}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            border: "1px solid var(--cmux-border)",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
            color: "var(--cmux-text)",
            cursor: "pointer",
            textAlign: "left",
            marginBottom: appearanceAdvancedOpen ? 12 : 0,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>{appearanceStrings.advancedToggle}</span>
          <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>{appearanceStrings.advancedNote}</span>
        </button>

        {appearanceAdvancedOpen && (
          <div id="appearance-advanced">
            <div style={{ marginBottom: 14 }}>
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
            <ThemeTweakPanel
              embedded
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
        )}
      </section>
    </div>
  );
}
