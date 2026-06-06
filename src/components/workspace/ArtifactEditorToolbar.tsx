import { memo, type CSSProperties, type ReactNode } from "react";
import {
  Bold,
  CheckCircle2,
  CircleAlert,
  FileCode,
  FileText,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  Loader2,
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
  sourcePath?: string;
  sourceKind?: "html" | "markdown";
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onCommand: (command: ArtifactEditorCommand) => void;
}

type ButtonVariant = "primary" | "default" | "danger";

const shellStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 0,
  borderBottom: "1px solid var(--cmux-border, #333)",
  background: "linear-gradient(180deg, color-mix(in srgb, var(--cmux-popover, #1e1e1e) 94%, #ffffff 7%), color-mix(in srgb, var(--cmux-popover, #1e1e1e) 98%, #000000 6%))",
  boxSizing: "border-box",
  color: "var(--cmux-text, #f3f4f6)",
};

const topRowStyle: CSSProperties = {
  minHeight: 38,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px 4px",
  boxSizing: "border-box",
  overflowX: "auto",
  overflowY: "hidden",
};

const commandRowStyle: CSSProperties = {
  minHeight: 36,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 10px 7px",
  boxSizing: "border-box",
  overflowX: "auto",
  overflowY: "hidden",
};

const fileBlockStyle: CSSProperties = {
  minWidth: 140,
  flex: "1 1 auto",
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gridTemplateRows: "auto auto",
  columnGap: 8,
  alignItems: "center",
  overflow: "hidden",
};

const kindBadgeStyle: CSSProperties = {
  gridRow: "1 / span 2",
  minWidth: 38,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "0 7px",
  borderRadius: 6,
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 76%, transparent)",
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 78%, #ffffff 10%)",
  color: "color-mix(in srgb, var(--cmux-text, #f3f4f6) 90%, #8ab4ff)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0,
  boxSizing: "border-box",
};

const fileNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: "16px",
};

const parentPathStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 86%, transparent)",
  fontSize: 10,
  lineHeight: "13px",
};

const actionsStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  overflowX: "auto",
  maxWidth: "52%",
};

const groupStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  padding: 3,
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 70%, transparent)",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 82%, #ffffff 6%)",
};

const groupLabelStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "0 5px",
  color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 90%, transparent)",
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "22px",
  letterSpacing: 0,
};

function fileLeaf(path: string | undefined): string {
  if (!path) return "Artifact";
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function parentPath(path: string | undefined): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized;
  return normalized.slice(0, index);
}

function sourceKindLabel(kind: ArtifactEditorToolbarProps["sourceKind"]): string {
  if (kind === "markdown") return "MD";
  if (kind === "html") return "HTML";
  return "FILE";
}

function buttonStyle(variant: ButtonVariant, disabled?: boolean, withLabel?: boolean): CSSProperties {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  return {
    minWidth: withLabel ? 74 : 28,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: withLabel ? "0 10px" : 0,
    border: isPrimary
      ? "1px solid color-mix(in srgb, var(--cmux-accent, #0a84ff) 82%, #ffffff 18%)"
      : isDanger
        ? "1px solid color-mix(in srgb, #ef4444 58%, var(--cmux-border, #3a3a3a) 42%)"
        : "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 80%, transparent)",
    borderRadius: 6,
    color: isPrimary
      ? "#ffffff"
      : isDanger
        ? "color-mix(in srgb, #fecaca 86%, var(--cmux-text, #f3f4f6))"
        : "var(--cmux-text, #f3f4f6)",
    background: disabled
      ? "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 88%, #ffffff 5%)"
      : isPrimary
        ? "linear-gradient(180deg, color-mix(in srgb, var(--cmux-accent, #0a84ff) 92%, #ffffff 12%), color-mix(in srgb, var(--cmux-accent, #0a84ff) 82%, #000000 18%))"
        : isDanger
          ? "color-mix(in srgb, #7f1d1d 48%, var(--cmux-popover, #1e1e1e) 52%)"
          : "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 78%, #ffffff 9%)",
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
  };
}

function statusStyle(isDirty: boolean, isEditing: boolean, isBusy: boolean): CSSProperties {
  const color = isBusy ? "#f59e0b" : isDirty ? "#ef4444" : isEditing ? "#0a84ff" : "#22c55e";
  return {
    flex: "0 0 auto",
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0 8px",
    borderRadius: 999,
    border: `1px solid color-mix(in srgb, ${color} 48%, var(--cmux-border, #3a3a3a) 52%)`,
    color: "var(--cmux-text, #f3f4f6)",
    background: `color-mix(in srgb, ${color} 16%, var(--cmux-popover, #1e1e1e) 84%)`,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0,
    whiteSpace: "nowrap",
  };
}

function ToolbarButton({
  title,
  disabled,
  variant = "default",
  label,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  variant?: ButtonVariant;
  label?: string;
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
      style={buttonStyle(variant, disabled, Boolean(label))}
    >
      {children}
      {label && <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0 }}>{label}</span>}
    </button>
  );
}

function StatusPill({
  isDirty,
  isEditing,
  isBusy,
}: Pick<ArtifactEditorToolbarProps, "isDirty" | "isEditing" | "isBusy">) {
  const iconSize = 13;
  if (isBusy) {
    return (
      <span style={statusStyle(isDirty, isEditing, isBusy)} title="Working">
        <Loader2 size={iconSize} />
        Working
      </span>
    );
  }
  if (isDirty) {
    return (
      <span style={statusStyle(isDirty, isEditing, isBusy)} title="Unsaved edits">
        <CircleAlert size={iconSize} />
        Unsaved
      </span>
    );
  }
  if (isEditing) {
    return (
      <span style={statusStyle(isDirty, isEditing, isBusy)} title="Editing">
        <Pencil size={iconSize} />
        Editing
      </span>
    );
  }
  return (
    <span style={statusStyle(isDirty, isEditing, isBusy)} title="Preview mode">
      <CheckCircle2 size={iconSize} />
      Preview
    </span>
  );
}

function ArtifactEditorToolbarImpl({
  canEdit,
  isEditing,
  isDirty,
  isBusy,
  sourcePath,
  sourceKind,
  onStartEdit,
  onSave,
  onCancel,
  onReload,
  onCommand,
}: ArtifactEditorToolbarProps) {
  const commandDisabled = !isEditing || isBusy;
  const iconSize = 15;
  const SourceIcon = sourceKind === "markdown" ? FileText : FileCode;
  const name = fileLeaf(sourcePath);
  const parent = parentPath(sourcePath);

  return (
    <div style={shellStyle}>
      <div style={topRowStyle}>
        <div style={fileBlockStyle} title={sourcePath}>
          <span style={kindBadgeStyle}>
            <SourceIcon size={13} />
            {sourceKindLabel(sourceKind)}
          </span>
          <span style={fileNameStyle}>{name}</span>
          <span style={parentPathStyle}>{parent || "No source file"}</span>
        </div>
        <StatusPill isDirty={isDirty} isEditing={isEditing} isBusy={isBusy} />
        <div style={actionsStyle}>
          {!isEditing ? (
            <ToolbarButton
              title="Start editing this artifact"
              disabled={!canEdit || isBusy}
              variant="primary"
              label="Edit"
              onClick={onStartEdit}
            >
              <Pencil size={iconSize} />
            </ToolbarButton>
          ) : (
            <ToolbarButton
              title={isDirty ? "Save changes to the source file" : "No changes to save"}
              disabled={!isDirty || isBusy}
              variant="primary"
              label="Save"
              onClick={onSave}
            >
              <Save size={iconSize} />
            </ToolbarButton>
          )}
          <ToolbarButton title="Reload preview from disk" disabled={isBusy} onClick={onReload}>
            <RefreshCw size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            title="Discard edits and leave edit mode"
            disabled={!isEditing || isBusy}
            variant={isDirty ? "danger" : "default"}
            onClick={onCancel}
          >
            <X size={iconSize} />
          </ToolbarButton>
        </div>
      </div>

      <div style={commandRowStyle}>
        <div style={groupStyle} role="group" aria-label="Text formatting">
          <span style={groupLabelStyle}>Text</span>
          <ToolbarButton title="Bold" disabled={commandDisabled} onClick={() => onCommand("bold")}>
            <Bold size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Italic" disabled={commandDisabled} onClick={() => onCommand("italic")}>
            <Italic size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Heading" disabled={commandDisabled} onClick={() => onCommand("heading")}>
            <Heading2 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Link" disabled={commandDisabled} onClick={() => onCommand("link")}>
            <Link size={iconSize} />
          </ToolbarButton>
        </div>

        <div style={groupStyle} role="group" aria-label="Lists">
          <span style={groupLabelStyle}>List</span>
          <ToolbarButton title="Bullet list" disabled={commandDisabled} onClick={() => onCommand("bulletList")}>
            <List size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Numbered list" disabled={commandDisabled} onClick={() => onCommand("numberedList")}>
            <ListOrdered size={iconSize} />
          </ToolbarButton>
        </div>

        <div style={groupStyle} role="group" aria-label="Table editing">
          <span style={groupLabelStyle}>Table</span>
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
        </div>
      </div>
    </div>
  );
}

export default memo(ArtifactEditorToolbarImpl);
