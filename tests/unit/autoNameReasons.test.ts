import { describe, expect, it } from "vitest";
import { createAutoNamePolicy, deriveAutoName, LAST_CONCRETE_NAME_MS, UNKNOWN_AUTO_NAME } from "../../src/lib/autoNamePolicy";
import { autoNameDescription, autoNameReasonLabel, type AutoNameReason } from "../../src/lib/autoNameStatus";
import { namingBinding, type AutoNameEvidence, type AutoNameScan } from "../../src/lib/autoNameMaterial";
import type { PaneTab, Workspace } from "../../src/types";

function evidence(instruction = "", extra: Partial<AutoNameEvidence> = {}): AutoNameEvidence {
  return { id:"t", workspaceId:"w", binding:"b", contentKey:instruction, instructions:instruction ? [instruction] : [],
    instructionHistoryComplete:true, materialStatus:"ready", activity:[], files:[], taskTitle:"", cwd:"", evidenceRefs:[], ...extra };
}
function scan(instruction: string, extra: Partial<AutoNameEvidence> = {}, tabExtra: Partial<PaneTab> = {}, protectedNames: string[] = []): AutoNameScan {
  const tab: PaneTab = { id:"t", sessionId:"pty", agentId:"codex", ...tabExtra };
  const tabs: PaneTab[] = [tab, ...protectedNames.map((name, index) => ({ id:"m"+index, sessionId:"manual"+index,
    agentId:"shell", label:name, labelSource:"user" as const }))];
  const workspace: Workspace = { id:"w", name:"workspace", createdAt:0, status:"running", gridTemplateId:"1x1",
    panes:[{ id:"p", agentId:"codex", sessionId:tab.sessionId, activeTabId:"t", tabs }] };
  const inputs = tabs.map(tab => ({ ...tab, label:tab.label ?? "", agentKind:"codex", agentSessionId:tab.id === "t" && "agentSessionId" in tabExtra ? tabExtra.agentSessionId : "agent", cwd:"/work", workspaceId:"w", paneId:"p", tail:[] }));
  const naming = new Map(inputs.map(tab => [tab.id, evidence(tab.id === "t" ? instruction : "", { ...extra, binding:namingBinding(tab) })]));
  return { tabs:inputs, workspaces:[workspace], naming } as unknown as AutoNameScan;
}

describe("U1-U10 reasons", () => {
  it.each([
    ["U1", evidence("", { materialStatus:"missing" }), "no-record"],
    ["U2", evidence("あれもこれもよくしてほしい"), "instruction-unclear"],
    ["U3", evidence("続けて"), "reply"],
    ["U4", evidence("日付表示を修正する", { instructionHistoryComplete:false }), "history-incomplete"],
    ["U5", evidence("日付表示を修正する", { instructionCompleteness:[false] }), "instruction-truncated"],
    ["U6", evidence("claude-234020 を確認する"), "unsafe-name"],
    ["U7", evidence("資".repeat(70) + "を修正する"), "name-too-long"],
    ["U9 waiting", evidence("", { materialStatus:"waiting" }), "waiting"],
    ["U9 failed", evidence("", { materialStatus:"unreadable" }), "read-failed"],
  ] as const)("explains %s", (_case, input, reason) => {
    const meaning = deriveAutoName(input);
    expect(meaning).toMatchObject({ strength:"unknown", unknownReason:reason });
    expect(autoNameDescription(meaning)).toBe("未取得: " + autoNameReasonLabel(reason));
  });
  it("U8 explains exhausted arrangements, while unknown siblings have no arbitrary numbers", () => {
    const policy = createAutoNamePolicy(() => 0);
    const result = policy.identify(scan("日付表示を修正する", {}, {}, ["日付表示修正", "修正・日付表示"]));
    expect(result.tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    expect(policy.meanings().get("t")?.unknownReason).toBe("name-conflict");
    policy.identify(scan("続けて", {}, {}, ["日付表示修正", "修正・日付表示"]));
    expect(policy.meanings().get("t")?.staleSince).toBeUndefined();
    const unknowns = createAutoNamePolicy(() => 0).identify(scan(""));
    expect(unknowns.tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
  it("U10 uses a readable launch label, and explains an internal counter", () => {
    const policy = createAutoNamePolicy(() => 0);
    expect(policy.identify(scan("", {}, { label:"dispatch-review", labelSource:"launch", agentSessionId:undefined })).tabs.get("t")?.displayName).toBe("dispatch-review");
    const invalid = createAutoNamePolicy(() => 0);
    invalid.identify(scan("", {}, { label:"codex-123", labelSource:"launch" }));
    expect(invalid.meanings().get("t")?.unknownReason).toBe("launch-label-unusable");
  });
  it("every reason has a user-readable explanation", () => {
    const reasons: AutoNameReason[] = ["no-record", "instruction-unclear", "reply", "history-incomplete", "instruction-truncated",
      "unsafe-name", "name-too-long", "name-conflict", "waiting", "read-failed", "launch-label-unusable"];
    for (const reason of reasons) expect(autoNameReasonLabel(reason).length).toBeGreaterThan(4);
  });
});

describe("retained concrete names", () => {
  it.each(["続けて", "進捗は?", "はい"])("marks the previous name after %s and expires after thirty minutes", followup => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    const first = policy.identify(scan("日付表示を修正する")).tabs.get("t")?.displayName;
    now = 10_000;
    expect(policy.identify(scan(followup)).tabs.get("t")?.displayName).toBe(first);
    expect(policy.meanings().get("t")).toMatchObject({ fresh:false, staleSince:10_000, unknownReason:"reply" });
    expect(autoNameDescription(policy.meanings().get("t"))).toContain("前回");
    now = LAST_CONCRETE_NAME_MS;
    policy.identify(scan(followup)); now += 10_000;
    expect(policy.identify(scan(followup)).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
  it("keeps the last task over a lower-priority launch label on read failure", () => {
    let now = 0; const policy = createAutoNamePolicy(() => now), tab = { label:"worker-a", labelSource:"launch" as const };
    policy.identify(scan("日付表示を修正する", {}, tab)); now = 1000;
    expect(policy.identify(scan("", { materialStatus:"unreadable" }, tab)).tabs.get("t")?.displayName).toBe("日付表示修正");
    expect(policy.meanings().get("t")?.unknownReason).toBe("read-failed");
  });
  it("replaces a retained task with a new concrete request and clears the marker", () => {
    let now = 0; const policy = createAutoNamePolicy(() => now);
    policy.identify(scan("日付表示を修正する")); now = 1000; policy.identify(scan("続けて"));
    policy.identify(scan("字幕位置を直す")); now = 11_000;
    expect(policy.identify(scan("字幕位置を直す")).tabs.get("t")?.displayName).toBe("字幕位置修正");
    expect(policy.meanings().get("t")?.staleSince).toBeUndefined();
  });
  it("never carries a name into a changed PTY or a different discovered Codex record", () => {
    const policy = createAutoNamePolicy(() => 0);
    policy.identify(scan("日付表示を修正する", { recordOwner:"old" }));
    expect(policy.identify(scan("続けて", { recordOwner:"new" })).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
    policy.identify(scan("日付表示を修正する"));
    expect(policy.identify(scan("続けて", {}, { sessionId:"new-pty" })).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

describe("Codex/dispatch record sources", () => {
  it("uses a spec heading even when the seat has no agent-session ID or label", () => {
    const policy = createAutoNamePolicy(() => 0);
    const input = scan("", { taskTitle:"タブ切り離しの修正", taskTitleSource:"spec", taskTitleComplete:true, recordOwner:"confirmed-owner", contextHistoryComplete:true, taskTitleExplicit:true, taskTitleInput:{event_id:"launch-spec", source_revision:1, source_byte_start:0} }, { agentSessionId:undefined });
    expect(input.tabs[0].agentSessionId).toBeUndefined();
    const named = policy.identify(input).tabs.get("t");
    expect(named?.displayName).toBe("タブ切り離しの修正");
    expect(policy.meanings().get("t")?.source).toBe("heading");
  });
  it("names from a complete first request and rejects a clipped first request", () => {
    const input = { initialInstruction:"タブ動作を調査する", initialInstructionComplete:true, recordOwner:"confirmed-owner", contextHistoryComplete:true, initialInstructionSource:{event_id:"first", source_revision:1, source_byte_start:0} };
    expect(createAutoNamePolicy(() => 0).identify(scan("", input)).tabs.get("t")?.displayName).toBe("タブ動作調査");
    expect(createAutoNamePolicy(() => 0).identify(scan("", { ...input, initialInstructionComplete:false })).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
  });
});

it("a still-available launch label remains a current seat label", () => {
  let now = 0; const policy = createAutoNamePolicy(() => now);
  const tab = { label:"dispatch-review", labelSource:"launch" as const };
  policy.identify(scan("", { materialStatus:"missing" }, tab)); now = 60_000;
  expect(policy.identify(scan("", { materialStatus:"missing" }, tab)).tabs.get("t")?.displayName).toBe("dispatch-review");
  expect(policy.meanings().get("t")?.staleSince).toBeUndefined();
});
it.each(["その作業は中止してください", "日付表示ではなく次は会議を予約してください"])("invalidates a prior name on an explicit stop/replacement: %s", text => {
  let now = 0; const policy = createAutoNamePolicy(() => now);
  policy.identify(scan("日付表示を修正する")); now = 1000; policy.identify(scan(text)); now = 11_000;
  expect(policy.identify(scan(text)).tabs.get("t")?.displayName).toBe(UNKNOWN_AUTO_NAME);
});
