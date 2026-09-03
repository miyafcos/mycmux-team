import { useId } from "react";
import type { CSSProperties } from "react";
import {
  LAUNCHABLE_AGENTS,
  LAUNCHER_MENU_TARGET,
  SHELL_TARGET,
  getCatalogEntry,
  isValidLaunchSpecValue,
  type PaneLaunchSpec,
} from "../../lib/agentCatalog";

interface AgentSelectorProps {
  slotIndex: number;
  value: PaneLaunchSpec;
  onChange: (spec: PaneLaunchSpec) => void;
}

const controlStyle: CSSProperties = {
  backgroundColor: "transparent",
  color: "var(--cmux-text)",
  colorScheme: "inherit",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: "var(--cmux-font-mono)",
  outline: "none",
  boxSizing: "border-box",
};

const optionStyle: CSSProperties = {
  backgroundColor: "var(--cmux-surface)",
  color: "var(--cmux-text)",
};

/**
 * One pane's launch choice: which agent, and optionally which model and effort.
 *
 * The agent list mirrors the launcher's own menu (src/lib/agentCatalog.ts), so
 * picking one here is the same thing as picking it from the launcher — the
 * choice travels as MYCMUX_LAUNCH_TARGET and the launcher does the spawning.
 */
export default function AgentSelector({ slotIndex, value, onChange }: AgentSelectorProps) {
  const modelListId = useId();
  const entry = getCatalogEntry(value.target);
  const model = value.model ?? "";
  // Empty is the default (no flag). A non-empty value that could be read as a
  // flag is dropped at launch, so say so here rather than silently ignoring it.
  // Trimmed the same way the launch path trims it, or a trailing space would
  // light up a value that will actually be accepted.
  const modelRejected = model.trim().length > 0 && !isValidLaunchSpecValue(model.trim());

  return (
    <div style={{ display: "flex", gap: 8, padding: "4px 0" }}>
      <span
        style={{
          fontSize: 11,
          color: "var(--cmux-text-tertiary)",
          fontFamily: "var(--cmux-font-mono)",
          width: 20,
          textAlign: "right",
          paddingTop: 6,
        }}
      >
        {slotIndex + 1}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <select
          value={value.target ?? LAUNCHER_MENU_TARGET}
          // Model and effort belong to the CLI that was picked, so switching the
          // agent clears them: a codex tier left behind would only be rejected
          // by claude.
          onChange={(event) => onChange({ target: event.target.value })}
          style={{ ...controlStyle, cursor: "pointer" }}
        >
          <option value={LAUNCHER_MENU_TARGET} style={optionStyle}>&gt; Launch Menu</option>
          <option value={SHELL_TARGET} style={optionStyle}>$ Shell</option>
          {LAUNCHABLE_AGENTS.map((agent) => (
            <option key={agent.target} value={agent.target} style={optionStyle}>
              {agent.label}
            </option>
          ))}
        </select>

        {entry && (
          <div style={{ display: "flex", gap: 4 }}>
            <input
              list={modelListId}
              value={model}
              onChange={(event) => onChange({ ...value, model: event.target.value })}
              placeholder="model (default)"
              spellCheck={false}
              aria-label={`Pane ${slotIndex + 1} model`}
              style={{
                ...controlStyle,
                flex: 2,
                minWidth: 0,
                borderColor: modelRejected ? "var(--cmux-red)" : "var(--cmux-border)",
              }}
            />
            <datalist id={modelListId}>
              {entry.models.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </datalist>
            {entry.efforts.length > 0 && (
              <select
                value={value.effort ?? ""}
                onChange={(event) => onChange({ ...value, effort: event.target.value })}
                aria-label={`Pane ${slotIndex + 1} effort`}
                style={{ ...controlStyle, flex: 1, minWidth: 0, cursor: "pointer" }}
              >
                <option value="" style={optionStyle}>effort (default)</option>
                {entry.efforts.map((effort) => (
                  <option key={effort} value={effort} style={optionStyle}>
                    {effort}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
