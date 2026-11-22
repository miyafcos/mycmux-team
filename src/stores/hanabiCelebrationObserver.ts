import { advanceMergeCelebration, DONE_CELEBRATION_COOLDOWN_MS, isHanabiDoneTransition, type MergeCelebrationState } from "../lib/hanabiEvents";
import type { CelebrationKind } from "../lib/hanabiScene";
import { acquireLiveTailConsumer, subscribeLiveTailObservations } from "./liveTailStore";
import { useSessionAttentionStore } from "./sessionAttentionStore";
import { useWorkspaceListStore } from "./workspaceListStore";
import { subscribeTerminalOutputObservations } from "./terminalObservationStore";

interface CelebrationMemory {
  epoch?: number;
  end?: number;
  baselineEnd?: number;
  merge?: MergeCelebrationState;
  lastDone?: number;
}
// Only success evidence, byte positions and cooldowns outlive a scene subscription.
// Decoders and screen fragments stay connection-local and are never retained here.
const memories = new Map<string, CelebrationMemory>();

function memoryFor(id: string, epoch?: number | null): CelebrationMemory {
  let memory = memories.get(id);
  if (!memory || (epoch != null && memory.epoch !== undefined && memory.epoch !== epoch)) {
    memory = {};
    memories.set(id, memory);
  }
  if (epoch != null) memory.epoch = epoch;
  return memory;
}

/** Test isolation only; production never resets a live terminal's history. */
export function __resetHanabiCelebrationsForTests(): void { memories.clear(); }

/** Mounted only by a visible, animated winter scene. No PTY transport hooks. */
export function connectHanabiCelebrations(onCelebrate: (kind: CelebrationKind) => void, now = Date.now): () => void {
  const streams = new Map<string, { epoch: number; end: number; decoder: TextDecoder; tail: string; baselineEnd?: number }>();
  const owns = (sessionId: string) => useWorkspaceListStore.getState().workspaces.some(workspace =>
    workspace.panes.some(pane => pane.tabs.some(tab => tab.type !== "web" && tab.sessionId === sessionId)));
  const prune = () => {
    for (const id of memories.keys()) if (!owns(id)) memories.delete(id);
    for (const id of streams.keys()) if (!owns(id)) streams.delete(id);
  };
  // No listeners remain while the scene is inactive. Sweep closures on reattach.
  prune();
  const releaseOwners = useWorkspaceListStore.subscribe((state, previous) => {
    if (state.workspaces !== previous.workspaces) prune();
  });
  const releaseOutput = subscribeTerminalOutputObservations((output) => {
    if (!owns(output.sessionId)) return;
    const id = output.sessionId;
    let stream = streams.get(id);
    const memory = memoryFor(id, output.epoch);
    const end = stream?.epoch === output.epoch ? stream.end : memory.end;
    const initialSnapshot = end === undefined && output.source === "snapshot";
    if (end !== undefined && output.endOffset <= end) return;
    if (!stream || stream.epoch !== output.epoch || output.baseline || output.startOffset > stream.end) {
      stream = { epoch: output.epoch, end: Math.max(output.startOffset, end ?? output.startOffset),
        decoder: new TextDecoder(), tail: "",
        baselineEnd: initialSnapshot ? output.frameEndOffset : memory.baselineEnd };
      streams.set(id, stream);
    }
    // A resync notice has no body. Body-bearing initial snapshots are instead
    // consumed chunk by chunk, with a stable baseline boundary for the frame.
    if (output.baseline) {
      stream.end = output.frameEndOffset; memory.end = stream.end;
      stream.baselineEnd = undefined; memory.baselineEnd = undefined;
      return;
    }
    const overlap = Math.max(0, stream.end - output.startOffset);
    const data = output.data.subarray(overlap);
    const boundary = stream.baselineEnd;
    const baselineBytes = boundary === undefined ? 0
      : Math.min(data.length, Math.max(0, boundary - output.startOffset - overlap));
    const at = now(), active = stream;
    const consume = (bytes: Uint8Array, baseline: boolean, baselineComplete = false) => {
      const text = active.tail + active.decoder.decode(bytes, { stream: true });
      const previous = memory.merge ?? advanceMergeCelebration(undefined, { text: "", outputAt: at - 1 }, at).state;
      const completeEnd = baselineComplete ? text.length : Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
      const result = advanceMergeCelebration(previous, { text: text.slice(0, completeEnd),
        outputAt: baseline ? previous.outputAt : Math.max(at, (previous.outputAt ?? 0) + 1) }, at);
      memory.merge = result.state;
      active.tail = text.slice(-8192);
      if (result.fire) onCelebrate("merge");
    };
    if (boundary !== undefined) {
      const complete = output.endOffset >= boundary;
      consume(data.subarray(0, baselineBytes), true, complete);
      if (complete) stream.baselineEnd = undefined;
    }
    if (boundary === undefined || baselineBytes < data.length) consume(data.subarray(baselineBytes), false);
    stream.end = output.endOffset;
    memory.end = stream.end;
    memory.baselineEnd = stream.baselineEnd;
  });
  const releaseAttention = useSessionAttentionStore.subscribe((state, previous) => {
    if (state.attentionBySession === previous.attentionBySession) return;
    for (const [id, next] of Object.entries(state.attentionBySession)) {
      if (!owns(id)) continue;
      const memory = memoryFor(id, next.sessionEpoch);
      if (next.sessionEpoch != null && streams.get(id)?.epoch !== next.sessionEpoch) streams.delete(id);
      if (!isHanabiDoneTransition(previous.attentionBySession[id], next)) continue;
      const at = now(), last = memory.lastDone;
      if (last !== undefined && at - last < DONE_CELEBRATION_COOLDOWN_MS) continue;
      memory.lastDone = at;
      onCelebrate("done");
    }
    prune();
  });
  const releaseObservations = subscribeLiveTailObservations((state, previous) => {
    const live = new Set(state.targets.map(target => target.sessionId));
    prune();
    for (const [id, entry] of Object.entries(state.entries)) {
      const observation = entry.evidence.observation;
      if (!owns(id) || !live.has(id) || entry.retained || entry.readPending || !observation.crop.readable
        || observation === previous.entries[id]?.evidence.observation) continue;
      if (streams.has(id)) continue;
      // A screen from before attachment is a baseline. No old success is replayed.
      const before = previous.entries[id]?.evidence.observation;
      const memory = memoryFor(id, useSessionAttentionStore.getState().attentionBySession[id]?.sessionEpoch);
      let baseline = memory.merge;
      if (!baseline && before?.crop.readable) {
        baseline = advanceMergeCelebration(undefined, { text: before.rawRows.join("\n"), outputAt: before.lastOutputAt }, now()).state;
      }
      const result = advanceMergeCelebration(baseline, {
        text: observation.rawRows.join("\n").slice(-32_000), outputAt: observation.lastOutputAt,
      }, now());
      memory.merge = result.state;
      if (result.fire) onCelebrate("merge");
    }
  });
  const releaseDemand = acquireLiveTailConsumer("hanabi-background");
  return () => { releaseOutput(); releaseDemand(); releaseObservations(); releaseAttention(); releaseOwners(); };
}
