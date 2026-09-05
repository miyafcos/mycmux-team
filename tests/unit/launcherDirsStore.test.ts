// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LauncherDirsView } from "../../src/lib/ipc";

const mocks = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  get: vi.fn(),
  update: vi.fn(),
  add: vi.fn(),
  move: vi.fn(),
  pin: vi.fn(),
  ignore: vi.fn(),
  open: vi.fn(),
  scan: vi.fn(), upsertRule: vi.fn(), deleteRule: vi.fn(), enabled: vi.fn(), mode: vi.fn(), register: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../src/lib/ipc", () => ({
  launcherDirsGet: mocks.get,
  launcherDirsUpdateEntry: mocks.update,
  launcherDirsSetSectionLabel: vi.fn(),
  launcherDirsAddEntry: mocks.add,
  launcherDirsRemoveEntry: vi.fn(),
  launcherDirsMoveEntry: mocks.move,
  launcherDirsPinEntry: mocks.pin,
  launcherDirsIgnorePath: mocks.ignore,
  launcherDirsUnignorePath: vi.fn(),
  launcherDirsExportRoots: vi.fn(),
  revealInExplorer: vi.fn(),
  launcherDirsScanNow: mocks.scan,
  launcherDirsUpsertRule: mocks.upsertRule,
  launcherDirsDeleteRule: mocks.deleteRule,
  launcherDirsSetRuleEnabled: mocks.enabled,
  launcherDirsSetRuleMode: mocks.mode,
  launcherDirsRegisterCandidate: mocks.register,
}));

import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { LauncherTab } from "../../src/components/settings/tabs/LauncherTab";
import { launcherTabStrings as T } from "../../src/components/settings/tabs/launcherTabStrings";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function view(label: string): LauncherDirsView {
  return {
    doc: {
      version: 1, sections: [{ id: "dev", label }], entries: [], ignored_paths: [], rules: [], last_scan: null,
      export: { roots_txt_mtime_ms: null, roots_txt_written_at: null, last_external_merge_at: null },
    },
    entries_exist: [], json_path: "C:/profile/launch-dirs.json", roots_txt_path: "C:/profile/launch-roots.txt", home_path: "C:/Users/test", test_profile_active: true,
  };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.update.mockReset();
  mocks.add.mockReset();
  mocks.move.mockReset();
  mocks.pin.mockReset();
  mocks.ignore.mockReset();
  mocks.open.mockReset();
  for (const mock of [mocks.scan, mocks.upsertRule, mocks.deleteRule, mocks.enabled, mocks.mode, mocks.register]) mock.mockReset();
  useLauncherDirsStore.setState({ view: null, error: null, loading: false, scanning: false });
});

describe("launcher settings interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let data: LauncherDirsView;

  beforeEach(async () => {
    data = view("Repos");
    data.doc.sections.push({ id: "anken", label: "Clients" });
    data.doc.entries = [
      { id: "one", section: "dev", label: "One", path: "C:/one", source: "manual", added_at: "2026-09-05" },
      { id: "two", section: "dev", label: "Two", path: "C:/two", source: "manual", added_at: "2026-09-05" },
      { id: "auto", section: "anken", label: "Automatic", path: "C:/automatic", source: "auto", signal: "mention", seen_at: "2026-09-05", added_at: "2026-09-05" },
    ];
    data.entries_exist = [["one", true], ["two", false], ["auto", true]];
    mocks.get.mockResolvedValue(data);
    mocks.update.mockResolvedValue(data);
    mocks.add.mockResolvedValue(data);
    mocks.move.mockResolvedValue(data);
    mocks.pin.mockResolvedValue(data);
    mocks.ignore.mockResolvedValue(data);
    useSettingsStore.setState({ launcherHiddenIds: ["anken", "codex"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(LauncherTab)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
  const byLabel = (label: string) => {
    const button = buttons().find((button) => button.textContent === label);
    expect(button, label).toBeDefined();
    return button!;
  };
  const input = () => container.querySelector<HTMLInputElement>(`input[aria-label="${T.editLabelTooltip}"]`)!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (key: string) => {
    await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })); });
  };

  it("shows saved candidates, scan results and test scheduling status, then registers the selected label", async () => {
    const path = "C:/Work Root/client/project";
    const saved = { ...data, doc: { ...data.doc, rules: [{ id: "r1", type: "session-cwd", section: "anken", enabled: true, mode: "suggest" }],
      last_scan: { at: "2026-09-05T12:00:00+09:00", duration_ms: 42, more: 4,
        results: { r1: { count: 1, truncated: true, error: null } },
        candidates: [{ path, label: "Candidate project", section: "anken", signal: "session", seen_at: "2026-09-05", rule_id: "r1", source: "rule" }] } } };
    await act(async () => { useLauncherDirsStore.setState({ view: saved }); });
    expect(container.textContent).toContain(T.scanTruncated);
    expect(container.textContent).toContain(T.scheduleOffInTest);
    expect(container.textContent).toContain(T.moreCandidates(4));
    expect(container.querySelector(`[title="${path}"]`)).not.toBeNull();
    expect(byLabel(T.registerTo("Clients")).style.borderColor).toBe("var(--cmux-accent)");
    mocks.register.mockResolvedValue(data);
    await act(async () => { byLabel(T.registerTo("Clients")).click(); });
    expect(mocks.register).toHaveBeenCalledWith("anken", path);
    expect(container.textContent).not.toContain("Candidate project");
  });

  it("creates a type-specific rule with validation and leaves an unsuccessful save open", async () => {
    await act(async () => { byLabel(T.addRule).click(); });
    expect(byLabel(T.ruleTypeGit).title).toBe(T.ruleTypeGitNote);
    await act(async () => { byLabel(T.ruleTypeGit).click(); });
    expect(container.querySelector(`[aria-label="${T.fieldParents}"]`)).not.toBeNull();
    expect(container.querySelector(`[aria-label="${T.fieldMinSessions}"]`)).toBeNull();
    await act(async () => { byLabel(T.saveRule).click(); });
    expect(container.textContent).toContain(T.validationParentsRequired);
    expect(mocks.upsertRule).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue("C:/chosen parent");
    await act(async () => { byLabel(`${T.pickFolderForRule} ${T.addFolderToList}`).click(); });
    expect((container.querySelector(`[aria-label="${T.fieldParents}"]`) as HTMLTextAreaElement).value).toBe("C:/chosen parent");
    mocks.upsertRule.mockRejectedValueOnce("not a directory: C:/chosen parent").mockResolvedValueOnce(data);
    await act(async () => { byLabel(T.saveRule).click(); });
    expect(container.textContent).toContain(T.validationNotADirectory("C:/chosen parent"));
    expect(container.querySelector("form")).not.toBeNull();
    await act(async () => { byLabel(T.saveRule).click(); });
    expect(mocks.upsertRule).toHaveBeenLastCalledWith(expect.objectContaining({ type: "git-parents", mode: "suggest", parents: ["C:/chosen parent"], max: 10, window_days: 30 }));
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("select, datalist")).toBeNull();
  });

  it("edits, toggles and deletes known rules and lets unknown rule types be deleted", async () => {
    const known = { id: "known", type: "session-cwd", section: "dev", enabled: true, mode: "suggest" };
    const saved = { ...data, doc: { ...data.doc, rules: [known, { id: "future", type: "future", custom: [1, 2] }] } };
    for (const mock of [mocks.mode, mocks.enabled, mocks.deleteRule]) mock.mockResolvedValue(saved);
    await act(async () => { useLauncherDirsStore.setState({ view: saved }); });
    const edits = buttons().filter((button) => button.textContent === T.editRule);
    expect(edits.map((button) => button.disabled)).toEqual([false, true]);
    const auto = container.querySelector<HTMLInputElement>('input[name="known"][value="auto"]')!;
    await act(async () => { auto.click(); });
    expect(mocks.mode).toHaveBeenCalledWith("known", "auto");
    const enabled = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent === T.ruleEnabled)!;
    await act(async () => { enabled.click(); });
    expect(mocks.enabled).toHaveBeenCalledWith("known", false);
    await act(async () => { byLabel(T.editRule).click(); });
    expect(container.querySelector(`[aria-label="${T.fieldRootOptional}"]`)).not.toBeNull();
    expect(container.querySelector(`[aria-label="${T.fieldMinSessions}"]`)).not.toBeNull();
    expect(container.querySelector(`[aria-label="${T.fieldDepth}"]`)).toBeNull();
    await act(async () => { byLabel(T.cancelEdit).click(); });
    const deletes = buttons().filter((button) => button.title === T.deleteRuleNote);
    await act(async () => { deletes[1].click(); });
    expect(mocks.deleteRule).toHaveBeenCalledWith("future");
  });

  it("shows hidden sections for editing and enables only valid manual moves", async () => {
    expect(container.textContent).toContain("Clients");
    expect(container.textContent).toContain(T.missing);
    expect(container.textContent).toContain("\u25cf09/05");
    const up = buttons().filter((button) => button.title === T.moveUp);
    const down = buttons().filter((button) => button.title === T.moveDown);
    expect(up.map((button) => button.disabled)).toEqual([true, false]);
    expect(down.map((button) => button.disabled)).toEqual([false, true]);
    await act(async () => { up[1].click(); });
    expect(mocks.move).toHaveBeenCalledWith("two", "up");
    await act(async () => { byLabel(T.pin).click(); });
    expect(mocks.pin).toHaveBeenCalledWith("auto");
    await act(async () => { byLabel(T.ignore).click(); });
    expect(mocks.ignore).toHaveBeenCalledWith("C:/automatic");
    expect(container.querySelector("select, datalist")).toBeNull();
  });

  it("saves labels once on Enter or blur, cancels on Escape, and rejects empty labels", async () => {
    await act(async () => { byLabel("One").click(); });
    await type(" Renamed ");
    await key("Enter");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenLastCalledWith("one", "Renamed");
    await act(async () => { byLabel("One").click(); });
    await type("Discarded");
    await key("Escape");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(input()).toBeNull();
    await act(async () => { byLabel("One").click(); });
    await type("   ");
    await key("Enter");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(T.labelEmpty);
    expect(byLabel("One")).toBeDefined();
    await act(async () => { byLabel("One").click(); });
    await type("Blurred");
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenLastCalledWith("one", "Blurred");
  });

  it("uses the folder picker and translates duplicate errors with the current section label", async () => {
    mocks.open.mockResolvedValue("C:/chosen");
    mocks.add.mockRejectedValue("already registered in anken");
    await act(async () => { byLabel(T.pickFolder).click(); });
    expect(mocks.open).toHaveBeenCalledWith({ directory: true, multiple: false, title: T.pickFolderTitle });
    expect(mocks.add).toHaveBeenCalledWith("dev", "C:/chosen", undefined);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(T.alreadyRegistered("Clients"));
    mocks.open.mockResolvedValue(null);
    await act(async () => { byLabel(T.pickFolder).click(); });
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("shares visibility ids without losing unrelated hidden rows, and routes settings requests", async () => {
    const sectionCheck = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent === T.showSection && !input.checked)!;
    expect(sectionCheck).toBeDefined();
    await act(async () => { sectionCheck.click(); });
    expect(useSettingsStore.getState().launcherHiddenIds).toEqual(["codex"]);
    useUiStore.getState().requestSettingsTab("launcher");
    expect(useUiStore.getState().requestedSettingsTab).toBe("launcher");
    useUiStore.getState().clearRequestedSettingsTab();
    expect(useUiStore.getState().requestedSettingsTab).toBeNull();
  });
});

describe("launcher directory store", () => {
  it("serializes rule changes and candidate registration through the existing queue", async () => {
    const next = view("Updated");
    for (const mock of [mocks.upsertRule, mocks.deleteRule, mocks.enabled, mocks.mode, mocks.register]) mock.mockResolvedValue(next);
    const state = useLauncherDirsStore.getState();
    const rule = { id: "r1", type: "session-cwd" };
    expect(await state.upsertRule(rule)).toBe(true);
    await state.setRuleEnabled("r1", false);
    await state.setRuleMode("r1", "auto");
    await state.registerCandidate("anken", "C:/candidate");
    await state.deleteRule("r1");
    expect(mocks.upsertRule).toHaveBeenCalledWith(rule);
    expect(mocks.enabled).toHaveBeenCalledWith("r1", false);
    expect(mocks.mode).toHaveBeenCalledWith("r1", "auto");
    expect(mocks.register).toHaveBeenCalledWith("anken", "C:/candidate");
    expect(mocks.deleteRule).toHaveBeenCalledWith("r1");
    expect(useLauncherDirsStore.getState().view).toEqual(next);
  });

  it("keeps scanning true while queued and in flight, coalesces clicks and recovers after errors", async () => {
    let finishRead!: (value: LauncherDirsView) => void;
    let finishScan!: (value: LauncherDirsView) => void;
    mocks.get.mockReturnValue(new Promise<LauncherDirsView>((resolve) => { finishRead = resolve; }));
    mocks.scan.mockReturnValueOnce(new Promise<LauncherDirsView>((resolve) => { finishScan = resolve; }));
    const state = useLauncherDirsStore.getState();
    const read = state.load();
    const scan = state.scanNow();
    expect(state.scanNow()).toBe(scan);
    expect(useLauncherDirsStore.getState().scanning).toBe(true);
    await Promise.resolve();
    expect(mocks.scan).not.toHaveBeenCalled();
    finishRead(view("Before"));
    await read;
    await vi.waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1));
    expect(useLauncherDirsStore.getState().scanning).toBe(true);
    finishScan(view("Scanned"));
    expect(await scan).toBe(true);
    expect(useLauncherDirsStore.getState().scanning).toBe(false);
    mocks.scan.mockRejectedValueOnce("scan already running");
    expect(await state.scanNow()).toBe(false);
    expect(useLauncherDirsStore.getState().error).toBe("scan already running");
    expect(useLauncherDirsStore.getState().scanning).toBe(false);
    mocks.scan.mockResolvedValueOnce(view("Recovered"));
    expect(await state.scanNow()).toBe(true);
  });

  it("subscribes once and reloads on the all-window change event", async () => {
    mocks.get.mockResolvedValue(view("Updated"));
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0][0]).toBe("launcher-dirs://changed");
    mocks.listen.mock.calls[0][1]({ payload: undefined });
    await vi.waitFor(() => expect(useLauncherDirsStore.getState().loading).toBe(false));
    expect(useLauncherDirsStore.getState().view?.doc.sections[0].label).toBe("Updated");
  });

  it("serializes a delayed read, an edit, and its event reload", async () => {
    let finishRead!: (value: LauncherDirsView) => void;
    mocks.get.mockReturnValueOnce(new Promise<LauncherDirsView>((resolve) => { finishRead = resolve; }))
      .mockResolvedValueOnce(view("New"));
    mocks.update.mockResolvedValue(view("New"));
    const read = useLauncherDirsStore.getState().load();
    const edit = useLauncherDirsStore.getState().updateEntry("id", "New");
    const reload = useLauncherDirsStore.getState().load();
    await Promise.resolve();
    expect(mocks.update).not.toHaveBeenCalled();
    finishRead(view("Old"));
    await Promise.all([read, edit, reload]);
    expect(mocks.update).toHaveBeenCalledWith("id", "New");
    expect(useLauncherDirsStore.getState().view?.doc.sections[0].label).toBe("New");
    expect(useLauncherDirsStore.getState().loading).toBe(false);
  });

  it("keeps raw failures and the last view, and the next edit still runs", async () => {
    useLauncherDirsStore.setState({ view: view("Existing") });
    mocks.update.mockRejectedValueOnce("already registered in anken").mockResolvedValueOnce(view("Saved"));
    expect(await useLauncherDirsStore.getState().updateEntry("id", "Duplicate")).toBe(false);
    expect(useLauncherDirsStore.getState().error).toBe("already registered in anken");
    expect(useLauncherDirsStore.getState().view?.doc.sections[0].label).toBe("Existing");
    mocks.get.mockResolvedValue(view("Existing"));
    await useLauncherDirsStore.getState().load();
    expect(useLauncherDirsStore.getState().error).toBe("already registered in anken");
    expect(await useLauncherDirsStore.getState().updateEntry("id", "Saved")).toBe(true);
    expect(useLauncherDirsStore.getState().error).toBeNull();
    expect(useLauncherDirsStore.getState().view?.doc.sections[0].label).toBe("Saved");
  });
});
