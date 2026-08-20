import { useEffect, useState } from "react";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { AI_PROVIDERS, aiProviderDef, classifyModelForProvider } from "../../../lib/aiModels";
import { formatSweepAiNote } from "../../layout/tabSweep";
import { aiSettingsStrings, autoPaneNamingStrings } from "../settingsStrings";
import { AutomationTab } from "./AutomationTab";
import {
  checkboxLabelStyle,
  checkboxLabelStyleFor,
  dividerStyle,
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
  const replyDraftSuggestionsEnabled = useSettingsStore((s) => s.replyDraftSuggestionsEnabled);
  const setReplyDraftSuggestionsEnabled = useSettingsStore((s) => s.setReplyDraftSuggestionsEnabled);
  const autoPaneNamingEnabled = useSettingsStore((s) => s.autoPaneNamingEnabled);
  const setAutoPaneNamingEnabled = useSettingsStore((s) => s.setAutoPaneNamingEnabled);

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

      <div style={dividerStyle} />

      <section aria-labelledby="cmux-delegation-watch-heading">
        <AutomationTab />
      </section>

      <div style={dividerStyle} />

      <section aria-labelledby="cmux-reply-draft-heading" data-ai-reply-draft-placeholder>
        <div id="cmux-reply-draft-heading" style={sectionHeadingStyle}>返信案の先回り</div>
        <div style={hintStyle}>
          選択中のチャットだけが対象です。チャットを選んだ時と、そのチャットのターンが終わった時 (完了・待機・停滞・エラー) に、AI が会話の記録を読んで具体的な次の一手を3つ用意します。会話が変わっていなければ再利用し、開いただけでは実行しません。
        </div>
        <label style={{ ...checkboxLabelStyleFor(enabled), marginTop: 8 }}>
          <input
            type="checkbox"
            checked={replyDraftSuggestionsEnabled}
            disabled={!enabled}
            onChange={(event) => setReplyDraftSuggestionsEnabled(event.target.checked)}
          />
          <span>AI に具体案を準備させる</span>
        </label>
        {!enabled ? <div style={hintStyle}>「AI機能を有効にする」をオンにすると設定できます</div> : null}
        {enabled && !replyDraftSuggestionsEnabled ? (
          <div style={{ ...hintStyle, color: "var(--cmux-usage-warn)" }}>
            オフのため、ダッシュボードの AI 案は作られません
          </div>
        ) : null}
        <div style={hintStyle}>画面を開いただけでは実行しません。設定をオフにすると、新しい AI 呼び出しは行いません。</div>
      </section>

      <div style={dividerStyle} />

      <section aria-labelledby="cmux-auto-pane-naming-heading">
        <div id="cmux-auto-pane-naming-heading" style={sectionHeadingStyle}>{autoPaneNamingStrings.title}</div>
        <div style={hintStyle}>{autoPaneNamingStrings.hint}</div>
        <label style={{ ...checkboxLabelStyleFor(enabled), marginTop: 8 }}>
          <input
            type="checkbox"
            checked={autoPaneNamingEnabled}
            disabled={!enabled}
            onChange={(event) => setAutoPaneNamingEnabled(event.target.checked)}
          />
          <span>{autoPaneNamingStrings.label}</span>
        </label>
        {!enabled ? <div style={hintStyle}>{autoPaneNamingStrings.disabledByAiHint}</div> : null}
        {/* This job runs unattended, so the "what leaves the machine" disclosure
            lives next to its switch — there is no panel the user opens first. */}
        {enabled && autoPaneNamingEnabled ? (
          <div style={hintStyle}>{formatSweepAiNote("naming", provider, model, enabled)}</div>
        ) : null}
      </section>
    </div>
  );
}
