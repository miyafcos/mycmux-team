const START_OPTIONS = [
  { id: "claude", label: "1. Claude Code" },
  { id: "claude-resume", label: "2. Claude Code (resume)" },
  { id: "claude-auto-mode", label: "3. Claude Code (auto-mode)" },
  { id: "codex", label: "4. Codex" },
  { id: "codex-resume", label: "5. Codex (resume)" },
  { id: "claude-codex", label: "6. claude-codex" },
  { id: "custom", label: "7. Custom..." },
] as const;

type StartOptionId = typeof START_OPTIONS[number]["id"] | "shell";

interface PaneStarterProps {
  onSelect: (target: StartOptionId) => void;
}

export default function PaneStarter({ onSelect }: PaneStarterProps) {
  const panelStyle: React.CSSProperties = {
    width: 420,
    maxWidth: "100%",
    background: "var(--cmux-surface)",
    border: "1px solid var(--cmux-border)",
    borderRadius: 8,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxSizing: "border-box",
  };

  const buttonStyle: React.CSSProperties = {
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "1px solid var(--cmux-border)",
    borderRadius: 4,
    color: "var(--cmux-text)",
    padding: "8px 10px",
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    cursor: "pointer",
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--cmux-bg, #0a0a0a)",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <div style={panelStyle}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "var(--cmux-text)",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Launch
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--cmux-text-secondary)",
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 4,
          }}
        >
          Select target
        </div>
        {START_OPTIONS.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            style={buttonStyle}
          >
            {option.label}
          </button>
        ))}
        <button
          onClick={() => onSelect("shell")}
          style={{
            ...buttonStyle,
            color: "var(--cmux-text-secondary)",
            marginTop: 4,
          }}
        >
          Shell prompt
        </button>
      </div>
    </div>
  );
}
