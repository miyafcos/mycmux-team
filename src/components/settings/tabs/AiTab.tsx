import { useEffect, useState } from "react";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";
import { AI_PROVIDERS, aiProviderDef, classifyModelForProvider } from "../../../lib/aiModels";
import { aiSettingsStrings } from "../settingsStrings";
import {
  checkboxLabelStyle,
  checkboxLabelStyleFor,
  dialogButtonStyle,
  sectionHeadingStyle,
} from "../tabStyles";

const MODEL_LIST_ID = "cmux-ai-model-presets";

const hintStyle = { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: "var(--cmux-text-dim)" } as const;

export function AiTab() {
  const provider = useAiSettingsStore((s) => s.aiProvider);
  const model = useAiSettingsStore((s) => s.aiModel);
  const enabled = useAiSettingsStore((s) => s.aiEnabled);
  const setProvider = useAiSettingsStore((s) => s.setAiProvider);
  const setModel = useAiSettingsStore((s) => s.setAiModel);
  const setEnabled = useAiSettingsStore((s) => s.setAiEnabled);
  const reset = useAiSettingsStore((s) => s.resetAiSettings);

  // The text field is uncontrolled between commits: normalising on every
  // keystroke would snap a half-typed (or momentarily empty) model back to the
  // provider default mid-edit. Committing on blur keeps free entry usable.
  const [draft, setDraft] = useState(model);
  useEffect(() => setDraft(model), [model]);

  const def = aiProviderDef(provider);
  const classification = classifyModelForProvider(provider, model);

  return (
    <div>
      <div style={sectionHeadingStyle}>{aiSettingsStrings.title}</div>
      <div style={{ ...hintStyle, marginTop: 0, marginBottom: 12 }}>{aiSettingsStrings.description}</div>

      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>{aiSettingsStrings.enableLabel}</span>
      </label>
      <div style={hintStyle}>{aiSettingsStrings.enableHint}</div>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{aiSettingsStrings.providerTitle}</div>
      {AI_PROVIDERS.map((entry) => (
        <label key={entry.id} style={checkboxLabelStyleFor(enabled)}>
          <input
            type="radio"
            name="cmux-ai-provider"
            checked={provider === entry.id}
            disabled={!enabled}
            onChange={() => setProvider(entry.id)}
          />
          <span>{entry.label}</span>
        </label>
      ))}
      <div style={hintStyle}>{aiSettingsStrings.providerHint}</div>

      <div style={{ ...sectionHeadingStyle, marginTop: 24 }}>{aiSettingsStrings.modelTitle}</div>
      <input
        type="text"
        list={MODEL_LIST_ID}
        value={draft}
        disabled={!enabled}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setModel(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setModel(draft);
        }}
        style={{ width: 300, fontSize: 12, padding: "5px 8px" }}
      />
      {/* Native datalist: matches this dialog's "plain inputs" idiom, survives
          IME composition, and does not fight OverlayShell's focus trap. Known
          tradeoff: WebView2 renders the dropdown with system colours, so it
          ignores the app theme. Swapping in a custom popover stays local to
          this file. */}
      <datalist id={MODEL_LIST_ID}>
        {def.presets.map((preset) => (
          <option key={preset.id} value={preset.id} label={preset.note} />
        ))}
      </datalist>
      <div style={hintStyle}>{aiSettingsStrings.modelHint}</div>
      {classification === "likely-mismatch" && (
        <div style={{ ...hintStyle, color: "var(--cmux-usage-warn)" }}>
          {aiSettingsStrings.modelMismatch(def.label)}
        </div>
      )}
      {classification === "custom" && <div style={hintStyle}>{aiSettingsStrings.modelCustom}</div>}

      <div style={{ ...hintStyle, marginTop: 20 }}>{aiSettingsStrings.costNote}</div>
      <div style={hintStyle}>{aiSettingsStrings.runningNote}</div>

      <button type="button" style={{ ...dialogButtonStyle, marginTop: 16 }} onClick={reset}>
        {aiSettingsStrings.resetButton}
      </button>
    </div>
  );
}
