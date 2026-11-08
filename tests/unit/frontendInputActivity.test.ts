import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionFrontendActivity, getSessionFrontendActivity } from "../../src/lib/agentDormancy";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));
import { writeToSession, writeToSessionGuarded } from "../../src/lib/ipc";
import { sendIntervention, writePaneMessage, type InterventionExpectation, type MessageSendGuard } from "../../src/lib/livebrief";

const id = "input-activity-session";
const guard: MessageSendGuard = { sessionId: id, sessionEpoch: 1, sessionRevision: 1, strictRevision: false,
  attentionId: null, inputRevision: 1, agentKind: null, agentSessionId: null, agentPid: null,
  agentStartedAt: null, agentMessage: true, source: null };
const expectation: InterventionExpectation = { interventionId: "review-reply", ptySessionId: id,
  agentSessionId: "agent", ptyInstanceId: "instance", ptyGeneration: 1, sourceRevision: 1,
  ptyInputRevision: 1, promptEventId: "prompt", promptHash: "hash" };

beforeEach(() => { clearSessionFrontendActivity(id); native.invoke.mockReset(); vi.spyOn(Date, "now").mockReturnValue(12345); });
afterEach(() => { clearSessionFrontendActivity(id); vi.restoreAllMocks(); });

describe("all frontend PTY input adapters invalidate old screen evidence", () => {
  it.each(["ordinary", "guarded", "message", "intervention"] as const)("marks activity before invoking %s input", async route => {
    let activityAtInvoke: number | undefined;
    native.invoke.mockImplementation(async () => {
      activityAtInvoke = getSessionFrontendActivity(id);
      return { sent: true, reason: null, type: "writtenAwaitingEvidence" };
    });
    if (route === "ordinary") await writeToSession(id, "reply");
    else if (route === "guarded") await writeToSessionGuarded(id, "reply", null, 1, 1, 1);
    else if (route === "message") await writePaneMessage(guard, "reply", false);
    else await sendIntervention(expectation, { type: "replyText", text: "reply" });
    expect(native.invoke).toHaveBeenCalledOnce();
    expect(activityAtInvoke).toBe(12345);
    expect(getSessionFrontendActivity(id)).toBe(12345);
  });
});
