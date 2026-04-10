const START_OPTIONS = [
  { id: "claude", label: "1. Claude Code", hint: "Standard Claude Code launch" },
  { id: "claude-resume", label: "2. Claude Code (resume)", hint: "Resume prompt via launcher" },
  { id: "claude-auto-mode", label: "3. Claude Code (auto-mode)", hint: "Launch with auto-mode" },
  { id: "codex", label: "4. Codex", hint: "Standard Codex launch" },
  { id: "codex-resume", label: "5. Codex (resume)", hint: "Resume prompt via launcher" },
  { id: "claude-codex", label: "6. claude-codex", hint: "Claude-on-Codex hybrid route" },
  { id: "custom", label: "7. Custom...", hint: "Open custom command prompt" },
] as const;

type StartOptionId = typeof START_OPTIONS[number]["id"] | "shell";

interface PaneStarterProps {
  onSelect: (target: StartOptionId) => void;
}

export default function PaneStarter({ onSelect }: PaneStarterProps) {
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
      <div
        style={{
          width: "min(460px, 100%)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 10,
          background: "rgba(18, 24, 38, 0.92)",
          boxShadow: "0 10px 24px rgba(0, 0, 0, 0.28)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "var(--cmux-text)",
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.04em",
          }}
        >
          Launch
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--cmux-text-secondary)",
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 2,
          }}
        >
          Select a startup target for this pane.
        </div>
        {START_OPTIONS.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            style={{
              width: "100%",
              textAlign: "left",
              border: "1px solid var(--cmux-border)",
              borderRadius: 8,
              background: "rgba(255,255,255,0.03)",
              color: "var(--cmux-text)",
              padding: "10px 12px",
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700 }}>{option.label}</span>
            <span style={{ fontSize: 10, color: "var(--cmux-text-secondary)" }}>{option.hint}</span>
          </button>
        ))}
        <button
          onClick={() => onSelect("shell")}
          style={{
            width: "100%",
            textAlign: "left",
            border: "1px dashed var(--cmux-border)",
            borderRadius: 8,
            background: "transparent",
            color: "var(--cmux-text-secondary)",
            padding: "10px 12px",
            cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
          }}
        >
          Shell prompt
        </button>
      </div>
    </div>
  );
}
