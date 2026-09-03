import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { GridTemplateId } from "../../types";
import { getGridTemplate } from "../../lib/gridTemplates";
import { normalizeCwd, workspaceNameFromCwd } from "../../lib/workspaceBootstrap";
import type { PaneLaunchSpec } from "../../lib/agentCatalog";
import GridPicker from "./GridPicker";
import AgentSlotList from "./AgentSlotList";

export interface WorkspaceSetupResult {
  name: string;
  gridTemplateId: GridTemplateId;
  /** Empty means "wherever a PTY starts by default" (the home directory). */
  cwd: string;
  paneSpecs: Record<number, PaneLaunchSpec>;
}

interface WorkspaceSetupProps {
  /** Seeded from the workspace in front of the user when the dialog opened. */
  defaultCwd?: string;
  onLaunch: (result: WorkspaceSetupResult) => void;
  onCancel: () => void;
}

const mono = "var(--cmux-font-mono)";

const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--cmux-text-secondary)",
  marginBottom: 6,
  fontFamily: mono,
};

const inputStyle: CSSProperties = {
  width: "100%",
  backgroundColor: "transparent",
  color: "var(--cmux-text)",
  colorScheme: "inherit",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: mono,
  outline: "none",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  color: "var(--cmux-text-secondary)",
  padding: "6px 16px",
  fontSize: 12,
  fontFamily: mono,
  cursor: "pointer",
};

export default function WorkspaceSetup({ defaultCwd, onLaunch, onCancel }: WorkspaceSetupProps) {
  const [name, setName] = useState("");
  const [gridId, setGridId] = useState<GridTemplateId>("1x1");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [paneSpecs, setPaneSpecs] = useState<Record<number, PaneLaunchSpec>>({});

  const template = getGridTemplate(gridId);
  // The folder names the workspace unless the user types over it, so choosing a
  // folder is usually the only thing this dialog needs.
  const derivedName = workspaceNameFromCwd(cwd);

  const handleLaunch = useCallback(() => {
    onLaunch({
      name: name.trim() || derivedName,
      gridTemplateId: gridId,
      cwd: normalizeCwd(cwd),
      paneSpecs,
    });
  }, [cwd, derivedName, gridId, name, onLaunch, paneSpecs]);

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Working folder for this workspace",
        ...(cwd ? { defaultPath: cwd } : {}),
      });
      // null = cancelled: keep whatever was already in the field.
      if (typeof picked === "string" && picked.length > 0) setCwd(picked);
    } catch (error) {
      console.error("[workspace-setup] folder picker failed", error);
    }
  }, [cwd]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "var(--cmux-bg)",
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "calc(100% - 32px)",
          maxHeight: "calc(100% - 32px)",
          overflowY: "auto",
          background: "var(--cmux-surface)",
          border: "1px solid var(--cmux-border)",
          borderRadius: 8,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div
          style={{
            fontSize: 14,
            color: "var(--cmux-text)",
            fontFamily: mono,
            fontWeight: 600,
          }}
        >
          New Workspace
        </div>

        <div>
          <div style={fieldLabelStyle}>Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={derivedName}
            onKeyDown={(e) => e.key === "Enter" && handleLaunch()}
            style={inputStyle}
          />
        </div>

        <div>
          <div style={fieldLabelStyle}>Working folder</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="(home)"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && handleLaunch()}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <button type="button" onClick={handleBrowse} style={buttonStyle}>
              Browse
            </button>
          </div>
        </div>

        <GridPicker selected={gridId} onSelect={setGridId} />
        <AgentSlotList
          paneCount={template.paneCount}
          specs={paneSpecs}
          onChange={setPaneSpecs}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={buttonStyle}>
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            style={{
              ...buttonStyle,
              background: "var(--cmux-accent)",
              border: "none",
              color: "var(--cmux-on-accent)",
              fontWeight: 600,
            }}
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
