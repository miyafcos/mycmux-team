import { recoverNamesFromContent, undoRecoveredNames, type NameRecoveryFeedback } from "../../../lib/nameRecoveryAction";
import { useAutoNameRuntimeStore } from "../../../stores/autoNameRuntimeStore";
import { useEffect, useRef, useState } from "react";
import { AI_PROVIDERS, aiProviderDef, classifyModelForProvider } from "../../../lib/aiModels";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getAppSettings, onAilogMirrorFullTextRootChanged, setAilogMirrorFullTextRoot } from "../../../lib/ipc";
import { useToastStore } from "../../../stores/toastStore";
import { aiSettingsStrings } from "../settingsStrings";
import { checkboxLabelStyle, checkboxLabelStyleFor, dividerStyle, sectionHeadingStyle } from "../tabStyles";

import { JevSettingsSection } from "./JevSettingsSection";
import { ClaudeSkillsSection } from "./ClaudeSkillsSection";
import { AgentIntegrationsSection } from "./AgentIntegrationsSection";
import { CodexAppServerSection } from "./CodexAppServerSection";
import { DshAcpSection } from "./DshAcpSection";

const CUSTOM_MODEL_VALUE = "__custom__";
const nameRecoveryFeedback: NameRecoveryFeedback = (result, undo) => {
  const messages = {
    applied: "名前を付け直しました。",
    failed: "作業内容を取得できませんでした。名前の付け直しは元に戻せます。",
    undone: "名前の付け直しを元に戻しました。後から手で付けた名前は残ります。",
  };
  useToastStore.getState().pushToast(messages[result], result === "failed" ? "error" : "info", undo ? { label: "元に戻す", run: undo } : undefined);
};
const hintStyle = { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: "var(--cmux-text-dim)" } as const;
const selectStyle = { width: 300, fontSize: 12, padding: "5px 8px" } as const;
const badgeStyle = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 6px",
  borderRadius: 999,
  background: "var(--cmux-surface-raised)",
  color: "var(--cmux-text-dim)",
  fontSize: 10,
  fontWeight: 700,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
} as const;

interface FeatureRowProps {
  label: string;
  badge?: string;
  disclosure: string;
  enabled: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  unavailable?: boolean;
}

function FeatureRow({ label, badge, disclosure, enabled, checked, onChange, unavailable = false }: FeatureRowProps) {
  const title = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span>{label}</span>
      {badge ? <span style={badgeStyle}>{badge}</span> : null}
    </div>
  );

  return (
    <div style={{ opacity: unavailable || !enabled ? 0.5 : 1 }} aria-disabled={unavailable || !enabled || undefined}>
      {onChange ? (
        <label style={checkboxLabelStyleFor(enabled && !unavailable)}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!enabled || unavailable}
            onChange={(event) => onChange(event.target.checked)}
          />
          {title}
        </label>
      ) : (
        <div style={{ ...checkboxLabelStyle, cursor: "default" }}>{title}</div>
      )}
      <div style={hintStyle}>{disclosure}</div>
    </div>
  );
}

function AilogFullTextMirrorSettings() {
  const [root, setRoot] = useState<string | null>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const readRevision = useRef(0);
  const latestSave = useRef(0);
  const confirmedSave = useRef(0);
  const title = "AI ログの全文の控え";

  useEffect(() => {
    let mounted = true;
    let loaded = false;
    let unlisten: (() => void) | undefined;
    const refresh = (savedRevision?: number) => {
      if (!mounted || (savedRevision !== undefined && savedRevision <= latestSave.current)) return;
      if (savedRevision !== undefined) latestSave.current = savedRevision;
      const observedSave = latestSave.current;
      const request = ++readRevision.current;
      const isCurrent = () => mounted && request === readRevision.current && observedSave >= confirmedSave.current;
      void getAppSettings().then((settings) => {
        if (!isCurrent()) return;
        const saved = settings.ailog_mirror_full_text_root?.trim() || null;
        confirmedSave.current = observedSave;
        setRoot(saved);
        setReadError(false);
        if (!loaded) {
          loaded = true;
          setDraft(saved ?? "");
        }
      }, () => {
        // A failed read of our own notice cannot undo a confirmed reply.
        if (isCurrent() && (observedSave === 0 || observedSave > confirmedSave.current)) {
          setReadError(true);
        }
      });
    };
    // Subscribe before loading so a concurrent save cannot go unnoticed.
    void onAilogMirrorFullTextRootChanged(refresh).then((stop) => {
      if (!mounted) {
        stop();
        return;
      }
      unlisten = stop;
      refresh();
    }, () => refresh());
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  async function save(next: string | null) {
    setSaving(true);
    setSaveError(undefined);
    try {
      const { root: saved, revision } = await setAilogMirrorFullTextRoot(next);
      if (revision >= latestSave.current) {
        latestSave.current = revision;
        if (revision > confirmedSave.current) {
          confirmedSave.current = revision;
          setRoot(saved);
          setReadError(false);
        }
        setDraft(saved ?? "");
      }
    } catch (cause) {
      setSaveError(cause === "ailog.mirror.root_not_absolute"
        ? "保存先には絶対パスを入力してください。"
        : "保存先の設定を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  const disabled = root === undefined || saving;
  const readMessage = readError
    ? root === undefined ? "保存先を読み込めませんでした。" : "保存先を読み直せませんでした。"
    : undefined;
  const status = root === undefined ? (readError ? null : "読み込み中")
    : readError ? "現在の保存先を確認できません" : root ?? "控えない";
  return (
    <section aria-label={title}>
      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{title}</div>
      <div role="status" style={{ ...hintStyle, overflowWrap: "anywhere" }}>
        {status}
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && draft.trim()) void save(draft);
      }} style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <label style={{ display: "grid", gap: 6 }}>
          保存先の絶対パス
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={disabled || !draft.trim()}>保存</button>
          <button type="button" disabled={disabled || (!readError && root === null)} onClick={() => void save(null)}>控えない</button>
        </div>
        {readMessage ? <div role="alert">{readMessage}</div> : null}
        {saveError ? <div role="alert">{saveError}</div> : null}
      </form>
    </section>
  );
}

export function AiTab() {
  const provider = useAiSettingsStore((s) => s.aiProvider);
  const model = useAiSettingsStore((s) => s.aiModel);
  const enabled = useAiSettingsStore((s) => s.aiEnabled);
  const setProvider = useAiSettingsStore((s) => s.setAiProvider);
  const setModel = useAiSettingsStore((s) => s.setAiModel);
  const setEnabled = useAiSettingsStore((s) => s.setAiEnabled);
  const replyDraftSuggestionsEnabled = useSettingsStore((s) => s.replyDraftSuggestionsEnabled);
  const setReplyDraftSuggestionsEnabled = useSettingsStore((s) => s.setReplyDraftSuggestionsEnabled);
  const autoPaneNamingEnabled = useSettingsStore((s) => s.autoPaneNamingEnabled);
  const setAutoPaneNamingEnabled = useSettingsStore((s) => s.setAutoPaneNamingEnabled);

  const autoWorkspaceNamingEnabled = useSettingsStore(s => s.autoWorkspaceNamingEnabled);
  const setAutoWorkspaceNamingEnabled = useSettingsStore(s => s.setAutoWorkspaceNamingEnabled);
  const recovery = useAutoNameRuntimeStore(s => s.recovery);

  const def = aiProviderDef(provider);
  const isPreset = def.presets.some((preset) => preset.id === model);
  const [customModelMode, setCustomModelMode] = useState(!isPreset);
  const [draft, setDraft] = useState(model);

  useEffect(() => {
    setCustomModelMode(!isPreset);
    setDraft(model);
  }, [isPreset, model]);

  const classification = classifyModelForProvider(provider, model);

  return (
    <div>
      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>{aiSettingsStrings.enableLabel}</span>
      </label>
      <div style={hintStyle}>{aiSettingsStrings.enableHint}</div>

      <label style={{ display: "grid", gap: 6, marginTop: 24, fontSize: 12, fontWeight: 600 }}>
        <span>{aiSettingsStrings.providerTitle}</span>
        <select
          value={provider}
          disabled={!enabled}
          onChange={(event) => setProvider(event.target.value as typeof provider)}
          style={selectStyle}
        >
          {AI_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>

      <label style={{ display: "grid", gap: 6, marginTop: 16, fontSize: 12, fontWeight: 600 }}>
        <span>{aiSettingsStrings.modelTitle}</span>
        <select
          value={customModelMode ? CUSTOM_MODEL_VALUE : model}
          disabled={!enabled}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL_VALUE) {
              setCustomModelMode(true);
              setDraft(model);
              return;
            }
            setCustomModelMode(false);
            setModel(event.target.value);
          }}
          style={selectStyle}
        >
          {def.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.id}</option>)}
          <option value={CUSTOM_MODEL_VALUE}>{aiSettingsStrings.customModelLabel}</option>
        </select>
      </label>
      {customModelMode ? (
        <input
          aria-label={aiSettingsStrings.customModelLabel}
          type="text"
          value={draft}
          disabled={!enabled}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setModel(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setModel(draft);
          }}
          style={{ ...selectStyle, marginTop: 8 }}
        />
      ) : null}
      {classification === "likely-mismatch" && (
        <div style={{ ...hintStyle, color: "var(--cmux-usage-warn)" }}>
          {aiSettingsStrings.modelMismatch(def.label)}
        </div>
      )}
      {customModelMode && classification === "custom" ? <div style={hintStyle}>{aiSettingsStrings.modelCustom}</div> : null}

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>名前の自動設定（AIを使わない）</div>
      <div style={{ display: "grid", gap: 14 }}>
        <FeatureRow
          label={aiSettingsStrings.features.autoPaneNaming.label}
          badge={aiSettingsStrings.automaticBadge}
          disclosure={aiSettingsStrings.features.autoPaneNaming.disclosure}
          enabled={true}
          checked={autoPaneNamingEnabled}
          onChange={setAutoPaneNamingEnabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.autoWorkspaceNaming.label}
          disclosure={aiSettingsStrings.features.autoWorkspaceNaming.disclosure}
          enabled={true}
          checked={autoWorkspaceNamingEnabled}
          onChange={setAutoWorkspaceNamingEnabled}
        />
        <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
          <button onClick={() => void recoverNamesFromContent(undefined, nameRecoveryFeedback)}>自動の名前に戻す (手で付けた名前以外)</button>
          {recovery && <button onClick={() => undoRecoveredNames(nameRecoveryFeedback)}>名前の付け直しを元に戻す</button>}
        </div>
      </div>
      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{aiSettingsStrings.featureTitle}</div>
      <div style={{ display: "grid", gap: 14 }}>
        <FeatureRow
          label={aiSettingsStrings.features.replyDraft.label}
          badge={aiSettingsStrings.automaticOnReadBadge}
          disclosure={aiSettingsStrings.features.replyDraft.disclosure}
          enabled={enabled}
          checked={replyDraftSuggestionsEnabled}
          onChange={setReplyDraftSuggestionsEnabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.reportInboxSummary.label}
          badge={aiSettingsStrings.automaticBadge}
          disclosure={aiSettingsStrings.features.reportInboxSummary.disclosure}
          enabled={enabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.tabSweep.label}
          badge={aiSettingsStrings.manualBadge}
          disclosure={aiSettingsStrings.features.tabSweep.disclosure}
          enabled={enabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.ailogSession.label}
          badge={aiSettingsStrings.manualBadge}
          disclosure={aiSettingsStrings.features.ailogSession.disclosure}
          enabled={enabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.ailogBatch.label}
          badge={aiSettingsStrings.manualBadge}
          disclosure={aiSettingsStrings.features.ailogBatch.disclosure}
          enabled={enabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.tabRelayout.label}
          disclosure={aiSettingsStrings.features.tabRelayout.disclosure}
          enabled={enabled}
        />
      </div>

      <AilogFullTextMirrorSettings />
      <JevSettingsSection aiEnabled={enabled} />
      <div style={dividerStyle} />
      <ClaudeSkillsSection />
      <AgentIntegrationsSection />
      <CodexAppServerSection />
      <DshAcpSection />
    </div>
  );
}
