import { memo, type CSSProperties, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ExternalLink,
  FolderOpen,
  Heading2,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sigma,
  Table,
  X,
} from "lucide-react";
import type { ArtifactSourceKind } from "../../types";

export type ArtifactEditorCommand =
  | "bold"
  | "italic"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "indent"
  | "outdent"
  | "fontFamily"
  | "fontSize"
  | "heading"
  | "bulletList"
  | "numberedList"
  | "link"
  | "equation"
  | "addRow"
  | "addColumn"
  | "deleteRow"
  | "deleteColumn";

export type ArtifactEditorCommandValue = string;

interface ArtifactEditorToolbarProps {
  canEdit: boolean;
  isEditing: boolean;
  isDirty: boolean;
  isBusy: boolean;
  isSourceMode?: boolean;
  sourcePath?: string;
  sourceKind?: ArtifactSourceKind;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onRevealSource: () => void;
  onOpenSource: () => void;
  onCommand: (command: ArtifactEditorCommand, value?: ArtifactEditorCommandValue) => void;
}

type ButtonVariant = "primary" | "default" | "danger";

const shellStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 0,
  borderBottom: "1px solid var(--cmux-border, #333)",
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 96%, #ffffff 4%)",
  boxSizing: "border-box",
  color: "var(--cmux-text, #f3f4f6)",
};

const topRowStyle: CSSProperties = {
  minHeight: 38,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 9px 3px",
  boxSizing: "border-box",
  overflowX: "auto",
  overflowY: "hidden",
};

const commandRowStyle: CSSProperties = {
  minHeight: 36,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 9px 6px",
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
  minWidth: 34,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 76%, transparent)",
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 84%, #ffffff 7%)",
  color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 92%, var(--cmux-text, #f3f4f6))",
  fontSize: 10,
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
  fontWeight: 650,
  lineHeight: "16px",
};

const parentPathStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 86%, transparent)",
  fontSize: 11,
  lineHeight: "13px",
};

const actionsStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  overflowX: "auto",
  maxWidth: "38%",
};

const groupStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: 2,
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 70%, transparent)",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 86%, #ffffff 5%)",
};

const groupLabelStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "0 4px",
  color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 90%, transparent)",
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "22px",
  letterSpacing: 0,
};

const selectStyle: CSSProperties = {
  height: 24,
  maxWidth: 142,
  border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 80%, transparent)",
  borderRadius: 5,
  background: "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 78%, #ffffff 9%)",
  color: "var(--cmux-text, #f3f4f6)",
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: 0,
  padding: "0 6px",
  boxSizing: "border-box",
};

const FONT_FAMILY_OPTIONS = [
  { label: "Aptos", value: "Aptos" },
  { label: "Yu Gothic", value: "Yu Gothic" },
  { label: "Meiryo", value: "Meiryo" },
  { label: "BIZ UD Gothic", value: "BIZ UDGothic" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Cambria Math", value: "Cambria Math" },
];

const FONT_SIZE_OPTIONS = ["10", "11", "12", "14", "16", "18", "24", "32"];

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

function sourceKindLabel(kind: ArtifactEditorToolbarProps["sourceKind"], sourcePath: string | undefined): string {
  if (kind === "office") {
    const extension = sourcePath?.split(".").pop()?.toUpperCase();
    if (extension && extension.length <= 5) return extension;
    return "OFFICE";
  }
  if (kind === "markdown") return "MD";
  if (kind === "html") return "HTML";
  return "FILE";
}

function buttonStyle(variant: ButtonVariant, disabled?: boolean, withLabel?: boolean): CSSProperties {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  return {
    minWidth: withLabel ? 62 : 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: withLabel ? "0 7px" : 0,
    border: isPrimary
      ? "1px solid color-mix(in srgb, var(--cmux-accent, #0a84ff) 62%, var(--cmux-border, #3a3a3a) 38%)"
      : isDanger
        ? "1px solid color-mix(in srgb, #ef4444 58%, var(--cmux-border, #3a3a3a) 42%)"
        : "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 80%, transparent)",
    borderRadius: 5,
    color: isPrimary
      ? "color-mix(in srgb, var(--cmux-accent, #0a84ff) 74%, #ffffff 26%)"
      : isDanger
        ? "color-mix(in srgb, #fecaca 86%, var(--cmux-text, #f3f4f6))"
        : "var(--cmux-text, #f3f4f6)",
    background: disabled
      ? "color-mix(in srgb, var(--cmux-popover, #1e1e1e) 88%, #ffffff 5%)"
      : isPrimary
        ? "color-mix(in srgb, var(--cmux-accent, #0a84ff) 13%, var(--cmux-popover, #1e1e1e) 87%)"
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
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "0 7px",
    borderRadius: 999,
    border: "1px solid color-mix(in srgb, var(--cmux-border, #3a3a3a) 74%, transparent)",
    color: "color-mix(in srgb, var(--cmux-text-muted, #a1a1aa) 82%, var(--cmux-text, #f3f4f6))",
    background: `color-mix(in srgb, ${color} 8%, var(--cmux-popover, #1e1e1e) 92%)`,
    fontSize: 10,
    fontWeight: 650,
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

function ToolbarSelect({
  title,
  disabled,
  placeholder,
  options,
  onChange,
}: {
  title: string;
  disabled?: boolean;
  placeholder: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      title={title}
      aria-label={title}
      disabled={disabled}
      defaultValue=""
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (value) onChange(value);
        event.currentTarget.value = "";
      }}
      style={{ ...selectStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444" }} />
        Unsaved
      </span>
    );
  }
  if (isEditing) {
    return (
      <span style={statusStyle(isDirty, isEditing, isBusy)} title="Editing">
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "#0a84ff" }} />
        Editing
      </span>
    );
  }
  return (
    <span style={statusStyle(isDirty, isEditing, isBusy)} title="Preview mode">
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
      Preview
    </span>
  );
}

function ArtifactEditorToolbarImpl({
  canEdit,
  isEditing,
  isDirty,
  isBusy,
  isSourceMode,
  sourcePath,
  sourceKind,
  onStartEdit,
  onSave,
  onCancel,
  onReload,
  onRevealSource,
  onOpenSource,
  onCommand,
}: ArtifactEditorToolbarProps) {
  const commandDisabled = !isEditing || isBusy || Boolean(isSourceMode);
  const iconSize = 13;
  const name = fileLeaf(sourcePath);
  const parent = parentPath(sourcePath);

  return (
    <div style={shellStyle}>
      <div style={topRowStyle}>
        <div style={fileBlockStyle} title={sourcePath}>
          <span style={kindBadgeStyle}>{sourceKindLabel(sourceKind, sourcePath)}</span>
          <span style={fileNameStyle}>{name}</span>
          <span style={parentPathStyle}>{parent || "No source file"}</span>
        </div>
        <StatusPill isDirty={isDirty} isEditing={isEditing} isBusy={isBusy} />
        <div style={actionsStyle}>
          <ToolbarButton
            title={isEditing ? "Editing" : "Edit this artifact"}
            disabled={!canEdit || isBusy || isEditing}
            variant={isEditing ? "primary" : "default"}
            onClick={onStartEdit}
          >
            <Pencil size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            title="Open in the default desktop app"
            disabled={!sourcePath || isBusy}
            onClick={onOpenSource}
          >
            <ExternalLink size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            title="Show document location in Explorer"
            disabled={!sourcePath || isBusy}
            onClick={onRevealSource}
          >
            <FolderOpen size={iconSize} />
          </ToolbarButton>
        </div>
      </div>

      {isEditing && (
      <div style={commandRowStyle}>
        <div style={groupStyle} role="group" aria-label="File actions">
          <span style={groupLabelStyle}>File</span>
          <ToolbarButton
            title={isDirty ? "Save changes to the source file" : "No changes to save"}
            disabled={!isDirty || isBusy}
            variant="primary"
            label="Save"
            onClick={onSave}
          >
            <Save size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Reload from disk" disabled={isBusy} onClick={onReload}>
            <RefreshCw size={iconSize} />
          </ToolbarButton>
          <ToolbarButton
            title="Discard edits and leave edit mode"
            disabled={isBusy}
            variant={isDirty ? "danger" : "default"}
            onClick={onCancel}
          >
            <X size={iconSize} />
          </ToolbarButton>
        </div>

        {!isSourceMode && <>
        <div style={groupStyle} role="group" aria-label="Text formatting">
          <span style={groupLabelStyle}>Text</span>
          <ToolbarButton title="Bold" disabled={commandDisabled} onClick={() => onCommand("bold")}>
            <Bold size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Italic" disabled={commandDisabled} onClick={() => onCommand("italic")}>
            <Italic size={iconSize} />
          </ToolbarButton>
          <ToolbarSelect
            title="Font family"
            disabled={commandDisabled}
            placeholder="Font"
            options={FONT_FAMILY_OPTIONS}
            onChange={(value) => onCommand("fontFamily", value)}
          />
          <ToolbarSelect
            title="Font size"
            disabled={commandDisabled}
            placeholder="Size"
            options={FONT_SIZE_OPTIONS.map((value) => ({ label: `${value} pt`, value }))}
            onChange={(value) => onCommand("fontSize", value)}
          />
        </div>

        <div style={groupStyle} role="group" aria-label="Paragraph formatting">
          <span style={groupLabelStyle}>Para</span>
          <ToolbarButton title="Align left" disabled={commandDisabled} onClick={() => onCommand("alignLeft")}>
            <AlignLeft size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Align center" disabled={commandDisabled} onClick={() => onCommand("alignCenter")}>
            <AlignCenter size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Align right" disabled={commandDisabled} onClick={() => onCommand("alignRight")}>
            <AlignRight size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Outdent" disabled={commandDisabled} onClick={() => onCommand("outdent")}>
            <ListIndentDecrease size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Indent" disabled={commandDisabled} onClick={() => onCommand("indent")}>
            <ListIndentIncrease size={iconSize} />
          </ToolbarButton>
        </div>

        <div style={groupStyle} role="group" aria-label="Document structure">
          <span style={groupLabelStyle}>Struct</span>
          <ToolbarButton title="Heading" disabled={commandDisabled} onClick={() => onCommand("heading")}>
            <Heading2 size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Bullet list" disabled={commandDisabled} onClick={() => onCommand("bulletList")}>
            <List size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Numbered list" disabled={commandDisabled} onClick={() => onCommand("numberedList")}>
            <ListOrdered size={iconSize} />
          </ToolbarButton>
        </div>

        <div style={groupStyle} role="group" aria-label="Insert">
          <span style={groupLabelStyle}>Insert</span>
          <ToolbarButton title="Link" disabled={commandDisabled} onClick={() => onCommand("link")}>
            <Link size={iconSize} />
          </ToolbarButton>
          <ToolbarButton title="Equation" disabled={commandDisabled} onClick={() => onCommand("equation")}>
            <Sigma size={iconSize} />
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
        </>}
      </div>
      )}
    </div>
  );
}

export default memo(ArtifactEditorToolbarImpl);
