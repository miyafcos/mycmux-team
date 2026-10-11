import { afterAll, expect, it } from "vitest";
import { buildAutoNameEvidence, namingBinding } from "../../src/lib/autoNameMaterial";
import { deriveAutoName, shortAutomaticName, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { aggregateWorkspaceName, createAutoWorkspaceNamePolicy } from "../../src/lib/autoWorkspaceNaming";
import { actions, envelope, fixtureMaterial, makeTab, makeWorkspace, materialFor, matrix, nextFamilies, policyHarness, tasks, user, writeMatrixReport } from "./helpers/autoNamingInvariants";

afterAll(() => writeMatrixReport(".dispatch/b11-conservative-after.json"));
const controls = nextFamilies.filter(family => family.keep).flatMap(family => family.texts);
const scanTab = (id = "t") => ({ ...makeTab(id), workspaceId: "w", workspaceName: "", paneId: "p", column: 1,
  label: "", cwd: "/fixture", agentKind: "claude", tail: [], lastOutputAt: null });
const meaning = (request: string) => deriveAutoName(buildAutoNameEvidence(scanTab(), materialFor(makeTab("t"), request)));

it("B11 F1: controls resolve the newest substantive instruction and cannot cancel a quiet-period barrier", async () => {
  const cases = tasks.flatMap(task => ["解説スライドを作る", "次は会議を予約してください", "動画を編集してはいけません"].flatMap(next =>
    controls.flatMap(control => ["between-scans", "during-quiet", "lost-history"].map(sequence => ({ task, next, control, sequence })))));
  await matrix("B11-F1-temporal", cases, ({ task, next, control, sequence }) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = task.request; h.run(0);
    if (sequence !== "between-scans") { m.latest_instruction = next; h.run(60_000); }
    m.latest_instruction = control;
    m.events = sequence === "lost-history" ? [user(2, control)] : [user(0, task.request), user(1, next), user(2, control)];
    h.run(sequence === "between-scans" ? 60_000 : 65_000);
    const name = h.run(sequence === "between-scans" ? 70_000 : 75_000).get("t")?.displayName;
    expect(name).toBe(UNKNOWN_AUTO_NAME);
    for (const at of [120_000, 360_000]) expect(h.run(at).get("t")?.displayName).toBe(name);
  });
});

it("B11 F2: real frontend budgets never close a clipped polarity or control clause", async () => {
  const suffixes = ["はいけません。", "は不要です。", "のをやめてください。", "よいですか？", "ください。"];
  const cases = [0, 21, 79].flatMap(consumed => suffixes.flatMap(suffix => ["fresh", "accepted"].map(mode => ({ consumed, suffix, mode }))));
  await matrix("B11-F2-budgets", cases, ({ consumed, suffix, mode }) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    if (mode === "accepted") { m.latest_instruction = "動画を編集する"; h.run(0); }
    const prefixLength = 1593 - consumed;
    const request = "引用：「" + "あ".repeat(prefixLength - 7) + "」。\n動画を編集して" + suffix;
    m.latest_instruction = consumed ? "未解釈の指示" + "あ".repeat(consumed - 6) : request;
    m.events = [user(0, request), ...(consumed ? [user(1, m.latest_instruction)] : [])];
    const evidence = buildAutoNameEvidence(scanTab(), fixtureMaterial(m));
    // Inspect the real older-instruction budget too, even when the newest request is unresolved.
    const clippedOnly = { ...evidence, instructions: evidence.instructions.slice(consumed ? 1 : 0),
      instructionCompleteness: (evidence as typeof evidence & { instructionCompleteness?: boolean[] }).instructionCompleteness?.slice(consumed ? 1 : 0) };
    expect(deriveAutoName(clippedOnly).strength).toBe("unknown");
    h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F1: barriers survive a missing observation and older history until a provably newer affirmation", async () => {
  await matrix("B11-F1-persistent-barriers", controls.flatMap(control => [false, true].map(positive => ({ control, positive }))), ({ control, positive }) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; m.events = [user(0, m.latest_instruction)]; h.run(0);
    m.latest_instruction = "動画を編集してはいけません"; m.events = [user(1, m.latest_instruction)]; h.run(60_000);
    m.latest_instruction = undefined; m.events = []; h.run(63_000); expect(h.policy.nextCheckMs()).toBe(7_000);
    m.latest_instruction = control;
    m.events = [user(positive ? 2 : 0, positive ? "解説スライドを作る" : "動画を編集する"), user(3, control)];
    h.run(65_000);
    expect(h.run(75_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F1: a later control restores the latest substantive task after its positive timer was abandoned", async () => {
  await matrix("B11-F1-positive-read-loss", controls, control => {
    const h = policyHarness(), m = h.materials.get("t")!;
    Object.assign(m, materialFor(h.tabs[0], "動画を編集する", 0)); h.run(0);
    Object.assign(m, materialFor(h.tabs[0], "解説スライドを作る", 1)); h.run(60_000); expect(h.policy.nextCheckMs()).toBe(10_000);
    Object.assign(m, materialFor(h.tabs[0])); h.run(63_000); expect(h.policy.nextCheckMs()).toBe(10_000);
    Object.assign(m, materialFor(h.tabs[0], control, 2)); h.run(65_000);
    expect(h.run(75_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    expect(h.policy.meanings().get("t")?.fresh).toBe(false);
  });
});

it("B11 F2: native completeness is retained even after text is already shorter than the frontend cap", async () => {
  await matrix("B11-F2-native-completeness", ["動画を編集して", "動画", "引用：「参考だけ」。"], request => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; h.run(0);
    m.latest_instruction = request; m.latest_instruction_kind = "answer"; m.latest_instruction_complete = false;
    h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    const complete = materialFor(h.tabs[0], "動画を編集して");
    const clipped = { ...complete, latest_instruction_complete: false };
    expect(buildAutoNameEvidence(scanTab(), complete).contentKey).not.toBe(buildAutoNameEvidence(scanTab(), clipped).contentKey);
  });
  for (const source of ["activity", "heading"]) {
    const tab = scanTab(), material = materialFor(makeTab("t"));
    if (source === "activity") { material.events = [envelope(0, { type: "agentMessage", text: "動画を編集して" })]; material.incomplete_event_ids = ["event-0"]; }
    else { material.task_title = "動画を編集して"; material.task_title_complete = false; }
    expect(deriveAutoName(buildAutoNameEvidence(tab, fixtureMaterial(material))).strength).toBe("unknown");
  }
});

it("B11 F2: a clipped control is never proof that work continues beyond the missing clause", async () => {
  await matrix("B11-F2-clipped-controls", controls.flatMap(control => ["動画を編集しない", "動画を編集してよいですか？", "次は会議を予約してください"].map(tail => ({ control, tail }))), ({ control, tail }) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; h.run(0);
    m.latest_instruction = "引用：「" + "あ".repeat(1600 - Array.from(control).length - 7) + "」。\n" + control + "。" + tail;
    h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F3: substantive answers invalidate old work while acknowledgements and bare choices stay held", async () => {
  const substantive = ["動画を編集してはいけません", "動画ではなく解説スライドを作る", "次は会議を予約してください"];
  await matrix("B11-F3-answer-evidence", [...substantive, "はい", "A", "動画", "了解"], request => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; h.run(0);
    m.events = [user(0, m.latest_instruction), envelope(1, { type: "userMessage", kind: "answer", text: request, digest: "answer" })];
    h.run(60_000); const name = h.run(70_000).get("t")?.displayName;
    expect(name).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F3: bare answers cannot revive old generic instructions or cancel a newer quiet-period task", async () => {
  await matrix("B11-F3-answer-history-loss", ["reject", "positive", "none"].flatMap(change => [false, true].map(history => ({ change, history }))), ({ change, history }) => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; m.events = [user(0, m.latest_instruction)]; h.run(0);
    const instruction = change === "reject" ? "動画を編集してはいけません" : "解説スライドを作る";
    if (change !== "none") { m.events.push(envelope(1, { type: "userMessage", kind: "answer", text: instruction, digest: "answer" })); h.run(60_000); }
    m.latest_instruction = history ? "動画を編集する" : undefined;
    m.events = [...(history ? [user(0, "動画を編集する")] : []), ...["A", "動画", "はい", "了解"].map((text, i) => envelope(i + 2, { type: "userMessage", kind: "answer", text, digest: String(i) }))];
    h.run(65_000); expect(h.run(75_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F3: semantic acknowledgements stay conservative even after a question closes", async () => {
  await matrix("B11-F3-closed-ack", ["answer", "taskChange", "ack"] as const, kind => {
    const h = policyHarness(), m = h.materials.get("t")!;
    m.latest_instruction = "動画を編集する"; m.events = [user(0, m.latest_instruction)]; h.run(0);
    m.latest_instruction = "動画を編集してはいけません"; m.events = [user(1, m.latest_instruction)]; h.run(60_000); h.run(70_000);
    m.latest_instruction = "了解"; m.latest_instruction_kind = kind; m.events = [user(0, "動画を編集する"), envelope(2, {type: "userMessage", kind, text: "了解", digest: "ack"})];
    h.run(120_000); expect(h.run(130_000).get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("B11 F4: abstractions follow only the deliverable head, not a domain modifier", async () => {
  const cases = ["動画", "映像", "字幕", "スライド", "教材"].flatMap(domain => ["請求書", "申請書", "管理表"].flatMap(head =>
    ["の", "向け"].flatMap(join => actions.map(action => ({ domain, head, join, action })))));
  await matrix("B11-F4-object-head", cases, ({ domain, head, join, action }) => {
    const target = "授業" + domain + join + head, result = meaning(target + "を" + action + "する");
    expect(result.action).toBe(action); expect(result.target).toBe(target);
    expect(result.topic).toBe(target + action);
  });
});

it("B11 F5: an action-like object noun cannot erase its explicit final predicate", async () => {
  const cases = actions.flatMap(noun => actions.map(action => ({ noun, action })));
  await matrix("B11-F5-nominal-objects", cases, ({ noun, action }) => {
    const target = "機材費の" + noun, request = target + "を" + action + "する", result = meaning(request);
    const lightEstimate = noun === "見積" && action === "制作";
    expect(result.target).toBe(lightEstimate ? "機材費" : target);
    expect(result.action).toBe(lightEstimate ? "見積" : action);
    const h = policyHarness(), m = h.materials.get("t")!;
    Object.assign(m, materialFor(h.tabs[0], target + "を確認する", 0)); h.run(0);
    Object.assign(m, materialFor(h.tabs[0], target + "を送付する", 1));
    h.run(60_000); expect(h.run(70_000).get("t")?.displayName).toBe(target + "送付");
  });
});

it("B11 F6: a rejection recomposes mixed workspaces without promoting held jobs", async () => {
  const cases = ["held-control", "held-absent", "fresh"].flatMap(state => [0, 1, 2].map(unknown => ({ state, unknown })));
  await matrix("B11-F6-mixed-workspace", cases, ({ state, unknown }) => {
    const tabs = [makeTab("a"), makeTab("b"), ...Array.from({ length: unknown }, (_, i) => makeTab("unknown-" + i))], h = policyHarness(tabs);
    const a = h.materials.get("a")!, b = h.materials.get("b")!;
    a.latest_instruction = "動画を編集する"; b.latest_instruction = "解説スライドを作る"; h.run(0);
    let clock = 0; const workspacePolicy = createAutoWorkspaceNamePolicy(() => clock);
    const first = aggregateWorkspaceName(h.workspace, h.policy.meanings());
    workspacePolicy.candidate(h.workspace, first); clock = 120_000;
    h.workspace.name = workspacePolicy.candidate(h.workspace, first)!; workspacePolicy.committed(h.workspace.id, first);
    expect(h.workspace.name).toContain("動画編集");
    a.latest_instruction = "動画を編集しない";
    b.latest_instruction = state === "held-control" ? "続きをお願いします" : state === "held-absent" ? undefined : "解説スライドを作る";
    h.run(180_000); h.run(190_000);
    const summary = aggregateWorkspaceName(h.workspace, h.policy.meanings());
    expect(summary.name).toBeTruthy(); expect(summary.name).not.toContain("動画編集");
    expect(h.policy.meanings().get("b")?.fresh).toBe(state === "fresh");
    clock = 190_000; expect(workspacePolicy.candidate(h.workspace, summary)).toBeNull();
    clock = 420_000; const name = workspacePolicy.candidate(h.workspace, summary);
    expect(name).toBe(summary.name);
  });
});
