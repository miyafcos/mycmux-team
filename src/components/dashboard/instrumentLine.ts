import type { AgentTelemetry } from "../../lib/livebrief";

export const CTX_WARN_PCT = 50;
export const CTX_ALERT_PCT = 80;
export const INSTRUMENT_SLOT_JOIN = " │ ";

export interface InstrumentLineInput {
  model?: { name: string; effort?: string | null } | null;
  context?: { pct?: number | null; tokens?: number | null } | null;
  costUsd?: number | null;
  sid?: string | null;
}

export function formatSid(sid: string | null | undefined): string | null {
  const trimmed = sid?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8);
}

export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "≈$0.00";
  const abs = Math.abs(usd);
  const body = abs > 0 && abs < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
  return `≈$${body}`;
}

export function contextBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = clamped <= 0 ? 0 : Math.min(4, Math.ceil(clamped / 25));
  return `${"▓".repeat(filled)}${"░".repeat(4 - filled)}`;
}

export function formatContextSlot(
  pct?: number | null,
  tokens?: number | null,
  options?: { bar?: boolean },
): string | null {
  if (pct == null && (tokens == null || !Number.isFinite(tokens))) return null;
  if (pct == null) return `CTX ${Math.round(tokens as number)}`;
  const rounded = Math.round(pct);
  const bangs = rounded >= CTX_ALERT_PCT ? "!!" : rounded >= CTX_WARN_PCT ? "!" : "";
  if (options?.bar === false) return `CTX ${rounded}%${bangs}`;
  return `CTX ${contextBar(rounded)} ${rounded}%${bangs}`;
}

export function formatModelSlot(model?: { name: string; effort?: string | null } | null): string | null {
  const name = model?.name?.trim();
  if (!name) return null;
  const effort = model?.effort?.trim();
  return effort ? `${name} (${effort})` : name;
}

export function formatInstrumentLine(input: InstrumentLineInput): string {
  const slots: string[] = [];
  const model = formatModelSlot(input.model);
  if (model) slots.push(model);
  const context = formatContextSlot(input.context?.pct, input.context?.tokens);
  if (context) slots.push(context);
  if (input.costUsd != null && Number.isFinite(input.costUsd)) slots.push(formatCostUsd(input.costUsd));
  const sid = formatSid(input.sid);
  if (sid) slots.push(`sid ${sid}`);
  return slots.join(INSTRUMENT_SLOT_JOIN);
}

export type InstrumentSlotKind = "model" | "context" | "cost" | "sid";

export interface InstrumentSlot {
  kind: InstrumentSlotKind;
  text: string;
}

export function instrumentSlotsFromTelemetry(
  telemetry: AgentTelemetry | null | undefined,
  sid?: string | null,
  options?: { compactContext?: boolean },
): InstrumentSlot[] {
  const slots: InstrumentSlot[] = [];
  const model = formatModelSlot(telemetry?.model);
  if (model) slots.push({ kind: "model", text: model });
  const context = formatContextSlot(
    telemetry?.context?.pct,
    telemetry?.context?.tokens,
    { bar: options?.compactContext ? false : true },
  );
  if (context) slots.push({ kind: "context", text: context });
  if (telemetry?.cost?.usd != null && Number.isFinite(telemetry.cost.usd)) {
    slots.push({ kind: "cost", text: formatCostUsd(telemetry.cost.usd) });
  }
  const sidText = formatSid(sid);
  if (sidText) slots.push({ kind: "sid", text: `sid ${sidText}` });
  return slots;
}

export function instrumentLineFromTelemetry(
  telemetry: AgentTelemetry | null | undefined,
  sid?: string | null,
): string {
  return instrumentSlotsFromTelemetry(telemetry, sid)
    .map((slot) => slot.text)
    .join(INSTRUMENT_SLOT_JOIN);
}
