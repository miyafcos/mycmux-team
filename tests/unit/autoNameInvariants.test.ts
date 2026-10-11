import { afterAll, expect, it } from "vitest";
import { buildAutoNameEvidence, namingBinding } from "../../src/lib/autoNameMaterial";
import { deriveAutoName, nameGraphemes, namePrefix, resolveNameSiblings, shortAutomaticName, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { aggregateWorkspaceName } from "../../src/lib/autoWorkspaceNaming";
import { getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";
import { actions, endings, envelope, makeTab, makeWorkspace, materialFor, matrix, nextFamilies, policyHarness, product, punctuation, targets, tasks, user, write, writeMatrixReport } from "./helpers/autoNamingInvariants";
import type { NamingProject } from "../../src/lib/autoNamePolicy";
import type { AutoNameEvidence } from "../../src/lib/autoNameMaterial";

const input = (text: string, cwd = ""): AutoNameEvidence => ({ id: "t", workspaceId: "w", binding: "b", contentKey: text,
  instructions: text ? [text] : [], activity: [], files: [], taskTitle: "", cwd, evidenceRefs: ["u"] });
afterAll(() => writeMatrixReport(".dispatch/b9-invariants-after.json"));

it("NINV2: whole predicates prove affirmation; nonpositive predicates invalidate fresh, accepted and saved names", async () => {
  const cases = targets.flatMap(target => actions.flatMap(action => endings.flatMap(ending => punctuation.flatMap(mark =>
    ["fresh", "accepted", "saved"].map(mode => ({ target, action, ending, mark, mode }))))));
  await matrix("polarity", cases, ({ target, action, ending, mark, mode }) => {
    const old = target + action;
    const h = policyHarness([makeTab("t", mode === "saved" ? { displayName: old, displayNameSource: "auto" } : {})]);
    const material = h.materials.get("t")!;
    if (mode === "accepted") Object.assign(material, materialFor(h.tabs[0], target + "を" + action + "する", 0));
    if (mode !== "fresh") h.run(0);
    const request = target + "を" + action + ending.text + mark;
    Object.assign(material, materialFor(h.tabs[0], request, mode === "accepted" && request !== target + "を" + action + "する" ? 1 : 0));
    h.run(1_000); const name = h.run(11_000).get("t")?.displayName;
    if (ending.positive) expect(name).toBe(old);
    else { expect(name).toMatch(new RegExp("^" + UNKNOWN_AUTO_NAME + "(?:・[1-9]\\d*)?$")); expect(h.policy.meanings().get("t")?.strength).toBe("unknown"); }
  });
});

it("NINV1: retention requires continuation/status evidence across tail loss and incidental writes", async () => {
  const cases = tasks.flatMap(task => nextFamilies.flatMap(family => family.texts.flatMap(text =>
    [false, true].flatMap(inWindow => [false, true].map(incidental => ({ task, family: family.kind, keep: family.keep, text, inWindow, incidental }))))));
  await matrix("transitions", cases, ({ task, family, keep, text, inWindow, incidental }) => {
    const h = policyHarness(); const m = h.materials.get("t")!;
    m.latest_instruction = task.request; h.run(0);
    const request = family === "replacement" ? task.target + "ではなく" + text : text;
    m.latest_instruction = request;
    m.events = inWindow ? [user(0, task.request), user(1, request)] : [
      user(0, task.request), ...Array.from({ length: 24 }, (_, i) => envelope(i + 1, { type: "agentMessage", text: "50%" })), user(25, request),
    ];
    if (incidental) m.events.push(write(30, task.target === "動画" ? "temporary.pptx" : "temporary.mp4"));
    const immutable = { ...h.tabs[0] }; delete immutable.displayName; delete immutable.displayNameSource;
    for (const at of [60_000, 69_999, 70_000, 90_000, 120_000, 180_000, 360_000]) {
      const name = h.run(at).get("t")?.displayName;
      if (keep) expect(name).toBe(at < 70_000 ? task.name : UNKNOWN_AUTO_NAME);
      else if (at >= 70_000) expect(name).not.toBe(task.name);
    }
    for (const commit of h.writes.filter(write => write.at >= 70_000)) {
      if (keep) expect(commit.name).toBe(UNKNOWN_AUTO_NAME); else expect(commit.name).not.toBe(task.name);
    }
    const after = { ...h.tabs[0] }; delete after.displayName; delete after.displayNameSource;
    expect(after).toEqual(immutable);
  });
});

it("NINV3: noun identity survives the latest-instruction-only material/cache/policy boundary", async () => {
  const pairs = [["計算表", "集計表"], ["アップロード処理", "納品処理"], ["確認画面", "検査画面"], ["作成履歴", "制作履歴"]];
  const cases = pairs.flatMap(pair => actions.flatMap(action => ["する", "してください"].map(ending => ({ pair, action, ending }))));
  await matrix("noun-cache", cases, ({ pair, action, ending }) => {
    const h = policyHarness(); const tab = { ...h.tabs[0], workspaceId: "w", workspaceName: "", paneId: "p", column: 1, label: "", cwd: "/fixture", agentKind: "claude", tail: [], lastOutputAt: null };
    const materials = pair.map((target, occurrence) => materialFor(h.tabs[0], target + "を" + action + ending, occurrence));
    const evidence = materials.map(m => buildAutoNameEvidence(tab, m));
    expect(evidence[0].contentKey).not.toBe(evidence[1].contentKey);
    h.materials.set("t", materials[0]); expect(h.run(0).get("t")?.displayName).toContain(pair[0]);
    h.materials.set("t", materials[1]); h.run(60_000);
    const name = h.run(70_000).get("t")?.displayName;
    expect(name).toContain(pair[1]); expect(name).not.toContain(pair[0]);
  });
});

it("NINV4: every existing action controls domain abstraction and the workspace vote", async () => {
  const domains = ["動画", "映像", "スライド", "教材", "字幕"];
  await matrix("domain-actions", domains.flatMap(domain => actions.map(action => ({ domain, action }))), ({ domain, action }) => {
    const meanings = ["授業", "研修"].map(prefix => deriveAutoName(input(prefix + domain + "を" + action + "する")));
    for (const [index, meaning] of meanings.entries()) {
      expect(meaning.action).toBe(action);
      expect(meaning.topic).toBe(["授業", "研修"][index] + domain + action);
    }
    const tabs = [makeTab("a"), makeTab("b")], ws = makeWorkspace(tabs);
    meanings.forEach((meaning, i) => { meaning.binding = namingBinding(tabs[i]); });
    const summary = aggregateWorkspaceName(ws, new Map(meanings.map((meaning, i) => [tabs[i].id, meaning])));
    if (!["制作", "修正", "校正", "調整", "編集"].includes(action)) expect(summary.name).not.toMatch(/動画(?:編集|制作)|教材制作/);
    expect(summary.jobs).toBe(2);
  });
});

it("NINV5: presentation stripping keeps the nearest child project identity", async () => {
  const parents = ["サンプル企画", "共通のサンプル企画", "授業資料の企画"];
  await matrix("project-context", product(parents, ["の", " "], actions), ([parent, separator, action]) => {
    const children = ["数学", "国語", "理科"];
    const projects: NamingProject[] = [{ label: parent, path: "/fixture", section: "subjects" },
      ...children.map((child, i) => ({ label: parent + "/" + child, path: "/fixture/child-" + i, section: "subjects" }))];
    const rows = children.map((child, i) => ({ id: String(i), tab: makeTab(String(i)),
      meaning: deriveAutoName(input(parent + separator + "スライドを" + action + "する", "/fixture/child-" + i), projects) }));
    expect(new Set(rows.map(row => row.meaning.meaningKey)).size).toBe(children.length);
    const names = resolveNameSiblings(rows);
    children.forEach((child, i) => { expect(rows[i].meaning.qualifier).toBe(child); expect(shortAutomaticName(names.get(String(i))!)).toContain(child); });
    expect(new Set([...names.values()].map(name => namePrefix(shortAutomaticName(name)))).size).toBe(children.length);
    expect([...names.values()].every(name => !/・\d+$/.test(name))).toBe(true);
  });
});

it("NINV6: length caps preserve complete nouns containing の, or return unknown", async () => {
  const nouns = ["きのこ", "たけのこ", "いのしし", "もののけ", "つのぶえ", "ほのぼの", "のり"];
  const modifiers = ["小学校低学年向け理科", "全国の小学校と中学校", "地域の自然観察教室", "低学年から高学年向け記録", "校外学習向けの参考資料"];
  const cases = nouns.flatMap(noun => modifiers.flatMap(modifier => [8, 12, 16, 20, 24].map(cap => ({ noun, modifier, cap }))));
  await matrix("complete-nouns", cases, ({ noun, modifier, cap }) => {
    const core = noun + "の観察記録制作", full = modifier + "の" + core;
    const short = shortAutomaticName(full, cap);
    expect(nameGraphemes(short).length).toBeLessThanOrEqual(cap);
    if (nameGraphemes(core).length <= cap) expect(short).toContain(core);
    else expect(short).toBe(UNKNOWN_AUTO_NAME);
    expect(short).not.toMatch(/[のをがにと・ ]$/);
  });
});

it("NINV1/NINV7: collisions never preserve a replaced/negated task; every seat has a presentation", async () => {
  const cases = [4, 5, 6].flatMap(size => actions.flatMap(action => ["replacement", "rejection"].map(kind => ({ size, action, kind }))));
  await matrix("collision-invalidation", cases, ({ size, action, kind }) => {
    const ids = Array.from({ length: size }, (_, i) => String.fromCharCode(97 + i)), h = policyHarness(ids.map(id => makeTab(id)));
    const target = (i: number) => "数学スライドの解説ページ" + "甲乙丙丁戊己"[i];
    ids.forEach((id, i) => { h.materials.get(id)!.latest_instruction = i === size - 1 ? "動画を編集する" : target(i) + "を" + action + "する"; });
    h.run(0);
    const changed = ids[size - 1];
    h.materials.get(changed)!.latest_instruction = kind === "replacement" ? "動画ではなく" + target(size - 1) + "を" + action + "する" : "動画を編集してはいけません";
    h.run(60_000); const names = h.run(70_000);
    expect(names.get(changed)?.displayName).not.toContain("動画編集");
    const visible = ids.map(id => shortAutomaticName(names.get(id)?.displayName ?? ""));
    expect(visible.every(Boolean)).toBe(true); expect(new Set(visible).size).toBe(size);
    const known = visible.filter(name => !name.startsWith(UNKNOWN_AUTO_NAME));
    expect(new Set(known.map(namePrefix)).size).toBe(known.length);
    ids.forEach((id, i) => { const name = names.get(id)?.displayName; expect(name).toBeTruthy();
      if (!name!.startsWith(UNKNOWN_AUTO_NAME)) expect(shortAutomaticName(name!)).toContain("甲乙丙丁戊己"[i]); });
  });
});

it("NINV7: unknown counters honor protected reservations and survive sibling additions/removals", async () => {
  const reservations = [[], [UNKNOWN_AUTO_NAME], [UNKNOWN_AUTO_NAME + "・1"], [UNKNOWN_AUTO_NAME + "・2"], [UNKNOWN_AUTO_NAME, UNKNOWN_AUTO_NAME + "・1"]];
  const cases = [2, 3, 4, 5].flatMap(size => reservations.flatMap(names => ["user", "legacy"].map(owner => ({ size, names, owner }))));
  await matrix("unknown-counters", cases, ({ size, names, owner }) => {
    const protectedRows = names.map((name, i) => ({ id: "p-" + i, tab: makeTab("p-" + i, owner === "user" ? { label: name, labelSource: "user" } : { label: "readable legacy", labelSource: undefined, displayName: name, displayNameSource: "auto" }), meaning: deriveAutoName(input("")) }));
    const before = structuredClone(protectedRows);
    const rows = Array.from({ length: size }, (_, i) => ({ id: "u-" + i, tab: makeTab("u-" + i), meaning: deriveAutoName(input("")) }));
    const resolve = () => {
      const resolved = resolveNameSiblings([...protectedRows, ...rows]);
      for (const row of rows) { row.tab.displayName = resolved.get(row.id); row.tab.displayNameSource = "auto"; }
      const visible = [...names, ...rows.map(row => getTabDisplayLabel(row.tab))];
      expect(new Set(visible).size).toBe(visible.length);
      expect(rows.every(row => new RegExp("^" + UNKNOWN_AUTO_NAME + "(?:・[1-9]\\d*)?$").test(row.tab.displayName ?? ""))).toBe(true);
      return new Map(rows.map(row => [row.id, row.tab.displayName]));
    };
    const initial = resolve();
    rows.unshift({ id: "0-new", tab: makeTab("0-new"), meaning: deriveAutoName(input("")) }); resolve();
    for (const row of rows.filter(row => row.id !== "0-new")) expect(row.tab.displayName).toBe(initial.get(row.id));
    rows.splice(rows.findIndex(row => row.id === "u-0"), 1); resolve();
    for (const row of rows.filter(row => row.id !== "0-new")) expect(row.tab.displayName).toBe(initial.get(row.id));
    expect(protectedRows).toEqual(before);
  });
});

it("NINV8: normalized sentence punctuation detaches acknowledgement clauses from every target/action", async () => {
  const cases = product(["了解", "承知しました", "ありがとうございます", "はい", "OK"], ["。", "！", "!", "？", "?", "；"], targets, actions);
  await matrix("ack-punctuation", cases, ([ack, mark, target, action]) => {
    const meaning = deriveAutoName(input(ack + mark + "次は" + target + "を" + action + "してください"));
    expect(meaning.fullName).toBe(target + action);
    expect(meaning.strength).toBe("strong");
  });
});

it("NINV2: unresolved predicates and contradictory context cannot enter an affirmative object's name", async () => {
  const goals = [{ target: "字幕位置", action: "修正" }, { target: "参加者名簿", action: "集計" }];
  const cases = targets.flatMap(target => ["編集", "修正", "制作"].flatMap(action => endings.filter(ending => !ending.positive).flatMap(ending =>
    ["。", "、", "が", ""].flatMap(join => goals.flatMap(goal => ["before", "after"].map(order => ({ target, action, ending: ending.text, join, goal, order })))))));
  await matrix("whole-predicate-context", cases, ({ target, action, ending, join, goal, order }) => {
    const negative = target + "を" + action + ending, positive = goal.target + "を" + goal.action + "してください";
    const meaning = deriveAutoName(input(order === "before" ? negative + join + positive : positive + join + negative));
    if (order === "after" && target === goal.target && action === goal.action) expect(meaning.strength).toBe("unknown");
    else expect([UNKNOWN_AUTO_NAME, goal.target + goal.action]).toContain(meaning.fullName);
  });
});

it("NINV1: explicit invalidation reaches workspace aggregation; absence alone remains unobserved", async () => {
  const cases = targets.flatMap(target => actions.flatMap(action => endings.filter(ending => !ending.positive).flatMap(ending =>
    [false, true].map(secondInvalid => ({ target, action, ending: ending.text, secondInvalid })))));
  await matrix("workspace-invalidation", cases, ({ target, action, ending, secondInvalid }) => {
    const h = policyHarness([makeTab("a"), makeTab("b")]);
    h.materials.get("a")!.latest_instruction = target + "を" + action + ending;
    if (secondInvalid) h.materials.get("b")!.latest_instruction = "次は会議を予約してください";
    h.run(0);
    const summary = aggregateWorkspaceName(h.workspace, h.policy.meanings());
    expect(summary.name).toBe(UNKNOWN_AUTO_NAME); expect(summary.unknown).toBe(2);
  });
  await matrix("workspace-unobserved", tasks, () => {
    const h = policyHarness(); h.run(0);
    expect(aggregateWorkspaceName(h.workspace, h.policy.meanings()).name).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("NINV5: matching leaf labels in different registered parents remain different project identities", async () => {
  await matrix("project-identity", ["企画", "サンプル企画", "共通授業企画"].flatMap(parent => ["数学", "国語", "理科"].map(child => ({ parent, child }))), ({ parent, child }) => {
    const projects = [{ section: "subjects", label: parent, path: "/fixture" },
      ...["甲", "乙"].map((suffix, i) => ({ section: "subjects", label: parent + suffix + "/" + child, path: "/fixture/parent-" + i }))];
    const rows = ["甲", "乙"].map((suffix, i) => ({ id: String(i), tab: makeTab(String(i)),
      meaning: deriveAutoName(input(parent + "のスライドを制作する", "/fixture/parent-" + i + "/src"), projects) }));
    expect(rows[0].meaning.meaningKey).not.toBe(rows[1].meaning.meaningKey);
    const names = resolveNameSiblings(rows);
    rows.forEach((row, i) => { const name = shortAutomaticName(names.get(row.id)!);
      if (!name.startsWith(UNKNOWN_AUTO_NAME)) { expect(name).toContain(parent + "甲乙"[i]); expect(name).toContain(child); expect(name).not.toMatch(/・\d+$/); } });
    expect(new Set([...names.values()].map(name => shortAutomaticName(name))).size).toBe(2);
  });
});

it("NINV1: question modality with a new task object/prefix is not status evidence", async () => {
  const cases = tasks.flatMap(task => ["会議", "休憩", "配送"].flatMap(object => ["次は", "次に", ""].flatMap(prefix =>
    ["を", "が", "は", ""].flatMap(particle => ["か", "?", "？"].map(mark => ({ task, text: prefix + object + particle + "進めます" + mark }))))));
  await matrix("new-job-questions", cases, ({ task, text }) => {
    const h = policyHarness(); h.materials.get("t")!.latest_instruction = task.request; h.run(0);
    h.materials.get("t")!.latest_instruction = text; h.run(60_000);
    expect(h.run(70_000).get("t")?.displayName).not.toBe(task.name);
  });
  await matrix("context-status-questions", tasks.flatMap(task => ["いつ終わりそうですか", "どうですか", "いつ終わりますか"].map(text => ({ task, text }))), ({ task, text }) => {
    const h = policyHarness(); h.materials.get("t")!.latest_instruction = task.request; h.run(0);
    h.materials.get("t")!.latest_instruction = text; h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("NINV1: lost invalidating instructions cannot be healed by incidental weak evidence", async () => {
  const cases = tasks.flatMap(task => ["rejection", "unknown", "replacement"].flatMap(kind =>
    ["mp4", "pptx", "csv", "same-activity", "new-activity"].map(source => ({ task, kind, source }))));
  await matrix("invalidated-tail-loss", cases, ({ task, kind, source }) => {
    const h = policyHarness(), m = h.materials.get("t")!; m.latest_instruction = task.request; h.run(0);
    m.latest_instruction = kind === "rejection" ? task.target + "を" + task.action + "しない" : kind === "unknown" ? "次は会議を予約してください" : task.target + "ではなく配送便を手配してください";
    h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    m.latest_instruction = null;
    m.events = source.endsWith("activity") ? [envelope(30, { type: "agentMessage", text: source === "same-activity" ? task.request.replace("する", "している") : "字幕位置を修正している" })] : [write(30, "temporary." + source)];
    for (const at of [130_000, 160_000, 200_000, 360_000]) expect(h.run(at).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    expect(h.policy.nextCheckMs()).toBeUndefined();
    m.latest_instruction = task.request; h.run(420_000);
    expect(h.run(430_000).get("t")?.displayName).toBe(task.name);
  });
});
