import { describe, it, expect, vi } from "vitest";
import type { SkillRow } from "../../src/lib/skillsApi";
const mocks = vi.hoisted(() => ({ add: vi.fn(), workspace: { id: "work", panes: [{ id: "first", cwd: "/first", tabs: [{ sessionId: "one", cwd: "/one" }] }, { id: "current", cwd: "/current", tabs: [{ sessionId: "two", cwd: "/two" }] }] } }));
vi.mock("../../src/stores/workspaceLayoutStore", () => ({ useWorkspaceLayoutStore: { getState: () => ({ addTabToPaneWithOptions: mocks.add }) } }));
vi.mock("../../src/stores/workspaceListStore", () => ({ useWorkspaceListStore: { getState: () => ({ getActiveWorkspace: () => mocks.workspace }) } }));
vi.mock("../../src/stores/uiStore", () => ({ useUiStore: { getState: () => ({ activePaneId: "two" }) } }));
import { startSkill } from "../../src/components/skills/skillLaunch";
import { skillsStrings as s } from "../../src/components/skills/skillsStrings";
const row = { id: "sample-review", label: "Sample review", calls: { claude: "/sample-review", codex: "$sample-review" }, docPath: "/fictional/SKILL.md" } as SkillRow;
describe("skill launches use current workspace/current tab", () => {
  it("passes the slash prompt into a fresh Claude pane", () => { startSkill(row, "claude"); expect(mocks.add).toHaveBeenLastCalledWith("work", "current", expect.objectContaining({ agentId: "claude-code", initialPrompt: "/sample-review", cwd: "/two", activate: true })); });
  it("passes the dollar prompt into a fresh Codex pane", () => { startSkill(row, "codex"); expect(mocks.add).toHaveBeenLastCalledWith("work", "current", expect.objectContaining({ agentId: "codex", initialPrompt: "$sample-review" })); });
  it("asks Claude to read the exact path before discussing a repair", () => { startSkill(row, "claude", true); expect(mocks.add).toHaveBeenLastCalledWith("work", "current", expect.objectContaining({ initialPrompt: s.repairPrompt(row.docPath!) })); });
});
