import { invoke } from "@tauri-apps/api/core";
import type { AutoNameMeaning } from "./autoNamePolicy";
import type { AutoNameReason } from "./autoNameStatus";
import type { AutoNameEvidence } from "./autoNameMaterial";

const pending = new Map<string, { reason: AutoNameReason; retained: boolean; at: number; count: number; readFailures: number }>();
const seenReads = new Map<string, { binding: string; count: number }>();
/** Flush transitions and count observations separately from actual failed native reads. No text or paths. */
export async function reportAutoNameFailures(meanings: ReadonlyMap<string, AutoNameMeaning>, now = Date.now(),
  reads: ReadonlyMap<string, Pick<AutoNameEvidence, "binding" | "readFailureCount">> = new Map()): Promise<void> {
  const requests: Array<{ tab_id: string; reason: AutoNameReason; retained: boolean; observations: number; read_failures: number }> = [];
  const flush = (id: string) => {
    const prior = pending.get(id);
    if (prior?.count) requests.push({tab_id:id, reason:prior.reason, retained:prior.retained,
      observations:prior.count, read_failures:prior.readFailures});
    pending.delete(id);
  };
  for (const id of pending.keys()) if (!meanings.has(id)) flush(id);
  for (const id of seenReads.keys()) if (!meanings.has(id) && !reads.has(id)) seenReads.delete(id);
  for (const [id, meaning] of meanings) {
    const read = reads.get(id), seen = seenReads.get(id);
    const count = read?.readFailureCount ?? 0;
    const valid = read?.binding === meaning.binding && Number.isSafeInteger(count) && count >= 0;
    const readFailures = valid ? Math.max(0, count - (seen?.binding === read.binding && count >= seen.count ? seen.count : 0)) : 0;
    if (valid) seenReads.set(id, {binding:read.binding, count});
    const reason = meaning.unknownReason ?? (readFailures ? "read-failed" : undefined);
    if (!reason) { flush(id); continue; }
    const retained = meaning.staleSince !== undefined, prior = pending.get(id);
    const same = prior?.reason === reason && prior.retained === retained;
    if (!same) flush(id);
    const observations = same ? prior.count + 1 : 1;
    const failures = (same ? prior.readFailures : 0) + readFailures;
    if (same && now - prior.at < 300_000) { prior.count = observations; prior.readFailures = failures; continue; }
    requests.push({tab_id:id, reason, retained, observations, read_failures:failures});
    pending.set(id, {reason, retained, at:now, count:0, readFailures:0});
  }
  try {
    for (let at = 0; at < requests.length; at += 64)
      await invoke("auto_name_diagnostics", {requests:requests.slice(at, at + 64)});
  } catch { /* Diagnostics cannot interrupt naming or a store change. */ }
}
