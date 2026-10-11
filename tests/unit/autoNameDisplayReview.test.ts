import { expect, it } from "vitest";
import { deriveAutoName, namePrefix, resolveNameSiblings, shortAutomaticName } from "../../src/lib/autoNamePolicy";
import { getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import type { AutoNameEvidence } from "../../src/lib/autoNameMaterial";
import type { PaneTab } from "../../src/types";
const evidence = (text: string, cwd = ""): AutoNameEvidence => ({ id: "t", workspaceId: "w", binding: "b", contentKey: text, instructions: [text], activity: [], files: [], taskTitle: "", cwd, evidenceRefs: ["u"] });
const tab = (id: string, extra: Partial<PaneTab> = {}): PaneTab => ({ id, sessionId: "s-" + id, agentId: "shell-starter", labelSource: "launch", ...extra });
it("R9: project context distinguishes mathematics and language slides as different jobs", () => {
  const rows = ["数学", "国語"].map((project, i) => ({ id: String(i), tab: tab(String(i)),
    meaning: deriveAutoName(evidence(project + "のスライドを作る", "/projects/" + project), ["数学", "国語"]) }));
  expect(rows[0].meaning.meaningKey).not.toBe(rows[1].meaning.meaningKey);
  const names = resolveNameSiblings(rows);
  expect(shortAutomaticName(names.get("0")!)).toContain("数学");
  expect(shortAutomaticName(names.get("1")!)).toContain("国語");
  expect([...names.values()].every(name => !/・\d+$/.test(name))).toBe(true);
  expect(new Set([...names.values()].map(name => namePrefix(shortAutomaticName(name)))).size).toBe(2);
});
it("R9: unrelated registry entries do not erase an object's leading phrase", () => {
  expect(deriveAutoName(evidence("数学の解説スライドを作る", "/projects/国語"), ["数学", "国語"]).fullName).toContain("数学");
});
it("R10: the visible short name keeps the deliverable and action", () => {
  const meaning = deriveAutoName(evidence("全国の小学校と中学校と高等学校の教職員の参加者名簿を作る"));
  const result = resolveNameSiblings([{ id: "a", tab: tab("a"), meaning }]).get("a")!;
  const short = getTabDisplayLabel({ ...tab("a"), displayName: result, displayNameSource: "auto" });
  expect(short).toContain("参加者名簿"); expect(short).toContain("制作");
  expect(short).not.toMatch(/[のをがにと・ ]$/);
});
it("R11: three genuinely different jobs keep distinct final four-character prefixes", () => {
  const rows = ["調整", "確認", "校正"].map((action, i) => ({ id: String.fromCharCode(97 + i), tab: tab(String(i)),
    meaning: deriveAutoName(evidence("数学スライドの解説ページを" + action + "する")) }));
  const names = [...resolveNameSiblings(rows).values()].map(name => shortAutomaticName(name));
  expect(new Set(names.map(namePrefix)).size).toBe(3);
  expect(names.every(name => !/・\d+$/.test(name))).toBe(true);
  ["調整", "確認", "校正"].forEach((action, i) => expect(names[i]).toContain(action));
});
it.each([
  { label: "calendar runner", displayName: "日付表示修正", displayNameSource: "auto" as const },
  { label: "another raw label", labelSource: "launch" as const, displayName: "日付表示修正" },
])("R12: protected visible display names constrain new automatic siblings: %j", legacy => {
  const protectedTab = tab("legacy", { ...legacy, labelSource: ("labelSource" in legacy ? legacy.labelSource : undefined) });
  const rows = [{ id: "legacy", tab: protectedTab, meaning: deriveAutoName(evidence("")) },
    { id: "new", tab: tab("new"), meaning: deriveAutoName(evidence("日付表示を修正する")) }];
  const before = structuredClone(protectedTab);
  const name = resolveNameSiblings(rows).get("new")!;
  expect(getTabDisplayLabel({ ...tab("new"), displayName: name, displayNameSource: "auto" })).not.toBe(getTabDisplayLabel(protectedTab));
  expect(protectedTab).toEqual(before);
});

it("R9: folder context also distinguishes identical wording in different projects", () => {
  const rows = ["数学", "国語"].map((project, i) => ({ id: String(i), tab: tab(String(i)),
    meaning: deriveAutoName(evidence("スライドを作る", "/projects/" + project), ["数学", "国語"]) }));
  expect(rows[0].meaning.meaningKey).not.toBe(rows[1].meaning.meaningKey);
  const names = resolveNameSiblings(rows);
  expect(shortAutomaticName(names.get("0")!)).toContain("数学");
  expect(shortAutomaticName(names.get("1")!)).toContain("国語");
});

it.each(["hierarchical-words", "nested-folder"] as const)("R9: the nearest project survives a shared registered parent: %s", kind => {
  const projects = ["数学", "国語"], parent = kind === "hierarchical-words" ? "サンプル企画" : "共通のサンプル企画";
  const registrations = ["サンプル企画", "共通のサンプル企画", ...projects];
  const rows = projects.map((project, i) => ({ id: String(i), tab: tab(String(i)),
    meaning: deriveAutoName(evidence("スライドを作る", "/projects/" + parent + "/" + project + "/src"), registrations) }));
  expect(rows[0].meaning.meaningKey).not.toBe(rows[1].meaning.meaningKey);
  const names = resolveNameSiblings(rows);
  projects.forEach((project, i) => expect(shortAutomaticName(names.get(String(i))!)).toContain(project));
  expect([...names.values()].every(name => !/・\d+$/.test(name))).toBe(true);
});
