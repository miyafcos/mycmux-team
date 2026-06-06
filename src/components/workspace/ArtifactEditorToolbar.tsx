import { memo, type CSSProperties, type ReactNode } from "react";
import {
  Bold,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Table,
  X,
} from "lucide-react";

export type ArtifactEditorCommand =
  | "bold"
  | "italic"
  | "heading"
  | "bulletList"
  | "numberedList"
  | "link"
  | "addRow"
  | "addColumn"
  | "deleteRow"
  | "deleteColumn";

interface ArtifactEditorToolbarProps {
  canEdit: boolean;
  isEditing: boolean;
  isDirty: boolean;
  isBusy: boolean;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onCommand: (command: ArtifactEditorCommand) => void;
}

const buttonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 80%, transparent)",
  borderRadius: 6,
  color: "var(--cmux-text, #f3f4f6)",
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 86%, #ffffff 8%)",
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.42,
  cursor: "not-allowed",
};

const separatorStyle: CSSProperties = {
  width: 1,
  height: 22,
  background: "color-mix(in srgb, var(--cmux-border, #3a3a3a) 72%, transparent)",
  margin: "0 2px",
};

function ToolbarButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={disabled ? disabledButtonStyle : buttonStyle}
    >
      {children}
    </button>
  );
}

function ArtifactEditorToolbarImpl({
  canEdit,
  isEditing,
  isDirty,
  isBusy,
  onStartEdit,
  onSave,
  onCancel,
  onReload,
  onCommand,
}: ArtifactEditorToolbarProps) {
  const commandDisabled = !isEditing || isBusy;
  const iconSize = 15;

  return (
    <div
      style={{
        height: 38,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
        borderBottom: "1px solid var(--cmux-border, #333)",
        background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 92%, #ffffff 5%)",
        boxSizing: "border-box",
        overflowX: "auto",
      }}
    >
      <ToolbarButton title="Edit" disabled={!canEdit || isEditing || isBusy} onClick={onStartEdit}>
        <Pencil size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Save" disabled={!isEditing || !isDirty || isBusy} onClick={onSave}>
        <Save size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Cancel" disabled={!isEditing || isBusy} onClick={onCancel}>
        <X size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Reload" disabled={isBusy} onClick={onReload}>
        <RefreshCw size={iconSize} />
      </ToolbarButton>

      <span style={separatorStyle} />

      <ToolbarButton title="Bold" disabled={commandDisabled} onClick={() => onCommand("bold")}>
        <Bold size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Italic" disabled={commandDisabled} onClick={() => onCommand("italic")}>
        <Italic size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Heading" disabled={commandDisabled} onClick={() => onCommand("heading")}>
        <Heading2 size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Bullet list" disabled={commandDisabled} onClick={() => onCommand("bulletList")}>
        <List size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Numbered list" disabled={commandDisabled} onClick={() => onCommand("numberedList")}>
        <ListOrdered size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Link" disabled={commandDisabled} onClick={() => onCommand("link")}>
        <Link size={iconSize} />
      </ToolbarButton>

      <span style={separatorStyle} />

      <ToolbarButton title="Add row" disabled={commandDisabled} onClick={() => onCommand("addRow")}>
        <Plus size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Add column" disabled={commandDisabled} onClick={() => onCommand("addColumn")}>
        <Table size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Delete row" disabled={commandDisabled} onClick={() => onCommand("deleteRow")}>
        <Minus size={iconSize} />
      </ToolbarButton>
      <ToolbarButton title="Delete column" disabled={commandDisabled} onClick={() => onCommand("deleteColumn")}>
        <X size={iconSize} />
      </ToolbarButton>

      {isDirty && (
        <span
          title="Unsaved edits"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--cmux-accent, #0a84ff)",
            marginLeft: 2,
            flex: "0 0 auto",
          }}
        />
      )}
    </div>
  );
}

export default memo(ArtifactEditorToolbarImpl);
