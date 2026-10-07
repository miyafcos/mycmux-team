import { OverlayShell } from "../common/OverlayShell";
import { AgentDesignView, type AgentDesignViewProps } from "./AgentDesignView";
import { agentDesignStrings as s } from "./agentDesignStrings";
export interface AgentDesignPanelProps extends AgentDesignViewProps { open: boolean; closing?: boolean }
export function AgentDesignPanel({ open, closing = false, ...view }: AgentDesignPanelProps) {
  return <OverlayShell open={open} closing={closing} onClose={view.onClose} size="full" ariaLabel={s.title} id="agent-design-panel" closeOnEscape={false}><AgentDesignView {...view} /></OverlayShell>;
}
