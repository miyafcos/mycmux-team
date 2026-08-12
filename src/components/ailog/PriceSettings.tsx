import { useMemo, useState } from "react";

import type { PriceEntry } from "../../lib/ailog";
import { noteStyle, ScrollBox, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

const fields: (keyof Pick<PriceEntry, "inputPerMtok" | "outputPerMtok" | "cacheReadPerMtok" | "cacheWrite5mPerMtok" | "cacheWrite1hPerMtok">)[] = ["inputPerMtok", "outputPerMtok", "cacheReadPerMtok", "cacheWrite5mPerMtok", "cacheWrite1hPerMtok"];

export function isValidNonNegativeDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function PriceSettings({ prices, unpricedModels, loading, error, repricedSessions, onSave }: { prices: PriceEntry[] | null; unpricedModels: string[]; loading: boolean; error: string | null; repricedSessions: number | null; onSave: (entry: PriceEntry) => void }) {
  const entries = useMemo(() => {
    const known = new Map((prices ?? []).map((entry) => [entry.model, entry]));
    const missing = unpricedModels.filter((model) => !known.has(model)).map((model) => ({ model, inputPerMtok: 0, outputPerMtok: 0, cacheReadPerMtok: 0, cacheWrite5mPerMtok: 0, cacheWrite1hPerMtok: 0, source: "unpriced", updatedAt: 0 }));
    return [...missing, ...(prices ?? [])];
  }, [prices, unpricedModels]);
  const [editing, setEditing] = useState<PriceEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {repricedSessions !== null ? <div role="status" style={noteStyle}>{`${repricedSessions} セッションを再計算しました`}</div> : null}
    {error ? <div role="alert" style={noteStyle}>{error}</div> : null}
    {loading ? <div style={noteStyle}>—</div> : <ScrollBox><table style={tableStyle}><thead><tr><th style={thLeftStyle}>model</th>{fields.map((field) => <th key={field} style={thStyle}>{field}</th>)}<th style={thStyle}>—</th></tr></thead><tbody>{entries.map((entry) => {
      const active = editing?.model === entry.model;
      const valid = active && fields.every((field) => isValidNonNegativeDecimal(values[field] ?? ""));
      return <tr key={entry.model} style={{ background: entry.source === "unpriced" ? "var(--cmux-hover)" : undefined }}><td style={tdLeftStyle}>{entry.model}{entry.source === "unpriced" ? <div style={{ ...noteStyle, color: "var(--cmux-usage-warn)" }}>単価未設定</div> : null}</td>{fields.map((field) => <td key={field} style={tdStyle}>{active ? <input aria-label={`${entry.model}-${field}`} value={values[field] ?? ""} onChange={(event) => setValues({ ...values, [field]: event.target.value })} style={{ width: 76 }} /> : entry[field]}</td>)}<td style={tdStyle}>{active ? <button type="button" disabled={!valid} onClick={() => { if (valid) onSave({ ...editing, inputPerMtok: Number(values.inputPerMtok), outputPerMtok: Number(values.outputPerMtok), cacheReadPerMtok: Number(values.cacheReadPerMtok), cacheWrite5mPerMtok: Number(values.cacheWrite5mPerMtok), cacheWrite1hPerMtok: Number(values.cacheWrite1hPerMtok) }); }} style={{ ...subtleButtonStyle, opacity: valid ? 1 : 0.5 }}>保存</button> : <button type="button" onClick={() => { setEditing(entry); setValues(Object.fromEntries(fields.map((field) => [field, String(entry[field])]))); }} style={subtleButtonStyle}>保存</button>}</td></tr>;
    })}</tbody></table></ScrollBox>}
  </div>;
}
