// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSkillsStatus, SkillState, ClaudeSkillsInstallResult } from "../../src/lib/claudeSkillsApi";
const api = vi.hoisted(() => ({ claudeSkillsStatus: vi.fn(), claudeSkillsInstall: vi.fn(), open: vi.fn() }));
vi.mock("../../src/lib/claudeSkillsApi", () => api);
vi.mock("@tauri-apps/plugin-shell", () => ({ open: api.open }));
import { ClaudeSkillsSection } from "../../src/components/settings/tabs/ClaudeSkillsSection";
let container: HTMLDivElement;
let root: Root;
const names = ["session-dispatch", "mycmux-bridge", "oracmux"];
function status(states: SkillState[] = ["latest", "latest", "latest"]): ClaudeSkillsStatus {
  return {
    pack_version: "1.0.0", home: "C:/Users/example",
    skills: names.map((name, index) => ({ name, state: states[index], installed_version: null })),
    cli: { state: "latest" },
    prereq: { claude: { found: true, detail: "claude.cmd" }, python: { found: true, detail: "Python 3.12.0" } },
  };
}
const emptyResult = { installed: [], skipped: [], backups: [], errors: [] };
beforeEach(() => {
  vi.resetAllMocks();
  api.claudeSkillsStatus.mockResolvedValue(status());
  api.claudeSkillsInstall.mockResolvedValue(emptyResult);
  api.open.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(value?: ClaudeSkillsStatus) {
  if (value) api.claudeSkillsStatus.mockResolvedValue(value);
  await act(async () => { root.render(<ClaudeSkillsSection />); });
}
function button(label: string) { return Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label); }
async function click(label: string) {
  expect(button(label), label).toBeDefined();
  await act(async () => { button(label)!.click(); });
}
describe("Claude Code skills settings", () => {
  it.each([
    ["not-installed", "未導入", "導入"],
    ["latest", "最新", null],
    ["outdated", "更新あり", "更新"],
    ["locally-modified", "ローカル改変", "退避して置き換える"],
  ] as const)("renders %s and only its action", async (state, label, action) => {
    await render(status([state, state, state]));
    expect(container.textContent).toContain(label);
    for (const candidate of ["導入", "更新", "退避して置き換える"]) {
      expect(Boolean(button(candidate))).toBe(candidate === action);
    }
    expect(api.claudeSkillsStatus).toHaveBeenCalledTimes(1);
    expect(api.claudeSkillsInstall).not.toHaveBeenCalled();
    expect(container.querySelector("h3")?.textContent?.includes("更新あり")).toBe(state === "outdated");
  });
  it("selects only missing or outdated skills with force=false", async () => {
    await render(status(["not-installed", "outdated", "locally-modified"]));
    await click("導入");
    expect(api.claudeSkillsInstall).toHaveBeenLastCalledWith([names[0]], false);
    await click("更新");
    expect(api.claudeSkillsInstall).toHaveBeenLastCalledWith([names[1]], false);
  });
  it("requires inline confirmation, supports cancel, and passes force=true", async () => {
    await render(status(["locally-modified", "latest", "latest"]));
    await click("退避して置き換える");
    expect(container.textContent).toContain("旧フォルダを `.bak-*` に退避して置き換えます");
    expect(api.claudeSkillsInstall).not.toHaveBeenCalled();
    await click("やめる");
    expect(button("実行")).toBeUndefined();
    await click("退避して置き換える");
    await click("実行");
    expect(api.claudeSkillsInstall).toHaveBeenCalledWith([names[0]], true);
    expect(button("実行")).toBeUndefined();
  });
  it.each(["not-installed", "outdated"] as const)("can repair just the CLI when %s", async (state) => {
    const value = status(); value.cli.state = state;
    await render(value);
    await click(state === "not-installed" ? "導入" : "更新");
    expect(api.claudeSkillsInstall).toHaveBeenCalledWith([], false);
  });
  it("shows missing prerequisites and their installation guidance", async () => {
    const value = status();
    value.prereq.claude = { found: false, detail: "missing claude" };
    value.prereq.python = { found: false, detail: "Python 3.9.0" };
    await render(value);
    expect(container.textContent).toContain("× Claude Code");
    expect(container.textContent).toContain("× Python");
    expect(container.textContent).toContain("npm install -g @anthropic-ai/claude-code");
    expect(container.textContent).toContain("python.org");
    expect(container.textContent).toContain("3.10 以上");
  });
  it("disables actions during install, then shows counts and backup names and refreshes", async () => {
    let finish!: (value: ClaudeSkillsInstallResult) => void;
    api.claudeSkillsInstall.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(status(["not-installed", "latest", "latest"]));
    await click("導入");
    expect(button("導入")?.disabled).toBe(true);
    expect(container.textContent).toContain("導入中…");
    api.claudeSkillsStatus.mockResolvedValue(status());
    await act(async () => { finish({ installed: [names[0]], skipped: ["agent CLI"], backups: ["C:\\skills\\old.bak-stamp"], errors: [] }); });
    expect(container.textContent).toContain("導入・更新 1 件 / 変更なし 1 件 / エラー 0 件");
    expect(container.textContent).toContain("退避: old.bak-stamp");
    expect(button("導入")).toBeUndefined();
    expect(api.claudeSkillsStatus).toHaveBeenCalledTimes(2);
  });
  it("renders preflight errors inside the card", async () => {
    api.claudeSkillsInstall.mockResolvedValue({ ...emptyResult, errors: ["oracmux: local changes"] });
    await render(status(["not-installed", "latest", "latest"]));
    await click("導入");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("oracmux: local changes");
  });
  it("shows a rejected status request and can retry", async () => {
    api.claudeSkillsStatus.mockRejectedValueOnce("status unavailable");
    await render();
    expect(container.textContent).toContain("status unavailable");
    await click("再確認");
    expect(container.textContent).toContain("session-dispatch");
  });
  it("opens the exact README through the existing external shell API", async () => {
    await render();
    await act(async () => { container.querySelector("a")!.click(); });
    expect(api.open).toHaveBeenCalledWith("https://github.com/miyafcos/mycmux-team/blob/master/skills/claude/README.md");
  });
});
