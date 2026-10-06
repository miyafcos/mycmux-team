import { emitTo, listen } from "@tauri-apps/api/event";
import { getAllWindows } from "@tauri-apps/api/window";
import { windowLabel } from "../windowContext";
import type { PaneHandoffEndpoint } from "../paneHandoff";
import { commitPaneHandoffContext, resolvePaneHandoffContext } from "../paneHandoffRuntime";
import type { DockTarget } from "../../stores/detachedDockStore";

const CONTEXT = "mycmux://tearout-handoff-context";
const REQUEST = "mycmux://tearout-handoff-request";
const RESULT = "mycmux://tearout-handoff-result";
const CANCEL = "mycmux://tearout-handoff-cancel";
type HandoffTarget = Extract<DockTarget, { kind: "handoff" }>;
interface HandoffApproval { receiver: string; token: string; target: HandoffTarget }
export interface TearoutHandoffDrag {
  id: string;
  label: string;
  sourceWindow: string;
  endpoint: PaneHandoffEndpoint | null;
}
interface Request { id: string; token: string; requester: string; approval: HandoffApproval }
const sources = new Map<string, TearoutHandoffDrag>();
const results = new Map<string, (ok: boolean) => void>();

export function tearoutHandoffSource(id: string, label: string, sourceWindow?: string): PaneHandoffEndpoint | null {
  const drag = sources.get(id);
  return drag?.label === label && drag.sourceWindow === sourceWindow ? drag.endpoint : null;
}

/** Complete fan-out before native movement can send its first sample. */
export async function publishTearoutHandoffDrag(drag: TearoutHandoffDrag): Promise<() => Promise<void>> {
  const labels = (await getAllWindows()).map(window => window.label);
  sources.set(drag.id, drag);
  const send = async (payload: TearoutHandoffDrag) => {
    const sent = await Promise.allSettled(labels.map(label => emitTo(label, CONTEXT, payload)));
    for (const result of sent) if (result.status === "rejected") console.warn("[tearout] handoff context failed", result.reason);
  };
  await send(drag);
  return async () => {
    sources.delete(drag.id);
    await send({ ...drag, endpoint: null });
  };
}

/** Handoff is a receiver operation, not a transfer of the source's workspace. */
export async function requestTearoutHandoff(id: string, approval: HandoffApproval): Promise<boolean> {
  const token = crypto.randomUUID();
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  const receipt = new Promise<boolean>((resolve, reject) => {
    results.set(token, resolve);
    timer = window.setTimeout(() => reject(new Error("tearout_handoff_timeout")), 120000);
  });
  // An emit failure can occur before awaiting receipt; retain its rejection handler.
  void receipt.catch(() => {});
  try {
    await emitTo(approval.receiver, REQUEST, { id, token, requester: windowLabel(), approval } satisfies Request);
    return await receipt;
  } catch (error) {
    await emitTo(approval.receiver, CANCEL, { token }).catch(() => {});
    throw error;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    results.delete(token);
  }
}

export function installTearoutHandoff(consumeApproval: (token: string, target: HandoffTarget) => boolean) {
  const receiver = windowLabel();
  const ownWindow = { target: { kind: "Window" as const, label: receiver } };
  const seen = new Map<string, Set<string>>();
  const cancelled = new Set<string>();
  let live = true;
  const receive = async (request: Request) => {
    const drag = sources.get(request.id);
    const tokens = seen.get(request.id) ?? new Set<string>();
    if (tokens.has(request.token)) return;
    tokens.add(request.token); seen.set(request.id, tokens);
    const isCurrent = () => live && !cancelled.has(request.token) && sources.get(request.id) === drag;
    let ok = false;
    try {
      const target = request.approval.target;
      if (drag?.endpoint && drag.sourceWindow === request.requester && request.approval.receiver === receiver
        && target.kind === "handoff" && consumeApproval(request.approval.token, target)) {
        const context = resolvePaneHandoffContext(drag.endpoint, target.workspaceId, target.paneId, target);
        ok = await commitPaneHandoffContext(context, isCurrent);
      } else {
        await commitPaneHandoffContext(null, isCurrent);
      }
    } finally {
      cancelled.delete(request.token);
      if (live) await emitTo(drag?.sourceWindow ?? request.requester, RESULT, { token: request.token, ok });
    }
  };
  const registered = [
    listen<TearoutHandoffDrag>(CONTEXT, ({ payload }) => {
      if (payload.endpoint) sources.set(payload.id, payload);
      else { sources.delete(payload.id); seen.delete(payload.id); }
    }, ownWindow),
    listen<Request>(REQUEST, ({ payload }) => { void receive(payload).catch(error => console.warn("[tearout] handoff failed", error)); }, ownWindow),
    listen<{ token: string; ok: boolean }>(RESULT, ({ payload }) => results.get(payload.token)?.(payload.ok), ownWindow),
    listen<{ token: string }>(CANCEL, ({ payload }) => cancelled.add(payload.token), ownWindow),
  ];
  return { ready: Promise.all(registered).then(() => {}), dispose: () => {
    live = false; sources.clear(); seen.clear(); cancelled.clear();
    for (const result of registered) void result.then(unlisten => unlisten()).catch(() => {});
  } };
}
