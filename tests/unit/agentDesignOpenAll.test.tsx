// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetail } from "../../src/components/agentDesign/ui";
import { DocumentView } from "../../src/components/agentDesign/DocumentView";
import { SourceText } from "../../src/components/agentDesign/SecretValues";
import { createReadOnlySkillsApi } from "../../src/components/agentDesign/readOnlySkillsApi";
import { agentDesignApi, type AgentDesignApi, type DesignDocument } from "../../src/lib/agentDesignApi";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
vi.mock("@tauri-apps/plugin-shell",()=>({open:vi.fn()}));
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
const bullets="\u2022\u2022\u2022\u2022";
const body='token = "'+bullets+'"\npassword = "'+bullets+'"\n';
const doc:DesignDocument={id:"setting",body,fields:[],size:{chars:body.length,bytes:64,lines:2},status:"present",revision:"revision-one",relative:"0/settings.json",
  masks:[{index:0,start:9,end:13,line:1,label:"value"},{index:1,start:27,end:31,line:2,label:"value"}]};
beforeEach(()=>{mocks.invoke.mockReset();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();vi.useRealTimers();});
const render=async(value:ReactNode)=>{await act(async()=>root.render(value));};
const press=async(selector:string)=>{await act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());};
describe("full agent-design contents with transient values",()=>{
  it("masks both values by default and requests only the clicked value",async()=>{
    const reveal=vi.fn(async()=> "CANARY_SECRET_7F3A");
    await render(<DocumentView document={doc} reveal={reveal}/>);
    expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
    expect(host.querySelectorAll(".ad-secret-text")).toHaveLength(2);
    expect([...host.querySelectorAll(".ad-secret-text")].every(el=>el.textContent===bullets)).toBe(true);
    await press('[data-secret-index="1"] button');
    expect(reveal).toHaveBeenCalledExactlyOnceWith(1);
    expect(host.querySelector('[data-secret-index="0"] .ad-secret-text')?.textContent).toBe(bullets);
    expect(host.querySelector('[data-secret-index="1"] .ad-secret-text')?.textContent).toBe("CANARY_SECRET_7F3A");
    await press('[data-secret-index="1"] button');expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
  });
  it("forgets a revealed value on close and reopening",async()=>{
    const reveal=vi.fn(async()=> "CANARY_SECRET_7F3A");
    await render(<DocumentView document={doc} reveal={reveal}/>);await press('[data-secret-index="0"] button');
    expect(host.textContent).toContain("CANARY_SECRET_7F3A");
    await render(null);await render(<DocumentView document={doc} reveal={reveal}/>);
    expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");expect(reveal).toHaveBeenCalledTimes(1);
  });
  it("discards a pending reveal after the item is closed",async()=>{
    let resolve!:(value:string)=>void;const reveal=vi.fn(()=>new Promise<string>(done=>{resolve=done;}));
    await render(<DocumentView document={doc} reveal={reveal}/>);await press('[data-secret-index="0"] button');await render(null);
    await act(async()=>resolve("CANARY_SECRET_7F3A"));expect(document.body.textContent).not.toContain("CANARY_SECRET_7F3A");
  });
  it("renders returned values as text and keeps backend errors private",async()=>{
    await render(<DocumentView document={doc} reveal={async()=>'<img src=x onerror="CANARY_SECRET_7F3A">'}/>);
    await press('[data-secret-index="0"] button');expect(host.querySelector("img")).toBeNull();
    await render(null);await render(<DocumentView document={doc} reveal={async()=>{throw new Error("CANARY_SECRET_7F3A");}}/>);
    await press('[data-secret-index="0"] button');expect(host.textContent).toContain(s.secretError);expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
  });
  it("shows script lines exactly and numbers every line",async()=>{
    const raw="# example\r\nprint('<script>')\r\n";
    await render(<SourceText body={raw}/>);
    expect([...host.querySelectorAll(".ad-source-line code")].map(el=>el.textContent).join("")).toBe(raw);
    expect([...host.querySelectorAll(".ad-line-number")].map(el=>el.textContent)).toEqual(["1","2"]);
    expect(host.querySelector("script")).toBeNull();
  });
  it("opens formerly disallowed items and navigates the full file list",async()=>{
    const item=catalog.items.find(i=>!i.documentAllowed)!;
    const document=vi.fn(async()=>({...doc,id:item.id,folder:"0/",files:[{id:"0/run.py",name:"run.py",directory:false,bytes:20,private:false,reason:null}],fileCount:1}));
    const api={...agentDesignApi,document,reveal:vi.fn(async()=> "CANARY_SECRET_7F3A")} satisfies AgentDesignApi;
    await render(<ItemDetail item={item} catalog={catalog} api={api} onBack={vi.fn()} onSkill={vi.fn()}/>);
    expect(document).toHaveBeenCalledWith(item.id,catalog.cwd);
    expect(host.textContent).not.toContain("\u672c\u6587\u306f\u51fa\u3057\u307e\u305b\u3093");
    await press('[data-ad-file="0/run.py"]');expect(document).toHaveBeenLastCalledWith(item.id,catalog.cwd,"0/run.py",undefined);
    await press('[data-secret-index="0"] button');
    expect(api.reveal).toHaveBeenCalledWith(item.id,catalog.cwd,"0/settings.json",0,"revision-one");
  });
  it("paginates the current directory and shows genuine unavailable reasons",async()=>{
    const file=vi.fn();
    await render(<DocumentView document={{...doc,body:null,files:[],folder:"0/nested",parent:"0/",nextOffset:500,reason:"unsupportedEncoding"}} onFile={file}/>);
    const next=[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===s.moreFiles)!;
    await act(async()=>next.click());expect(file).toHaveBeenCalledWith("0/nested",500);expect(host.textContent).toContain(s.documentReasons.unsupportedEncoding);
  });
  it("uses desktop-only invoke for open and reveal without keeping values in the catalogue",async()=>{
    mocks.invoke.mockResolvedValue(doc);
    await agentDesignApi.document("item",null,"0/.env",500);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_document",{id:"item",cwd:null,relative:"0/.env",offset:500});
    mocks.invoke.mockResolvedValue("CANARY_SECRET_7F3A");
    await agentDesignApi.reveal!("item",null,"0/.env",0,"revision-one");
    expect(mocks.invoke).toHaveBeenLastCalledWith("agent_design_reveal",{id:"item",cwd:null,relative:"0/.env",mask:0,revision:"revision-one"});
    const shelf=createReadOnlySkillsApi(()=>"/synthetic");
    await shelf.openDocument("reviewer","0/run.py");await shelf.revealValue("reviewer","0/.env",1,"r");
    expect(mocks.invoke).toHaveBeenLastCalledWith("agent_design_reveal",{id:"reviewer",cwd:"/synthetic",relative:"0/.env",mask:1,revision:"r"});
    expect(JSON.stringify(agentDesignApi.peek("/synthetic"))).not.toContain("CANARY_SECRET_7F3A");
  });
});

it("remasks one value after 15 seconds and blocks copying a selection that includes it", async () => {
  vi.useFakeTimers();
  await render(<DocumentView document={doc} reveal={async () => "CANARY_SECRET_7F3A"} />); await press('[data-secret-index="0"] button');
  const range = document.createRange(); range.selectNodeContents(host); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const copy = new Event("copy", { bubbles: true, cancelable: true }); document.dispatchEvent(copy); expect(copy.defaultPrevented).toBe(true);
  await act(async () => vi.advanceTimersByTime(14999)); expect(host.textContent).toContain("CANARY_SECRET_7F3A");
  await act(async () => vi.advanceTimersByTime(1)); expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
});
it("remasks on loss of focus and discards an outstanding reveal", async () => {
  let resolve!: (value: string) => void;
  await render(<DocumentView document={doc} reveal={() => new Promise(done => { resolve = done; })} />); await press('[data-secret-index="0"] button');
  await act(async () => window.dispatchEvent(new Event("blur"))); await act(async () => resolve("CANARY_SECRET_7F3A"));
  expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
  await render(null); await render(<DocumentView document={doc} reveal={async () => "CANARY_SECRET_7F3A"} />); await press('[data-secret-index="0"] button');
  expect(host.textContent).toContain("CANARY_SECRET_7F3A"); await act(async () => window.dispatchEvent(new Event("blur"))); expect(host.textContent).not.toContain("CANARY_SECRET_7F3A");
});
