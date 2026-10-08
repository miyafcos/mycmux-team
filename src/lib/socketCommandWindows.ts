import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { windowLabel } from "./windowContext";
import type { WebPaneCommandContext } from "../components/workspace/webPaneCommandQueue";

export type SocketArgs = Record<string, unknown> | null | undefined;
export const PEER_COMMAND_EVENTS = {
  request: "mycmux://socket-command",
  response: "mycmux://socket-command-result",
};
const PEER_COMMAND_TIMEOUT_MS = 20_000;

export interface PeerSocketCommandRequest {
  requestId: string;
  targetWindow: string;
  replyWindow: string;
  cmd: string;
  args: SocketArgs;
  expiresAt: number;
  context: WebPaneCommandContext;
  preflightOnly?: boolean;
}
interface PeerSocketCommandResponse {
  requestId: string;
  ownerWindow: string;
  result?: unknown;
  error?: string;
}
type PeerEvents = typeof PEER_COMMAND_EVENTS;

/** A reply belongs to both one request and one addressed owner. */
export async function requestPeerSocketCommand(
  targetWindow: string, cmd: string, args: SocketArgs,
  context: WebPaneCommandContext,
  options: { events?: PeerEvents; preflightOnly?: boolean } = {},
): Promise<unknown> {
  const events = options.events ?? PEER_COMMAND_EVENTS;
  const replyWindow = windowLabel(), requestId = crypto.randomUUID();
  const expiresAt = Math.min(context.deadline, Date.now() + PEER_COMMAND_TIMEOUT_MS);
  let resolve!: (result: unknown) => void, reject!: (error: unknown) => void;
  const response = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  let finished = false;
  const unlisten = await listen<PeerSocketCommandResponse>(events.response, ({ payload }) => {
    if (finished || payload.requestId !== requestId || payload.ownerWindow !== targetWindow) return;
    finished = true;
    if (Date.now() >= expiresAt) { reject(new Error(`${cmd} owner window did not respond`)); return; }
    if (payload.error !== undefined) reject(new Error(payload.error));
    else resolve(payload.result);
  }, { target: { kind: "Window", label: replyWindow } });
  const timer = setTimeout(() => reject(new Error(`${cmd} owner window did not respond`)), Math.max(0, expiresAt - Date.now()));
  try {
    if (Date.now() >= expiresAt) throw new Error(`${cmd} owner window did not respond`);
    const [, result] = await Promise.all([
      emitTo(targetWindow, events.request, {
        requestId, targetWindow, replyWindow, cmd, args, expiresAt, context,
        ...(options.preflightOnly ? { preflightOnly: true } : {}),
      } satisfies PeerSocketCommandRequest),
      response,
    ]);
    return result;
  } finally {
    finished = true;
    clearTimeout(timer);
    unlisten();
  }
}

/** Hydrate, then execute once against the owner's live state. Expired requests
 * cannot begin an operation, even if hydration or event delivery was delayed. */
export async function listenForPeerSocketCommandEvent(
  accepts: (request: PeerSocketCommandRequest) => boolean,
  execute: (request: PeerSocketCommandRequest) => Promise<unknown>,
  ready: () => Promise<void> = async () => {},
  events: PeerEvents = PEER_COMMAND_EVENTS,
): Promise<UnlistenFn> {
  const label = windowLabel(), seen = new Map<string, number>();
  let disposed = false;
  const unlisten = await listen<PeerSocketCommandRequest>(events.request, async ({ payload }) => {
    if (disposed || payload.targetWindow !== label || !payload.requestId || !payload.replyWindow
      || !Number.isFinite(payload.expiresAt) || !payload.context || !accepts(payload)) return;
    for (const [id, expiry] of seen) if (expiry <= Date.now()) seen.delete(id);
    if (seen.has(payload.requestId)) return;
    seen.set(payload.requestId, payload.expiresAt);
    let response: PeerSocketCommandResponse;
    try {
      await ready();
      if (disposed || Date.now() >= payload.expiresAt) throw new Error(`${payload.cmd} owner request expired`);
      response = { requestId: payload.requestId, ownerWindow: label, result: await execute(payload) };
    } catch (error) {
      response = { requestId: payload.requestId, ownerWindow: label, error: error instanceof Error ? error.message : String(error) };
    }
    if (!disposed) await emitTo(payload.replyWindow, events.response, response);
  }, { target: { kind: "Window", label } });
  return () => { disposed = true; seen.clear(); unlisten(); };
}
