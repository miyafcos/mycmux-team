import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useLauncherDirsStore } from "../../../stores/launcherDirsStore";
import { AGENT_CATALOG } from "../../../lib/agentCatalog";
import { revealInExplorer } from "../../../lib/ipc";
import type { LauncherDirSection } from "../../../lib/ipc";
import { RULE_TYPES, formatCandidate, readLastScan, readRule, ruleForm, ruleId, ruleSummary, ruleTypeLabel, ruleTypeNote, validateRuleForm } from "../../../lib/launcherDirsModel";
import type { LauncherRule, RuleForm, RuleMode } from "../../../lib/launcherDirsModel";
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

const fieldStyle: CSSProperties = {
  width: "100%", minWidth: 0, boxSizing: "border-box", padding: "5px 7px", borderRadius: 4,
  border: "1px solid var(--cmux-border)", background: "var(--cmux-surface)", color: "var(--cmux-text)",
  font: "inherit", fontSize: "var(--cmux-font-size-sm)",
};
const cardStyle: CSSProperties = { border: "1px solid var(--cmux-border-hairline)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 };
const accentButton: CSSProperties = { ...smallButton, borderColor: "var(--cmux-accent)", color: "var(--cmux-accent-text)" };

function ModeFields({ name, mode, onChange, disabled }: { name: string; mode: RuleMode; onChange: (mode: RuleMode) => void; disabled: boolean }) {
  return <span style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
    {(["suggest", "auto"] as const).map((value) => <label key={value} style={{ ...checkboxLabelStyle, padding: 0, fontSize: "var(--cmux-font-size-xs)" }}>
      <input type="radio" name={name} value={value} checked={mode === value} disabled={disabled} onChange={() => onChange(value)} />
      {value === "suggest" ? T.modeSuggest : T.modeAuto}
    </label>)}
  </span>;
}

function RuleEditor({ initial, sections, busy, onSave, onCancel }: {
  initial: RuleForm; sections: LauncherDirSection[]; busy: boolean;
  onSave: (rule: LauncherRule) => Promise<boolean>; onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((old) => ({ ...old, [key]: value }));
  const isGit = form.type === "git-parents", isFolder = form.type === "folder-root", isCwd = form.type === "session-cwd";
  const pick = async () => {
    try {
      const path = await openDialog({ directory: true, multiple: false, title: T.pickFolderForRule });
      if (typeof path === "string") setForm((old) => isGit ? { ...old, parents: [old.parents.trim(), path].filter(Boolean).join("\n") } : { ...old, root: path });
    } catch (error) { setError(String(error)); }
  };
  const textField = (key: "parents" | "root" | "depth_overrides" | "exclude_prefixes" | "exclude_names" | "exclude_substrings" | "top_level_exclude", label: string, multiline = true) => <label style={{ display: "block", marginTop: 8 }}>
    <span style={{ display: "block", ...noteStyle, marginBottom: 3 }}>{label}</span>
    {multiline ? <textarea aria-label={label} rows={3} value={form[key]} onChange={(event) => set(key, event.target.value)} style={{ ...fieldStyle, resize: "vertical", fontFamily: "var(--cmux-font-mono)" }} />
      : <input aria-label={label} value={form[key]} onChange={(event) => set(key, event.target.value)} style={fieldStyle} />}
  </label>;
  const numberField = (key: "window_days" | "max" | "depth" | "max_depth" | "min_sessions" | "min_mentions", label: string) => <label style={{ flex: "1 1 120px", minWidth: 0 }}>
    <span style={{ display: "block", ...noteStyle, marginBottom: 3 }}>{label}</span>
    <input aria-label={label} type="number" min="1" step="1" value={form[key]} onChange={(event) => set(key, event.target.value)} style={fieldStyle} />
  </label>;
  return <form noValidate style={{ ...cardStyle, borderColor: "var(--cmux-accent)" }} onSubmit={(event) => {
    event.preventDefault();
    if (busy) return;
    const checked = validateRuleForm(form, T);
    setError(checked.error);
    if (checked.rule) void onSave(checked.rule).then((saved) => { if (saved) onCancel(); });
  }}>
    <div style={{ fontWeight: 600, marginBottom: 8 }}>{initial.id ? T.editorTitleEdit : T.editorTitleNew}{" \u00b7 "}{ruleTypeLabel(form.type, T)}</div>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div style={detailsRow}><span style={noteStyle}>{T.fieldSection}</span>
        {sections.map((section) => <button key={section.id} type="button" aria-pressed={form.section === section.id} style={form.section === section.id ? accentButton : smallButton} onClick={() => set("section", section.id)}>{section.label}</button>)}
      </div>
      <div style={detailsRow}><span style={noteStyle}>{T.fieldMode}</span><ModeFields name={`edit-${form.id || "new"}`} mode={form.mode} onChange={(mode) => set("mode", mode)} disabled={busy} /></div>
      {isGit ? textField("parents", T.fieldParents) : textField("root", isCwd ? T.fieldRootOptional : T.fieldRoot, false)}
      <button type="button" style={{ ...smallButton, marginTop: 4 }} onClick={() => { void pick(); }}>{T.pickFolderForRule}{isGit ? ` ${T.addFolderToList}` : ""}</button>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        {numberField("window_days", T.fieldWindowDays)}{numberField("max", T.fieldMax)}
        {!isGit && !isCwd && numberField("depth", T.fieldDepth)}
        {isFolder && numberField("max_depth", T.fieldMaxDepth)}
        {isCwd && numberField("min_sessions", T.fieldMinSessions)}
        {form.type === "session-mentions" && numberField("min_mentions", T.fieldMinMentions)}
      </div>
      {!isGit && !isCwd && textField("depth_overrides", T.fieldDepthOverrides)}
      {(isGit || isFolder) && <>
        {textField("exclude_prefixes", T.fieldExcludePrefixes)}
        {isGit && textField("exclude_names", T.fieldExcludeNames)}
        {textField("exclude_substrings", T.fieldExcludeSubstrings)}
      </>}
      {isFolder && textField("top_level_exclude", T.fieldTopLevelExclude)}
      {error && <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)", marginTop: 8 }}>{error}</div>}
      <div style={{ ...detailsRow, marginTop: 8 }}>
        <button type="submit" style={accentButton}>{T.saveRule}</button>
        <button type="button" style={smallButton} onClick={onCancel}>{T.cancelEdit}</button>
      </div>
    </fieldset>
  </form>;
}

export function LauncherTab() {
  const hiddenIds = useSettingsStore((state) => state.launcherHiddenIds);
  const setHiddenIds = useSettingsStore((state) => state.setLauncherHiddenIds);
  const hidden = new Set(hiddenIds);
  const store = useLauncherDirsStore();
  const { view, load, loading } = store;
  const sections = useMemo(() => dirSections(view), [view]);
  const [errorArea, setErrorArea] = useState<"folders" | "candidates" | "rules" | "details">("folders");
  const [localError, setLocalError] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<RuleForm | null>(null);
  const [choosingType, setChoosingType] = useState(false);
  const scan = readLastScan(view?.doc.last_scan);
  const rules = view?.doc.rules ?? [];

  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    setHiddenIds([...next]);
  };
  const run = (area: "folders" | "candidates" | "rules" | "details", operation: () => Promise<unknown>) => {
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
    const bare = rawError.startsWith("invalid rule: ") ? rawError.slice("invalid rule: ".length) : rawError;
    if (bare === "label is empty") return T.labelEmpty;
    if (bare === "not a directory") return T.notADirectory;
    if (bare.startsWith("not a directory: ")) return T.validationNotADirectory(bare.slice("not a directory: ".length));
    if (bare.startsWith("path must be absolute: ")) return T.validationAbsolutePath(bare.slice("path must be absolute: ".length));
    if (bare === "path contains a line break") return T.validationLineBreakInPath;
    const sectionId = bare.match(/^already registered in (.+)$/)?.[1];
    if (sectionId) return T.alreadyRegistered(view?.doc.sections.find((section) => section.id === sectionId)?.label ?? sectionId);
    return T.saveFailed(rawError);
  })();
  const errorBlock = (area: "folders" | "candidates" | "rules" | "details") => errorArea === area && errorText ? (
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
  const editor = (initial: RuleForm) => <RuleEditor key={initial.id || "new-rule"} initial={initial} sections={view?.doc.sections ?? []} busy={loading}
    onCancel={() => setEditingRule(null)} onSave={(rule) => { setErrorArea("rules"); setLocalError(null); return store.upsertRule(rule); }} />;
  const scanNow = (area: "candidates" | "rules") => run(area, store.scanNow);
  const ruleLabel = (id: string) => {
    const rule = readRule(rules.find((value) => ruleId(value) === id));
    if (!rule) return T.ruleTypeUnknown;
    const section = view?.doc.sections.find((section) => section.id === rule.section)?.label ?? rule.section;
    return `${section} \u00b7 ${ruleTypeLabel(rule.type, T)}`;
  };
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
      <div style={sectionHeadingStyle}>{T.candidatesHeading}</div>
      <div style={noteStyle}>{T.candidatesNote}</div>
      <div style={detailsRow}>
        <button type="button" style={smallButton} disabled={loading || store.scanning} onClick={() => scanNow("candidates")}>{store.scanning ? T.scanning : T.refreshCandidates}</button>
        <span role="status" style={noteStyle}>{scan ? T.lastScan(formatWhen(scan.at)) : T.lastScanNever}</span>
      </div>
      {scan && Object.entries(scan.results).map(([id, result]) => <div key={id} style={{ ...noteStyle, marginBottom: 3, overflowWrap: "anywhere", color: result.error ? "var(--cmux-red)" : noteStyle.color }}>
        {result.error ? T.scanFailed(ruleLabel(id), result.error) : `${ruleLabel(id)}: ${result.count}`}
        {result.truncated ? ` (${T.scanTruncated})` : ""}
      </div>)}
      {!scan?.candidates.length ? <div style={{ ...noteStyle, padding: "6px 0" }}>{T.noCandidates}</div> : scan.candidates.map((candidate) => {
        const formatted = formatCandidate(candidate, T);
        return <div key={candidate.path} style={{ borderTop: "1px solid var(--cmux-border-hairline)", padding: "7px 0" }}>
          <div style={{ display: "flex", gap: 7, alignItems: "baseline", minWidth: 0 }}>
            <span style={noteStyle}>{formatted.mark}</span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{candidate.label}</span>
            <span style={{ ...noteStyle, marginLeft: "auto", whiteSpace: "nowrap" }}>{formatted.signal}</span>
          </div>
          <div style={{ ...detailsRow, paddingBottom: 0 }}>
            <span title={formatted.title} style={{ ...pathStyle, flex: "1 1 200px" }}>{formatted.path}</span>
            {view?.doc.sections.map((section) => <button key={section.id} type="button" disabled={loading}
              style={candidate.section === section.id ? accentButton : smallButton}
              onClick={() => run("candidates", () => store.registerCandidate(section.id, candidate.path))}>{T.registerTo(section.label)}</button>)}
            <button type="button" style={smallButton} disabled={loading} title={T.ignoreTooltip} onClick={() => run("candidates", () => store.ignorePath(candidate.path))}>{T.ignore}</button>
          </div>
        </div>;
      })}
      {scan && scan.more > 0 && <div style={{ ...noteStyle, marginTop: 5 }}>{T.moreCandidates(scan.more)}</div>}
      {errorBlock("candidates")}

      <div style={dividerStyle} />
      <div style={sectionHeadingStyle}>{T.rulesHeading}</div>
      <div style={{ ...noteStyle, marginBottom: 8 }}>{T.rulesNote}</div>
      {rules.length === 0 && <div style={{ ...noteStyle, padding: "6px 0" }}>{T.noRules}</div>}
      {rules.map((value, index) => {
        const rule = readRule(value), id = ruleId(value);
        if (id && editingRule?.id === id) return editor(editingRule);
        return <div key={id ?? `unknown-${index}`} style={{ ...cardStyle, opacity: rule ? 1 : 0.55 }}>
          <div style={{ fontWeight: 600 }}>{rule ? ruleLabel(rule.id) : T.ruleTypeUnknown}</div>
          <div title={ruleSummary(value, view?.home_path ?? "", T)} style={{ ...noteStyle, margin: "3px 0 6px", overflowWrap: "anywhere" }}>{ruleSummary(value, view?.home_path ?? "", T)}</div>
          <div style={detailsRow}>
            {rule && <>
              <ModeFields name={rule.id} mode={rule.mode} disabled={loading} onChange={(mode) => run("rules", () => store.setRuleMode(rule.id, mode))} />
              <label style={{ ...checkboxLabelStyle, padding: 0, fontSize: "var(--cmux-font-size-xs)", marginLeft: "auto" }}>
                <input type="checkbox" checked={rule.enabled} disabled={loading} onChange={(event) => run("rules", () => store.setRuleEnabled(rule.id, event.target.checked))} />{T.ruleEnabled}
              </label>
            </>}
            <button type="button" style={smallButton} disabled={loading || !rule} onClick={() => { if (rule) { setChoosingType(false); setEditingRule(ruleForm(rule.type, rule.section, rule)); } }}>{T.editRule}</button>
            <button type="button" style={smallButton} disabled={loading || id === null} title={T.deleteRuleNote} onClick={() => { if (id !== null) run("rules", () => store.deleteRule(id)); }}>{T.deleteRule}</button>
          </div>
        </div>;
      })}
      {editingRule?.id === "" && editor(editingRule)}
      {choosingType && <div style={{ ...detailsRow, marginBottom: 8 }}>
        {RULE_TYPES.map((type) => <button key={type} type="button" style={smallButton} title={ruleTypeNote(type, T)} disabled={loading} onClick={() => {
          setEditingRule(ruleForm(type, view?.doc.sections[0]?.id ?? "dev")); setChoosingType(false);
        }}>{ruleTypeLabel(type, T)}</button>)}
      </div>}
      <div style={detailsRow}>
        <button type="button" style={smallButton} disabled={loading || editingRule !== null} aria-expanded={choosingType} onClick={() => setChoosingType(!choosingType)}>{T.addRule}</button>
        <button type="button" style={smallButton} disabled={loading || store.scanning} onClick={() => scanNow("rules")}>{store.scanning ? T.scanning : T.scanNow}</button>
      </div>
      <div style={noteStyle}>{view?.test_profile_active ? T.scheduleOffInTest : T.scheduleNote}</div>
      {errorBlock("rules")}

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
