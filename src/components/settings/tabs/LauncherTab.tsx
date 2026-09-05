import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useLauncherDirsStore } from "../../../stores/launcherDirsStore";
import { AGENT_CATALOG } from "../../../lib/agentCatalog";
import { revealInExplorer } from "../../../lib/ipc";
import { dirSections, middleEllipsis, shortLabel } from "../../workspace/launcherModel";
import { AgentKindIcon } from "../../icons/AgentIcons";
import { checkboxLabelStyle, dialogButtonStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";
import { launcherTabStrings as T } from "./launcherTabStrings";

const ICON_FOR: Record<string, string> = {
  claude: "claude", codex: "codex", "claude-codex": "claude-codex", "claude-codex-open": "claude-codex",
  grok: "grok", agy: "antigravity", "web-chatgpt": "codex", "web-gemini": "gemini",
  "web-grok": "grok", "web-claude": "claude", "web-notebooklm": "notebooklm",
};

const smallButton: CSSProperties = {
  ...dialogButtonStyle, padding: "3px 7px", fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "inherit", whiteSpace: "nowrap",
};
const noteStyle: CSSProperties = { fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-dim)" };
const pathStyle: CSSProperties = {
  ...noteStyle, fontFamily: "var(--cmux-font-mono)", minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const detailsRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "5px 0" };

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function EditableLabel({ value, disabled, onSave, onEmpty }: {
  value: string;
  disabled: boolean;
  onSave: (label: string) => void;
  onEmpty: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const activeEdit = useRef(false);
  const finish = (cancel = false) => {
    // Enter removes the input and can cause blur too. Only one may save.
    if (!activeEdit.current) return;
    activeEdit.current = false;
    setEditing(false);
    if (cancel) return;
    const label = draft.trim();
    if (!label) onEmpty();
    else if (label !== value) onSave(label);
  };
  if (editing) return (
    <input
      autoFocus
      value={draft}
      aria-label={T.editLabelTooltip}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === "Escape");
        }
      }}
      style={{
        width: "100%", minWidth: 0, boxSizing: "border-box", border: "1px solid var(--cmux-accent)",
        borderRadius: 4, background: "var(--cmux-surface)", color: "var(--cmux-text)",
        font: "inherit", fontSize: "var(--cmux-font-size-sm)", padding: "2px 3px",
      }}
    />
  );
  return (
    <button
      type="button"
      disabled={disabled}
      title={`${T.editLabelTooltip}: ${value}`}
      onClick={() => { activeEdit.current = true; setDraft(value); setEditing(true); }}
      style={{
        background: "none", border: 0, borderBottom: "1px dashed var(--cmux-border)", padding: "2px 0",
        color: "inherit", cursor: disabled ? "default" : "text", font: "inherit", maxWidth: "100%",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left",
      }}
    >
      {value}
    </button>
  );
}

export function LauncherTab() {
  const hiddenIds = useSettingsStore((state) => state.launcherHiddenIds);
  const setHiddenIds = useSettingsStore((state) => state.setLauncherHiddenIds);
  const hidden = new Set(hiddenIds);
  const store = useLauncherDirsStore();
  const { view, load, loading } = store;
  const sections = useMemo(() => dirSections(view), [view]);
  const [errorArea, setErrorArea] = useState<"folders" | "details">("folders");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    setHiddenIds([...next]);
  };
  const run = (area: "folders" | "details", operation: () => Promise<unknown>) => {
    setErrorArea(area);
    setLocalError(null);
    void operation().catch((error: unknown) => setLocalError(error instanceof Error ? error.message : String(error)));
  };
  const pickFolder = (sectionId: string) => run("folders", async () => {
    const path = await openDialog({ directory: true, multiple: false, title: T.pickFolderTitle });
    if (typeof path === "string") await store.addEntry(sectionId, path);
  });
  const emptyLabel = () => { setErrorArea("folders"); setLocalError("label is empty"); };
  const rawError = localError ?? store.error;
  const errorText = (() => {
    if (!rawError) return null;
    if (rawError === "label is empty") return T.labelEmpty;
    if (rawError === "not a directory") return T.notADirectory;
    const sectionId = rawError.match(/^already registered in (.+)$/)?.[1];
    if (sectionId) return T.alreadyRegistered(view?.doc.sections.find((section) => section.id === sectionId)?.label ?? sectionId);
    return T.saveFailed(rawError);
  })();
  const errorBlock = (area: "folders" | "details") => errorArea === area && errorText ? (
    <div role="alert" style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-red)", marginTop: 8, overflowWrap: "anywhere" }}>{errorText}</div>
  ) : null;

  const row = (id: string, label: string, iconKind?: string, note?: string) => (
    <label key={id} style={{ ...checkboxLabelStyle, alignItems: "flex-start" }}>
      <input type="checkbox" checked={!hidden.has(id)} onChange={(event) => toggle(id, event.target.checked)} />
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {iconKind ? <AgentKindIcon kind={iconKind} size={16} /> : null}
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block" }}>{label}</span>
          {note ? <span style={{ display: "block", ...noteStyle }}>{note}</span> : null}
        </span>
      </span>
    </label>
  );
  const writtenAt = formatWhen(view?.doc.export.roots_txt_written_at ?? null);
  const mergedAt = formatWhen(view?.doc.export.last_external_merge_at ?? null);

  return (
    <div style={{ fontSize: "var(--cmux-font-size-sm)", minWidth: 0 }}>
      <div style={sectionHeadingStyle}>{T.launchHeading}</div>
      {AGENT_CATALOG.filter((entry) => entry.kind === "agent").map((entry) => row(entry.target, shortLabel(entry), ICON_FOR[entry.target], entry.label))}
      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>{T.webHeading}</div>
      {AGENT_CATALOG.filter((entry) => entry.kind === "web").map((entry) => row(entry.target, shortLabel(entry), ICON_FOR[entry.target]))}
      <div style={dividerStyle} />
      {row("resume", T.resumeRow, undefined, T.resumeNote)}

      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>{T.foldersHeading}</div>
      <div style={{ ...noteStyle, marginBottom: 10 }}>{T.foldersNote}</div>
      {loading && <div role="status" style={{ ...noteStyle, marginBottom: 8 }}>{T.loading}</div>}
      {sections.map((section) => {
        const manual = section.items.filter((item) => item.source === "manual");
        return (
          <div key={section.id} style={{ border: "1px solid var(--cmux-border-hairline)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <div style={{ fontWeight: 600, minWidth: 60, maxWidth: "100%" }}>
                <EditableLabel value={section.label} disabled={loading} onEmpty={emptyLabel} onSave={(label) => run("folders", () => store.setSectionLabel(section.id, label))} />
              </div>
              <span style={noteStyle}>{T.sectionCount(section.items.length, manual.length, section.items.length - manual.length)}</span>
              <label style={{ ...checkboxLabelStyle, marginLeft: "auto", padding: 0, fontSize: "var(--cmux-font-size-xs)" }}>
                <input type="checkbox" checked={!hidden.has(section.id)} onChange={(event) => toggle(section.id, event.target.checked)} />
                {T.showSection}
              </label>
              <button type="button" style={smallButton} disabled={loading} onClick={() => pickFolder(section.id)}>{T.pickFolder}</button>
            </div>
            {section.items.length === 0 ? <div style={{ ...noteStyle, padding: "6px 0" }}>{T.sectionEmpty}</div> : section.items.map((item) => {
              const index = manual.findIndex((entry) => entry.id === item.id);
              const isManual = item.source === "manual";
              return (
                <div key={item.id} style={{
                  display: "grid", gridTemplateColumns: "44px minmax(70px, 1fr) minmax(70px, 1fr) auto auto auto", gap: 6,
                  alignItems: "center", borderTop: "1px solid var(--cmux-border-hairline)", padding: "6px 0",
                  color: item.exists ? "var(--cmux-text)" : "var(--cmux-text-dim)",
                }}>
                  <span style={{ display: "flex", gap: 2 }}>
                    {isManual && <>
                      <button type="button" title={T.moveUp} aria-label={T.moveUp} disabled={loading || index === 0} style={{ ...smallButton, padding: "2px 4px" }} onClick={() => run("folders", () => store.moveEntry(item.id, "up"))}>&#8593;</button>
                      <button type="button" title={T.moveDown} aria-label={T.moveDown} disabled={loading || index === manual.length - 1} style={{ ...smallButton, padding: "2px 4px" }} onClick={() => run("folders", () => store.moveEntry(item.id, "down"))}>&#8595;</button>
                    </>}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <EditableLabel value={item.label} disabled={loading} onEmpty={emptyLabel} onSave={(label) => run("folders", () => store.updateEntry(item.id, label))} />
                    {!item.exists && <span style={{ display: "block", ...noteStyle }}>{T.missing}</span>}
                  </span>
                  <span title={item.path} style={pathStyle}>{middleEllipsis(item.path, 42)}</span>
                  <span style={{ ...noteStyle, fontFamily: "var(--cmux-font-mono)", whiteSpace: "nowrap" }}>{item.mark}</span>
                  <span style={{ fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap", border: "1px solid var(--cmux-border)", borderRadius: 4, padding: "0 5px", color: !item.exists ? "var(--cmux-text-dim)" : isManual ? "var(--cmux-text-secondary)" : "var(--cmux-accent-text)" }}>
                    {isManual ? T.badgeManual : T.badgeAuto}
                  </span>
                  <span style={{ display: "flex", gap: 3 }}>
                    {isManual ? (
                      <button type="button" style={smallButton} disabled={loading} onClick={() => run("folders", () => store.removeEntry(item.id))}>{T.remove}</button>
                    ) : <>
                      <button type="button" style={smallButton} disabled={loading} title={T.pinTooltip} onClick={() => run("folders", () => store.pinEntry(item.id))}>{T.pin}</button>
                      <button type="button" style={smallButton} disabled={loading} title={T.ignoreTooltip} onClick={() => run("folders", () => store.ignorePath(item.path))}>{T.ignore}</button>
                    </>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={noteStyle}>{T.markLegend}</div>
      {errorBlock("folders")}

      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>{T.detailsHeading}</div>
      {view && <>
        <div style={detailsRow}>
          <span style={noteStyle}>{T.jsonLabel}</span>
          <span style={{ ...pathStyle, whiteSpace: "normal", overflowWrap: "anywhere" }}>{view.json_path}</span>
          <button type="button" style={smallButton} onClick={() => run("details", () => revealInExplorer(view.json_path))}>{T.open}</button>
        </div>
        <div style={detailsRow}>
          <span style={noteStyle}>{T.rootsLabel}</span>
          <span style={{ ...pathStyle, whiteSpace: "normal", overflowWrap: "anywhere" }}>{view.roots_txt_path}</span>
          <span style={noteStyle}>{writtenAt ? T.rootsWrittenAt(writtenAt) : T.rootsNeverWritten}</span>
          <button type="button" style={smallButton} disabled={loading} onClick={() => run("details", store.exportRoots)}>{T.exportNow}</button>
        </div>
        {view.doc.export.last_external_merge_at && <div style={{ ...noteStyle, padding: "5px 0" }}>{T.externalMerged(mergedAt)}</div>}
        <div style={{ ...noteStyle, marginTop: 10, fontWeight: 600 }}>{T.ignoredHeading}</div>
        {view.doc.ignored_paths.length === 0 ? <div style={{ ...noteStyle, padding: "5px 0" }}>{T.ignoredEmpty}</div> : view.doc.ignored_paths.map((path) => (
          <div key={path} style={detailsRow}>
            <span title={path} style={{ ...pathStyle, flex: "1 1 auto" }}>{middleEllipsis(path, 72)}</span>
            <button type="button" style={smallButton} disabled={loading} onClick={() => run("details", () => store.unignorePath(path))}>{T.unignore}</button>
          </div>
        ))}
      </>}
      {errorBlock("details")}
    </div>
  );
}
