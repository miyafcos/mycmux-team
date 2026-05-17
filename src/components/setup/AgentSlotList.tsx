import AgentSelector from "./AgentSelector";
import { getDefaultAgent } from "../../lib/agents";

interface AgentSlotListProps {
  paneCount: number;
  assignments: Record<number, string>;
  onChange: (assignments: Record<number, string>) => void;
}

export default function AgentSlotList({ paneCount, assignments, onChange }: AgentSlotListProps) {
  const defaultAgentId = getDefaultAgent().id;
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--cmux-text-tertiary)",
          marginBottom: 8,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        Agents ({paneCount} panes)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {Array.from({ length: paneCount }, (_, i) => (
          <AgentSelector
            key={i}
            slotIndex={i}
            value={assignments[i] ?? defaultAgentId}
            onChange={(agentId) => onChange({ ...assignments, [i]: agentId })}
          />
        ))}
      </div>
    </div>
  );
}
