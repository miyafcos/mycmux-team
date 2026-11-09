import { describe, expect, it } from "vitest";
import { isAgentTabSlashCommand } from "../../src/components/terminal/agentTabSlashCommand";

describe("in-tab slash command detection", () => {
  it.each([
    "/effort", "/cost", "/model sonnet", "/compact \u8981\u70b9\u3060\u3051", "/plugin:skill",
    "  /cost  ", "\t/model sonnet\t", "\u3000/effort\u3000", "/Model SONNET",
  ])("recognizes the single-line command %j", text => {
    expect(isAgentTabSlashCommand(text)).toBe(true);
  });

  it.each([
    "", "   ", "/", "/ ", "/  cost", "//", "//cost", "/123", "/_cost", "/\u30e2\u30c7\u30eb",
    "hello /cost", "\u3053\u3093\u306b\u3061\u306f", "/cost\nmore", "/cost\rmore", "/cost\r\nmore",
    "/cost\n", "\n/cost", "/cost\u2028more", "/cost\u2029more",
  ])("keeps ordinary or multiline text %j on the conversation route", text => {
    expect(isAgentTabSlashCommand(text)).toBe(false);
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SkillCatalog, SkillRow } from "../../src/lib/skillsApi";
import { claudeSlashCommands } from "../../src/components/terminal/claudeSlashCommands";
import { agentTabSlashCommandOpensTerminal } from "../../src/components/terminal/agentTabSlashCommand";
import {
  AGENT_TAB_SLASH_RECENT_KEY, agentTabSlashEnterAction, agentTabSlashQuery,
  buildAgentTabSlashCandidates, completeAgentTabSlashCommand, filterAgentTabSlashCandidates,
  loadAgentTabSlashSkills, resetAgentTabSlashSkillsForTest,
  readAgentTabSlashRecent, rememberAgentTabSlashCommand, type AgentTabSlashSuggestion,
} from "../../src/components/terminal/agentTabSlashSuggest";

const skillsMocks = vi.hoisted(() => ({ peek: vi.fn(), cached: vi.fn(), refresh: vi.fn() }));
vi.mock("../../src/lib/skillsApi", () => ({ skillsApi: skillsMocks }));
beforeEach(() => resetAgentTabSlashSkillsForTest());

const candidate = (name: string, patch: Partial<AgentTabSlashSuggestion> = {}): AgentTabSlashSuggestion =>
  ({ name, kind: "skill", aliases: [], argumentHint: "", description: "test", ...patch });
const skill = (name: string, patch: Partial<SkillRow> = {}): SkillRow =>
  ({ id: name, calls: { claude: "/" + name }, line: "\u4ed5\u4e8b\u3092\u9032\u3081\u308b", lastUsedAt: null, ...patch } as SkillRow);
const catalog = (skills: SkillRow[]): SkillCatalog =>
  ({ generatedAt: "", categories: [], skills, hiddenCount: 0, newCount: 0 });
afterEach(() => vi.unstubAllGlobals());

describe("Claude Code 2.1.319 command catalog", () => {
  it("contains every non-hidden definition including the eight getter definitions", () => {
    const expected = "add-dir advisor artifacts auto-mode-setup autocompact autofix-pr background branch brief btw bug cd chrome clear cloud-plugins color compact config context copy daemon design-login desktop diff doctor effort exit export fast feedback focus fork goal help hooks ide import init insights install install-github-app install-slack-app keybindings list-agents login logout loops mcp memory mobile model output-style permissions plan plugin powerup privacy-settings project radio rate-limit-options recap release-notes reload-plugins reload-skills remote-env rename resume rewind scroll-speed session setup-bedrock setup-vertex skill-doctor skills status statusline stickers stop subtask tasks team-onboarding teleport terminal-setup theme tui upgrade usage usage-credits use-case version voice web-setup wellbeing workflows".split(" ").sort();
    expect(claudeSlashCommands.map(command => command.name).sort()).toEqual(expected);
    expect(claudeSlashCommands).toHaveLength(94);
    expect(claudeSlashCommands.filter(command => command.kind === "prompt").map(command => command.name).sort())
      .toEqual(["init", "insights", "statusline", "team-onboarding"]);
  });
  it("keeps names and aliases unique and excludes the seven hidden commands", () => {
    const names = claudeSlashCommands.flatMap(command => [command.name, ...command.aliases]);
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    for (const hidden of ["agents", "design-consent", "design-revoke", "extra-usage", "heapdump", "pro-trial-expired", "workflow-launch-exec"]) {
      expect(names).not.toContain(hidden);
    }
    expect(claudeSlashCommands.find(command => command.name === "usage")?.aliases).toEqual(["cost", "stats"]);
    expect(claudeSlashCommands.find(command => command.name === "clear")?.aliases).toEqual(["reset", "new"]);
  });
  it("records provenance, concise Japanese descriptions and resolved or empty dynamic hints", () => {
    const source = readFileSync(new URL("../../src/components/terminal/claudeSlashCommands.ts", import.meta.url), "utf8");
    expect(source.split("\n").slice(0, 4).join("\n")).toContain("Claude Code 2.1.319");
    expect(source.split("\n")[1]).toContain("claude-builtin-commands-2.1.319.tsv");
    expect(source.split("\n")[2]).toContain("claude-builtin-commands-2.1.319-getters.tsv");
    for (const command of claudeSlashCommands) {
      expect(command.description).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(command.description.length).toBeLessThanOrEqual(30);
      expect(command.description).not.toMatch(/[\r\n]/);
      expect(command.argumentHint).not.toContain("<getter>");
      expect(command.argumentHint).not.toContain(String.fromCharCode(36) + "{");
    }
    expect(claudeSlashCommands.find(command => command.name === "effort")?.argumentHint).toBe("[low|medium|high|xhigh|max|auto]");
    expect(claudeSlashCommands.find(command => command.name === "advisor")?.argumentHint).toBe("");
    expect(claudeSlashCommands.find(command => command.name === "color")?.argumentHint).toBe("");
  });
});

describe("slash candidates and matching", () => {
  it("adds only listed Claude calls, retaining plugin call names, Japanese lines and usage times", () => {
    const commands = buildAgentTabSlashCandidates(catalog([
      skill("a", { calls: { claude: "/plugin:my-command" }, lastUsedAt: 123 }),
      skill("hidden", { listedIn: { claude: false, codex: true } }),
      skill("codex", { calls: { codex: "$codex" } }),
      skill("collision", { calls: { claude: "/cost" } }),
      skill("duplicate", { calls: { claude: "/plugin:my-command" } }),
      skill("invalid", { calls: { claude: "/bad argument" } }),
    ]));
    expect(commands).toHaveLength(95);
    expect(commands.at(-1)).toMatchObject({ name: "plugin:my-command", kind: "skill", description: "\u4ed5\u4e8b\u3092\u9032\u3081\u308b", lastUsedAt: 123 });
    expect(buildAgentTabSlashCandidates(null)).toHaveLength(94);
  });
  it.each([
    ["/", 1, ""], ["/he", 3, "he"], ["/He", 2, "He"], ["/help argument", 3, "help"],
    ["/help argument", 6, null], ["/help ", 6, null], ["/help", 0, null], [" /help", 4, null],
    ["/help\n", 5, null], ["/help\r", 5, null], ["/help\u2028x", 5, null], ["/help\u2029x", 5, null],
  ])("uses the command-name caret boundary for %j at %i", (text, cursor, expected) => {
    expect(agentTabSlashQuery(text as string, cursor as number)).toBe(expected);
  });
  it("ranks prefix names and aliases, infixes, then subsequences without recency crossing groups", () => {
    const commands = [
      candidate("s-t-a-t", { lastUsedAt: 999 }), candidate("upstatus"), candidate("status"),
      candidate("station"), candidate("meter", { aliases: ["STAT-meter"] }), candidate("unmatched"),
    ];
    expect(filterAgentTabSlashCandidates(commands, "STAT", ["upstatus", "s-t-a-t", "station"]).map(c => c.name))
      .toEqual(["station", "meter", "status", "upstatus", "s-t-a-t"]);
    expect(filterAgentTabSlashCandidates(commands, "zzzz", [])).toEqual([]);
  });
  it("uses Composer recency, skill lastUsedAt, then name within one match group", () => {
    const commands = [candidate("plan-c", { lastUsedAt: 100 }), candidate("plan-d"),
      candidate("plan-a", { lastUsedAt: 100 }), candidate("plan-b", { lastUsedAt: 200 })];
    expect(filterAgentTabSlashCandidates(commands, "plan", ["plan-d"]).map(c => c.name))
      .toEqual(["plan-d", "plan-b", "plan-a", "plan-c"]);
  });
  it("shows at most five recent commands first for slash alone, and alphabetizes the remainder", () => {
    const names = ["z", "y", "x", "w", "v", "u", "a", "b"];
    const commands = names.map(name => candidate(name, { lastUsedAt: 999 - name.charCodeAt(0) }));
    expect(filterAgentTabSlashCandidates(commands, "", names.slice(0, 6)).map(c => c.name))
      .toEqual(["z", "y", "x", "w", "v", "a", "b", "u"]);
  });
  it("finds built-in aliases case-insensitively", () => {
    expect(filterAgentTabSlashCandidates(buildAgentTabSlashCandidates(null), "CoSt", [])[0].name).toBe("usage");
  });
  it("completes a name without discarding existing arguments", () => {
    expect(completeAgentTabSlashCommand("/ad", candidate("add-dir", { argumentHint: "<path>" }))).toBe("/add-dir ");
    expect(completeAgentTabSlashCommand("/hel", candidate("help"))).toBe("/help");
    expect(completeAgentTabSlashCommand("/ad C:/work", candidate("add-dir", { argumentHint: "<path>" }))).toBe("/add-dir C:/work");
  });
  it("sends exact names and aliases unchanged, even for a required-argument command", () => {
    const required = candidate("add-dir", { argumentHint: "<path>" });
    expect(agentTabSlashEnterAction("/ad", required)).toEqual({ text: "/add-dir ", send: false });
    expect(agentTabSlashEnterAction("/add-dir", required)).toEqual({ text: "/add-dir", send: true });
    expect(agentTabSlashEnterAction("/cost", candidate("usage", { aliases: ["cost"] }))).toEqual({ text: "/cost", send: true });
    expect(agentTabSlashEnterAction("/he", candidate("help"))).toEqual({ text: "/help", send: true });
  });
});

describe("optional and required slash arguments", () => {
  it.each(["<optional custom summarization instructions>", "<OPTIONAL instructions>", "<OpTiOnAl instructions>"])
    ("sends an optional argument hint %s while Tab still adds a space", hint => {
      const command = candidate("compact", { argumentHint: hint });
      expect(agentTabSlashEnterAction("/comp", command)).toEqual({ text: "/compact ", send: true });
      expect(completeAgentTabSlashCommand("/comp", command)).toBe("/compact ");
      expect(agentTabSlashEnterAction("/compact", command)).toEqual({ text: "/compact", send: true });
    });
  it.each(["add-dir", "cd", "fork", "model", "subtask"])("keeps %s completion waiting for a required argument", name => {
    const command = claudeSlashCommands.find(command => command.name === name)!;
    expect(agentTabSlashEnterAction("/" + name.slice(0, -1), command)).toEqual({ text: "/" + name + " ", send: false });
  });
  it("finds compact as the only optional angle-bracket hint in the unchanged table", () => {
    expect(claudeSlashCommands.filter(command => /^<optional/i.test(command.argumentHint)).map(command => command.name)).toEqual(["compact"]);
  });
});

describe("lazy slash skill loading", () => {
  beforeEach(() => {
    skillsMocks.peek.mockReset().mockReturnValue(null);
    skillsMocks.cached.mockReset().mockResolvedValue(null);
    skillsMocks.refresh.mockReset().mockResolvedValue(catalog([skill("loaded")]));
  });
  it("reads the cache before scanning once and shares the completed result", async () => {
    const first = loadAgentTabSlashSkills();
    const second = loadAgentTabSlashSkills();
    expect(second).toBe(first);
    expect(await first).toEqual(catalog([skill("loaded")]));
    expect(loadAgentTabSlashSkills()).toBe(first);
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).toHaveBeenCalledTimes(1);
    expect(skillsMocks.cached.mock.invocationCallOrder[0]).toBeLessThan(skillsMocks.refresh.mock.invocationCallOrder[0]);
  });
  it("shares a pending cache read and does not scan until it returns null", async () => {
    let finish!: (value: SkillCatalog | null) => void;
    skillsMocks.cached.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = loadAgentTabSlashSkills();
    expect(loadAgentTabSlashSkills()).toBe(first);
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).not.toHaveBeenCalled();
    finish(null);
    expect(await first).toEqual(catalog([skill("loaded")]));
    expect(skillsMocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("reuses the composer's initial cache read without reading twice", async () => {
    const initialRead = skillsMocks.cached();
    await loadAgentTabSlashSkills(initialRead);
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("uses a cached catalog without scanning", async () => {
    const data = catalog([skill("cached")]);
    skillsMocks.cached.mockResolvedValue(data);
    expect(await loadAgentTabSlashSkills()).toBe(data);
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).not.toHaveBeenCalled();
  });
  it("uses an already populated snapshot without reading or scanning", async () => {
    const data = catalog([skill("present")]);
    skillsMocks.peek.mockReturnValue(data);
    expect(await loadAgentTabSlashSkills()).toBe(data);
    expect(skillsMocks.cached).not.toHaveBeenCalled();
    expect(skillsMocks.refresh).not.toHaveBeenCalled();
  });
  it("checks for a snapshot populated elsewhere during the cache read", async () => {
    let finish!: (value: SkillCatalog | null) => void;
    skillsMocks.cached.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = loadAgentTabSlashSkills();
    const data = catalog([skill("external")]);
    skillsMocks.peek.mockReturnValue(data);
    finish(null);
    expect(await pending).toBe(data);
    expect(skillsMocks.refresh).not.toHaveBeenCalled();
  });
  it("retains a failed scan without retrying", async () => {
    skillsMocks.refresh.mockRejectedValue(new Error("scan unavailable"));
    const first = loadAgentTabSlashSkills();
    expect(await first).toBeNull();
    expect(loadAgentTabSlashSkills()).toBe(first);
    expect(await loadAgentTabSlashSkills()).toBeNull();
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("retains a cache-read failure without scanning or retrying", async () => {
    skillsMocks.cached.mockRejectedValue(new Error("cache unavailable"));
    expect(await loadAgentTabSlashSkills()).toBeNull();
    expect(await loadAgentTabSlashSkills()).toBeNull();
    expect(skillsMocks.cached).toHaveBeenCalledTimes(1);
    expect(skillsMocks.refresh).not.toHaveBeenCalled();
  });
});

describe("sent-command classification and bounded history", () => {
  it.each([
    ["/help", true], ["/clear name", true], ["/init", false], ["/insights", false],
    ["/statusline", false], ["/team-onboarding", false], ["/plugin:mine args", false],
    ["/cost", true], ["  /RESET  ", true], ["/unknown-command args", true],
  ])("classifies the sent first token %s independently of menu selection", (text, expected) => {
    const commands = buildAgentTabSlashCandidates(catalog([skill("mine", { calls: { claude: "/plugin:mine" } })]));
    expect(agentTabSlashCommandOpensTerminal(text, commands)).toBe(expected);
  });
  it("persists at most twenty unique canonical names and never arguments", () => {
    let stored = "";
    vi.stubGlobal("localStorage", { setItem: (_key: string, value: string) => { stored = value; }, getItem: () => stored || null });
    const commands = buildAgentTabSlashCandidates(null);
    let recent: string[] = [];
    for (let i = 0; i < 25; i++) recent = rememberAgentTabSlashCommand("/command-" + i + " private-argument", commands, recent);
    recent = rememberAgentTabSlashCommand("/cost secret", commands, recent);
    recent = rememberAgentTabSlashCommand("/usage other", commands, recent);
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("usage");
    expect(new Set(recent).size).toBe(20);
    expect(readAgentTabSlashRecent()).toEqual(recent);
    expect(stored).not.toMatch(/secret|argument|other|\/cost/);
    expect(rememberAgentTabSlashCommand("ordinary text", commands, recent)).toEqual(recent);
    expect(rememberAgentTabSlashCommand("/help\nmore", commands, recent)).toEqual(recent);
  });
  it("bounds and validates storage and tolerates unavailable or malformed storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(["help", "help", "bad argument", "/cost", 1, null, "usage"]), setItem: vi.fn() });
    expect(readAgentTabSlashRecent()).toEqual(["help", "usage"]);
    vi.stubGlobal("localStorage", { getItem: () => "{broken", setItem: vi.fn() });
    expect(readAgentTabSlashRecent()).toEqual([]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } });
    expect(readAgentTabSlashRecent()).toEqual([]);
    expect(rememberAgentTabSlashCommand("/cost private", buildAgentTabSlashCandidates(null), [])).toEqual(["usage"]);
    expect(AGENT_TAB_SLASH_RECENT_KEY).toBe("mycmux:agent-tab-slash-recent");
  });
});
