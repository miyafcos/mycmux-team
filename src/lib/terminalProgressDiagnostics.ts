import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";

export const TERMINAL_PROGRESS_INTERVAL_MS = 1_000;
export const TERMINAL_PROGRESS_SESSION_CAP = 64;

export interface TerminalProgressViewport {
  viewportY: number;
  baseY: number;
  alternate: boolean;
  cols: number;
  rows: number;
  overlayOwners: number;
}

export interface TerminalProgressSample extends TerminalProgressViewport {
  token: string;
  receivedGeneration: number | null;
  parsedGeneration: number | null;
  receivedEnd: number | null;
  parsedEnd: number | null;
  renderTick: number;
}

export interface TerminalProgressRequest {
  /** Routing only; the backend must never serialize this field to the log. */
  sessionId: string;
  sample: TerminalProgressSample;
}

interface ProgressState {
  sample: Omit<TerminalProgressSample, keyof TerminalProgressViewport>;
  readViewport: () => TerminalProgressViewport | null;
}

interface ProgressWriteToken {
  state: ProgressState;
  generation: number | null;
  end: number;
}

const validNumber = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Only primitives cross this boundary. No output, input, path, env, or DOM is accepted. */
export function createTerminalProgressDiagnostics(options: {
  enabled: () => boolean;
  write: (records: TerminalProgressRequest[]) => Promise<unknown>;
  token?: () => string;
}) {
  const sessions = new Map<string, ProgressState>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const flush = (): void => {
    if (!options.enabled() || inFlight) return;
    const records: TerminalProgressRequest[] = [];
    for (const [sessionId, state] of sessions) {
      let view: TerminalProgressViewport | null;
      try { view = state.readViewport(); } catch { continue; }
      if (!view || typeof view.alternate !== "boolean"
        || ![view.viewportY, view.baseY, view.cols, view.rows, view.overlayOwners].every(validNumber)
        || view.cols < 1 || view.rows < 1 || view.cols > 65_535 || view.rows > 65_535
        || view.overlayOwners > TERMINAL_PROGRESS_SESSION_CAP) continue;
      // Explicit projection is also a privacy boundary if a caller adds fields.
      records.push({ sessionId, sample: {
        token: state.sample.token,
        receivedGeneration: state.sample.receivedGeneration,
        parsedGeneration: state.sample.parsedGeneration,
        receivedEnd: state.sample.receivedEnd,
        parsedEnd: state.sample.parsedEnd,
        renderTick: state.sample.renderTick,
        viewportY: view.viewportY, baseY: view.baseY, alternate: view.alternate,
        cols: view.cols, rows: view.rows, overlayOwners: view.overlayOwners,
      } });
    }
    if (!records.length || !options.enabled()) return;
    inFlight = true;
    // Diagnostics must never throw into the transport or create an IPC backlog.
    void Promise.resolve().then(() => options.enabled() ? options.write(records) : undefined)
      .catch(() => {}).finally(() => { inFlight = false; });
  };

  return {
    watch(sessionId: string, readViewport: ProgressState["readViewport"]): () => void {
      if (!options.enabled() || (!sessions.has(sessionId) && sessions.size >= TERMINAL_PROGRESS_SESSION_CAP)) return () => {};
      const state: ProgressState = { readViewport, sample: {
        token: options.token?.() ?? crypto.randomUUID(),
        receivedGeneration: null, parsedGeneration: null, receivedEnd: null, parsedEnd: null, renderTick: 0,
      } };
      sessions.set(sessionId, state);
      timer ??= setInterval(flush, TERMINAL_PROGRESS_INTERVAL_MS);
      return () => {
        // A late cleanup from an old mount cannot discard its successor.
        if (sessions.get(sessionId) === state) sessions.delete(sessionId);
        if (!sessions.size) { clearInterval(timer); timer = undefined; }
      };
    },
    receive(sessionId: string, generation: number, end: number): void {
      if (!options.enabled() || !validNumber(generation) || !validNumber(end)) return;
      const state = sessions.get(sessionId);
      if (!state) return;
      const sample = state.sample;
      if (sample.receivedGeneration !== generation) {
        if (sample.receivedGeneration !== null && generation < sample.receivedGeneration) return;
        sample.receivedGeneration = generation;
        sample.receivedEnd = end;
        sample.parsedGeneration = null;
        sample.parsedEnd = null;
      } else sample.receivedEnd = Math.max(sample.receivedEnd ?? 0, end);
    },
    startWrite(sessionId: string, end?: number, generation?: number): ProgressWriteToken | null {
      if (!options.enabled() || end === undefined || !validNumber(end)
        || (generation !== undefined && !validNumber(generation))) return null;
      const state = sessions.get(sessionId);
      if (!state) return null;
      return { state, end, generation: generation ?? state.sample.receivedGeneration };
    },
    finishWrite(sessionId: string, token: ProgressWriteToken | null): void {
      if (!options.enabled() || !token || sessions.get(sessionId) !== token.state) return;
      const sample = token.state.sample;
      if (token.generation !== sample.receivedGeneration) return;
      sample.parsedGeneration = token.generation;
      sample.parsedEnd = Math.max(sample.parsedEnd ?? 0, token.end);
    },
    render(sessionId: string): void {
      if (!options.enabled()) return;
      const state = sessions.get(sessionId);
      if (state) state.sample.renderTick = Math.min(Number.MAX_SAFE_INTEGER, state.sample.renderTick + 1);
    },
  };
}

export const terminalProgressDiagnostics = createTerminalProgressDiagnostics({
  enabled: () => useSettingsStore.getState().terminalProgressDiagnosticsEnabled === true,
  write: (records) => invoke("record_terminal_progress", { enabled: true, records }),
});
