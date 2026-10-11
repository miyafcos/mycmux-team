import { expect, it } from "vitest";
import { buildAutoNameEvidence, type NamingMaterial } from "../../src/lib/autoNameEvidence";
import type { GroupingScan } from "../../src/components/layout/tabGrouping";
import { fixtureMaterial } from "./helpers/autoNamingInvariants";
import { deriveAutoName, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
const tab = { id: "t", sessionId: "pty", workspaceId: "w", agentKind: "claude", agentSessionId: "agent", cwd: "/test" } as GroupingScan["tabs"][number];
const material = (events: NamingMaterial["events"]): NamingMaterial => fixtureMaterial({ tab_id: "t", pty_session_id: "pty", agent_kind: "claude", agent_session_id: "agent", cwd: "/test", events });
const event = (id: string, kind: NamingMaterial["events"][number]["kind"]) => ({ eventId: id, sourceRevision: 1, occurredAt: 1, sourceByteStart: 0, sourceByteEnd: 1, kind });
it("uses a correction, not an ack or a read-only video as the output", () => {
  const result = buildAutoNameEvidence(tab, material([
    event("u", { type: "userMessage", kind: "correction", text: "動画ではなく方程式の解説スライドを作る", digest: "x" }),
    event("r", { type: "toolStart", call_id: "r", tool: "Read", target: "reference.mp4" }),
    event("w", { type: "fileChange", path: "lesson.pptx", change: "modified" }),
    event("a", { type: "userMessage", kind: "ack", text: "了解", digest: "a" }),
  ]));
  expect(result.instructions).toEqual(["動画ではなく方程式の解説スライドを作る"]);
  expect(result.latestInput).toMatchObject({eventId: "a", kind: "ack"});
  expect(deriveAutoName(result).fullName).toBe(UNKNOWN_AUTO_NAME);
  expect(result.files).toEqual(expect.arrayContaining([expect.objectContaining({ name: "reference.mp4", operation: "read" }), expect.objectContaining({ name: "lesson.pptx", operation: "write" })]));
});
it("rejects a different agent or PTY binding", () => {
  const input = { ...material([event("u", { type: "agentMessage", text: "秘密" })]), pty_session_id: "other" };
  expect(buildAutoNameEvidence(tab, input).activity).toEqual([]);
});
it("bounds combined text and never treats a shell command as a path", () => {
  const input = material([
    event("u", { type: "userMessage", kind: "taskStart", text: "長".repeat(10000), digest: "u" }),
    event("a", { type: "agentMessage", text: "動".repeat(10000) }),
    event("s", { type: "toolStart", call_id: "s", tool: "Bash", target: "echo input.mp4" }),
  ]);
  const result = buildAutoNameEvidence(tab, input);
  expect(Array.from([...result.instructions, ...result.activity, result.cwd, result.taskTitle, ...result.files.map(f => f.name)].join("")).length).toBeLessThanOrEqual(3000);
  expect(result.files).toEqual([]);
  input.events.find(e => e.kind.type === "agentMessage")!.kind = { type: "agentMessage", text: "別の進捗表示" };
  expect(buildAutoNameEvidence(tab, input).contentKey).toBe(result.contentKey);
});
