import { useEffect } from "react";
import { LAUNCHABLE_AGENTS } from "../../../lib/agentCatalog";
import { agentServiceVisibilityStrings as T } from "../../../lib/agentServiceVisibilityStrings";
import { useAgentServiceVisibility } from "../../../hooks/useAgentServiceVisibility";
import { useAgentServiceDetectionStore } from "../../../stores/agentServiceDetectionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { AgentKindIcon } from "../../icons/AgentIcons";
import { launchItems } from "../../workspace/launcherModel";
import { checkboxLabelStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";

const noteStyle = { fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-dim)" };
const icons = new Map(launchItems().map((item) => [item.target, item.iconKind]));

export function AgentServicesTab() {
  const visible = useAgentServiceVisibility();
  const setVisible = useSettingsStore((state) => state.setAgentServiceVisible);
  const { detection, refresh } = useAgentServiceDetectionStore();
  useEffect(() => { void refresh(); }, [refresh]);
  return <div style={{ fontSize: "var(--cmux-font-size-sm)", minWidth: 0 }}>
    <div style={sectionHeadingStyle}>{T.heading}</div>
    <p style={noteStyle}>{T.note}</p>
    <p style={noteStyle}>{T.firstRunNote}</p>
    {LAUNCHABLE_AGENTS.map((agent) => <label key={agent.target} style={{ ...checkboxLabelStyle, alignItems: "flex-start" }}>
      <input type="checkbox" checked={visible(agent.target)} onChange={(event) => setVisible(agent.target, event.target.checked)} />
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <AgentKindIcon kind={icons.get(agent.target) ?? ""} size={16} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block" }}>{agent.label}</span>
          <span role="status" style={{ display: "block", ...noteStyle }}>
            {detection.status === "success" ? detection.installed[agent.target] ? T.detected : T.notDetected
              : detection.status === "failed" ? T.detectFailed : detection.status === "waiting-for-path" ? T.notChecked : T.detecting}
          </span>
        </span>
      </span>
    </label>)}
    <div style={dividerStyle} />
    <p style={noteStyle}>{T.webNote}</p>
  </div>;
}
