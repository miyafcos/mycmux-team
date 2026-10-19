import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAttributeGrouping, collectAttributeTabs, buildAttributeGroupingPrompt, judgeAttributeGrouping,
  fallbackAttributeGrouping, normalizeAttributeName, parseAttributeGroupingOutput, ATTRIBUTE_GROUPING_VERSION,
  type AttributeGroupingResult, type ProjectAttribute,
} from "../../src/components/layout/attributeGrouping";
import { checkAttributeGrouping } from "../../src/components/layout/attributeGroupingChecks";
import { attributeCombinedName, attributeDefaultShort } from "../../src/components/layout/attributeGroupingNames";
import { compileGroupingPlan } from "./helpers/groupingTestEntrypoint";
import { type GroupingScan, type GroupingTab } from "../../src/components/layout/tabGrouping";
import type { ProjectRegistration } from "../../src/lib/paneIdentity";
import type { Workspace } from "../../src/types";

type Row = { project: string; workspace?: string; attribute?: ProjectAttribute; title?: string; label?: string; cwd?: string; pinned?: boolean; parent?: string };
function scenario(rows: Row[], bundles: Array<{ projects: string[]; reason: string }> = [], registry: ProjectRegistration[] = []) {
  const tabs: GroupingTab[] = rows.map((row, i) => ({
    id: `t${i+1}`, sessionId: `s${i+1}`, label: row.label ?? row.project, displayName: row.title ?? row.project,
    labelSource: "user", cwd: row.cwd ?? "/home/example", agentKind: "codex", workspaceId: row.workspace ?? "机",
    workspaceName: row.workspace ?? "机", paneId: `place${i+1}`, column: 1, lastOutputAt: null, tail: [],
    origin: row.parent ? { kind: "agent", parentTabId: row.parent } : { kind: "human" },
  }));
  const workspaces: Workspace[] = [...new Set(tabs.map(tab => tab.workspaceId))].map(id => {
    const here = tabs.filter(tab => tab.workspaceId === id);
    const panes = here.map(tab => ({ id: tab.paneId, agentId: "codex", sessionId: tab.sessionId, activeTabId: tab.id,
      ...(rows[Number(tab.id.slice(1))-1].pinned ? { pinnedTabId: tab.id } : {}),
      tabs: [{ id: tab.id, sessionId: tab.sessionId, agentId: "codex", type: "terminal" as const, label: tab.label, cwd: tab.cwd, origin: tab.origin }] }));
    return { id, name:id, panes, gridTemplateId:"1x1", status:"running", createdAt:0,
      splitColumns: Array.from({ length:Math.ceil(panes.length/4) }, (_,i)=>panes.slice(i*4,i*4+4).map(p=>p.id)) };
  });
  const scan: GroupingScan = { tabs, workspaces, scannedAt:0, workspaceIds:workspaces.map(w=>w.id), lineageClusters:[],
    baseline:tabs.map(t=>({tabId:t.id,workspaceId:t.workspaceId,paneId:t.paneId,sessionId:t.sessionId})) };
  const projects = [...new Set(rows.map(row => row.project).filter(Boolean))].map(name=>({name,short:[...name].slice(0,8).join(""),
    attribute:rows.find(row=>row.project===name)?.attribute ?? "アプリ・開発", evidence:"題名"}));
  const ai = { projects, panes:rows.map((row,i)=>({id:`p${i+1}`,project:row.project,confidence:1})), bundles };
  return { scan, registry, ai, raw:JSON.stringify(ai) };
}
function build(input: ReturnType<typeof scenario>) { return buildAttributeGrouping(input.scan,input.registry,input.raw); }
function assertValid(scan: GroupingScan, result: AttributeGroupingResult) {
  expect(checkAttributeGrouping(scan,result)).toEqual({ placement:[], protected:[], limits:[], attributes:[], names:[], materials:[] });
  const compiled = compileGroupingPlan(result.plan,scan.workspaces,{
    baseline:scan.baseline,activeWorkspaceId:scan.workspaceIds[0],activeSessionId:scan.tabs[0]?.sessionId ?? null,
    allocationSeed:"attribute-test",createdAt:0,
  });
  expect(compiled.ok,compiled.ok?undefined:compiled.errors.join("/")).toBe(true);
  if (!compiled.ok) throw new Error("compile failed");
  expect(compiled.transaction.expected.movedTabIds.length).toBe(result.moves.length);
  return compiled;
}
const repeated = (project: string, count: number, overrides: Partial<Row> = {}): Row[] => Array.from({length:count},()=>({project,...overrides}));

describe("attribute judgement and prompt",()=>{
  it("uses scan IDs, titles and matched registrations, compresses home paths and omits tails",()=>{
    const input=scenario([{project:"北斗学院",cwd:"C:/Users/example/projects/hikari"},{project:"",title:"",label:"ラベルだけ"}],[],
      [{section:"anken",label:"北斗学院",path:"C:/Users/example/projects/hikari"}]);
    input.scan.tabs[0].tail=["PRIVATE_TAIL_SENTINEL"];
    input.scan.tabs[1].taskTitle="依頼の題名";
    const tabs=collectAttributeTabs(input.scan,input.registry);
    expect(tabs.map(t=>t.id)).toEqual(["p1","p2"]);
    const prompt=buildAttributeGroupingPrompt(tabs,input.registry);
    expect(prompt).toContain("やることは 3 つ");
    expect(prompt).toContain("フォルダ=~/projects/hikari");
    expect(prompt).toContain("登録=北斗学院");
    expect(prompt).toContain("案件=北斗学院 (確定)");
    expect(prompt).toContain("id=p2 | 題名=依頼の題名 | ラベル=ラベルだけ");
    expect(prompt).not.toContain("PRIVATE_TAIL_SENTINEL");
    expect(prompt).not.toContain("C:/Users/example");
    expect(ATTRIBUTE_GROUPING_VERSION).toBe("attribute-grouping-v4");
  });
  it("accepts material from any member, normalizes punctuation/case and strips final parentheses",()=>{
    const input=scenario([{project:"AB_c.d",title:"A B・C/D 開始"},{project:"a-bcD (master)",title:"続き"}]);
    input.ai.projects=[{name:"AB_c.d (master)",short:"AB",attribute:"アプリ・開発",evidence:"題名"}];
    const judged=judgeAttributeGrouping(collectAttributeTabs(input.scan,[]),input.ai);
    expect(judged.projects.map(p=>p.name)).toEqual(["AB_c.d"]);
    expect(judged.tabs.map(t=>t.project)).toEqual(["AB_c.d","AB_c.d"]);
    expect(normalizeAttributeName("A B・C/D_-.")).toBe("abcd");
    expect(judged.issues).toEqual([]);
  });
  it("allows names from a path-matched registry component, but rejects a name found only in the registry list",()=>{
    const input=scenario([{project:"架空商品",title:"修正",cwd:"/work/client"}],[],
      [{section:"anken",label:"北斗学院/架空商品 (試用)",path:"/work/client"},{section:"dev",label:"別アプリ",path:"/elsewhere"}]);
    const tabs=collectAttributeTabs(input.scan,input.registry).map(t=>({...t,fixedProject:""}));
    expect(judgeAttributeGrouping(tabs,input.ai).tabs[0].project).toBe("架空商品");
    const rejected=judgeAttributeGrouping(tabs,{projects:[{name:"別アプリ",short:"別",attribute:"アプリ・開発"}],panes:[{id:"p1",project:"別アプリ"}]});
    expect(rejected.tabs[0].project).toBe("修正");
    expect(rejected.issues.some(i=>i.kind==="名前の材料なし")).toBe(true);
  });
  it("rejects invented shorts, accepts literal substrings and records invalid attributes without moving them",()=>{
    const input=scenario([{project:"記録の整理と振り返り"}]);
    for (const [short,attribute,expected] of [["振り返り","整理・事務","振り返り"],["別名","整理・事務","記録の整理と振り"],["整理と振り返り","unknown","整理と振り返り"]] as const) {
      const judged=judgeAttributeGrouping(collectAttributeTabs(input.scan,[]),{...input.ai,projects:[{name:input.ai.projects[0].name,short,attribute}]});
      expect(judged.projects[0].short).toBe(expected);
      expect(judged.projects[0].attribute).toBe(attribute==="unknown"?"不明":attribute);
      expect(judged.issues.some(i=>i.kind==="呼び名が名前の一部でない")).toBe(short==="別名");
      expect(judged.issues.some(i=>i.kind==="属性が一覧外")).toBe(attribute==="unknown");
    }
    const unknown=buildAttributeGrouping(input.scan,[],JSON.stringify({...input.ai,projects:[{name:input.ai.projects[0].name,short:"記録",attribute:"不明"}]}));
    expect(unknown.moves).toEqual([]);
  });
  it("records missing, duplicate and foreign IDs; fixed evidence wins over conflicting answers",()=>{
    const input=scenario([{project:"別件",cwd:"/work/core"},{project:"題名のテーマ"},{project:""}],[],
      [{section:"dev",label:"mycmux",path:"/work/core"}]);
    const tabs=collectAttributeTabs(input.scan,input.registry);
    const judged=judgeAttributeGrouping(tabs,{projects:[{name:"mycmux",short:"mycmux",attribute:"アプリ・開発"}],
      panes:[{id:"p1",project:"別件"},{id:"p1",project:"別件"},{id:"extra",project:"別件"}]});
    expect(judged.tabs[0].project).toBe("mycmux");
    expect(judged.issues.map(i=>i.kind)).toEqual(expect.arrayContaining(["重複","欠落","存在しないタブ","確定を上書きしかけた"]));
  });
  it.each(["", "作業内容未取得・2"])("leaves rejected nameless title %s unknown",title=>{
    const input=scenario([{project:"架空の推測",title,label:""}]);
    expect(build(input).tabs[0].project).toBe("");
  });
  it("fixes folder and lineage identities while leaving task/session-only evidence to the AI",()=>{
    const registry=[{section:"dev",label:"mycmux",path:"/work/mycmux"},
      ...Array.from({length:20},(_,i)=>({section:"dev",label:`別登録${i}`,path:`/other/${i}`}))];
    const input=scenario([{project:"mycmux",cwd:"/work/mycmux"},{project:"mycmux",parent:"t1"},{project:"mycmux"},{project:"mycmux"}],[],registry);
    input.scan.tabs[2].taskTitle="mycmux";
    input.scan.tabs[3].sessionTitle="mycmux";
    const tabs=collectAttributeTabs(input.scan,registry);
    expect(tabs.map(t=>t.projectReason)).toEqual(["folder_registry","lineage","task_title","session_title"]);
    expect(tabs.map(t=>Boolean(t.fixedProject))).toEqual([true,true,false,false]);
  });
  it("uses folder words and learned aliases as fixed project evidence",()=>{
    const registry=[{section:"dev",label:"mycmux",path:"/work/core"},
      ...Array.from({length:20},(_,i)=>({section:"dev",label:`別登録${i}`,path:`/other/${i}`}))];
    const input=scenario([...repeated("mycmux",3,{cwd:"/work/core",label:"alpha-root"}),
      {project:"",label:"alpha-next"},{project:"",cwd:"/work/mycmux-wt-temp"}],[],registry);
    input.scan.tabs.forEach(tab=>{tab.labelSource="auto";});
    const tabs=collectAttributeTabs(input.scan,registry);
    expect(tabs.map(t=>t.projectReason)).toEqual(["folder_registry","folder_registry","folder_registry","alias","folder_words"]);
    expect(tabs.every(t=>t.fixedProject==="mycmux")).toBe(true);
  });
  it("keeps the registered fallback category for aliases with a final full-width annotation",()=>{
    const registry=[{section:"dev",label:"mycmux（主）",path:"/work/core"}];
    const input=scenario([...repeated("mycmux",3,{cwd:"/work/core",label:"alpha-root"}),
      {project:"mycmux",label:"alpha-next"}],[],registry);
    input.scan.tabs.forEach(tab=>{tab.labelSource="auto";});
    const result=fallbackAttributeGrouping(input.scan,registry,"AI がオフ");
    expect(result.tabs[3].projectReason).toBe("alias");
    expect(result.projects[0]).toMatchObject({name:"mycmux",attribute:"アプリ・開発"});
    assertValid(input.scan,result);
  });
  it("treats malformed JSON and invalid schema as failures",()=>{
    for (const raw of ["no json","{oops}","{}",'{"projects":[],"panes":null}']) expect(()=>parseAttributeGroupingOutput(raw)).toThrow();
    expect(parseAttributeGroupingOutput('text {"projects":[],"panes":[]} text').panes).toEqual([]);
  });
});

describe("attribute bundles and all six invariants",()=>{
  const rows=[...repeated("core",4,{workspace:"core"}),{project:"guest",workspace:"core"},{project:"guest2",workspace:"core"},
    {project:"予算",attribute:"整理・事務" as const},{project:"記録",attribute:"整理・事務" as const},
    {project:"稼働の案件",workspace:"稼働"},{project:"固定案件",pinned:true},{project:"",title:""}];
  it("retains same-attribute residents, never renames destinations and keeps held tabs in their places",()=>{
    const input=scenario(rows,[{projects:["予算","記録"],reason:"事務の整理"}]),result=build(input);
    const compiled=assertValid(input.scan,result);
    expect(result.groups.find(g=>g.name==="core")?.units.map(u=>u.name)).toEqual(["core","guest","guest2"]);
    expect(result.plan.rationale).toContain("今の置き場に同居");
    const after=compiled.transaction.workspaces;
    for(const id of ["t9","t10","t11"]) {
      const before=input.scan.tabs.find(t=>t.id===id)!;
      expect(after.find(w=>w.id===before.workspaceId)?.panes.find(p=>p.id===before.paneId)?.tabs.some(t=>t.id===id)).toBe(true);
    }
    expect(input.scan.workspaces.map(w=>w.name)).toEqual(after.filter(w=>input.scan.workspaceIds.includes(w.id)).map(w=>w.name));
  });
  it.each(["placement","protected","limits","attributes","names","materials"] as const)("rejects a deliberately broken %s invariant",key=>{
    const input=scenario(rows,[{projects:["予算","記録"],reason:"事務"}]),result=structuredClone(build(input));
    const group=result.groups.find(g=>g.name==="core")!;
    if(key==="placement") result.plan.groups.push(structuredClone(result.plan.groups[0]));
    if(key==="protected") result.moves.push({id:"p9",tabId:"t9",from:"稼働",to:"core"});
    if(key==="limits") group.tabIds.push(...Array<string>(17-group.tabIds.length).fill(group.tabIds[0]));
    if(key==="attributes") group.units[1].attribute="整理・事務";
    if(key==="names") group.name="勝手な名前";
    if(key==="materials") group.units[0].name="根拠のない造語";
    expect(checkAttributeGrouping(input.scan,result)[key].length).toBeGreaterThan(0);
  });
  it("enforces eight-tab bundles and two-guest/sixteen-tab hosts, including rejected AI combinations",()=>{
    const input=scenario([...repeated("host",14,{workspace:"host"}),...repeated("guest",3,{workspace:"host"}),
      ...repeated("a",3),...repeated("b",3),...repeated("c",3),{project:"other",attribute:"整理・事務"}],[
      {projects:["a","b","c"],reason:"9 tabs rejected"},{projects:["host","guest"],reason:"17 tabs rejected"},
      {projects:["a","other"],reason:"mixed rejected"},{projects:["a","a"],reason:"duplicate rejected"},
      {projects:["a","absent"],reason:"missing rejected"},
    ]);
    const result=build(input);
    expect(result.groups.find(g=>g.units[0].name==="host")?.units).toHaveLength(1);
    expect(result.issues.filter(i=>i.kind==="AI の組を採らず")).toHaveLength(5);
    expect(result.groups.filter(g=>g.kind==="まとめ").every(g=>g.tabIds.length<=8)).toBe(true);
    // This source deliberately has more than sixteen visible places; verify proposal constraints separately.
    expect(checkAttributeGrouping(input.scan,result).limits).toEqual([]);
  });
  it("routes a valid AI guest into a large project and rejects another host or a fourth guest",()=>{
    const input=scenario([...repeated("host",4,{workspace:"host"}),...repeated("second",4,{workspace:"second"}),
      {project:"a"},{project:"b"},{project:"c"}],[
      {projects:["host","a","b"],reason:"same tools"},{projects:["host","c"],reason:"third guest"},
      {projects:["host","second"],reason:"two hosts"},
    ]);
    const result=build(input);
    expect(result.groups.find(g=>g.units[0].name==="host")?.units.map(u=>u.name)).toEqual(["host","a","b"]);
    expect(result.issues.filter(i=>i.kind==="AI の組を採らず")).toHaveLength(2);
    assertValid(input.scan,result);
  });
  it("uses a strict unrelated majority and preserves existing names with a rename hint",()=>{
    const input=scenario([{project:"記録",workspace:"自由机"},{project:"記録",workspace:"自由机"},{project:"記録",workspace:"自由机"},{project:"記録",workspace:"別机"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({keepsWorkspaceId:"自由机",name:"自由机",renameHint:"記録"});
    expect(result.plan.rationale).toContain("付け直すなら候補「記録」");
    assertValid(input.scan,result);
    const tie=scenario([{project:"記録",workspace:"自由机"},{project:"記録",workspace:"自由机"},{project:"記録",workspace:"別机"},{project:"記録",workspace:"別机"}]);
    expect(build(tie).groups[0]).toMatchObject({keepsWorkspaceId:null,name:"記録",renameHint:null});
  });
  it("fits incoming tabs into a full four-by-four destination without moving pinned residents",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core"}),...Array.from({length:12},(_,i)=>({project:"",title:"",workspace:"core",pinned:i===0})),
      {project:"core",workspace:"机"}]);
    const result=build(input),compiled=assertValid(input.scan,result);
    const destination=compiled.transaction.workspaces.find(w=>w.id==="core")!;
    expect(destination.splitColumns).toHaveLength(4);
    expect(destination.splitColumns?.every(column=>column.length<=4)).toBe(true);
    expect(result.plan.groups.find(g=>g.disposition==="reorganize")?.layout?.columns[0].panes[0].existingPaneId).toBeDefined();
  });
  it.each([["anken","編集・制作"],["dev","アプリ・開発"],["other","不明"]] as const)("maps fallback registry section %s to %s", (section,attribute)=>{
    const input=scenario([{project:"北斗学院",cwd:"/work/client"}],[],[{section,label:"北斗学院",path:"/work/client"}]);
    const result=fallbackAttributeGrouping(input.scan,input.registry,"AI がオフ");
    expect(result.projects[0].attribute).toBe(attribute);
    assertValid(input.scan,result);
  });
  it("falls back to fixed projects and registry categories; uncertain tabs stay put",()=>{
    const input=scenario([{project:"mycmux",cwd:"/work/core"},{project:"mycmux",cwd:"/work/core",workspace:"別机"},
      {project:"題名だけの案件"}],[],[{section:"dev",label:"mycmux",path:"/work/core"}]);
    const result=fallbackAttributeGrouping(input.scan,input.registry,"AI がオフ");
    expect(result.plan.rationale).toContain("AI の判定なし (AI がオフ)");
    expect(result.projects[0].attribute).toBe("アプリ・開発");
    expect(result.tabs[2].project).toBe("");
    expect(result.moves.some(m=>m.tabId==="t3")).toBe(false);
    assertValid(input.scan,result);
  });
});


describe("FIX1 attributes, sparse projects, complete names and folder instructions",()=>{
  it("F1 inherits one containing AI name without changing the fixed project",()=>{
    const input=scenario([{project:"ひかりスタ 数学",cwd:"/work/math"}],[],[{section:"anken",label:"ひかりスタ/数学",path:"/work/math"}]);
    const result=buildAttributeGrouping(input.scan,input.registry,JSON.stringify({projects:[{name:"ひかりスタ",short:"ひかり",attribute:"編集・制作"}],panes:[{id:"p1",project:"ひかりスタ"}]}));
    expect(result.projects[0]).toMatchObject({name:"ひかりスタ 数学",attribute:"編集・制作"});
    expect(result.issues.some(i=>i.kind==="確定案件の属性を補完"&&i.detail.includes("AI名の包含"))).toBe(true);
  });
  it("F1 rejects ambiguous containing names, uses the registered category, and stays unknown without it",()=>{
    const input=scenario([{project:"ひかりスタ",cwd:"/work/math"}],[],[{section:"anken",label:"ひかりスタ",path:"/work/math"}]);
    const ai={projects:[{name:"ひかりスタ 数学",short:"数学",attribute:"アプリ・開発"},{name:"ひかりスタ 理科",short:"理科",attribute:"整理・事務"}],panes:[{id:"p1",project:"ひかりスタ"}]};
    const tabs=collectAttributeTabs(input.scan,input.registry);
    const judged=judgeAttributeGrouping(tabs,ai,input.registry);
    expect(judged.projects[0].attribute).toBe("編集・制作");
    expect(judged.issues.some(i=>i.detail.includes("登録の区分")&&i.detail.includes("2件"))).toBe(true);
    const unknown=judgeAttributeGrouping(tabs.map(t=>({...t,registration:null,fixedKey:"no-registry"})),ai,[]);
    expect(unknown.projects[0].attribute).toBe("不明");
    expect(unknown.issues.some(i=>i.detail.startsWith("不明:"))).toBe(true);
    const unrelated=judgeAttributeGrouping(tabs,{projects:[{name:"無関係",short:"無関係",attribute:"アプリ・開発"}],panes:[]},input.registry);
    expect(unrelated.projects[0].attribute).toBe("編集・制作");
  });
  it("F1 preserves an exact AI category and resolves the reverse containment only when unique",()=>{
    const input=scenario([{project:"ひかりスタ",cwd:"/work/client"}],[],[{section:"anken",label:"ひかりスタ",path:"/work/client"}]);
    const tabs=collectAttributeTabs(input.scan,input.registry);
    const exact=judgeAttributeGrouping(tabs,{projects:[{name:"ひかりスタ",short:"ひかり",attribute:"整理・事務"}],panes:[]},input.registry);
    expect(exact.projects[0].attribute).toBe("整理・事務");
    expect(exact.issues.some(i=>i.kind==="確定案件の属性を補完")).toBe(false);
    const longer=judgeAttributeGrouping(tabs,{projects:[{name:"ひかりスタ 制作",short:"制作",attribute:"編集・制作"}],panes:[]},input.registry);
    expect(longer.projects[0].attribute).toBe("編集・制作");
    expect(longer.issues.some(i=>i.detail.includes("AI名の包含"))).toBe(true);
  });
  it("F3 hosts an isolated small project at its current owner before a larger remote owner",()=>{
    const input=scenario([...repeated("home",4,{workspace:"home"}),...repeated("remote",7,{workspace:"remote"}),{project:"guest",workspace:"home"}]);
    const result=build(input);
    expect(result.groups.find(g=>g.name==="home")?.units.map(u=>u.name)).toContain("guest");
    expect(result.moves.some(m=>m.id==="p12")).toBe(false);
    assertValid(input.scan,result);
  });
  it("F3 chooses the largest eligible remote host and rejects wrong attributes or full hosts",()=>{
    const input=scenario([...repeated("small",4,{workspace:"small"}),...repeated("large",7,{workspace:"large"}),{project:"guest",workspace:"elsewhere"}]);
    const result=build(input);
    expect(result.groups.find(g=>g.name==="large")?.units.map(u=>u.name)).toContain("guest");
    expect(result.moves.find(m=>m.id==="p12")?.to).toBe("large");
    assertValid(input.scan,result);
    const rejected=scenario([...repeated("full",16,{workspace:"full"}),{project:"guest",workspace:"elsewhere"},{project:"editing",workspace:"elsewhere",attribute:"編集・制作"}]);
    const held=build(rejected);
    expect(held.moves).toEqual([]);
    expect(held.groups.every(g=>g.units[0].name!=="guest"&&g.units[0].name!=="editing")).toBe(true);
    assertValid(rejected.scan,held);
  });
  it("F3 keeps a sole leftover project in place and permits a genuine two-project bundle",()=>{
    for(const count of [1,3]){
      const input=scenario(repeated("single",count,{workspace:"自由机"})), result=build(input);
      expect(result.groups).toEqual([]);expect(result.moves).toEqual([]);
      expect(result.issues.some(i=>i.kind==="小さい案件を今の場所に残す")).toBe(true);
      assertValid(input.scan,result);
    }
    const input=scenario([{project:"first",workspace:"one"},{project:"second",workspace:"two"},{project:"third",workspace:"three"}],
      [{projects:["first","second"],reason:"same tools"}]);
    input.ai.projects[2].attribute="編集・制作";
    input.raw=JSON.stringify(input.ai);
    const result=build(input);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].units.map(u=>u.name)).toEqual(["first","second"]);
    expect(result.moves.some(m=>m.id==="p3")).toBe(false);
    assertValid(input.scan,result);
  });
  it("F4 keeps complete shorts, drops the last one to fit, and avoids partial ASCII words",()=>{
    expect(attributeCombinedName(["資料チェック","週次のふり返り","X.7 SSD"])).toBe("資料チェック・週次のふり返り");
    expect(attributeCombinedName(["青ボタンの確認","Claude codex応答計測"])).toBe("青ボタンの確認");
    expect(attributeCombinedName(["ひかりスタ","予算"])).toBe("ひかりスタ・予算");
    expect(attributeCombinedName(["資料まとめと記録 ClaudeLongIdentifier"])).toBe("資料まとめと記録");
    expect(attributeCombinedName(["abcdefghijklmnopqrstuvwxyz"])).toBe("");
    expect(attributeDefaultShort("Claude codex応答計測")).toBe("Claude");
    expect(attributeDefaultShort("LongIdentifier と記録")).toBe("LongIdentifier");
    const input=scenario([{project:"Claude codex応答計測"}]);
    const long=judgeAttributeGrouping(collectAttributeTabs(input.scan,[]),{...input.ai,projects:[{name:"Claude codex応答計測",short:"Claude codex応答計測",attribute:"アプリ・開発"}]});
    expect(long.projects[0].short).toBe("Claude");
    expect(long.issues.some(i=>i.kind==="呼び名が長すぎる")).toBe(true);
    const invalid=judgeAttributeGrouping(collectAttributeTabs(input.scan,[]),{...input.ai,projects:[{name:"Claude codex応答計測",short:"造語",attribute:"アプリ・開発"}]});
    expect(invalid.projects[0].short).toBe("Claude");
  });
  it("F5 includes Romanized folder instructions but does not turn an ambiguous folder into fixed evidence",()=>{
    const registry=[{section:"anken",label:"ひかりスタ/数学",path:"/clients/math"},{section:"anken",label:"ひかりスタ/理科",path:"/clients/science"},
      ...Array.from({length:20},(_,i)=>({section:"dev",label:`無関係${i}`,path:`/other/${i}`}))];
    const input=scenario([{project:"",title:"講師の手配",cwd:"/work/hikarista_math_instructor"}],[],registry);
    const tabs=collectAttributeTabs(input.scan,registry);
    expect(tabs[0].fixedProject).toBe("");
    const prompt=buildAttributeGroupingPrompt(tabs,registry);
    expect(prompt).toContain("名前やそのローマ字・英字");
    expect(prompt).toContain("hikarista_… はひかりスタ");
    expect(prompt).toContain("mycmux-wt-… は mycmux");
    expect(prompt).not.toContain("案件=ひかりスタ (確定)");
    const judged=judgeAttributeGrouping(tabs,{projects:[{name:"無関係",short:"無関係",attribute:"アプリ・開発"}],panes:[{id:"p1",project:"無関係"}]},registry);
    expect(judged.tabs[0].project).toBe("講師の手配");
  });
});


describe("FIX2 anchors, strict receiver votes and rejected-name attributes",()=>{
  it("G1 chooses a related small-project home before an unrelated majority",()=>{
    const input=scenario([{project:"灯台",workspace:"灯台の机"},...repeated("星図",2,{workspace:"共有机"}),...repeated("観測",2,{workspace:"共有机"})],
      [{projects:["星図","観測","灯台"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({keepsWorkspaceId:"灯台の机",renameHint:null});
    expect(result.moves.some(move=>move.id==="p1")).toBe(false);
    expect(result.moves).toHaveLength(4);
    assertValid(input.scan,result);
  });
  it("G1 recognizes a literal short as an anchor",()=>{
    const input=scenario([{project:"灯台の観測記録",workspace:"観測の机"},{project:"星図",workspace:"共有机"}]);
    input.ai.projects[0].short="観測";
    const result=buildAttributeGrouping(input.scan,[],JSON.stringify(input.ai));
    expect(result.groups[0].keepsWorkspaceId).toBe("観測の机");
    expect(result.moves.map(move=>move.id)).toEqual(["p2"]);
    assertValid(input.scan,result);
  });
  it("G1 favors the larger anchor project and holds a competing anchor in place",()=>{
    const input=scenario([...repeated("小舟",2,{workspace:"小舟"}),...repeated("灯台",3,{workspace:"灯台"}),{project:"星図",workspace:"共有机"}],
      [{projects:["小舟","灯台","星図"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].keepsWorkspaceId).toBe("灯台");
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["灯台","星図"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p6"]);
    expect(result.issues.some(issue=>issue.id==="小舟"&&issue.kind==="錨の案件を今の場所に残す")).toBe(true);
    assertValid(input.scan,result);
  });
  it("G1 breaks equal anchor votes by scan order, independently of AI member order",()=>{
    const input=scenario([{project:"小舟",workspace:"小舟"},{project:"灯台",workspace:"灯台"},{project:"星図",workspace:"共有机"}],
      [{projects:["灯台","小舟","星図"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].keepsWorkspaceId).toBe("小舟");
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["小舟","星図"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p3"]);
    assertValid(input.scan,result);
  });
  it("G1 holds an anchor whose workspace is already claimed by another group",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core anchor"}),{project:"anchor",workspace:"core anchor",attribute:"整理・事務"},
      {project:"帳簿",workspace:"共有机",attribute:"整理・事務"}],[{projects:["anchor","帳簿"],reason:"same administration"}]);
    const result=build(input);
    expect(result.groups.map(group=>group.units.map(unit=>unit.name))).toEqual([["core"]]);
    expect(result.moves).toEqual([]);
    expect(result.issues.some(issue=>issue.id==="anchor"&&issue.kind==="錨の案件を今の場所に残す")).toBe(true);
    assertValid(input.scan,result);
  });
  it("G1 rejects a remote host that would evict its guest from a named home",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core"}),{project:"灯台",workspace:"灯台"}],
      [{projects:["core","灯台"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["core"]);
    expect(result.moves).toEqual([]);
    expect(result.issues.some(issue=>issue.kind==="AI の組を採らず")).toBe(true);
    assertValid(input.scan,result);
  });
  it("G1 does not treat unrelated workspace names as anchors",()=>{
    const input=scenario([{project:"灯台",workspace:"作業机"},{project:"星図",workspace:"資料机"}],
      [{projects:["灯台","星図"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({keepsWorkspaceId:null,name:"灯台・星図"});
    expect(result.moves).toHaveLength(2);
    expect(result.issues.some(issue=>issue.kind==="錨の案件を今の場所に残す")).toBe(false);
    assertValid(input.scan,result);
  });
  it.each([2,3])("G2 requires a strict majority for an unrelated receiver (%i of four)",count=>{
    const input=scenario([...repeated("記録",count,{workspace:"共有机"}),...repeated("記録",4-count,{workspace:"資料机"})]);
    const result=build(input);
    expect(result.groups[0].keepsWorkspaceId).toBe(count===3?"共有机":null);
    expect(result.groups[0].renameHint).toBe(count===3?"記録":null);
    assertValid(input.scan,result);
  });
  it("G2 keeps the related half threshold even behind an unrelated tied candidate",()=>{
    const input=scenario([...repeated("記録",2,{workspace:"共有机"}),...repeated("記録",2,{workspace:"記録の机"})]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({keepsWorkspaceId:"記録の机",renameHint:null});
    expect(result.moves.map(move=>move.id)).toEqual(["p1","p2"]);
    assertValid(input.scan,result);
  });
  it("G3 retains the rejected AI category but keeps the title and its own short",()=>{
    const input=scenario([{project:"推測された改善",title:"灯台の起動時間",label:"灯台の起動時間",attribute:"整理・事務"}]);
    input.ai.projects[0].short="改善";
    const result=buildAttributeGrouping(input.scan,[],JSON.stringify(input.ai));
    expect(result.tabs[0]).toMatchObject({project:"灯台の起動時間",source:"rejected"});
    expect(result.projects[0]).toMatchObject({name:"灯台の起動時間",short:"灯台の起動時間",attribute:"整理・事務"});
    expect(result.issues.some(issue=>issue.kind==="名前の材料なし")).toBe(true);
    expect(result.issues.some(issue=>issue.kind==="差し戻しで属性を引き継ぐ")).toBe(true);
    expect(result.projects.some(project=>project.name==="推測された改善"||project.short==="改善")).toBe(false);
    assertValid(input.scan,result);
  });
  it("G3 stays unknown when the rejected project is absent, even if the title has an AI category",()=>{
    const input=scenario([{project:"推測された改善",title:"灯台",label:"灯台"}]);
    const raw=JSON.stringify({...input.ai,projects:[{name:"灯台",short:"灯台",attribute:"アプリ・開発"}]});
    const result=buildAttributeGrouping(input.scan,[],raw);
    expect(result.projects[0]).toMatchObject({name:"灯台",attribute:"不明"});
    expect(result.issues.some(issue=>issue.kind==="差し戻しで属性を引き継ぐ")).toBe(false);
    expect(result.moves).toEqual([]);
    assertValid(input.scan,result);
  });
  it("G3 does not inherit an invalid category or resurrect an absent title",()=>{
    const input=scenario([{project:"推測された改善",title:"灯台",label:"灯台"}]);
    const invalid={...input.ai,projects:[{name:"推測された改善",short:"改善",attribute:"invalid"}]};
    const result=buildAttributeGrouping(input.scan,[],JSON.stringify(invalid));
    expect(result.projects[0].attribute).toBe("不明");
    expect(result.moves).toEqual([]);
    assertValid(input.scan,result);
    const nameless=scenario([{project:"推測された改善",title:"",label:""}]);
    const held=build(nameless);
    expect(held.tabs[0].project).toBe("");
    expect(held.projects).toEqual([]);
    expect(held.moves).toEqual([]);
    assertValid(nameless.scan,held);
  });
});


describe("FIX3 host anchors and incoming-only guest slots",()=>{
  it("H1 matches reproduction B when AI tries to pull a scattered six-tab host into a small anchor",()=>{
    const rows=[...repeated("北斗学院",2,{workspace:"机",attribute:"編集・制作"}),
      ...repeated("北斗学院",2,{workspace:"棚",attribute:"編集・制作"}),
      ...repeated("北斗学院",2,{workspace:"箱",attribute:"編集・制作"}),
      {project:"サンプル企画",workspace:"サンプル企画",attribute:"編集・制作" as const}];
    const a=scenario(rows,[{projects:["北斗学院","サンプル企画"],reason:"同じ制作"}]),b=scenario(rows);
    const actual=build(a),control=build(b);
    expect(actual.groups).toEqual(control.groups);
    expect(actual.moves).toEqual(control.moves);
    expect(actual.plan).toEqual(control.plan);
    expect(actual.groups).toHaveLength(1);
    expect(actual.groups[0]).toMatchObject({name:"北斗学院",kind:"単独",keepsWorkspaceId:null});
    expect(actual.moves).toHaveLength(6);
    expect(actual.moves.every(move=>move.to==="(新) 北斗学院")).toBe(true);
    expect(actual.moves.some(move=>move.id==="p7")).toBe(false);
    expect(actual.issues.filter(issue=>issue.kind==="AI の組を採らず")).toHaveLength(1);
    assertValid(a.scan,actual);assertValid(b.scan,control);
  });
  it("H1 admits a small anchor only into its already selected matching host workspace",()=>{
    const input=scenario([...repeated("北斗学院",2,{workspace:"北斗学院 サンプル企画"}),
      ...repeated("北斗学院",2,{workspace:"机"}),{project:"サンプル企画",workspace:"北斗学院 サンプル企画"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({keepsWorkspaceId:"北斗学院 サンプル企画",kind:"同居"});
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["北斗学院","サンプル企画"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p3","p4"]);
    assertValid(input.scan,result);
  });
  it("H1 retains AI hosting without a receiver when the small project has no anchor",()=>{
    const input=scenario([...repeated("北斗学院",2,{workspace:"机"}),...repeated("北斗学院",2,{workspace:"棚"}),
      ...repeated("北斗学院",2,{workspace:"箱"}),{project:"サンプル企画",workspace:"机"}],
      [{projects:["北斗学院","サンプル企画"],reason:"same production"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({kind:"同居",keepsWorkspaceId:null});
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["北斗学院","サンプル企画"]);
    expect(result.moves).toHaveLength(7);
    expect(result.issues.some(issue=>issue.kind==="AI の組を採らず")).toBe(false);
    assertValid(input.scan,result);
  });
  it("H2 admits an incoming project beside two resident guest projects",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core"}),{project:"resident-a",workspace:"core"},
      {project:"resident-b",workspace:"core"},{project:"incoming",workspace:"共有机"}]);
    const result=build(input);
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["core","resident-a","resident-b","incoming"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p7"]);
    assertValid(input.scan,result);
  });
  it("H2 rejects a third incoming project even with free resident guests, and the independent checker rejects a forced third",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core"}),{project:"resident-a",workspace:"core"},
      {project:"resident-b",workspace:"core"},{project:"first",workspace:"共有机"},{project:"second",workspace:"共有机"},
      {project:"third",workspace:"別机"}],[{projects:["core","first","second"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["core","resident-a","resident-b","first","second"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p7","p8"]);
    assertValid(input.scan,result);
    const broken=structuredClone(result),extra=broken.projects.find(project=>project.name==="third")!;
    broken.groups[0].units.push({...extra,movable:[...extra.tabIds]});
    broken.groups[0].tabIds.push(...extra.tabIds);
    expect(checkAttributeGrouping(input.scan,broken).limits).toEqual(["core"]);
  });
  it("H2 counts a partly incoming project as one guest even when most of its tabs already live at the receiver",()=>{
    const input=scenario([...repeated("core",4,{workspace:"core"}),...repeated("split",2,{workspace:"core"}),
      {project:"split",workspace:"共有机"},{project:"second",workspace:"共有机"},{project:"third",workspace:"別机"}],
      [{projects:["core","second","third"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["core","split","second"]);
    expect(result.moves.map(move=>move.id)).toEqual(["p7","p8"]);
    expect(result.issues.some(issue=>issue.kind==="AI の組を採らず")).toBe(true);
    assertValid(input.scan,result);
  });
  it("H2 counts all guest projects while the host receiver remains undecided",()=>{
    const input=scenario([...repeated("北斗学院",2,{workspace:"机"}),...repeated("北斗学院",2,{workspace:"棚"}),
      ...repeated("北斗学院",2,{workspace:"箱"}),{project:"小舟",workspace:"机"},{project:"星図",workspace:"机"},
      {project:"観測",workspace:"共有机"}],[{projects:["北斗学院","小舟","星図"],reason:"same tools"},
      {projects:["北斗学院","観測"],reason:"third guest"}]);
    const result=build(input);
    expect(result.groups[0]).toMatchObject({kind:"同居",keepsWorkspaceId:null});
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["北斗学院","小舟","星図"]);
    expect(result.moves).toHaveLength(8);
    expect(result.moves.some(move=>move.id==="p9")).toBe(false);
    expect(result.issues.some(issue=>issue.kind==="AI の組を採らず")).toBe(true);
    assertValid(input.scan,result);
  });
  it("H2 recounts resident guests after a late receiver selection before admitting a leftover project",()=>{
    const input=scenario([...repeated("北斗学院",3,{workspace:"机"}),...repeated("北斗学院",2,{workspace:"棚"}),
      ...repeated("北斗学院",2,{workspace:"箱"}),{project:"小舟",workspace:"机"},{project:"星図",workspace:"机"},
      {project:"観測",workspace:"棚"}],[{projects:["北斗学院","小舟","星図"],reason:"same tools"}]);
    const result=build(input);
    expect(result.groups[0].keepsWorkspaceId).toBe("机");
    expect(result.groups[0].units.map(unit=>unit.name)).toEqual(["北斗学院","小舟","星図","観測"]);
    expect(result.moves.map(move=>move.id)).toContain("p10");
    assertValid(input.scan,result);
  });
  it.each([13,14])("H2 preserves the sixteen-tab cap and four-by-four layout beside resident guests (host %i)",count=>{
    const input=scenario([...repeated("core",count,{workspace:"core"}),{project:"resident-a",workspace:"core"},
      {project:"resident-b",workspace:"core"},{project:"incoming",workspace:"共有机"}]);
    const result=build(input);
    expect(result.groups[0].units.some(unit=>unit.name==="incoming")).toBe(count===13);
    expect(result.moves).toHaveLength(count===13?1:0);
    assertValid(input.scan,result);
  });
});

describe("recorded fictional replays",()=>{
  it.each(["today","d1006"])("replays every %s tab with product identities and records every prototype difference",label=>{
    const fixture=JSON.parse(readFileSync(new URL(`../fixtures/attribute-grouping/${label}.json`,import.meta.url),"utf8"));
    const result=buildAttributeGrouping(fixture.scan,fixture.registry,fixture.raw);
    assertValid(fixture.scan,result);
    expect(result.tabs).toHaveLength(label==="today"?35:31);
    expect(result.tabs.filter(t=>t.fixedProject)).toHaveLength(label==="today"?20:14);
    expect(result.groups).toHaveLength(4);
    expect(result.moves).toHaveLength(label==="today"?5:6);
    expect(fixture.prototype.moves).toBe(label==="today"?7:4);
    const expected=fixture.expected.groups as Array<{kind:string;projects:string[];existing:boolean}>;
    // Fictional labels can change lexical guest order without changing a bundle.
    expect(result.groups.map(g=>({kind:g.kind,projects:g.units.map(u=>u.name).sort(),existing:Boolean(g.keepsWorkspaceId)})))
      .toEqual(expected.map(group=>({...group,projects:[...group.projects].sort()})));
    expect(result.moves.map(m=>m.id)).toEqual(fixture.expected.moves);
  });
});
