import {
  mockGroupingAnalysis,
  mockGroupingPlans,
  mockGroupingScan,
  mockWorkspaces,
} from "../../tests/unit/fixtures/tabGroupingMockScenario";

const MOCK_ANALYSIS_DELAY_MS = 300;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function livePtySnapshot(): Record<string, { process_status: "working"; agent_active: true }> {
  return Object.fromEntries(
    mockWorkspaces.flatMap((workspace) =>
      workspace.panes.flatMap((pane) =>
        pane.tabs.map((tab) => [
          tab.sessionId,
          { process_status: "working" as const, agent_active: true as const },
        ]),
      ),
    ),
  );
}

export async function scanGroupingContextMock() {
  return clone(mockGroupingScan);
}

export async function runGroupingAnalysisMock() {
  await sleep(MOCK_ANALYSIS_DELAY_MS);
  return clone(mockGroupingAnalysis);
}

export async function invoke<T>(command: string): Promise<T> {
  switch (command) {
    case "run_tab_sweep_judge":
      await sleep(MOCK_ANALYSIS_DELAY_MS);
      return JSON.stringify({ schemaVersion: 1, plans: mockGroupingPlans }) as T;
    case "abort_tab_sweep_judge":
      return true as T;
    case "get_pty_metadata_snapshot":
      return livePtySnapshot() as T;
    case "get_session_output_snapshot":
      return {} as T;
    case "get_session_scrollback":
      throw new Error("The live mock has no terminal scrollback.");
    default:
      return null as T;
  }
}

export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;

  toJSON(): string {
    return "__TAURI_CHANNEL_STUB__";
  }
}

export type UnlistenFn = () => void;

export async function listen<T>(
  _event: string,
  _handler: (event: { event: string; id: number; payload: T }) => void,
): Promise<UnlistenFn> {
  return () => undefined;
}

export async function emit(): Promise<void> {
  return undefined;
}

export async function homeDir(): Promise<string> {
  return "C:\\Users\\miyaz";
}

export function convertFileSrc(path: string): string {
  return path;
}

export async function getVersion(): Promise<string> {
  return "0.57.0-live-mock";
}

const inertWindow = {
  label: "grouping-live-mock",
  listen,
  emit,
  setFocus: async () => undefined,
  show: async () => undefined,
  hide: async () => undefined,
  close: async () => undefined,
};

export function getCurrentWindow() {
  return inertWindow;
}

export function getCurrentWebview() {
  return inertWindow;
}
