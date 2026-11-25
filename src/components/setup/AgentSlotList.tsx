import AgentSelector from "./AgentSelector";
import type { PaneLaunchSpec } from "../../lib/agentCatalog";
import type { LaunchAccountListListener } from "../../lib/tabAccounts";
import { setupStrings } from "./setupStrings";

interface AgentSlotListProps {
  visible: boolean;
  paneCount: number;
  specs: Record<number, PaneLaunchSpec>;
  onChange: (slot: number, spec: PaneLaunchSpec) => void;
  onAccountRead: LaunchAccountListListener;
  onOpenAccountManagement: () => void;
}

const EMPTY_SPEC: PaneLaunchSpec = {};

export default function AgentSlotList({ visible, paneCount, specs, onChange, onAccountRead, onOpenAccountManagement }: AgentSlotListProps) {
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
        {setupStrings.agents(paneCount)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {Array.from({ length: paneCount }, (_, i) => (
          <AgentSelector
            key={i}
            visible={visible}
            slotIndex={i}
            value={specs[i] ?? EMPTY_SPEC}
            onChange={spec => onChange(i, spec)}
            onAccountRead={onAccountRead}
            onOpenAccountManagement={onOpenAccountManagement}
          />
        ))}
      </div>
    </div>
  );
}
