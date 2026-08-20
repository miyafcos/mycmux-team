import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TERMINAL_FONT_PRESETS,
  UI_FONT_SCALE_DEFAULT,
  UI_FONT_SCALE_MAX,
  UI_FONT_SCALE_MIN,
  UI_FONT_SCALE_STEP,
  useThemeStore,
  type TerminalFontPreset,
  type UiDensity,
} from "../../stores/themeStore";

const UI_DENSITY_OPTIONS: Array<{ value: UiDensity; label: string; detail: string }> = [
  { value: "compact", label: "つめる", detail: "行間と余白を絞って一覧性を上げる" },
  { value: "standard", label: "標準", detail: "これまでどおりの表示" },
  { value: "relaxed", label: "ゆったり", detail: "文字を一回り大きく、行間と余白を広く" },
];

interface ThemeFontSettingsProps {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  setFontSize: (size: number) => void;
  setFontFamily: (fontFamily: string) => void;
  setLineHeight: (lineHeight: number) => void;
  mode?: "all" | "controls" | "presets";
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
    presetIds: ["biz-readable", "ms-gothic"],
  },
  {
    id: "tone-shift",
    title: "印象を変える",
    detail: "雰囲気を変えたいとき",
    presetIds: ["ud-kyokasho", "biz-udmincho"],
  },
];

function UiDensityPicker() {
  const uiDensity = useThemeStore((s) => s.uiDensity);
  const setUiDensity = useThemeStore((s) => s.setUiDensity);
  const uiFontScale = useThemeStore((s) => s.uiFontScale);
  const setUiFontScale = useThemeStore((s) => s.setUiFontScale);
  const activeDetail = UI_DENSITY_OPTIONS.find((option) => option.value === uiDensity)?.detail;
  const isUiFontScaleDefault = uiFontScale === UI_FONT_SCALE_DEFAULT;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)" }}>画面の余白と文字の大きさ</div>
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
          {UI_DENSITY_OPTIONS.map((option) => {
            const active = uiDensity === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setUiDensity(option.value)}
                style={{
                  height: 26,
                  minWidth: 62,
                  border: "none",
                  borderRadius: 5,
                  background: active ? "var(--cmux-selected)" : "transparent",
                  color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {activeDetail ? (
        <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>{activeDetail}</div>
      ) : null}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <label htmlFor="ui-font-scale" style={{ fontSize: 12, color: "var(--cmux-text-secondary)" }}>
            画面の文字サイズ {Math.round(uiFontScale * 100)}%
          </label>
          <button
            type="button"
            onClick={() => setUiFontScale(UI_FONT_SCALE_DEFAULT)}
            disabled={isUiFontScaleDefault}
            style={{
              height: 26,
              border: "1px solid var(--cmux-border)",
              borderRadius: 7,
              background: "transparent",
              color: isUiFontScaleDefault ? "var(--cmux-text-dim)" : "var(--cmux-text-secondary)",
              cursor: isUiFontScaleDefault ? "default" : "pointer",
              padding: "0 10px",
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            リセット
          </button>
        </div>
        <input
          id="ui-font-scale"
          type="range"
          min={UI_FONT_SCALE_MIN}
          max={UI_FONT_SCALE_MAX}
          step={UI_FONT_SCALE_STEP}
          value={uiFontScale}
          onChange={(event) => setUiFontScale(Number(event.target.value))}
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}

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
              color: active ? "var(--cmux-accent-text)" : "var(--cmux-text)",
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
              fontSize: 11,
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
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--cmux-accent-text)", fontWeight: 700 }}>
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
              fontSize: 11,
              lineHeight: 1.25,
            }}
          >
            {tag}
          </span>
        ))}
      </div>

      {/* The old 11px specimen made every preset look identical. The glyph line
          is set large and limited to the characters that actually differ
          between mono faces (zero/O, one/l/I, brackets, arrows); the Japanese
          and table lines stay small because what they show is weight and
          column alignment, not letterform. */}
      <div
        style={{
          border: "1px solid var(--cmux-border)",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--cmux-bg) 88%, var(--cmux-text))",
          padding: "7px 8px",
          fontFamily: preset.value,
          letterSpacing: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            fontSize: 17,
            lineHeight: 1.3,
            color: "var(--cmux-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          0Oo 1lI| {"{}[]"}
        </div>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.35,
            color: "var(--cmux-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          国鬱ぎゅアガパ {preset.sample}
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 11,
            lineHeight: 1.3,
            whiteSpace: "pre",
            color: "var(--cmux-text-secondary)",
            overflow: "hidden",
          }}
        >
          | 項目     | 12,300 | 待機 |
        </div>
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
  mode = "all",
}: ThemeFontSettingsProps) {
  const usesKnownPreset = TERMINAL_FONT_PRESETS.some((preset) => preset.value === fontFamily);
  const showControls = mode !== "presets";
  const showPresets = mode !== "controls";

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
{showControls && (
        <>
      <UiDensityPicker />

      <div>
        <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)", marginBottom: 8 }}>
          フォントサイズ: {fontSize}px
        </div>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
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
        </>
      )}

      {showPresets && (

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--cmux-text-secondary)" }}>端末フォント</div>
            <div style={{ marginTop: 2, fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
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
                <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>{group.detail}</div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
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
      )}
    </section>
  );
}

export function ThemeFontPresetPicker(props: Omit<ThemeFontSettingsProps, "mode">) {
  return <ThemeFontSettings {...props} mode="presets" />;
}
