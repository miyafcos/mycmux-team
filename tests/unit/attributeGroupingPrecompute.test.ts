// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness=vi.hoisted(()=>({
  raw:JSON.stringify({projects:[{name:"mycmux",short:"mycmux",attribute:"アプリ・開発"},{name:"記録",short:"記録",attribute:"整理・事務"}],
    panes:[{id:"p1",project:"mycmux"},{id:"p2",project:"記録"}],bundles:[]}),
  fail:null as unknown, hang:false,
  invoke:vi.fn(async(command:string,args?:Record<string,unknown>):Promise<unknown>=>{
    if(command==="agent_session_titles") return [];
    if(command==="run_tab_sweep_judge") {
      if(harness.hang) return new Promise(()=>{});
      if(harness.fail) throw harness.fail;
      return harness.raw;
    }
    if(command==="run_jev_grouping_judge") {
      const requests=JSON.parse(args!.prompt as string).requests;
      return JSON.stringify({answers:Object.fromEntries(requests.flatMap((request:{questions:Record<string,{criteria:Record<string,string>}>})=>
        Object.entries(request.questions).map(([id,q])=>[id,{type:"choice",choice:"unspecified",confidence:1,
          probabilities:Object.fromEntries(Object.keys(q.criteria).map(role=>[role,Number(role==="unspecified")]))}])) )});
    }
    return true;
  }),
}));
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:harness.invoke}));
vi.mock("../../src/lib/ipc",async original=>({...await original<typeof import("../../src/lib/ipc")>(),
  getPtyMetadataSnapshot:vi.fn(async()=>({"session-a":{process_status:"codex"},"session-b":{process_status:"codex"}})),
  getSessionOutputSnapshot:vi.fn(async()=>({})),
}));
import {
  __resetGroupingPrecomputeForTests, generateForegroundGroupingAnalysis, peekGroupingPrecompute,
  markGroupingInterest, GROUPING_STRUCTURE_DEBOUNCE_MS, GROUPING_BACKGROUND_DAILY_LIMIT, cancelForegroundGroupingAnalysis,
  requestGroupingPrecomputeRefresh, rememberGroupingAnalysis,
} from "../../src/lib/groupingPrecompute";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { rememberGroupingPreset, readGroupingPreset, } from "../../src/components/layout/tabGrouping";
import { withRequestedGroupingPlan } from "../../src/components/layout/groupingLocalPlan";

const originalRaw=harness.raw;
const originalInvoke=harness.invoke.getMockImplementation()!;
beforeEach(()=>{
  localStorage.clear(); harness.invoke.mockClear(); harness.invoke.mockImplementation(originalInvoke); harness.raw=originalRaw; harness.fail=null; harness.hang=false;
  __resetGroupingPrecomputeForTests();
  useAiSettingsStore.setState({aiEnabled:true,aiProvider:"codex",aiModel:"gpt-6-luna"});
  useJevSettingsStore.setState({enabled:true,loaded:true});
  useLauncherDirsStore.setState({view:{doc:{entries:[{section:"dev",label:"mycmux",path:"/work/core"}]}} as never});
  useWorkspaceListStore.setState({workspaces:[{id:"source",name:"机",gridTemplateId:"1x1",status:"running",createdAt:0,splitColumns:[["place-a"],["place-b"]],
    panes:["a","b"].map(id=>({id:"place-"+id,agentId:"codex",sessionId:"session-"+id,activeTabId:id,
      tabs:[{id,sessionId:"session-"+id,agentId:"codex",label:id==="a"?"mycmux":"記録",displayName:id==="a"?"mycmux":"記録",
        cwd:id==="a"?"/work/core":"/home/example",type:"terminal",origin:{kind:"human"}}]}))}],
    layoutRevision:useWorkspaceListStore.getState().layoutRevision+1});
  usePaneMetadataStore.setState({metadata:{},volatileMetadata:{}});
  useSessionAttentionStore.getState().resetForTests(); useAskQuestionStore.getState().resetForTests();
});
afterEach(()=>{
  cancelForegroundGroupingAnalysis(); __resetGroupingPrecomputeForTests(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();localStorage.clear();
});
function attributePlan(result:Awaited<ReturnType<typeof generateForegroundGroupingAnalysis>>) {
  expect(result.kind).toBe("ready");
  if(result.kind!=="ready" || result.analysis.parsed.status!=="ok") throw new Error("not ready");
  expect(result.analysis.parsed.plans.map(p=>p.strategy)).toEqual(["attribute","role","minimal_move"]);
  return {plan:result.analysis.parsed.plans[0],analysis:result.analysis};
}
const attributeCalls=()=>harness.invoke.mock.calls.filter(([command])=>command==="run_tab_sweep_judge");


describe("FIX1 bounded background waits and retryable fallbacks",()=>{
  it("F2 lets a background attribute reply arrive after 51 seconds and reuses a successful cache",async()=>{
    vi.useFakeTimers();rememberGroupingPreset("attribute");useJevSettingsStore.setState({enabled:false});
    let resolve!:(value:string)=>void;
    const original=harness.invoke.getMockImplementation()!;
    harness.invoke.mockImplementation((command,args)=>command==="run_tab_sweep_judge"?new Promise<string>(done=>{resolve=done;}):original(command,args));
    markGroupingInterest();await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    await vi.waitFor(()=>expect(attributeCalls()).toHaveLength(1),{timeout:10_000});
    await vi.advanceTimersByTimeAsync(51_000);
    expect(harness.invoke.mock.calls.some(([command])=>command==="abort_tab_sweep_judge")).toBe(false);
    expect(peekGroupingPrecompute().kind).toBe("pending");
    resolve(harness.raw);
    await vi.waitFor(()=>expect(peekGroupingPrecompute().kind).toBe("fresh"),{timeout:10_000});
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")!).count).toBe(1);
  });
  it("F2 aborts background work at 120 seconds, leaves no final fallback cache, and retries on refresh",async()=>{
    vi.useFakeTimers();rememberGroupingPreset("attribute");useJevSettingsStore.setState({enabled:false});harness.hang=true;
    markGroupingInterest();await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    await vi.waitFor(()=>expect(attributeCalls()).toHaveLength(1),{timeout:10_000});
    await vi.advanceTimersByTimeAsync(90_000);
    expect(peekGroupingPrecompute().kind).toBe("pending");
    expect(harness.invoke.mock.calls.some(([command])=>command==="abort_tab_sweep_judge")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.waitFor(()=>expect(peekGroupingPrecompute().kind).toBe("miss"),{timeout:10_000});
    expect(harness.invoke.mock.calls.some(([command])=>command==="abort_tab_sweep_judge")).toBe(true);
    expect(JSON.parse(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")!).count).toBe(1);
    harness.hang=false;requestGroupingPrecomputeRefresh();
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    await vi.waitFor(()=>expect(peekGroupingPrecompute().kind).toBe("fresh"),{timeout:10_000});
    expect(attributeCalls()).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")!).count).toBe(2);
  });
  it.each(["invalid","error"] as const)("F2 retries a foreground %s fallback on the next opening",async failure=>{
    rememberGroupingPreset("attribute");useJevSettingsStore.setState({enabled:false});
    if(failure==="invalid")harness.raw="bad JSON";else harness.fail={code:"cli_failed"};
    const fallback=await generateForegroundGroupingAnalysis(false,undefined,"attribute");
    const {analysis}=attributePlan(fallback);
    expect(analysis.attributeRetryable).toBe(true);
    expect(peekGroupingPrecompute().kind).toBe("miss");
    rememberGroupingAnalysis(analysis);
    expect(peekGroupingPrecompute().kind).toBe("miss");
    harness.raw=originalRaw;harness.fail=null;
    const {analysis:retried}=attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(retried.attributeRetryable).toBeUndefined();
    expect(attributeCalls()).toHaveLength(2);
    expect(peekGroupingPrecompute().kind).toBe("fresh");
    expect(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")).toBeNull();
  });
  it("F2 counts each background CLI and optional Jev request in the existing shared budget",async()=>{
    vi.useFakeTimers();rememberGroupingPreset("attribute");
    markGroupingInterest();await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    await vi.waitFor(()=>expect(peekGroupingPrecompute().kind).toBe("fresh"),{timeout:10_000});
    const judges=harness.invoke.mock.calls.filter(([command])=>command==="run_tab_sweep_judge"||command==="run_jev_grouping_judge");
    expect(attributeCalls()).toHaveLength(1);
    expect(judges.length).toBeGreaterThan(1);
    expect(JSON.parse(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")!).count).toBe(judges.length);
  });
  it("F2 keeps the AI-off local fallback stable without invoking or consuming the budget",async()=>{
    rememberGroupingPreset("attribute");useAiSettingsStore.setState({aiEnabled:false});
    const {analysis}=attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(analysis.attributeRetryable).toBeUndefined();
    expect(peekGroupingPrecompute().kind).toBe("fresh");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(0);
    expect(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")).toBeNull();
  });
});

describe("attribute preset production and storage",()=>{
  it.each(["recommended","active_watch","main_sessions","attribute"] as const)("calls the CLI only for %s when attribute is requested",async preset=>{
    rememberGroupingPreset(preset);
    expect(readGroupingPreset()).toBe(preset);
    const produced=await generateForegroundGroupingAnalysis(true,undefined,preset==="recommended"?undefined:preset);
    expect(produced.kind).toBe("ready");
    expect(attributeCalls()).toHaveLength(preset==="attribute"?1:0);
    expect(harness.invoke.mock.calls.some(([command])=>command==="run_jev_grouping_judge")).toBe(true);
    if(preset==="attribute") {
      attributePlan(produced);
      expect(attributeCalls()[0][1]).toMatchObject({mode:"grouping",requestId:expect.any(String)});
      expect(attributeCalls()[0][1]?.prompt).toContain("attribute-grouping-v4");
      expect(attributeCalls()[0][1]?.prompt).not.toContain('"tail"');
    }
  });
  it("keeps recommended as the default and preserves the completed attribute plan on repeated hydration",async()=>{
    expect(readGroupingPreset()).toBe("recommended");
    const {plan,analysis}=attributePlan(await generateForegroundGroupingAnalysis(true,undefined,"attribute"));
    const hydrated=withRequestedGroupingPlan(analysis,"attribute");
    if(hydrated.parsed.status!=="ok") throw new Error("invalid");
    expect(hydrated.parsed.plans[0]).toBe(plan);
    expect(plan.rationale).not.toContain("判定待ち");
  });
  it.each(["off","invalid","error"] as const)("falls back to fixed-only categories after %s",async failure=>{
    if(failure==="off") useAiSettingsStore.setState({aiEnabled:false});
    if(failure==="invalid") harness.raw="not JSON";
    if(failure==="error") harness.fail={code:"cli_failed"};
    const {plan}=attributePlan(await generateForegroundGroupingAnalysis(true,undefined,"attribute"));
    expect(plan.rationale).toContain("AI の判定なし");
    expect(plan.rationale).toContain(failure==="off"?"AI がオフ":failure==="invalid"?"JSON":"AI の呼び出しに失敗");
    expect(plan.groups.find(g=>g.disposition==="keep")?.tabIds).toContain("b");
    if(failure==="off") expect(attributeCalls()).toHaveLength(0);
  });
  it("aborts a timed-out attribute invocation and publishes the fixed-only fallback",async()=>{
    vi.useFakeTimers();harness.hang=true;useJevSettingsStore.setState({enabled:false});
    const pending=generateForegroundGroupingAnalysis(true,undefined,"attribute");
    await vi.waitFor(()=>expect(attributeCalls()).toHaveLength(1),{timeout:10_000});
    await vi.advanceTimersByTimeAsync(25_001);
    const {plan}=attributePlan(await pending);
    expect(plan.rationale).toContain("AI の判定なし (時間切れ)");
    expect(harness.invoke.mock.calls).toContainEqual(["abort_tab_sweep_judge",{requestId:attributeCalls()[0][1]?.requestId}]);
  });
  it("cancels a pending attribute request through the existing abort command",async()=>{
    vi.useFakeTimers();harness.hang=true;useJevSettingsStore.setState({enabled:false});
    const pending=generateForegroundGroupingAnalysis(true,undefined,"attribute");
    const rejected=expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(()=>expect(attributeCalls()).toHaveLength(1),{timeout:10_000});
    cancelForegroundGroupingAnalysis();await rejected;
    expect(harness.invoke.mock.calls.some(([command])=>command==="abort_tab_sweep_judge")).toBe(true);
  });
  it("invalidates the selected attribute cache when the CLI model/provider changes",async()=>{
    rememberGroupingPreset("attribute");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(peekGroupingPrecompute().kind).toBe("fresh");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(1);
    useAiSettingsStore.setState({aiModel:"gpt-6.1-sol"});
    expect(peekGroupingPrecompute().kind).toBe("hard-stale");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(2);
    useAiSettingsStore.setState({aiProvider:"claude"});
    expect(peekGroupingPrecompute().kind).toBe("hard-stale");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(3);
  });
  it("invalidates the attribute cache when registered project evidence changes",async()=>{
    rememberGroupingPreset("attribute");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    useLauncherDirsStore.setState({view:{doc:{entries:[{section:"anken",label:"北斗学院",path:"/work/core"}]}} as never});
    expect(peekGroupingPrecompute().kind).toBe("hard-stale");
    attributePlan(await generateForegroundGroupingAnalysis(false,undefined,"attribute"));
    expect(attributeCalls()).toHaveLength(2);
  });
  it("keeps a valid attribute plan when the optional Jev service fails",async()=>{
    const original=harness.invoke.getMockImplementation()!;
    harness.invoke.mockImplementation(async(command,args)=>{
      if(command==="run_jev_grouping_judge") throw new Error("role failure");
      return original(command,args);
    });
    const {plan,analysis}=attributePlan(await generateForegroundGroupingAnalysis(true,undefined,"attribute"));
    expect(plan.rationale).not.toContain("AI の判定なし");
    if(analysis.parsed.status!=="ok") throw new Error("invalid");
    expect(analysis.parsed.droppedPlans.some(i=>i.reason.includes("役割の判定なし"))).toBe(true);
  });
  it("honors hidden-window gating and the existing daily background budget for attribute calls",async()=>{
    vi.useFakeTimers();rememberGroupingPreset("attribute");useJevSettingsStore.setState({enabled:false});
    const visibility=vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
    markGroupingInterest();
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    expect(attributeCalls()).toHaveLength(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    await vi.waitFor(()=>expect(attributeCalls()).toHaveLength(1),{timeout:10_000});
    for(let i=1;i<=GROUPING_BACKGROUND_DAILY_LIMIT;i++){
      useWorkspaceListStore.setState({layoutRevision:useWorkspaceListStore.getState().layoutRevision+1});
      await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS+1);
    }
    expect(attributeCalls()).toHaveLength(GROUPING_BACKGROUND_DAILY_LIMIT);
  });
});


describe("FIX5 cold registry identity", () => {
  const registeredView = { doc: { entries: [{ section: "dev", label: "mycmux", path: "/work/core" }] } };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  function coldRegistry(reply: Promise<unknown> = Promise.resolve(registeredView)) {
    useLauncherDirsStore.setState({ view: null, loading: false, error: null });
    harness.invoke.mockImplementation((command, args) => command === "launcher_dirs_get"
      ? reply : originalInvoke(command, args));
  }
  it.each([false, true])("M1 completes the first cold AI-on attribute request (force=%s) with one judge call", async force => {
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: false });
    coldRegistry();
    const result = await generateForegroundGroupingAnalysis(force, undefined, "attribute");
    const { plan } = attributePlan(result);
    expect(plan.rationale).not.toContain("AI の判定なし");
    expect(attributeCalls()).toHaveLength(1);
    expect(harness.invoke.mock.calls.filter(([command]) => command === "launcher_dirs_get")).toHaveLength(1);
    expect(peekGroupingPrecompute().kind).toBe("fresh");
    attributePlan(await generateForegroundGroupingAnalysis(false, undefined, "attribute"));
    expect(attributeCalls()).toHaveLength(1);
    expect(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")).toBeNull();
  });
  it("M1 preserves the first cold recommended request without the attribute judge", async () => {
    rememberGroupingPreset("recommended");
    useJevSettingsStore.setState({ enabled: false });
    coldRegistry();
    const result = await generateForegroundGroupingAnalysis();
    expect(result.kind).toBe("ready");
    expect(attributeCalls()).toHaveLength(0);
    expect(useLauncherDirsStore.getState().view).toEqual(registeredView);
  });
  it("M1 preserves an already loaded attribute registry without reloading", async () => {
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: false });
    attributePlan(await generateForegroundGroupingAnalysis(false, undefined, "attribute"));
    expect(attributeCalls()).toHaveLength(1);
    expect(harness.invoke.mock.calls.filter(([command]) => command === "launcher_dirs_get")).toHaveLength(0);
  });
  it.each(["registry", "provider", "model"] as const)("M1 rejects an in-flight result after a real %s change", async change => {
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: false });
    const reply = deferred<string>();
    harness.invoke.mockImplementation((command, args) => command === "run_tab_sweep_judge"
      ? reply.promise : originalInvoke(command, args));
    const pending = generateForegroundGroupingAnalysis(false, undefined, "attribute");
    await vi.waitFor(() => expect(attributeCalls()).toHaveLength(1), { timeout: 10_000 });
    if (change === "registry") useLauncherDirsStore.setState({
      view: { doc: { entries: [{ section: "dev", label: "mycmux", path: "/work/changed" }] } } as never,
    });
    else if (change === "provider") useAiSettingsStore.setState({ aiProvider: "claude" });
    else useAiSettingsStore.setState({ aiModel: "gpt-6.1-sol" });
    reply.resolve(harness.raw);
    expect(await pending).toEqual({ kind: "obsolete" });
    expect(peekGroupingPrecompute().kind).not.toBe("fresh");
    expect(attributeCalls()).toHaveLength(1);
  });
  it("M1 cancels while the cold registry is loading without starting a judge", async () => {
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: false });
    const registry = deferred<unknown>();
    coldRegistry(registry.promise);
    const pending = generateForegroundGroupingAnalysis(false, undefined, "attribute");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([command]) => command === "launcher_dirs_get"))
      .toHaveLength(1), { timeout: 10_000 });
    cancelForegroundGroupingAnalysis();
    await rejected;
    registry.resolve(registeredView);
    await vi.waitFor(() => expect(useLauncherDirsStore.getState().view).toEqual(registeredView), { timeout: 10_000 });
    expect(attributeCalls()).toHaveLength(0);
    expect(peekGroupingPrecompute().kind).not.toBe("fresh");
  });
  it("M1 completes a cold background request and consumes exactly one daily slot", async () => {
    vi.useFakeTimers();
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: false });
    coldRegistry();
    markGroupingInterest();
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS + 1);
    await vi.waitFor(() => expect(peekGroupingPrecompute().kind).toBe("fresh"), { timeout: 10_000 });
    expect(attributeCalls()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("mycmux.groupingPrecompute.dailyBudget.v1")!).count).toBe(1);
  });

  it("M1 includes cold registry loading in the foreground deadline and aborts the active role request", async () => {
    vi.useFakeTimers();
    rememberGroupingPreset("attribute");
    useJevSettingsStore.setState({ enabled: true });
    const registry = deferred<unknown>(), attribute = deferred<string>();
    let startedAt = 0;
    useLauncherDirsStore.setState({ view: null, loading: false, error: null });
    harness.invoke.mockImplementation((command, args) => {
      if (command === "launcher_dirs_get") { startedAt = Date.now(); return registry.promise; }
      if (command === "run_tab_sweep_judge") return attribute.promise;
      if (command === "run_jev_grouping_judge") return new Promise(() => {});
      return originalInvoke(command, args);
    });
    const pending = generateForegroundGroupingAnalysis(true, undefined, "attribute");
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([command]) => command === "launcher_dirs_get"))
      .toHaveLength(1), { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(19_000);
    registry.resolve(registeredView);
    await vi.waitFor(() => expect(attributeCalls()).toHaveLength(1), { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    attribute.resolve(harness.raw);
    await vi.waitFor(() => expect(harness.invoke.mock.calls.filter(([command]) => command === "run_jev_grouping_judge"))
      .toHaveLength(1), { timeout: 10_000 });
    const roleRequest = harness.invoke.mock.calls.find(([command]) => command === "run_jev_grouping_judge")![1]!.requestId;
    await vi.advanceTimersByTimeAsync(startedAt + 59_000 - Date.now());
    expect(harness.invoke.mock.calls.filter(([command]) => command === "abort_tab_sweep_judge")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_001);
    await rejected;
    expect(harness.invoke.mock.calls).toContainEqual(["abort_tab_sweep_judge", { requestId: roleRequest }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(peekGroupingPrecompute().kind).not.toBe("fresh");
    expect(attributeCalls()).toHaveLength(1);
    expect(harness.invoke.mock.calls.filter(([command]) => command === "run_jev_grouping_judge")).toHaveLength(1);
  });
});
