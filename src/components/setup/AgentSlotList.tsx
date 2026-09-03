import AgentSelector from "./AgentSelector";
import type { PaneLaunchSpec } from "../../lib/agentCatalog";

interface AgentSlotListProps {
  paneCount: number;
  specs: Record<number, PaneLaunchSpec>;
  onChange: (specs: Record<number, PaneLaunchSpec>) => void;
}

const EMPTY_SPEC: PaneLaunchSpec = {};

export default function AgentSlotList({ paneCount, specs, onChange }: AgentSlotListProps) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--cmux-text-tertiary)",
          marginBottom: 8,
          fontFamily: "var(--cmux-font-mono)",
        }}
      >
        Agents ({paneCount} panes)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {Array.from({ length: paneCount }, (_, i) => (
          <AgentSelector
            key={i}
            slotIndex={i}
            value={specs[i] ?? EMPTY_SPEC}
            onChange={(spec) => onChange({ ...specs, [i]: spec })}
          />
        ))}
      </div>
    </div>
  );
}
