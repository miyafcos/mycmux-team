import type { ThemeDefinition } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
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

export default function ThemeSwitcher({ onClose, onOpenKeybindings }: ThemeSwitcherProps) {
  const currentId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);

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
            Settings
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
            Theme Library
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

        <div>
          <div
            style={{
              fontSize: 12,
              color: "var(--cmux-text-secondary)",
              marginBottom: 8,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Font Size: {fontSize}px
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
            Keyboard Shortcuts
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
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
