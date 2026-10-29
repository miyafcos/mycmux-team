// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TearoutReleaseReceiver, type ReleaseApproval, type ReleaseFrame } from "../../src/lib/tearout/release";
import type { DockTarget } from "../../src/stores/detachedDockStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it.each(["expired", "receiver_changed", "release_id_changed", "target_changed", "layout_changed", "sender_changed",
  "not_approved", "already_consumed", "disposed", "backend_rejected"] as const)("review2 consume returns the exact rejection code: %s", async reason => {
  const target: DockTarget = { kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "right" };
  const frame: ReleaseFrame = { id: "release", mode: "dock", label: "child", source: "source", receiver: "main", receiver_epoch: 1,
    region_count: 1, client_x: 10, client_y: 20, token: "token", point: { x: 10, y: 20, at: Date.now(), method: "native_up" } };
  let revision = "layout";
  const consume = vi.fn(async () => reason !== "backend_rejected");
  const activity = vi.fn();
  const receiver = new TearoutReleaseReceiver({ receiver: "main", begin: async () => frame, decide: async () => true,
    consume, freeze() {}, target: () => target, revision: () => revision, activity, frame() {}, isFrameCurrent: () => true,
    afterPaint: callback => { callback(); return () => {}; } });
  const approval: ReleaseApproval = { receiver: "main", token: frame.token, target, release_id: frame.id, layout_revision: revision };
  await receiver.resolve({ id: frame.id, epoch: 1 });
  if (reason === "expired") await vi.advanceTimersByTimeAsync(6000);
  if (reason === "receiver_changed") approval.receiver = "other";
  if (reason === "release_id_changed") approval.release_id = "other-release";
  if (reason === "target_changed") approval.target = { kind: "workspace" };
  if (reason === "layout_changed") revision = "resized";
  if (reason === "not_approved") approval.token = "unknown";
  if (reason === "already_consumed") expect(await receiver.consume(approval, "child")).toEqual({ ok: true });
  if (reason === "disposed") receiver.dispose();
  expect(await receiver.consume(approval, reason === "sender_changed" ? "stranger" : "child")).toEqual({ ok: false, reason });
  expect(consume).toHaveBeenCalledTimes(reason === "backend_rejected" || reason === "already_consumed" ? 1 : 0);
  receiver.dispose();
  expect(activity).toHaveBeenCalledWith(frame.token, false);
});
