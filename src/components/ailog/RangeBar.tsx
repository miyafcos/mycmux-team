/**
 * Header row: range picker, filters, and index freshness.
 * Job controls live in the panel menu / auto-index hook.
 */

import { useEffect, useState } from "react";

import {
  RANGE_PRESETS,
  formatAgo,
  formatCount,
  formatMoney,
  type Overview,
  type RangePreset,
  type UsageRhythmReport,
} from "../../lib/ailog";
import { ButtonGroup, Chip, subtleButtonStyle } from "./ui";

export function RangeBar({
  preset,
  customFrom,
  customTo,
  onPreset,
  onCustomRange,
  overview,
  usageRhythm,
  onRefresh,
  loading,
  excludeSynthetic,
  onExcludeSynthetic,
  includeSidechain,
  onIncludeSidechain,
  usdJpyRate,
  onUsdJpyRate,
}: {
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  onPreset: (preset: RangePreset) => void;
  onCustomRange: (from: string, to: string) => void;
  overview: Overview | null;
  usageRhythm: UsageRhythmReport | null;
  onRefresh: () => void;
  loading: boolean;
  excludeSynthetic: boolean;
  onExcludeSynthetic: (value: boolean) => void;
  includeSidechain: boolean;
  onIncludeSidechain: (value: boolean) => void;
  usdJpyRate: number;
  onUsdJpyRate: (rate: number) => void;
}) {
  const freshness = overview?.indexFreshness ?? usageRhythm?.indexFreshness;
  const customIncomplete = preset === "custom" && (!customFrom || !customTo);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ButtonGroup
          ariaLabel="期間"
          value={preset}
          onChange={onPreset}
          options={RANGE_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))}
        />

        {preset === "custom" ? (
          <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0 }}>
            <input
              type="date"
              aria-label="開始日"
              value={customFrom}
              onChange={(event) => onCustomRange(event.target.value, customTo)}
              style={dateInputStyle}
            />
            <span style={{ color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>〜</span>
            <input
              type="date"
              aria-label="終了日"
              value={customTo}
              onChange={(event) => onCustomRange(customFrom, event.target.value)}
              style={dateInputStyle}
            />
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="再読込"
          title="再読込"
          style={{ ...subtleButtonStyle, opacity: loading ? 0.5 : 1 }}
        >
          ⟳
        </button>
      </div>

      {customIncomplete ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-usage-warn)" }}>
          日付を 2 つ選ぶと反映されます（それまでは直前の期間のままです）
        </div>
      ) : null}

      {overview && overview.excludedInternal.sessions > 0 ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
          {`内部処理 ${formatCount(overview.excludedInternal.sessions)} 件 (${formatMoney(overview.excludedInternal.costUsd)}) を除外`}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={excludeSynthetic}
            onChange={(event) => onExcludeSynthetic(event.target.checked)}
          />
          {"<synthetic> をシリーズ別の表から除外"}
        </label>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={includeSidechain}
            onChange={(event) => onIncludeSidechain(event.target.checked)}
          />
          サブエージェントのターンも含める
        </label>
        <UsdJpyRateField value={usdJpyRate} onChange={onUsdJpyRate} />
        {freshness ? (
          <Chip title="最後にインデックスが完了した時刻">
            {`記録は ${formatAgo(freshness.lastIndexedAt)}まで`}
          </Chip>
        ) : null}
        {freshness && freshness.staleFiles > 0 ? (
          <Chip tone="warn" title="前回のインデックス以降に更新されたファイル数">
            {`未取り込み ${formatCount(freshness.staleFiles)} ファイル`}
          </Chip>
        ) : null}
      </div>

      {overview ? (
        <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)", lineHeight: 1.5 }}>
          {overview.costNote}
          {overview.priceSource ? `（単価: ${{ default: "既定", user: "手入力", mixed: "既定+手入力" }[overview.priceSource] ?? overview.priceSource}）` : ""}
        </div>
      ) : null}
    </div>
  );
}

const dateInputStyle = {
  background: "var(--cmux-hover)",
  border: "1px solid var(--cmux-border)",
  borderRadius: 5,
  color: "var(--cmux-text)",
  fontSize: "var(--cmux-font-size-xs)",
  padding: "3px 6px",
  colorScheme: "light dark" as const,
};

const checkboxLabelStyle = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
};

function UsdJpyRateField({
  value,
  onChange,
}: {
  value: number;
  onChange: (rate: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <label style={checkboxLabelStyle}>
      <span>為替レート</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label="為替レート (1ドルあたりの円)"
        value={draft}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (Number.isFinite(next) && next > 0) onChange(next);
        }}
        onBlur={() => setDraft(String(value))}
        style={{ ...dateInputStyle, width: 72 }}
      />
      <span>円/ドル</span>
    </label>
  );
}
