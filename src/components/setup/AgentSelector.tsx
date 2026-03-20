import { BUILT_IN_AGENTS } from "../../lib/agents";

interface AgentSelectorProps {
  value: string;
  onChange: (agentId: string) => void;
  slotIndex: number;
}

export default function AgentSelector({ value, onChange, slotIndex }: AgentSelectorProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "#585b70",
          fontFamily: "'JetBrains Mono', monospace",
          width: 20,
          textAlign: "right",
        }}
      >
        {slotIndex + 1}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          backgroundColor: "transparent",
          color: "var(--cmux-text)",
          colorScheme: "dark",
          border: "1px solid var(--cmux-border)",
          borderRadius: 4,
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "'JetBrains Mono', monospace",
          cursor: "pointer",
          outline: "none",
        }}
      >
        {BUILT_IN_AGENTS.map((agent) => (
          <option key={agent.id} value={agent.id} style={{ backgroundColor: "var(--cmux-surface)", color: "var(--cmux-text)" }}>
            {agent.icon} {agent.name}
          </option>
        ))}
      </select>
    </div>
  );
}
