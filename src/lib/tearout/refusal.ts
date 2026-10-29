import { LocalTearoutRefusal } from "./operation";
import { TearoutRecord } from "./record";
import { recoveryBusy, transferReservationBusy } from "./recoveryNotice";

export async function recordTearoutRefusal(record: TearoutRecord, refusal: LocalTearoutRefusal): Promise<void> {
  record.error("move_busy"); record.failure("tearout_move_busy", refusal.phase);
  record.refusal(refusal.source, refusal.blockerId, refusal.phase);
  if (refusal.phase === "restoring") recoveryBusy();
  else if (refusal.reason === "reservation") transferReservationBusy();
  try { await record.finish("rejected_busy", null, null); }
  catch (error) { console.warn("[tearout] rejection log failed", error); }
}
export async function rejectTearoutStart(record: TearoutRecord, refusal: LocalTearoutRefusal): Promise<never> {
  await recordTearoutRefusal(record, refusal);
  throw refusal;
}
