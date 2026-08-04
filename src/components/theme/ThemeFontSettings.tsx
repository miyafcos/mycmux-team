import { TERMINAL_FONT_PRESETS, type TerminalFontPreset } from "../../stores/themeStore";

interface ThemeFontSettingsProps {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  setFontSize: (size: number) => void;
  setFontFamily: (fontFamily: string) => void;
  setLineHeight: (lineHeight: number) => void;
}

interface FontPresetGroup {
  id: string;
  title: string;
  detail: string;
  presetIds: string[];
}

const FONT_PRESET_GROUPS: FontPresetGroup[] = [
  {
    id: "code-standard",
    title: "コード・標準",
    detail: "普段使い。迷ったらここから",
    presetIds: ["jetbrains-ja", "udev-gothic", "udev-gothic-35", "cascadia-biz", "consolas-meiryo"],
  },
  {
    id: "ja-readable",
    title: "日本語・表の読みやすさ",
    detail: "教材・表・ログ確認向き",
    presetIds: ["biz-readable", "hg-gothic-m", "ms-gothic"],
  },
  {
    id: "tone-shift",
    title: "印象を変える",
    detail: "雰囲気を変えたいとき",
    presetIds: ["mac-style", "ud-kyokasho", "biz-udmincho"],
  },
];

function FontPresetOption({
  preset,
  active,
  onSelect,
}: {
  preset: TerminalFontPreset;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      style={{
        minWidth: 0,
        padding: "8px 9px",
        border: active
          ? "1px solid color-mix(in srgb, var(--cmux-accent) 82%, white)"
          : "1px solid var(--cmux-border)",
        borderRadius: 7,
        background: active
          ? "color-mix(in srgb, var(--cmux-accent) 12%, var(--cmux-surface))"
          : "var(--cmux-surface)",
        color: "var(--cmux-text)",
        cursor: "pointer",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: active
          ? "0 0 0 1px color-mix(in srgb, var(--cmux-accent) 70%, transparent)"
          : "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: active ? "var(--cmux-accent)" : "var(--cmux-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {preset.label}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 10,
              color: "var(--cmux-text-tertiary)",
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {preset.description}
          </div>
        </div>
        {active && (
          <span style={{ flexShrink: 0, fontSize: 10, color: "var(--cmux-accent)", fontWeight: 700 }}>
            選択中
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {preset.tags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            style={{
              border: "1px solid var(--cmux-border)",
              borderRadius: 999,
              padding: "1px 6px",
              color: "var(--cmux-text-secondary)",
              fontSize: 9,
              lineHeight: 1.25,
            }}
          >
            {tag}
          </span>
        ))}
      </div>

      <div
        style={{
          border: "1px solid var(--cmux-border)",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--cmux-bg) 88%, var(--cmux-text))",
          padding: "6px 7px",
          fontFamily: preset.value,
          fontSize: 11,
          lineHeight: 1.3,
          letterSpacing: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ whiteSpace: "pre", color: "var(--cmux-text)" }}>| 項目     | 金額   | 状態 |</div>
        <div style={{ whiteSpace: "pre", color: "var(--cmux-text-secondary)" }}>| Codex入力 | 12,300 | 待機 |</div>
        <div style={{ marginTop: 3, color: "var(--cmux-text)" }}>{preset.sample} fgIl| →</div>
      </div>
    </button>
  );
}

function findPresetById(id: string): TerminalFontPreset | undefined {
  return TERMINAL_FONT_PRESETS.find((preset) => preset.id === id);
}

export function ThemeFontSettings({
  fontSize,
  fontFamily,
  lineHeight,
  setFontSize,
  setFontFamily,
  setLineHeight,
}: ThemeFontSettingsProps) {
  const usesKnownPreset = TERMINAL_FONT_PRESETS.some((preset) => preset.value === fontFamily);

  return (
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
        <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)", marginBottom: 8 }}>
          フォントサイズ: {fontSize}px
        </div>
        <input
          type="range"
          min={10}
          max={24}
          value={fontSize}
          onChange={(event) => setFontSize(Number(event.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)", marginBottom: 8 }}>
          行間: {lineHeight.toFixed(2)}
        </div>
        <input
          type="range"
          min={1}
          max={1.8}
          step={0.05}
          value={lineHeight}
          onChange={(event) => setLineHeight(Number(event.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)" }}>端末フォント</div>
            <div style={{ marginTop: 2, fontSize: 10, color: "var(--cmux-text-tertiary)" }}>
              3分類から選ぶ。すべて表プレビューつき
            </div>
          </div>
        </div>

        {!usesKnownPreset && (
          <div style={{ marginBottom: 10 }}>
            <FontPresetOption
              preset={{
                id: "custom",
                label: "カスタム",
                value: fontFamily,
                sample: "Aa 0123 日本語",
                description: "保存済みのカスタム指定",
                tags: ["保存値", "カスタム"],
              }}
              active
              onSelect={() => setFontFamily(fontFamily)}
            />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {FONT_PRESET_GROUPS.map((group) => (
            <section key={group.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700 }}>{group.title}</div>
                <div style={{ fontSize: 10, color: "var(--cmux-text-tertiary)" }}>{group.detail}</div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                  gap: 8,
                }}
              >
                {group.presetIds.map((presetId) => {
                  const preset = findPresetById(presetId);
                  if (!preset) return null;
                  return (
                    <FontPresetOption
                      key={preset.id}
                      preset={preset}
                      active={preset.value === fontFamily}
                      onSelect={() => {
                        setFontFamily(preset.value);
                        if (preset.recommendedLineHeight !== undefined) {
                          setLineHeight(preset.recommendedLineHeight);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
