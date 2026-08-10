import { useState } from "react";
import type {
  ThemeBackgroundSettings,
  ThemeColorScheme,
  ThemeDefinition,
  ThemeTweakColorKey,
  ThemeTweaks,
} from "../../types";
import {
  THEME_TWEAK_GROUPS,
  THEME_TWEAK_PRESETS,
  hasThemeTweak,
  isDefaultThemeBackground,
  readThemeColor,
} from "../../lib/themeTweaks";
import { ThemeBackgroundPanel } from "./ThemeBackgroundPanel";
import { ThemeFontSettings } from "./ThemeFontSettings";

interface ThemeTweakPanelProps {
  topSlot?: React.ReactNode;
  baseTheme: ThemeDefinition;
  themeTweaks: ThemeTweaks;
  changedCount: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  setFontSize: (size: number) => void;
  setFontFamily: (fontFamily: string) => void;
  setLineHeight: (lineHeight: number) => void;
  setThemeTweakColor: (key: ThemeTweakColorKey, color: string) => void;
  applyThemeTweakPreset: (colors: Partial<Record<ThemeTweakColorKey, string>>) => void;
  setThemeBackground: (background: Partial<ThemeBackgroundSettings>) => void;
  clearThemeTweakColor: (key: ThemeTweakColorKey) => void;
  resetThemeTweaks: () => void;
}

interface TweakField {
  key: ThemeTweakColorKey;
  label: string;
  detail: string;
}

const QUICK_TWEAK_FIELDS: TweakField[] = [
  { key: "chrome.accent", label: "アクセント", detail: "選択中・フォーカス" },
  { key: "chrome.background", label: "背景", detail: "アプリ全体" },
  { key: "chrome.surface", label: "パネル", detail: "サイドバー・設定画面" },
  { key: "chrome.border", label: "境界線", detail: "ペインや区切り" },
  { key: "chrome.text", label: "UI 文字", detail: "メニュー・ラベル" },
  { key: "terminal.background", label: "端末背景", detail: "Codex/Claude の出力面" },
  { key: "terminal.foreground", label: "端末文字", detail: "通常の出力文字" },
  { key: "terminal.cursor", label: "カーソル", detail: "入力位置" },
  { key: "terminal.selectionBackground", label: "選択範囲", detail: "ドラッグ選択" },
  { key: "status.working", label: "作業中", detail: "実行中ステータス" },
  { key: "status.waiting", label: "待機", detail: "入力・承認待ち" },
  { key: "notification", label: "通知", detail: "バッジ・注意表示" },
];

const QUICK_TWEAK_KEYS = new Set<ThemeTweakColorKey>(QUICK_TWEAK_FIELDS.map((field) => field.key));

const PRESET_SWATCH_KEYS: ThemeTweakColorKey[] = [
  "chrome.background",
  "chrome.surface",
  "chrome.text",
  "chrome.accent",
  "terminal.cursor",
];

function formatColor(value: string): string {
  return value.toUpperCase();
}

function isLightColor(value: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return false;
  }

  const red = parseInt(match[1].slice(0, 2), 16);
  const green = parseInt(match[1].slice(2, 4), 16);
  const blue = parseInt(match[1].slice(4, 6), 16);
  return (red * 0.299 + green * 0.587 + blue * 0.114) / 255 > 0.62;
}

function PresetButton({
  preset,
  scheme,
  onApply,
}: {
  preset: (typeof THEME_TWEAK_PRESETS)[number];
  scheme: ThemeColorScheme;
  onApply: (colors: Partial<Record<ThemeTweakColorKey, string>>) => void;
}) {
  const presetColors = preset.colorsByScheme[scheme];
  const swatches = PRESET_SWATCH_KEYS.map((key) => presetColors[key]).filter((color): color is string => Boolean(color));

  return (
    <button
      type="button"
      onClick={() => onApply(presetColors)}
      title={preset.description}
      style={{
        minWidth: 0,
        minHeight: 54,
        padding: "8px 10px",
        border: "1px solid var(--cmux-border)",
        borderRadius: 8,
        background: "var(--cmux-surface)",
        color: "var(--cmux-text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preset.label}
        </span>
        <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {swatches.map((swatch, index) => (
            <span
              key={`${preset.id}-${index}`}
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: swatch,
                boxShadow: "0 0 0 1px color-mix(in srgb, var(--cmux-bg) 70%, transparent)",
              }}
            />
          ))}
        </span>
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 11,
          color: "var(--cmux-text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {preset.description}
      </div>
    </button>
  );
}

function ColorTweakRow({
  field,
  baseValue,
  value,
  changed,
  onChange,
  onReset,
}: {
  field: TweakField;
  baseValue: string;
  value: string;
  changed: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(138px, 1fr) 42px minmax(82px, 96px) 58px",
        alignItems: "center",
        gap: 10,
        minHeight: 47,
        padding: "8px 10px",
        borderBottom: "1px solid var(--cmux-border)",
        background: changed ? "color-mix(in srgb, var(--cmux-accent) 9%, transparent)" : "transparent",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {field.label}
          </span>
          {changed && (
            <span style={{ color: "var(--cmux-accent-text)", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
              変更
            </span>
          )}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 11,
            color: "var(--cmux-text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {field.detail}
        </div>
      </div>

      <input
        type="color"
        aria-label={`${field.label}を変更`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: 38,
          height: 30,
          padding: 0,
          border: "1px solid var(--cmux-border)",
          borderRadius: 7,
          background: "transparent",
          cursor: "pointer",
        }}
      />

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--cmux-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: 0,
          }}
        >
          {formatColor(value)}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 10,
            color: "var(--cmux-text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: 0,
          }}
        >
          base {formatColor(baseValue)}
        </div>
      </div>

      <button
        type="button"
        onClick={onReset}
        disabled={!changed}
        title="この色だけ戻す"
        style={{
          height: 28,
          border: "1px solid var(--cmux-border)",
          borderRadius: 6,
          background: "transparent",
          color: changed ? "var(--cmux-text-secondary)" : "var(--cmux-text-dim)",
          cursor: changed ? "pointer" : "default",
          fontSize: 11,
        }}
      >
        戻す
      </button>
    </div>
  );
}

function AdvancedColorRow({
  label,
  baseValue,
  value,
  changed,
  onChange,
  onReset,
}: {
  label: string;
  baseValue: string;
  value: string;
  changed: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <ColorTweakRow
      field={{ key: "notification", label, detail: `base ${formatColor(baseValue)}` }}
      baseValue={baseValue}
      value={value}
      changed={changed}
      onChange={onChange}
      onReset={onReset}
    />
  );
}

export function ThemeTweakPanel({
  topSlot,
  baseTheme,
  themeTweaks,
  changedCount,
  fontSize,
  fontFamily,
  lineHeight,
  setFontSize,
  setFontFamily,
  setLineHeight,
  setThemeTweakColor,
  applyThemeTweakPreset,
  setThemeBackground,
  clearThemeTweakColor,
  resetThemeTweaks,
}: ThemeTweakPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presetScheme, setPresetScheme] = useState<ThemeColorScheme>(() =>
    isLightColor(themeTweaks.colors["chrome.background"] ?? readThemeColor(baseTheme, "chrome.background"))
      ? "light"
      : "dark",
  );

  const colorForKey = (key: ThemeTweakColorKey): string => {
    return themeTweaks.colors[key] ?? readThemeColor(baseTheme, key);
  };

  const resetDisabled =
    changedCount === 0 && isDefaultThemeBackground(themeTweaks.background);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 18 }}>
      {topSlot}
      <ThemeFontSettings
        fontSize={fontSize}
        fontFamily={fontFamily}
        lineHeight={lineHeight}
        setFontSize={setFontSize}
        setFontFamily={setFontFamily}
        setLineHeight={setLineHeight}
      />

      <section style={{ marginBottom: 14 }}>
        <div
          style={{
            marginBottom: 8,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>選んだテーマの微調整</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
                padding: 3,
                border: "1px solid var(--cmux-border)",
                borderRadius: 7,
                background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
              }}
            >
              {[
                { scheme: "dark" as const, label: "暗色" },
                { scheme: "light" as const, label: "白系" },
              ].map((item) => {
                const active = presetScheme === item.scheme;
                return (
                  <button
                    key={item.scheme}
                    type="button"
                    onClick={() => setPresetScheme(item.scheme)}
                    style={{
                      height: 26,
                      minWidth: 54,
                      border: "none",
                      borderRadius: 5,
                      background: active ? "var(--cmux-selected)" : "transparent",
                      color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: active ? 700 : 500,
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          <button
            type="button"
            onClick={resetThemeTweaks}
            disabled={resetDisabled}
            style={{
              height: 32,
              minWidth: 82,
              border: "1px solid var(--cmux-border)",
              borderRadius: 7,
              background: "transparent",
              color: resetDisabled ? "var(--cmux-text-dim)" : "var(--cmux-text-secondary)",
              cursor: resetDisabled ? "default" : "pointer",
              fontSize: 11,
            }}
          >
            すべて戻す
          </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {THEME_TWEAK_PRESETS.map((preset) => (
            <PresetButton
              key={preset.id}
              preset={preset}
              scheme={presetScheme}
              onApply={applyThemeTweakPreset}
            />
          ))}
        </div>
      </section>

      <ThemeBackgroundPanel background={themeTweaks.background} setThemeBackground={setThemeBackground} />

      <section
        style={{
          border: "1px solid var(--cmux-border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--cmux-surface)",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--cmux-border)",
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>主要色</div>
          <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>よく触る項目</div>
        </div>
        {QUICK_TWEAK_FIELDS.map((field) => {
          const baseValue = readThemeColor(baseTheme, field.key);
          return (
            <ColorTweakRow
              key={field.key}
              field={field}
              baseValue={baseValue}
              value={colorForKey(field.key)}
              changed={hasThemeTweak(themeTweaks, field.key)}
              onChange={(value) => setThemeTweakColor(field.key, value)}
              onReset={() => clearThemeTweakColor(field.key)}
            />
          );
        })}
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            border: "1px solid var(--cmux-border)",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
            color: "var(--cmux-text)",
            cursor: "pointer",
            textAlign: "left",
            marginBottom: showAdvanced ? 12 : 0,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>詳細色</span>
          <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
            {showAdvanced ? "閉じる" : "ANSI 色など"}
          </span>
        </button>

        {showAdvanced && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {THEME_TWEAK_GROUPS.map((group) => {
              const fields = group.fields.filter((field) => !QUICK_TWEAK_KEYS.has(field.key));
              if (fields.length === 0) {
                return null;
              }

              return (
                <section
                  key={group.id}
                  style={{
                    border: "1px solid var(--cmux-border)",
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--cmux-surface)",
                  }}
                >
                  <div
                    style={{
                      padding: "9px 12px",
                      borderBottom: "1px solid var(--cmux-border)",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {group.label}
                  </div>
                  {fields.map((field) => {
                    const baseValue = readThemeColor(baseTheme, field.key);
                    return (
                      <AdvancedColorRow
                        key={field.key}
                        label={field.label}
                        baseValue={baseValue}
                        value={colorForKey(field.key)}
                        changed={hasThemeTweak(themeTweaks, field.key)}
                        onChange={(value) => setThemeTweakColor(field.key, value)}
                        onReset={() => clearThemeTweakColor(field.key)}
                      />
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
