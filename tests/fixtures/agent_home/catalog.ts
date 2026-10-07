import type { AgentDesignCatalog, DesignService, DesignFinding, DesignItem } from "../../../src/lib/agentDesignApi";
export function syntheticService(id: "claude" | "codex" | "hermes"): DesignService {
  return { id, displayName: id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : "Hermes", root: "/synthetic/home/." + id, state: id === "hermes" ? "absent" : "present",
    version: id === "hermes" ? null : "1.0.0", settings: [{ key: "model", value: "synthetic-model" }, { key: "unsupported", value: "1" }],
    stats: { skillsOwn: 2, skillsCodex: 2, skillsAgents: 0, rules: 2, rulesAlways: 1, rulesAlwaysChars: 20, rulesConditional: 1, hookEvents: 1, hookHandlers: 1, memoryIndexLines: 1, memoryFiles: 1, memoryIndexChars: 18, references: 1, scripts: 1, plugins: 1, pluginsEnabled: 0, scheduledJobs: 1, scheduledEnabled: 1 },
    hooks: [{ event: "Stop", matcher: "", script: "synthetic.py", source: "/synthetic/home/hooks.json", line: 1 }],
    session: { file: "synthetic.jsonl", linesRead: 5, bytesConsumed: 1024, stoppedAt: "firstRequest",
      listing: { count: 2, chars: 100, entries: [{ name: "reviewer", chars: 50, kind: "own", plugin: null, path: null, usageRecorded: false }], groups: [{ kind: "own", count: 2, chars: 100 }], pluginCounts: {}, disabledCounts: {}, disabledChars: 0 },
      startupHooks: [], startupChars: id === "codex" ? null : 10, sections: [{ kind: "memory", chars: 18 }] },
    context: { instructions: 20, memory: 18, listing: 100, startup: id === "codex" ? null : 10, product: null, total: id === "codex" ? 138 : 148, knownTotal: id === "codex" ? 138 : 148 } };
}
export const syntheticItem = (id: string, layer = 3, kind = "instruction"): DesignItem => ({ id, service: "claude", layer, displayName: "CLAUDE.md", path: "/synthetic/home/.claude/CLAUDE.md", kind, status: "present",
  size: { chars: 20, lines: 2, bytes: 20 }, readTiming: "always", evidence: "declaration", modifiedAt: 0,
  fields: kind === "settings" ? [{ key: "unsupported", value: "1" }] : [], conditions: [], documentAllowed: kind === "instruction", active: true });
export const syntheticFinding: DesignFinding = { id: "claude:unusedListing", kind: "unusedListing", service: "claude", layer: 5, severity: "decide", count: 1, chars: 50,
  evidence: [{ path: "/synthetic/home/.claude.json", line: 1, record: "synthetic.jsonl", rule: "noUsageRecord", fields: [] }],
  unknowns: ["usageStartDate"], proposal: "unusedListing", itemIds: [], names: ["reviewer"] };
export const syntheticCatalog: AgentDesignCatalog = { schemaVersion: 1, generatedAt: "2026-01-02T03:04:05Z", generator: "mycmux/1.0.0", home: "/synthetic/home", workFolder: "/synthetic/home", cwd: "/synthetic/home", refreshMs: 12,
  services: [syntheticService("claude"), syntheticService("codex"), syntheticService("hermes")],
  items: [syntheticItem("instructions"), syntheticItem("settings", 2, "settings"), { ...syntheticItem("skill", 5, "skill"), displayName: "reviewer", documentAllowed: false, fields: [{ key: "name", value: "reviewer" }] }],
  links: [], findings: [syntheticFinding], closedCount: 0, warnings: [], layers: [], readingFlows: [], compareRows: [], documents: {}, closedRevision: 0 };
