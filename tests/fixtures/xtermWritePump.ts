import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import type { Terminal } from "@xterm/xterm";
import * as cache from "../../src/components/terminal/terminalCache";
import * as generations from "../../src/lib/ptyReadGeneration";
import * as paint from "../../src/lib/paintStats";
import * as flow from "../../src/lib/terminalFlowTrace";
import { terminalProgressDiagnostics } from "../../src/lib/terminalProgressDiagnostics";
import { TerminalStreamHealth } from "../../src/lib/terminalStreamHealth";
import { LightDarkColorAdaptController, shouldAdaptLightColorsForPane } from "../../src/lib/lightDarkColorAdapt";
import { SgrLightRewriter } from "../../src/components/terminal/sgrLightTheme";
import { ackFrontendData } from "../../src/lib/ipc";
import { stripTerminalMouseModeControlSequencesForSession } from "../../src/components/terminal/terminalMouseInputFilter";

// Execute the component's actual private pump/authority code with a real
// Terminal, without mounting canvas/WebGL in jsdom or copying its decisions.
// Only UI layout and scheduling are supplied by this driver. No predicate in
// the fixture knows whether the Terminal's text is current or parsed.
const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8");
function section(start: string, end: string): string {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  if (at < 0 || until < 0) throw new Error(`XTermWrapper pump boundary missing: ${start}`);
  return source.slice(at, until);
}
const componentFunctions = [
  section("    const canWritePendingBatches =", "    const registerReadAuthority ="),
  section("    const batchDataToBytes =", "    const ackBatch ="),
  section("    const registerReadAuthority =", "    const schedulePendingWriteDrain ="),
  section("    const writeTerminalOutput =", "    const scheduleTuiRecoveryRedraw ="),
  section("    async function pumpTerminalWrites()", "    removePtyReplayTarget ="),
].join("\n").replaceAll("import.meta.env.DEV", "false");

const compiled = transpileModule(`
function construct(bindings: any, sessionId: string, term: any) {
  const { registerCurrentOutputParser, markTerminalBufferReady, ptyReadGeneration,
    beginTerminalBufferWrite, cancelTerminalBufferWrites, recordTerminalWriteStart, recordTerminalWriteCallback,
    terminalWriteByteLength, startTerminalFlowWrite, finishTerminalFlowWrite,
    terminalProgressDiagnostics, LightDarkColorAdaptController, SgrLightRewriter,
    TerminalStreamHealth, shouldAdaptLightColorsForPane, sliceBatchAfterScrollbackOffset,
    rememberTerminalRawTail, terminalScrollbackResyncNeeded, bumpTerminalWriteCounter,
    bumpPaintStat, ackFrontendData, stripTerminalMouseModeControlSequencesForSession } = bindings;
  let disposed = false, termDisposed = false, writingBatch = false, visible = true;
  let replayActive = false, scrollbackSyncInFlight = null, currentPendingBatch = null;
  let pumpGeneration = 1, lastSynchronizedScrollbackEnd = 0;
  const pendingBatches: any[] = [], timers = new Map<number, () => void>();
  const window = { setTimeout(callback: () => void, ms: number) {
    const timer = globalThis.setTimeout(callback, ms); timers.set(Number(timer), callback); return timer;
  }, clearTimeout(timer: number) { globalThis.clearTimeout(timer); timers.delete(Number(timer)); } };
  const streamHealth = new TerminalStreamHealth();
  const colorAdapterRef = { current: new LightDarkColorAdaptController() };
  const sgrLightRewriters = new WeakMap(); sgrLightRewriters.set(term, new SgrLightRewriter());
  const launchParamsRef = { current: { command: "synthetic" } }, processTitleRef = { current: "" };
  const colorAdaptCommandsRef = { current: [] }, isLightThemeRef = { current: false };
  const diagStats = { writes: 0, bytes: 0 }, outputDecoder = new TextDecoder();
  const frontendChannelReady = true;
  const invalidateContainerVisibilityMemo = () => {};
  const isContainerWritable = () => visible;
  const isParkedByWindowOnly = () => false;
  const syncDroppedBatchScrollbackIfNeeded = async () => {};
  const scheduleScrollbackRetry = () => {}, schedulePendingWriteDrain = () => {};
  const clearPendingDrainTimer = () => {}, settleStartupSession = () => {};
  const hasTerminalLiveOutput = () => true, markTerminalHasLiveOutput = () => {};
  const ackPendingBatch = (pending: any) => {
    if (pending.acked) return;
    pending.acked = true;
    void ackFrontendData(sessionId, pending.batch.generation, pending.batch.seq, pending.batch.bytes);
  };
  ${componentFunctions}
  registerReadAuthority(term);
  return {
    submit(data: string) {
      const bytes = new TextEncoder().encode(data);
      const end = lastSynchronizedScrollbackEnd + bytes.length;
      pendingBatches.push({ acked: false, batch: { data: bytes, bytes: bytes.length, generation: 1,
        seq: 1, scrollbackStart: lastSynchronizedScrollbackEnd, scrollbackEnd: end } });
      return pumpTerminalWrites();
    },
    watchdog() {
      for (const [timer, callback] of [...timers]) {
        window.clearTimeout(timer); callback();
      }
    },
    visible(value: boolean) { visible = value; },
    attach() { registerReadAuthority(term); },
    inspect() { return { writingBatch, pending: pendingBatches.length }; },
    dispose() { disposed = true; termDisposed = true; cancelTerminalBufferWrites?.(term); for (const timer of timers.keys()) window.clearTimeout(timer); }
  };
}
return construct;`, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
const construct = new Function(compiled)() as (bindings: object, sessionId: string, term: Terminal) => {
  submit(data: string): Promise<void>;
  watchdog(): void;
  visible(value: boolean): void;
  attach(): void;
  inspect(): { writingBatch: boolean; pending: number };
  dispose(): void;
};
export function xtermWritePump(sessionId: string, term: Terminal) {
  return construct({ ...cache, ...generations, ...paint, ...flow, terminalProgressDiagnostics,
    LightDarkColorAdaptController, SgrLightRewriter, TerminalStreamHealth, shouldAdaptLightColorsForPane,
    bumpPaintStat: paint.bump, ackFrontendData, stripTerminalMouseModeControlSequencesForSession }, sessionId, term);
}

// The initial replay submits separately from the pump. Run that actual
// submission/callback block too, so its operation lifetime is audited.
const replaySubmission = section(
  "          const completeParse = beginTerminalBufferWrite(sessionId, replayTerm, replayReadGeneration);",
  '        recordPerf("xterm.replay.done", sessionId);',
);
const replayCompiled = transpileModule(`
function replay(bindings: any, sessionId: string, replayTerm: any, rewrittenOutput: string) {
  const { beginTerminalBufferWrite, markTerminalBufferReady, ptyReadGeneration,
    recordTerminalWriteStart, recordTerminalWriteCallback } = bindings;
  const replayReadGeneration = ptyReadGeneration(sessionId);
  const writeMeasurement = recordTerminalWriteStart(sessionId, rewrittenOutput.length);
  return new Promise<void>((resolve) => {
    ${replaySubmission}
}
return replay;`, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
const replay = new Function(replayCompiled)() as (bindings: object, sessionId: string, term: Terminal, data: string) => Promise<void>;
export function xtermInitialReplayWrite(sessionId: string, term: Terminal, data: string): Promise<void> {
  return replay({ ...cache, ...generations, ...paint }, sessionId, term, data);
}
