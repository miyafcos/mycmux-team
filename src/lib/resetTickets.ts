import type { CliProvider, ProfileUsage } from "./ipc";
import { formatPct } from "./accountRows";
import { PROVIDER_SHORT } from "./cliAccounts";

// Usage-limit reset tickets ("リセット券") and the copy that goes with them.
//
// Claude Code calls them grants (the `cedar_ember` block of /api/oauth/usage)
// and Codex calls them rate-limit reset credits (/wham/rate-limit-reset-credits).
// The two differ in one way the user has to know before spending one: a Claude
// reset keeps the weekly reset day, a Codex reset restarts the weekly window
// from the next request (OpenAI Help Center, "How banked Codex resets work").
// The Rust side reports both in the one shape below; this module only formats.

/** Reset tickets on one account, as the usage poll reports them. */
export interface ResetTickets {
  /** Tickets left right now (Claude: sum of grants' resets_left; Codex: available_count). */
  available: number;
  /** Soonest expiry among the remaining tickets (RFC 3339), when known. */
  expires_at: string | null;
  /** Whether the server would take a ticket right now. */
  usable_now: boolean;
  /** Why not, when `usable_now` is false and `available` > 0. */
  blocked_reason: ResetTicketBlockedReason | null;
  /** Windows a ticket refills, in the API's names ("five_hour", "seven_day", ...). */
  clears: string[];
  /** True when using one restarts the weekly window (Codex); false when the day stays (Claude). */
  moves_weekly_reset: boolean;
  /** Claude only: true when the ticket can be used only at a usage limit. */
  requires_limit: boolean;
  /** The server's name for the ticket, when it gave one. */
  title: string | null;
}

export type ResetTicketBlockedReason =
  | "requires_limit"
  | "paused"
  | "cooldown"
  | "blocked_by_other_limit"
  | "not_offered";

export type ResetTicketOutcomeKind =
  | "reset"
  | "already_used"
  | "nothing_to_reset"
  | "no_ticket"
  | "cooldown"
  | "rate_limited"
  | "auth_error"
  | "token_stale"
  | "owner_mismatch"
  | "unconfirmed"
  | "unavailable"
  | "offer_changed"
  | "busy";

/** What `use_reset_ticket` answers. Only `unconfirmed` may have spent a ticket without saying so. */
export interface ResetTicketOutcome {
  kind: ResetTicketOutcomeKind;
  /** Tickets left after the call, when the server said. */
  resets_left: number | null;
  /** Claude: the weekly reset time the server reported after the call. */
  weekly_resets_at: string | null;
  /**
   * True when this press followed an earlier press whose result was never
   * confirmed. The backend then re-sends that request instead of a new one,
   * and "nothing was used" is only true of this press, not of the earlier one.
   */
  retry_of_unconfirmed?: boolean;
}

export type ResetTicketTone = "ok" | "warn" | "error";

export interface ResetTicketMessage {
  tone: ResetTicketTone;
  text: string;
}

export interface ResetTicketConfirm {
  title: string;
  message: string;
  okLabel: string;
  cancelLabel: string;
}

type Row = Pick<ProfileUsage, "provider" | "email" | "label" | "is_active" | "five_hour" | "seven_day">;

type FormatOptions = { timeZone?: string };

/** The tickets worth showing on a row: none when there are zero or the poll did not say. */
export function visibleResetTickets(row: { reset_tickets?: ResetTickets | null }): ResetTickets | null {
  const tickets = row.reset_tickets ?? null;
  return tickets && tickets.available > 0 ? tickets : null;
}

/** Tickets per provider across the rows, for the panel header. */
export function resetTicketTotals(
  rows: readonly { provider: CliProvider; reset_tickets?: ResetTickets | null }[],
): Record<CliProvider, number> {
  const totals: Record<CliProvider, number> = { claude: 0, codex: 0, grok: 0 };
  for (const row of rows) {
    const tickets = visibleResetTickets(row);
    if (tickets) totals[row.provider] += tickets.available;
  }
  return totals;
}

export const RESET_TICKET_HEADER_TITLE = "使えるリセット券の合計 (この欄に出ているアカウントの分)";

/** "券 CC 6 · CX 5"; null when no row has a ticket. */
export function resetTicketHeaderLabel(totals: Record<CliProvider, number>): string | null {
  const parts = (["claude", "codex", "grok"] as const)
    .filter((provider) => totals[provider] > 0)
    .map((provider) => `${PROVIDER_SHORT[provider]} ${totals[provider]}`);
  return parts.length > 0 ? `券 ${parts.join(" · ")}` : null;
}

export const RESET_TICKET_BUSY_LABEL = "処理中…";

/** "券1 10/23" (count and the soonest expiry's date). */
export function resetTicketChipLabel(tickets: ResetTickets, options: FormatOptions = {}): string {
  const day = formatExpiryDay(tickets.expires_at, options);
  return day ? `券${tickets.available} ${day}` : `券${tickets.available}`;
}

export function resetTicketChipTitle(tickets: ResetTickets, options: FormatOptions = {}): string {
  const head = [`リセット券 ${tickets.available} 枚`];
  const until = formatExpiryTime(tickets.expires_at, options);
  if (until) head.push(`${until} まで`);
  head.push(
    tickets.usable_now
      ? "押すと、使う前に確認します"
      : `いまは使えません (${BLOCKED_SHORT[tickets.blocked_reason ?? "not_offered"]})`,
  );
  return head.join(" · ");
}

const BLOCKED_SHORT: Record<ResetTicketBlockedReason, string> = {
  requires_limit: "上限に達したときだけ使える券",
  paused: "一時停止中",
  cooldown: "直前のリセットを処理中",
  blocked_by_other_limit: "ほかの枠が戻るまで使えない券",
  not_offered: "サーバーが受け付けない状態",
};

const BLOCKED_TEXT: Record<ResetTicketBlockedReason, string> = {
  requires_limit: "上限に達したときだけ使える券です。",
  paused: "券が一時停止されています。",
  cooldown: "直前のリセットを処理中です。少し待ってから使えます。",
  blocked_by_other_limit: "ほかの枠が戻るまで使えない券です。",
  not_offered: "サーバーがいまは受け付けない状態です。少し待ってからもう一度押してください。",
};

/** Shown in place of the confirm dialog when the chip is pressed while the ticket cannot be used. */
export function resetTicketBlockedMessage(row: Row, tickets: ResetTickets): ResetTicketMessage {
  return {
    tone: "warn",
    text: `${who(row)} のリセット券は、いまは使えません。${BLOCKED_TEXT[tickets.blocked_reason ?? "not_offered"]}`,
  };
}

export const RESET_TICKET_CONFIRM_TITLE = "リセット券を使う";
export const RESET_TICKET_CONFIRM_OK = "使う";
export const RESET_TICKET_CONFIRM_CANCEL = "やめる";

export function resetTicketConfirm(
  row: Row,
  tickets: ResetTickets,
  options: FormatOptions = {},
): ResetTicketConfirm {
  const lines: string[] = [who(row), ""];
  lines.push(`${clearsText(tickets.clears)}の使用率を 0% に戻します。`);
  const current = [
    row.five_hour ? `5h ${formatPct(row.five_hour.pct)}` : null,
    row.seven_day ? `7d ${formatPct(row.seven_day.pct)}` : null,
  ].filter((part): part is string => part !== null);
  if (current.length > 0) lines.push(`いまの使用率: ${current.join(" · ")}`);
  const weekly = formatExpiryTime(row.seven_day?.resets_at ?? null, options);
  if (tickets.moves_weekly_reset) {
    lines.push(
      `週のリセット日時が変わります。次の週リセットは、このあと最初に Codex を使った時点から 7 日後になり、${
        weekly ? `元の ${weekly} の` : "元の日時の"
      }リセットは来ません。`,
    );
  } else {
    lines.push(weekly ? `週のリセット日時 (${weekly}) は変わりません。` : "週のリセット日時は変わりません。");
  }
  const atLimit = Math.max(row.five_hour?.pct ?? 0, row.seven_day?.pct ?? 0) >= 100;
  if (!atLimit) lines.push("まだ上限に達していません。いま使うと、枠に残っている分は無駄になります。");
  if (tickets.moves_weekly_reset) lines.push("戻す使用量がないときは、券は使われずに残ります。");
  lines.push("");
  const after = Math.max(0, tickets.available - 1);
  const until = formatExpiryTime(tickets.expires_at, options);
  lines.push(`残り ${tickets.available} 枚 → ${after} 枚${until ? ` (${until} まで)` : ""}`);
  return {
    title: RESET_TICKET_CONFIRM_TITLE,
    message: lines.join("\n"),
    okLabel: RESET_TICKET_CONFIRM_OK,
    cancelLabel: RESET_TICKET_CONFIRM_CANCEL,
  };
}

/** The line the panel shows after `use_reset_ticket` answers. */
export function resetTicketOutcomeMessage(
  row: Row,
  tickets: Pick<ResetTickets, "moves_weekly_reset">,
  outcome: ResetTicketOutcome,
): ResetTicketMessage {
  if (outcome.retry_of_unconfirmed) {
    const retry = retryOutcomeMessage(row, outcome);
    if (retry) return retry;
  }
  const name = who(row);
  switch (outcome.kind) {
    case "reset": {
      const left = outcome.resets_left === null ? "" : `残り ${outcome.resets_left} 枚。`;
      const weekly = tickets.moves_weekly_reset
        ? "週のリセット日時は、次に Codex を使った時点から 7 日後になります。"
        : "";
      return { tone: "ok", text: `${name} のリセット券を使いました。${left}${weekly}使用量を取り直しています。` };
    }
    case "already_used":
      return { tone: "warn", text: `${name} の券はすでに使われていました。使用量を取り直しています。` };
    case "nothing_to_reset":
      return { tone: "warn", text: `${name} はいま戻す使用量がないため、券は使われませんでした。` };
    case "no_ticket":
      return {
        tone: "warn",
        text: `${name} には使える券がありませんでした (期限切れか使用済み)。何も使われていません。`,
      };
    case "cooldown":
      return {
        tone: "warn",
        text: `${name} は直前のリセットを処理中です。何も使われていません。1 分ほど待ってからもう一度押してください。`,
      };
    case "rate_limited":
      return {
        tone: "warn",
        text: `サーバーの回数制限で受け付けられませんでした。何も使われていません。少し待ってからもう一度押してください。${
          row.provider === "claude" ? "急ぐときは、同じアカウントで開いた claude.ai (ブラウザ) からも使える場合があります。" : ""
        }`,
      };
    case "auth_error":
      return {
        tone: "error",
        text: `${name} のトークンが受け付けられませんでした。何も使われていません。使用量の更新 (数分) を待ってからもう一度押してください。`,
      };
    case "token_stale":
      return {
        tone: "warn",
        text: `${name} のトークンが期限切れです。何も使われていません。${
          row.is_active ? "使用中の CLI がトークンを更新してから" : "使用量の更新でトークンが新しくなってから"
        }もう一度押してください。`,
      };
    case "owner_mismatch":
      return {
        tone: "error",
        text: `${name} の行に保存されたトークンが別のアカウントのものだったため、使いませんでした。このアカウントに再ログインしてください。`,
      };
    case "unconfirmed":
      return {
        tone: "warn",
        text: `${name} のリセット券が使われたか確認できませんでした。使用量を取り直しています。戻っていなければ、10 分以内にもう一度押してください (同じ要求として送り直します)。`,
      };
    case "offer_changed":
      return {
        tone: "warn",
        text: `${name} で使える券が入れ替わっていたため、今回は何も使っていません。使用量を取り直しています。`,
      };
    case "unavailable":
      return {
        tone: "warn",
        text: "いまはリセットを受け付けていません。何も使われていません。少し待ってからもう一度押してください。",
      };
    case "busy":
      return { tone: "warn", text: `${name} のリセットを処理中です。` };
  }
}

const EARLIER_UNKNOWN = "前回の操作が通ったかは、まだ分かりません。";

// After an unconfirmed press the backend re-sends that same request, so what
// this press found also says something about the earlier one, and "nothing was
// used" would be true of this press only. Kinds whose wording does not change
// fall back to the ordinary lines.
function retryOutcomeMessage(row: Row, outcome: ResetTicketOutcome): ResetTicketMessage | null {
  const name = who(row);
  switch (outcome.kind) {
    case "already_used":
      return { tone: "ok", text: `${name} の前回の操作は通っていたようです。使用量を取り直しています。` };
    case "nothing_to_reset":
      return {
        tone: "ok",
        text: `${name} の枠はすでに戻っていました (前回の操作が通っていた可能性があります)。使用量を取り直しています。`,
      };
    case "no_ticket":
      return {
        tone: "warn",
        text: `${name} の券はもう残っていません。前回の操作で使われた可能性があります。使用量を取り直しています。`,
      };
    case "cooldown":
      return {
        tone: "warn",
        text: `${name} の前回の操作がまだ処理中かもしれません。使用量を取り直しています。1 分ほどたっても戻っていなければ、もう一度押してください。`,
      };
    // No pointer to claude.ai here: the earlier request may still go through,
    // and a second use from the browser would spend a second ticket.
    case "rate_limited":
      return {
        tone: "warn",
        text: `サーバーの回数制限で受け付けられませんでした。${EARLIER_UNKNOWN}少し待ってからもう一度押してください (前回と同じ要求として送ります)。`,
      };
    case "auth_error":
      return {
        tone: "error",
        text: `${name} のトークンが受け付けられませんでした。${EARLIER_UNKNOWN}使用量の更新 (数分) を待ってからもう一度押してください。`,
      };
    case "token_stale":
      return {
        tone: "warn",
        text: `${name} のトークンが期限切れです。${EARLIER_UNKNOWN}${
          row.is_active ? "使用中の CLI がトークンを更新してから" : "使用量の更新でトークンが新しくなってから"
        }もう一度押してください。`,
      };
    case "unavailable":
      return {
        tone: "warn",
        text: `いまはリセットを受け付けていません。${EARLIER_UNKNOWN}少し待ってからもう一度押してください。`,
      };
    case "offer_changed":
      return {
        tone: "warn",
        text: `${name} で使える券が前回の操作のあとで入れ替わっていたため、今回は何も使っていません。前回の操作が通ったかは、取り直した使用量で確かめてください。`,
      };
    default:
      return null;
  }
}

/** When the command itself rejected (it does so only before sending anything). */
export function resetTicketInvokeErrorMessage(row: Row, error: unknown): ResetTicketMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return { tone: "error", text: `${who(row)} のリセット券を使えませんでした (${detail})。` };
}

function who(row: Pick<Row, "provider" | "email" | "label">): string {
  return `${PROVIDER_SHORT[row.provider]} ${row.email ?? row.label}`;
}

function clearsText(clears: readonly string[]): string {
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  for (const key of clears) {
    if (key === "five_hour") add("5 時間枠");
    else if (key === "seven_day" || key === "seven_day_overage_included") add("週の枠");
    else if (key === "seven_day_opus") add("Opus の週の枠");
    else if (key === "seven_day_sonnet") add("Sonnet の週の枠");
  }
  if (names.length === 0) return "使用枠";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join("、")}と${names[names.length - 1]}`;
}

function dateParts(iso: string | null, options: FormatOptions) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: options.timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}

/** "10/23" */
function formatExpiryDay(iso: string | null, options: FormatOptions): string {
  const parts = dateParts(iso, options);
  return parts ? `${parts.month}/${parts.day}` : "";
}

/** "10/23 01:00" */
function formatExpiryTime(iso: string | null, options: FormatOptions): string {
  const parts = dateParts(iso, options);
  return parts ? `${parts.month}/${parts.day} ${parts.hour.padStart(2, "0")}:${parts.minute.padStart(2, "0")}` : "";
}
