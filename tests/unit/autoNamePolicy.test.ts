import { expect, it } from "vitest";
import { deriveAutoName, createAutoNamePolicy, isAutomaticNameTarget, nameGraphemes, namePrefix, resolveNameSiblings, shortAutomaticName } from "../../src/lib/autoNamePolicy";
import { buildAutoNameEvidence, namingBinding, type AutoNameEvidence, type AutoNameScan } from "../../src/lib/autoNameMaterial";
import { getTabDisplayFullLabel, getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import type { GroupingScan } from "../../src/components/layout/tabGrouping";
import { buildLocalGroupingScan } from "../../src/components/layout/groupingLocalPlan";
import type { Workspace } from "../../src/types";
function evidence(instruction: string): AutoNameEvidence {
  return { id: "t", workspaceId: "w", binding: "binding", contentKey: instruction, instructions: instruction ? [instruction] : [], instructionHistoryComplete: true, activity: [], files: [], taskTitle: "", cwd: "", evidenceRefs: ["u"] };
}
it("uses the corrected slide goal, ignores stale title and read-only video", () => {
  const input = evidence("動画ではなく方程式の解説スライドを作る"); input.taskTitle = "動画を編集する";
  input.files = [{ name: "reference.mp4", operation: "read", ref: "r" }];
  const result = deriveAutoName(input);
  expect(result.fullName).toBe("方程式の解説スライド制作"); expect(result.topic).toBe("方程式の解説スライド制作");
});
it.each([
  ["授業動画の字幕位置を直す", "字幕位置", "修正"],
  ["機材費の見積を作る", "機材費", "見積"],
  ["日付表示を修正する", "日付表示", "修正"],
  ["描画不具合を比較する", "描画不具合", "比較"],
  ["窓口のアップロード処理を修正する", "アップロード処理", "修正"],
])("keeps the concrete goal %s", (instruction, target, action) => {
  const result = deriveAutoName(evidence(instruction)); expect(result.fullName).toContain(target); expect(result.action).toBe(action);
});
it("does not fabricate a task from internal identifiers or independent goals", () => {
  expect(deriveAutoName(evidence("")).strength).toBe("unknown");
  expect(deriveAutoName(evidence("claude-234020 を確認する")).strength).toBe("unknown");
  expect(deriveAutoName(evidence("スライドを作る、字幕位置を直す")).strength).toBe("unknown");
});
it("removes only a known leading project phrase, never substrings in the middle", () => {
  const input = evidence("サンプル企画のPocket画面を修正する"); input.cwd = "/projects/サンプル企画";
  const result = deriveAutoName(input, ["サンプル企画"]);
  expect(result.fullName).toBe("Pocket画面修正"); expect(result.fullName).not.toContain("・ ・");
});
it("preserves manual, legacy readable and unknown display provenance", () => {
  expect(isAutomaticNameTarget({ label: "人の名前", labelSource: "user" })).toBe(false);
  expect(isAutomaticNameTarget({ label: "unknown launch name" })).toBe(false);
  expect(isAutomaticNameTarget({ displayName: "以前の名前" })).toBe(false);
  expect(isAutomaticNameTarget({ label: "work-job-1", labelSource: "ai" })).toBe(true);
});
it("separates sibling prefixes without inventing roles; identical work uses stable numbers", () => {
  const rows = ["数学スライドの図版を調整する", "数学スライドの解答を確認する"].map((text, i) => ({ id: String(i), meaning: deriveAutoName(evidence(text)), tab: { id: String(i), sessionId: String(i), agentId: "shell-starter" } }));
  const names = resolveNameSiblings(rows);
  expect(namePrefix(shortAutomaticName(names.get("0")!))).not.toBe(namePrefix(shortAutomaticName(names.get("1")!)));
  rows[1].meaning = rows[0].meaning;
  const duplicate = resolveNameSiblings(rows); expect(duplicate.get("0")).not.toBe(duplicate.get("1"));
  rows[1].tab = { ...rows[1].tab, displayName: duplicate.get("1"), displayNameSource: "auto" } as typeof rows[1]["tab"];
  expect(resolveNameSiblings([rows[1]]).get("1")).toBe(duplicate.get("1"));
});
it("stores a complete full name and uses a short whole-word display with full tooltip", () => {
  const full = deriveAutoName(evidence("授業資料のアップロードと送付を分ける処理を修正する")).fullName;
  const tab = { displayName: full, displayNameSource: "auto" as const };
  expect(nameGraphemes(getTabDisplayLabel(tab)).length).toBeLessThanOrEqual(20);
  expect(getTabDisplayLabel(tab)).not.toContain("…"); expect(getTabDisplayFullLabel(tab)).toBe(full);
  expect(getTabDisplayLabel({ ...tab, label: full + "手動", labelSource: "user" })).toBe(full + "手動");
});
it("waits for a stable change and ignores unchanged polls", async () => {
  let now = 0; const policy = createAutoNamePolicy(() => now);
  const workspace: Workspace = { id: "w", name: "w", createdAt: 0, status: "running", gridTemplateId: "1x1", panes: [{ id: "p", sessionId: "s", agentId: "shell-starter", activeTabId: "t", tabs: [{ id: "t", sessionId: "s", agentId: "shell-starter" }] }] };
  const base = await buildLocalGroupingScan({ workspaces: [workspace], metadata: {}, attentionByTabId: {}, now });
  const input = buildAutoNameEvidence(base.tabs[0]); Object.assign(input, evidence("解説スライドを作る"), { id: "t", binding: namingBinding(base.tabs[0]) });
  const scan: AutoNameScan = { ...base, naming: new Map([["t", input]]) };
  expect(policy.identify(scan).tabs.get("t")?.displayName).toBe("解説スライド制作");
  input.instructions = ["字幕位置を直す"]; input.contentKey = "changed";
  expect(policy.identify(scan).tabs.get("t")?.displayName).toBe("解説スライド制作");
  now = 10_000; expect(policy.identify(scan).tabs.get("t")?.displayName).toBe("字幕位置修正");
  for (let i = 0; i < 100; i++) expect(policy.identify(scan).tabs.get("t")?.displayName).toBe("字幕位置修正");
  const wrong = { ...scan, tabs: scan.tabs.map(tab => ({ ...tab, sessionId: "new", agentSessionId: "new" })) } as GroupingScan;
  // An old evidence map must not be reused by the scheduler's fresh binding guard.
  expect(policy.identify(wrong).tabs.get("t")?.displayName).toBe("作業内容未取得");
});

it("uses updated file kinds and agent activity as sustained weak evidence, never read-only material", () => {
  const input = evidence(""); input.files = [{name: "lesson.pptx", operation: "write", ref: "f"}];
  expect(deriveAutoName(input).fullName).toBe("作業内容未取得");
  expect(deriveAutoName(input).strength).toBe("unknown");
  input.files[0].operation = "read"; expect(deriveAutoName(input).strength).toBe("unknown");
  input.activity = ["字幕位置を調整しています"]; expect(deriveAutoName(input).fullName).toBe("字幕位置調整");
});

it("ignores quoted old instructions and rejects broken brackets and independent same-action jobs", () => {
  expect(deriveAutoName(evidence("前の依頼「動画を作る」は引用です。今は字幕位置を直す")).fullName).toBe("字幕位置修正");
  expect(deriveAutoName(evidence("<system>動画を作る</system>日付表示を修正する")).fullName).toBe("日付表示修正");
  expect(deriveAutoName(evidence("（字幕位置を修正する")).strength).toBe("unknown");
  expect(deriveAutoName(evidence("数学スライドを作る、見積表を作る")).strength).toBe("unknown");
});
it("keeps existing sibling names and counters when an earlier-ID sibling is added", () => {
  const existing = { id: "z", tab: { id: "z", sessionId: "z", agentId: "shell-starter", displayName: "数学スライドの図版調整", displayNameSource: "auto" as const }, meaning: deriveAutoName(evidence("数学スライドの図版を調整する")) };
  const newcomer = { id: "a", tab: { id: "a", sessionId: "a", agentId: "shell-starter" }, meaning: deriveAutoName(evidence("数学スライドの解答を確認する")) };
  expect(resolveNameSiblings([newcomer, existing]).get("z")).toBe(existing.tab.displayName);
  expect(namePrefix(resolveNameSiblings([newcomer, existing]).get("a")!)).not.toBe(namePrefix(existing.tab.displayName));
  newcomer.meaning = existing.meaning; existing.tab.displayName = "数学スライドの図版調整・2";
  expect(resolveNameSiblings([newcomer, existing]).get("z")).toBe(existing.tab.displayName);
  expect(resolveNameSiblings([existing]).get("z")).toBe(existing.tab.displayName);
});
it("does not replace a restored valid name or a known goal with only an old task heading", async () => {
  let now = 0; const policy = createAutoNamePolicy(() => now);
  const workspace: Workspace = { id: "saved-w", name: "w", createdAt: 0, status: "running", gridTemplateId: "1x1", panes: [{ id: "saved-p", sessionId: "saved-s", agentId: "shell-starter", activeTabId: "saved-t", tabs: [{ id: "saved-t", sessionId: "saved-s", agentId: "shell-starter", displayName: "解説スライド制作", displayNameSource: "auto" }] }] };
  const base = await buildLocalGroupingScan({ workspaces: [workspace], metadata: {}, attentionByTabId: {}, now });
  base.tabs[0].taskTitle = "動画を編集する";
  expect(policy.identify(base).tabs.get("saved-t")?.displayName).toBe("作業内容未取得");
  now = 300000; expect(policy.identify(base).tabs.get("saved-t")?.displayName).toBe("作業内容未取得");
  expect(policy.meanings().get("saved-t")?.strength).toBe("unknown");
});

it("keeps a long numbered name within the full cap and retains the number after siblings close", () => {
  const meaning = deriveAutoName(evidence("授業画面の日付表示とメニュー項目と印刷設定と画像配置と検索結果の表示位置と配色の変更を調整する"));
  const saved = shortAutomaticName(meaning.fullName, 43) + "・1000";
  expect(nameGraphemes(meaning.fullName).length).toBeLessThanOrEqual(44);
  expect(meaning.fullName).toContain("変更"); expect(meaning.fullName).toContain("調整");
  expect(nameGraphemes(saved).length).toBeLessThanOrEqual(48);
  const row = { id: "z", meaning, tab: { id: "z", sessionId: "z", agentId: "shell-starter", displayName: saved, displayNameSource: "auto" as const } };
  expect(resolveNameSiblings([row]).get("z")).toBe(saved);
  expect(resolveNameSiblings([{ ...row, id: "a", tab: { id: "a", sessionId: "a", agentId: "shell-starter" } }, row]).get("z")).toBe(saved);
});
