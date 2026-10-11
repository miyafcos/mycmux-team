import { claimResetTicketForApi, getAccountUsage, type CliProvider } from "./ipc";
import { parseAccountTarget } from "./accountSwitchApi";
import type { ResetTicketOutcomeKind } from "./resetTickets";

const COMMAND = "account.use_reset_ticket";
const OUTCOMES = new Set<ResetTicketOutcomeKind>([
  "reset", "already_used", "offer_changed", "nothing_to_reset", "no_ticket", "cooldown",
  "rate_limited", "auth_error", "token_stale", "owner_mismatch", "unconfirmed", "unavailable", "busy",
]);

export interface AccountResetTicketResponse {
  provider: CliProvider;
  profile_id: string;
  status: "used" | "unconfirmed" | "no_ticket" | "not_usable" | "rejected" | "failed";
  outcome: ResetTicketOutcomeKind | null;
  resets_left: number | null;
  expires_at: string | null;
  tickets_known: boolean;
  weekly_resets_at: string | null;
  retry_of_unconfirmed: boolean;
  error_code: string | null;
}

function alias(args: Record<string, unknown>, snake: string, camel: string): unknown {
  const left = args[snake];
  const right = args[camel];
  if (left !== undefined && right !== undefined && left !== right) {
    throw new Error(`${COMMAND}.invalid_args`);
  }
  return left !== undefined ? left : right;
}

function parseArgs(input: unknown) {
  const target = parseAccountTarget(input, COMMAND);
  const args = input as Record<string, unknown>;
  const requestId = alias(args, "request_id", "requestId");
  const expectedEmail = alias(args, "expected_email", "expectedEmail");
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId))) {
    throw new Error(`${COMMAND}.invalid_args`);
  }
  if (expectedEmail !== undefined && expectedEmail !== null && typeof expectedEmail !== "string") {
    throw new Error(`${COMMAND}.invalid_args`);
  }
  return { ...target, requestId: requestId as string | undefined, expectedEmail: (expectedEmail ?? null) as string | null };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function date(value: unknown): string | null {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

async function ticketInventory(provider: CliProvider, profileId: string, expectedEmail: string | null, deadline: number) {
  // The current wire data has no verified owner ID for mutable live:* rows.
  // Preserve the claim's known result/count without mixing another login in.
  if (profileId.startsWith("live:") || Date.now() >= deadline) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const report = await Promise.race([
      getAccountUsage(false, "account.use_reset_ticket"),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadline - Date.now()); }),
    ]);
    const row = report?.accounts.find((row) => row.provider === provider && row.profile_id === profileId);
    // Saved row IDs are stable per registered identity. An explicit expected
    // email must also agree (including an unknown email being unproven).
    const asciiFold = (email: string) => email.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (!row?.registered || (expectedEmail !== null
      && (row.email === null || asciiFold(row.email) !== asciiFold(expectedEmail)))) return null;
    const tickets = row.state === "ok" && !row.needs_relogin ? row.reset_tickets : null;
    return tickets && count(tickets.available) !== null ? tickets : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function status(kind: ResetTicketOutcomeKind): AccountResetTicketResponse["status"] {
  if (kind === "reset" || kind === "already_used") return "used";
  if (kind === "unconfirmed") return "unconfirmed";
  if (kind === "no_ticket") return "no_ticket";
  if (kind === "busy") return "rejected";
  return "not_usable";
}

export async function useResetTicketForApi(input: unknown, deadline: number): Promise<AccountResetTicketResponse> {
  const { provider, profileId, requestId, expectedEmail } = parseArgs(input);
  const reply: AccountResetTicketResponse = {
    provider, profile_id: profileId, status: "failed", outcome: null,
    resets_left: null, expires_at: null, tickets_known: false, weekly_resets_at: null,
    retry_of_unconfirmed: false, error_code: null,
  };
  if (Date.now() >= deadline) return { ...reply, status: "rejected", error_code: "reset_ticket.error.request_expired" };
  try {
    const outcome = await claimResetTicketForApi(provider, profileId, requestId ?? crypto.randomUUID(), expectedEmail);
    if (!OUTCOMES.has(outcome.kind)) return { ...reply, error_code: "reset_ticket.error.use_failed" };
    reply.status = status(outcome.kind);
    reply.outcome = outcome.kind;
    reply.resets_left = count(outcome.resets_left) ?? (outcome.kind === "no_ticket" ? 0 : null);
    reply.weekly_resets_at = date(outcome.weekly_resets_at);
    reply.retry_of_unconfirmed = outcome.retry_of_unconfirmed === true;
    // The same backend rejects overlap with PC or API, without spending again.
    if (outcome.kind === "busy") return { ...reply, error_code: "reset_ticket.error.busy" };
    const tickets = await ticketInventory(provider, profileId, expectedEmail, deadline);
    if (tickets) {
      reply.resets_left ??= count(tickets.available);
      reply.expires_at = date(tickets.expires_at);
      reply.tickets_known = true;
    }
    return reply;
  } catch (error) {
    const code = error instanceof Error ? error.message : error;
    if (code === "reset_ticket.error.profile_not_found") return { ...reply, status: "rejected", error_code: code };
    if (code === "Reset tickets are not supported for Grok") {
      return { ...reply, status: "not_usable", error_code: "reset_ticket.error.unsupported_provider" };
    }
    if (code === "Invalid request id") return { ...reply, status: "rejected", error_code: "reset_ticket.error.invalid_request_id" };
    return { ...reply, error_code: "reset_ticket.error.use_failed" };
  }
}
