# Livebrief autonomy fixtures

These are small structural excerpts from the provided sanitized Claude and Codex skeletons. Text remains anonymized and model names are replaced with model-a. No actual conversation or user session is read by these tests.

- claude-monitor.jsonl: human input, Monitor call/result, end_turn, turn_duration (5 records).
- codex-open-sleep.jsonl: task_started and a still-open sleep call (2 records).
- codex-complete.jsonl: task_started and task_complete (2 records).

Additional Bash background, Agent async, ScheduleWakeup, TaskStop and notification records in autonomy_tests.rs are constructed from the supplied table using the keys and value types observed in actual records.

## FIX-4 producer / display fixtures

`autonomy-clock-cases.json` uses synthetic Claude turn records and cached-poll clocks. Rust verifies the normalized lastEventAt and turn after each step; TS consumes those same fields for the 30-minute display boundary. The rollback anchor is held only by the Rust adapter; display classification stays pure.

The three `J3` entries appended to `notification-delivery-cases.json` combine the supplied skeleton's content-free dequeue-to-user handoff and absorbed-mid-turn remove shapes. They cover overlapping identical notices in both route orders and an identified duplicate receipt that leaves the next notice pending. The identified cases finish by delivering a terminal notice and checking complete / pending=0 / done. Under ANSWER-FIX5-1, the fifth shared case keeps its historical anonymous J3 name but now retains possible B / pending=1 / running, with completion bounded by the existing 30-minute safety net. Its observed input is indistinguishable from K1; the other six pre-existing cases remain unchanged.

## FIX-5 anonymous duplicate fixtures

The four appended K1 scenes are constructed from the supplied skeleton keys and the mothership table. They cover user/remove and remove/user for A after a content-free dequeue, followed by either a user or absorbed remove for B. IDs on removes are opaque and do not invent an enqueue/dequeue/user link. Each scene retains pending=1 after A's duplicate and the completed turn, then reaches pending=0 / done on B's delivery and turn completion.

Each scene and the one authorized anonymous J3 correction export the event-clock offsets checked by the real Rust adapter/reducer. Cached polls without B preserve that clock and pending evidence. TS checks running at 1 second and 29:59, and done at 30:00 in the model, section and DOM row. If an ambiguous remove was really B's first receipt, conservative completion can be delayed by up to 30 minutes.

## FIX-6 provisional remove IDs

`notification-provisional-id-cases.json` adds exactly four synthetic scenes using the supplied skeleton keys and mothership table; the existing 11 delivery scenes and assertions are unchanged. The L1 eight-record scene with opaque R, the same scene without any R, and the review's anonymous-user control all finish at pending=0. The six-record anonymous control without B's later handoff stays pending=1. ANSWER-FIX6-1 corrects FIX-6's pending=1 claim for the anonymous eight-record scene; that expectation applies only to the six-record control.

Rust checks every produced autonomy field and event clock, cached polls, and same-conversation seeded replay through the provisional match. TS checks the same outputs in the model, section and DOM: identified/handed-off delivery is done immediately after end_turn; undelivered anonymous B is running at 1 second and 29:59 and done at 30:00. Definite IDs retain priority over all handoffs; an anonymous duplicate remove ID remains provisional until a definite dequeue revokes its old association. Other rare ambiguous orders remain subject to the existing 30-minute display safety net, as authorized in FIX-6.
