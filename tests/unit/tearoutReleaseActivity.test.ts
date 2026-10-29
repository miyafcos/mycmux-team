// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TearoutReleaseReceiver, type ReleaseFrame } from "../../src/lib/tearout/release";
import { setTearoutDisplayActivity, tearoutDisplayReasons } from "../../src/lib/tearout/operation";
const target = { kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "center" } as const;
const frame: ReleaseFrame = { id: "review-release", mode: "dock", label: "child", source: "child", receiver: "main", receiver_epoch: 1,
  region_count: 1, client_x: 50, client_y: 80, token: "review-token", point: { x: 50, y: 80, at: 10, method: "native_up" } };
let receiver: TearoutReleaseReceiver;
let paint: (() => void) | undefined;
let fault: string;
let effects: ConstructorParameters<typeof TearoutReleaseReceiver>[0];
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); fault = ""; paint = undefined;
  effects = { receiver: "main", begin: async () => fault === "identity" ? { ...frame, receiver: "other" } : frame,
    decide: async () => fault !== "decide", consume: vi.fn(async () => true), freeze() {}, target: () => target,
    revision: () => "revision", activity: setTearoutDisplayActivity, isFrameCurrent: () => true,
    frame: value => { if (value && fault === "busy" || !value && fault === "clear") throw new Error("frame_failed"); },
    afterPaint: callback => { paint = callback; return () => { paint = undefined; }; } };
  receiver = new TearoutReleaseReceiver(effects);
});
afterEach(() => { receiver.dispose(); vi.useRealTimers(); });
it.each(["identity", "timeout", "decide", "busy"])("review clears release activity on %s failure", async failing => {
  fault = failing;
  const resolved = receiver.resolve({ id: frame.id, epoch: 1 }); await flush();
  if (fault === "timeout") await vi.advanceTimersByTimeAsync(250);
  else paint?.();
  await resolved;
  expect(tearoutDisplayReasons().displayActivity).toEqual([]);
});
it("review clears release activity even when clearing the painted frame throws", async () => {
  fault = "clear";
  const resolved = receiver.resolve({ id: frame.id, epoch: 1 }); await flush(); paint?.();
  await expect(resolved).rejects.toThrow("frame_failed");
  expect(tearoutDisplayReasons().displayActivity).not.toContain(`release:${frame.id}`);
});
it("review clears the token activity after successful consumption", async () => {
  const resolved = receiver.resolve({ id: frame.id, epoch: 1 }); await flush(); paint?.(); await resolved;
  expect(tearoutDisplayReasons().displayActivity).toEqual([frame.token]);
  expect(await receiver.consume({ receiver: "main", token: frame.token, target, release_id: frame.id, layout_revision: "revision" }, "child")).toEqual({ ok: true });
  expect(tearoutDisplayReasons().displayActivity).toEqual([]);
  expect(effects.consume).toHaveBeenCalledOnce();
});
