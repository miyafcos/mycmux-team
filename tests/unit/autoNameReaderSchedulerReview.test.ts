// @vitest-environment jsdom
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutoPaneNamingScheduler } from "../../src/lib/autoPaneNaming";
import { getTabDisplayLabel, getTabDisplayFullLabel } from "../../src/lib/tabDisplayLabel";
import { namePrefix } from "../../src/lib/autoNamePolicy";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useAutoNameRuntimeStore, clearNamingHolds } from "../../src/stores/autoNameRuntimeStore";
import type { Workspace } from "../../src/types";
import type { NamingMaterial } from "../../src/lib/autoNameMaterial";
import { fixtureMaterial } from "./helpers/autoNamingInvariants";
import { dirname } from "node:path";
interface Fixture {
  registrations?: Array<{ section: string; label: string; path: string }>;
  id: string; reason: string; distinct?: boolean; projects?: string[]; workspaceMust?: string[]; workspaceForbidden?: string[];
  jobs: Array<{ id: string; project?: string; must: string[]; forbidden?: string[];
    frames: Array<{ at: number; events: NamingMaterial["events"]; task_title: string | null }> }>;
}
const fixtures = JSON.parse(readFileSync("tests/fixtures/auto_naming_review_native.json", "utf8")).cases as Fixture[];
const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fake.invoke }));
const results: Array<{ id: string; names: Array<{ id: string; full: string; short: string }>; workspace: string }> = [];
afterAll(() => {
  if (process.env.AUTO_NAMING_QUALITY_REPORT !== "1") return;
  const path = process.env.AUTO_NAMING_NATIVE_REPORT_PATH ?? ".dispatch/b7-native-after.json";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mode: "real-reader-scheduler", modelCalls: 0, cases: results }, null, 2) + "\n");
});
let scheduler: ReturnType<typeof createAutoPaneNamingScheduler> | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(2_000_000);
  useSettingsStore.setState({ autoPaneNamingEnabled: true, autoWorkspaceNamingEnabled: true });
  useAiSettingsStore.setState({ aiEnabled: false });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useLiveBriefStore.getState().reset();
  useAutoNameRuntimeStore.setState({ recovery: null, revision: 0, meanings: new Map(), descriptions: new Map(), invalidatedTabs: new Map(), invalidatedWorkspaces: new Map() });
  fake.invoke.mockReset();
});
afterEach(() => {
  scheduler?.stop(); scheduler = undefined;
  const ws = useWorkspaceListStore.getState().workspaces;
  clearNamingHolds(ws.map(w => w.id), ws.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => t.id))));
  useLauncherDirsStore.setState({ view: null }); vi.clearAllTimers(); vi.useRealTimers();
});
for (const fixture of fixtures) it("reader/scheduler: " + fixture.id + " — " + fixture.reason, async () => {
  const ws: Workspace = { id: fixture.id, name: "前のワークスペース名", nameSource: "auto", status: "running", createdAt: 2_000_000, gridTemplateId: "1x1",
    splitColumns: [["p"]], panes: [{ id: "p", sessionId: "unused", activeTabId: "", agentId: "shell-starter",
      tabs: fixture.jobs.map(job => ({ id: fixture.id + "-" + job.id, sessionId: "pty-" + fixture.id + "-" + job.id,
        agentId: "shell-starter", agentKind: "claude", agentSessionId: "agent-" + job.id, cwd: "/fixture/" + (job.project ?? fixture.id),
        // Unlabeled: a launch label would replace the unknown name under test (2026-10-14).
        initialPrompt: "original", commandArgv: ["claude", "--resume", job.id], launchEnv: { ORIGINAL: job.id } })) }] };
  const before = structuredClone(ws.panes[0].tabs);
  useWorkspaceListStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  useLauncherDirsStore.setState({ view: { doc: { entries: fixture.registrations ?? (fixture.projects ?? []).map(label => ({ section: "subjects", label, path: "/fixture/" + label })) } } as NonNullable<ReturnType<typeof useLauncherDirsStore.getState>["view"]> });
  let elapsed = 0;
  fake.invoke.mockImplementation(async (command, args) => {
    if (command === "get_pty_metadata_snapshot") return Object.fromEntries(ws.panes[0].tabs.map(tab => [tab.sessionId, { process_status: "working" }]));
    if (command === "get_session_output_snapshot") return {};
    if (command === "auto_name_materials") return args.requests.map((request: { tab_id: string }) => {
      const job = fixture.jobs.find(job => request.tab_id === fixture.id + "-" + job.id)!;
      const frame = [...job.frames].reverse().find(frame => frame.at <= elapsed)!;
      return fixtureMaterial({ ...request, events: frame.events, task_title: frame.task_title } as NamingMaterial);
    });
    throw new Error("Unexpected naming IPC: " + command);
  });
  scheduler = createAutoPaneNamingScheduler();
  for (const at of [0, 60_000, 70_000, 120_000, 180_000, 300_000, 360_000]) {
    elapsed = at; vi.setSystemTime(2_000_000 + at); await scheduler.runNow();
  }
  const after = useWorkspaceListStore.getState().workspaces[0];
  results.push({ id: fixture.id, names: after.panes[0].tabs.map(tab => ({ id: tab.id, full: getTabDisplayFullLabel(tab), short: getTabDisplayLabel(tab) })), workspace: after.name });
  for (const [index, job] of fixture.jobs.entries()) {
    const tab = after.panes[0].tabs[index], short = getTabDisplayLabel(tab);
    for (const word of job.must) { expect(tab.displayName, job.id + " full").toContain(word); expect(short, job.id + " short").toContain(word); }
    for (const word of job.forbidden ?? []) { expect(tab.displayName).not.toContain(word); expect(short).not.toContain(word); }
    const { displayName: _name, displayNameSource: _source, ...immutable } = tab;
    expect(immutable).toEqual(before[index]);
  }
  if (fixture.distinct) {
    const short = after.panes[0].tabs.map(tab => getTabDisplayLabel(tab));
    expect(new Set(short.map(namePrefix)).size).toBe(short.length);
    expect(short.every(name => !/・\d+$/.test(name))).toBe(true);
  }
  for (const word of fixture.workspaceMust ?? []) expect(after.name).toContain(word);
  for (const word of fixture.workspaceForbidden ?? []) expect(after.name).not.toContain(word);
  expect(fake.invoke.mock.calls.every(([command]) => ["get_pty_metadata_snapshot", "get_session_output_snapshot", "auto_name_materials", "agent_session_titles"].includes(command))).toBe(true);
  expect(useAiSettingsStore.getState().aiEnabled).toBe(false);
});
