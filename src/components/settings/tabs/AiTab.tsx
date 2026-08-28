import { useEffect, useState } from "react";
import { AI_PROVIDERS, aiProviderDef, classifyModelForProvider } from "../../../lib/aiModels";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { aiSettingsStrings } from "../settingsStrings";
import { checkboxLabelStyle, checkboxLabelStyleFor, dividerStyle, sectionHeadingStyle } from "../tabStyles";

const CUSTOM_MODEL_VALUE = "__custom__";
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

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{aiSettingsStrings.featureTitle}</div>
      <div style={{ display: "grid", gap: 14 }}>
        <FeatureRow
          label={aiSettingsStrings.features.autoPaneNaming.label}
          badge={aiSettingsStrings.automaticBadge}
          disclosure={aiSettingsStrings.features.autoPaneNaming.disclosure}
          enabled={enabled}
          checked={autoPaneNamingEnabled}
          onChange={setAutoPaneNamingEnabled}
        />
        <FeatureRow
          label={aiSettingsStrings.features.replyDraft.label}
          badge={aiSettingsStrings.automaticBadge}
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
          unavailable
        />
      </div>

      <div style={dividerStyle} />
    </div>
  );
}
