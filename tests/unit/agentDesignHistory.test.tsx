// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { AgentDesignApi, DesignHistory, DesignHistoryChange, DesignHistoryDiff } from "../../src/lib/agentDesignApi";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",async(importOriginal)=>({...await importOriginal<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn()}));
vi.mock("../../src/components/skills/skillLaunch",()=>({startSkill:vi.fn()}));
import { agentDesignApi } from "../../src/lib/agentDesignApi";
import { AgentDesignView } from "../../src/components/agentDesign/AgentDesignView";
import { HistoryView, historyStrings as h } from "../../src/components/agentDesign/HistoryView";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const change=(id:string,layer=3):DesignHistoryChange=>({id,itemId:layer===0?null:"instructions",service:"claude",layer,displayName:layer===0?"readAmount":"CLAUDE.md",path:layer===0?null:catalog.items[0].path,
  kind:"changed",badge:layer===0?"readAmountChanged":"fileChanged",source:"snapshot",at:"2026-10-06T03:04:05Z",beforeBytes:20,afterBytes:40,amountChanges:layer===0?[{key:"instructions",before:20,after:40}]:[],hash:null,subject:null,author:null,linesAdded:null,linesDeleted:null});
const history:DesignHistory={schemaVersion:1,snapshotCount:2,capturedAt:"2026-10-06T03:04:05Z",writing:false,warnings:[],changes:[change("rule"),change("memory",4),change("amount",0)]};
const gitChange:DesignHistoryChange={...change("git-rule"),source:"git",hash:"a".repeat(40),subject:"Update fixture rule",author:null,linesAdded:1,linesDeleted:1,at:"2026-10-05T03:04:05Z"};
const diff:DesignHistoryDiff={mode:"text",status:"ready",beforeBytes:20,afterBytes:40,truncated:false,lines:[{kind:"deleted",oldLine:2,newLine:null,text:"Previous rule"},{kind:"added",oldLine:null,newLine:2,text:"Current rule"}]};
let root:Root,host:HTMLDivElement,api:AgentDesignApi;
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
const click=async(element:HTMLElement)=>{await act(async()=>element.click());};
const select=async(id="instructions")=>{await click(button("ファイルの変更履歴"));await click(document.querySelector<HTMLElement>('[data-ad-history-item="'+id+'"]')!);};
const filter=async(value:string)=>{const input=document.querySelector<HTMLSelectElement>('[aria-label="履歴の層"]')!;await act(async()=>{input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));});};
const snapshot=async()=>{await click(button("過去の写しを比べる"));};
const git=async()=>{await click(button("ファイルの変更履歴"));};
const render=async()=>{await act(async()=>root.render(<HistoryView catalog={catalog} serviceId="claude" api={api} query=""/>));};
beforeEach(()=>{
  mocks.invoke.mockReset();
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  api={peek:()=>catalog,cached:vi.fn(async()=>catalog),refresh:vi.fn(async()=>catalog),document:vi.fn(),close:vi.fn(),scene:vi.fn(),setHermesHome:vi.fn(),
    history:vi.fn(async()=>history),historyGit:vi.fn(async()=>({status:"ready",changes:[gitChange]})),historyDiff:vi.fn(async()=>diff)};
});
afterEach(()=>{act(()=>root.unmount());document.body.replaceChildren();vi.useRealTimers();});
describe("agent design history",()=>{
  it("keeps the history surface and key 5 beside the mechanism, rail and four established surfaces",async()=>{
    await act(async()=>root.render(<AgentDesignView api={api} initialCatalog={catalog} onClose={vi.fn()}/>));
    expect(document.querySelectorAll(".ad-tabs button")).toHaveLength(8);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>(".ad-tabs button")).every(tab => !tab.disabled)).toBe(true);
    await act(async()=>document.querySelector(".ad-view")!.dispatchEvent(new KeyboardEvent("keydown",{key:"5",bubbles:true})));
    expect(document.querySelector('[data-ad-view="history"]')).toBeTruthy();expect(document.querySelectorAll(".ad-service")).toHaveLength(3);
    expect(api.historyGit).not.toHaveBeenCalled();
    for(const [index,id] of ["overview","reading","compare","inspection"].entries()){
      await click(document.querySelectorAll<HTMLButtonElement>(".ad-tabs button")[index+1]);expect(document.querySelector('[data-ad-view="'+id+'"]')).toBeTruthy();
    }
  });
  it("does not switch surfaces on an editing key 5",async()=>{
    await act(async()=>root.render(<AgentDesignView api={api} initialCatalog={catalog} onClose={vi.fn()}/>));
    await act(async()=>document.querySelector<HTMLInputElement>('.ad-search input')!.dispatchEvent(new KeyboardEvent("keydown",{key:"5",bubbles:true})));
    expect(document.querySelector('[data-ad-view="mechanism"]')).toBeTruthy();
  });
  it("groups the timeline by day and separates file and reading amount badges",async()=>{
    await render();expect(document.querySelectorAll("[data-ad-change]")).toHaveLength(3);
    expect(document.querySelector(".ad-history-days h3")?.textContent).toBe(new Date(history.changes[0].at).toLocaleDateString("ja-JP"));
    expect(document.querySelectorAll(".ad-history-badge-fileChanged")).toHaveLength(2);expect(document.querySelectorAll(".ad-history-badge-readAmountChanged")).toHaveLength(1);
    expect(document.body.textContent).toContain("+0.02 KB");expect(api.historyGit).not.toHaveBeenCalled();
  });
  it("filters by layer, by reading amount, and by search without Git reads",async()=>{
    await render();await filter("4");expect(document.querySelectorAll("[data-ad-change]")).toHaveLength(1);
    await filter("-1");expect(document.querySelector('[data-ad-change="amount"]')).toBeTruthy();
    await filter("all");
    await act(async()=>root.render(<HistoryView catalog={catalog} serviceId="claude" api={api} query="does-not-match"/>));
    expect(document.querySelectorAll("[data-ad-change]")).toHaveLength(0);expect(document.body.textContent).toContain(h.noMatch);expect(api.historyGit).not.toHaveBeenCalled();
  });
  it("loads Git only for a chosen item and diff only for a chosen commit",async()=>{
    await render();await select();expect(api.historyGit).toHaveBeenCalledWith("instructions",catalog.cwd);expect(api.historyDiff).not.toHaveBeenCalled();
    await click(document.querySelector('[data-ad-change="git-rule"]')!);expect(api.historyDiff).toHaveBeenCalledWith("instructions",gitChange.hash,catalog.cwd);
    expect(document.querySelector(".ad-history-line.deleted")?.textContent).toContain("2");expect(document.querySelector(".ad-history-line.added code")?.textContent).toBe("Current rule");
    expect(document.querySelector(".ad-detail")?.textContent).toContain(s.unknown);
  });
  it("shows settings as safe fields and explains hidden secrets",async()=>{
    api.historyDiff=vi.fn(async()=>({...diff,mode:"fields",lines:[{kind:"added",oldLine:null,newLine:1,text:"model: fixture-large"}]}));
    await render();await select();await click(document.querySelector('[data-ad-change="git-rule"]')!);
    expect(document.querySelector(".ad-detail")?.textContent).toContain(h.fieldBody);expect(document.querySelector(".ad-history-diff")?.textContent).toContain("model: fixture-large");
  });
  it("shows no memory body and only metadata for a snapshot",async()=>{
    await render();await click(document.querySelector('[data-ad-change="memory"]')!);
    expect(document.querySelector(".ad-detail")?.textContent).toContain(h.memoryBody);expect(api.historyDiff).not.toHaveBeenCalled();
    await click(document.querySelector('[data-ad-change="rule"]')!);expect(document.querySelector(".ad-detail")?.textContent).toContain(h.snapshotBody);
  });
  it("renders before and after reading counts in a separate detail",async()=>{
    await render();await click(document.querySelector('[data-ad-change="amount"]')!);
    expect(document.querySelector(".ad-detail .ad-fields")?.textContent).toContain("20");expect(document.querySelector(".ad-detail .ad-fields")?.textContent).toContain("40");expect(api.historyGit).not.toHaveBeenCalled();
  });
  it("handles the one-snapshot and missing Git empty state",async()=>{
    api.history=vi.fn(async()=>({...history,snapshotCount:1,changes:[]}));api.historyGit=vi.fn(async()=>({status:"gitUnavailable",changes:[]}));
    await render();expect(document.body.textContent).toContain(h.one);await select();expect(document.body.textContent).toContain("変更履歴を読む道具が見つかりません");
  });
  it("handles no snapshots, unreadable history and request errors",async()=>{
    api.history=vi.fn(async()=>({...history,snapshotCount:0,warnings:["historyUnsupported"],changes:[]}));
    await render();expect(document.body.textContent).toContain(h.empty);expect(document.body.textContent).toContain(h.warning);
    api.history=vi.fn(async()=>{throw new Error("unavailable");});await act(async()=>root.render(<HistoryView catalog={{...catalog,generatedAt:"new"}} serviceId="claude" api={api} query=""/>));
    expect(document.body.textContent).toContain(h.error);
  });
  it("keeps old snapshots until a background write finishes",async()=>{
    vi.useFakeTimers();api.history=vi.fn().mockResolvedValueOnce({...history,writing:true}).mockResolvedValue(history);
    await render();expect(document.body.textContent).toContain(h.writing);expect(document.querySelectorAll("[data-ad-change]")).toHaveLength(3);
    await act(async()=>vi.advanceTimersByTimeAsync(200));expect(api.history).toHaveBeenCalledTimes(2);expect(document.body.textContent).not.toContain(h.writing);
  });
  it("drops an obsolete Git response after changing service",async()=>{
    let finish:(value:{status:string;changes:DesignHistoryChange[]})=>void=()=>{};
    api.historyGit=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));await render();await select();
    await act(async()=>root.render(<HistoryView catalog={catalog} serviceId="codex" api={api} query=""/>));
    await act(async()=>finish({status:"ready",changes:[gitChange]}));expect(document.querySelector('[data-ad-change="git-rule"]')).toBeNull();
  });
  it("shows hidden, failed and truncated diff states",async()=>{
    api.historyDiff=vi.fn(async()=>({...diff,mode:"hidden",lines:[]}));await render();await select();await click(document.querySelector('[data-ad-change="git-rule"]')!);expect(document.querySelector(".ad-detail")?.textContent).toContain(h.noBody);
    await snapshot();await click(document.querySelector('[data-ad-change="rule"]')!);api.historyDiff=vi.fn(async()=>({...diff,truncated:true}));await git();await click(document.querySelector('[data-ad-change="git-rule"]')!);expect(document.body.textContent).toContain(h.truncated);
    await snapshot();await click(document.querySelector('[data-ad-change="rule"]')!);api.historyDiff=vi.fn(async()=>{throw new Error("failed");});await git();await click(document.querySelector('[data-ad-change="git-rule"]')!);expect(document.body.textContent).toContain(h.diffError);
  });
  it("registers the three read-only history API commands",async()=>{
    mocks.invoke.mockResolvedValue(history);
    await agentDesignApi.history!(catalog.cwd);await agentDesignApi.historyGit!("instructions",catalog.cwd);await agentDesignApi.historyDiff!("instructions",gitChange.hash!,catalog.cwd);
    expect(mocks.invoke.mock.calls.map(c=>c[0])).toEqual(["agent_design_history","agent_design_history_git","agent_design_history_diff"]);
    expect(mocks.invoke.mock.calls[2][1]).toEqual({cwd:catalog.cwd,id:"instructions",hash:gitChange.hash});
  });
});
