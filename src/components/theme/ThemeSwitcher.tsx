import type { ThemeDefinition } from "../../types";
import { TERMINAL_FONT_PRESETS, type TerminalFontPreset, useThemeStore } from "../../stores/themeStore";
import { THEMES, THEME_GROUPS } from "./themeDefinitions";

interface ThemeSwitcherProps {
  onClose: () => void;
  onOpenKeybindings?: () => void;
}

function ThemePreview({ theme, isActive }: { theme: ThemeDefinition; isActive: boolean }) {
  return (
    <div
      style={{
        width: 46,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          height: 30,
          borderRadius: 7,
          background: `linear-gradient(135deg, ${theme.chrome.background} 0%, ${theme.terminal.background} 68%, ${theme.chrome.surface} 100%)`,
          border: `1px solid ${isActive ? theme.chrome.accent : theme.chrome.border}`,
          padding: 5,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxShadow: isActive ? `0 0 0 1px ${theme.chrome.accent}22 inset` : "none",
        }}
      >
        <div style={{ display: "flex", gap: 3 }}>
          <div style={{ width: 5, height: 5, borderRadius: 999, background: theme.terminal.red }} />
          <div style={{ width: 5, height: 5, borderRadius: 999, background: theme.terminal.yellow }} />
          <div style={{ width: 5, height: 5, borderRadius: 999, background: theme.chrome.accent }} />
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <div
            style={{
              height: 3,
              width: 20,
              borderRadius: 999,
              background: theme.terminal.foreground,
              opacity: 0.8,
            }}
          />
          <div
            style={{
              height: 3,
              width: 8,
              borderRadius: 999,
              background: theme.terminal.blue,
            }}
          />
        </div>
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
        padding: "10px 11px",
        border: active ? "1px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
        borderRadius: 8,
        background: active ? "var(--cmux-selected)" : "var(--cmux-surface)",
        color: "var(--cmux-text)",
        cursor: "pointer",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 8,
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
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {preset.label}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 10,
              color: "var(--cmux-text-tertiary)",
              lineHeight: 1.35,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {preset.description}
          </div>
        </div>
        {active && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              color: "var(--cmux-accent)",
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            選択中
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {preset.tags.map((tag) => (
          <span
            key={tag}
            style={{
              border: "1px solid var(--cmux-border)",
              borderRadius: 999,
              padding: "2px 6px",
              color: "var(--cmux-text-secondary)",
              fontSize: 9,
              lineHeight: 1.2,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {tag}
          </span>
        ))}
      </div>

      <div
        style={{
          border: "1px solid var(--cmux-border)",
          borderRadius: 7,
          background: "color-mix(in srgb, var(--cmux-bg) 88%, var(--cmux-text))",
          padding: "7px 8px",
          fontFamily: preset.value,
          fontSize: 12,
          lineHeight: 1.45,
          letterSpacing: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ color: "var(--cmux-accent)", marginBottom: 2 }}>表プレビュー</div>
        <div style={{ whiteSpace: "pre", color: "var(--cmux-text)" }}>| 項目       | 金額   | 状態 |</div>
        <div style={{ whiteSpace: "pre", color: "var(--cmux-text-tertiary)" }}>| ---------- | ------ | ---- |</div>
        <div style={{ whiteSpace: "pre", color: "var(--cmux-text-secondary)" }}>| Codex入力  | 12,300 | 待機 |</div>
        <div style={{ marginTop: 3, color: "var(--cmux-text)" }}>{preset.sample}  fgIl1│└→</div>
      </div>
    </button>
  );
}

export default function ThemeSwitcher({ onClose, onOpenKeybindings }: ThemeSwitcherProps) {
  const currentId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const fontFamily = useThemeStore((s) => s.fontFamily);
  const setFontFamily = useThemeStore((s) => s.setFontFamily);

  const currentTheme = THEMES.find((theme) => theme.id === currentId) ?? THEMES[0];
  const groupedThemes = THEME_GROUPS.map((group) => ({
    ...group,
    themes: THEMES.filter((theme) => theme.group === group.id),
  }));

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "82vh",
          background: "var(--cmux-surface)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 10,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 14,
              color: "var(--cmux-text)",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 600,
            }}
          >
            設定
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--cmux-accent)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {currentTheme.name}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--cmux-text-secondary)",
                fontFamily: "'JetBrains Mono', monospace",
                marginTop: 2,
              }}
            >
              {currentTheme.description}
            </div>
          </div>
        </div>

        <div style={{ minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          <div
            style={{
              fontSize: 12,
              color: "var(--cmux-text-secondary)",
              marginBottom: 10,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            テーマ
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {groupedThemes.map((group) => (
              <div key={group.id}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 8,
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--cmux-text)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 600,
                    }}
                  >
                    {group.label}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--cmux-text-tertiary)",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {group.hint}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                  }}
                >
                  {group.themes.map((theme) => {
                    const isActive = currentId === theme.id;
                    return (
                      <button
                        key={theme.id}
                        onClick={() => setTheme(theme.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          minHeight: 58,
                          background: isActive ? "var(--cmux-selected)" : "color-mix(in srgb, var(--cmux-text) 5%, transparent)",
                          border: isActive
                            ? "1px solid var(--cmux-accent)"
                            : "1px solid var(--cmux-border)",
                          borderRadius: 8,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <ThemePreview theme={theme} isActive={isActive} />
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              color: isActive ? "var(--cmux-accent)" : "var(--cmux-text)",
                              fontFamily: "'JetBrains Mono', monospace",
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {theme.name}
                          </div>
                          <div
                            style={{
                              marginTop: 3,
                              fontSize: 10,
                              color: "var(--cmux-text-tertiary)",
                              fontFamily: "'JetBrains Mono', monospace",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {theme.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div
              style={{
                fontSize: 12,
                color: "var(--cmux-text-secondary)",
                marginBottom: 8,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              フォントサイズ: {fontSize}px
            </div>
            <input
              type="range"
              min={10}
              max={24}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          <div>
            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--cmux-text-secondary)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                端末フォント
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  color: "var(--cmux-text-tertiary)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Codex / Claude 出力
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 8,
              }}
            >
              {!TERMINAL_FONT_PRESETS.some((preset) => preset.value === fontFamily) && (
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
              )}
              {TERMINAL_FONT_PRESETS.map((preset) => (
                <FontPresetOption
                  key={preset.id}
                  preset={preset}
                  active={preset.value === fontFamily}
                  onSelect={() => setFontFamily(preset.value)}
                />
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onOpenKeybindings}
            style={{
              background: "transparent",
              border: "1px solid var(--cmux-border)",
              borderRadius: 4,
              color: "var(--cmux-text-secondary)",
              padding: "6px 16px",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: "pointer",
              marginRight: 8,
            }}
          >
            キーボードショートカット
          </button>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--cmux-border)",
              borderRadius: 4,
              color: "var(--cmux-text-secondary)",
              padding: "6px 16px",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
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
