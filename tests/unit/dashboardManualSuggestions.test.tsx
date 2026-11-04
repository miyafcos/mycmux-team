// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: transport.invoke }));
import { NextActionSuggestions } from "../../src/components/dashboard/NextActionSuggestions";
import { __resetBackgroundAiSchedulerForTests, nextActionRequestKey, observeActiveSession, observeAheadSessions, useBackgroundAiSuggestionStore } from "../../src/lib/backgroundAiScheduler";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, answers: number;
const target = (eventSeq: number, displayState: "done" | "running" = "done", sessionId = "fictional-session") => ({sessionId,eventSeq,displayState,questionActive:false,tabLabel:"Fictional review",cwd:null});
const result = (n: number) => ({oneLine:`Fictional plan ${n}`,completionAssessment:"Review",nextActions:[{label:`Fictional action ${n}`,prompt:`Inspect fictional sample ${n}`}]});
const judgeCalls = () => transport.invoke.mock.calls.filter(([name]) => name === "run_next_action_judge");
const tick = async (ms=1600) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const render = async (eventSeq=1,displayState: "done"|"running"="done",sessionId="fictional-session",onConfirm=vi.fn(async()=>{})) => act(async()=>root.render(<NextActionSuggestions sessionId={sessionId} eventSeq={eventSeq} displayState={displayState} questionActive={false} sending={false} onConfirm={onConfirm}/>));
const read = async () => act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());
const initialAi=useAiSettingsStore.getState(), initialSettings=useSettingsStore.getState();
beforeEach(()=>{
  vi.useFakeTimers(); transport.invoke.mockReset(); answers=0;
  transport.invoke.mockImplementation(async(name:string)=>name==="run_next_action_judge"?result(++answers):true);
  __resetBackgroundAiSchedulerForTests();
  useAiSettingsStore.setState({aiEnabled:true,aiProvider:"codex",aiModel:"gpt-5.6-luna"});
  useSettingsStore.setState({replyDraftSuggestionsEnabled:true});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();__resetBackgroundAiSchedulerForTests();useAiSettingsStore.setState(initialAi);useSettingsStore.setState(initialSettings);vi.useRealTimers();});
it("prepares automatically but reveals a current ready answer only after reading",async()=>{
  observeActiveSession(target(1));await render();await tick();
  expect(judgeCalls()).toHaveLength(1);expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-session']?.status).toBe('ready');
  expect(host.querySelector('.cmux-dashboard-next-action')).toBeNull();
  await read();expect(host.textContent).toContain('Fictional action 1');expect(judgeCalls()).toHaveLength(1);expect(useAiSettingsStore.getState().aiEnabled).toBe(true);
});
it("clears the displayed previous turn when the real scheduler observes running",async()=>{
  observeActiveSession(target(1));await tick();await render();await read();expect(host.textContent).toContain('Fictional action 1');
  await act(async()=>observeActiveSession(target(2,'running')));await render(2,'running');await tick(5000);
  expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-session']).toBeUndefined();expect(host.querySelector('.cmux-dashboard-next-action')).toBeNull();expect(judgeCalls()).toHaveLength(1);
});
it("reads the new completed turn after switching away and returning, never the old ready key",async()=>{
  observeActiveSession(target(1));await tick();await render();await read();
  observeActiveSession(null);await render(0,'done','fictional-other');
  observeActiveSession(target(3));await render(3);expect(host.querySelector('.cmux-dashboard-next-action')).toBeNull();await read();await tick();
  expect(judgeCalls()).toHaveLength(2);expect(host.textContent).toContain('Fictional action 2');expect(host.textContent).not.toContain('Fictional action 1');
  expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-session']?.requestKey).toBe(nextActionRequestKey(target(3)));
});
it.each(['event','prompt','model'] as const)("hides an externally stale ready %s key even before scheduling clears it",async reason=>{
  observeActiveSession(target(3));await tick();
  const current=nextActionRequestKey(target(3));const bad=reason==='event'?current.replace(':3:done:',':1:done:'):reason==='prompt'?current.replace('next-action-v2','old-prompt'):current+':old-model';
  useBackgroundAiSuggestionStore.getState().set('fictional-session',{status:'ready',requestKey:bad,...result(99)});
  await render(3);expect(host.querySelector('.cmux-dashboard-next-action')).toBeNull();await read();expect(host.textContent).not.toContain('Fictional action 99');await tick();
  expect(host.textContent).toContain('Fictional action 2');expect(judgeCalls()).toHaveLength(2);
});
it("resets reading consent when the model changes",async()=>{
  observeActiveSession(target(1));await tick();await render();await read();
  await act(async()=>useAiSettingsStore.setState({aiModel:'gpt-6.1-sol'}));await tick();
  expect(host.querySelector('.cmux-dashboard-next-action')).toBeNull();await read();await tick();expect(host.textContent).toContain('Fictional action 2');
});
it("keeps preparation of visible unopened sessions",async()=>{
  observeActiveSession(target(1));observeAheadSessions([target(7,'done','fictional-ahead')]);await tick();
  expect(judgeCalls()).toHaveLength(2);expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-ahead']?.status).toBe('ready');
});
it.each(['ai','reply'] as const)("shows only a one-line note when %s is disabled",async kind=>{
  if(kind==='ai')useAiSettingsStore.setState({aiEnabled:false});else useSettingsStore.setState({replyDraftSuggestionsEnabled:false});
  observeActiveSession(target(1));await render();await tick();expect(host.querySelector('button')).toBeNull();expect(host.textContent).toContain('無効');expect(judgeCalls()).toHaveLength(0);
});
it("shows elapsed time and retry for an in-flight mocked judge",async()=>{
  transport.invoke.mockImplementation((name:string)=>name==='run_next_action_judge'?new Promise(()=>{}):Promise.resolve(true));
  observeActiveSession(target(1));await render();await tick();await read();await tick(31000);
  expect(host.textContent).toContain('31秒');expect(host.textContent).toContain('時間がかかっています');expect(host.querySelector('.cmux-dashboard-next-actions-retry')).not.toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>('.cmux-dashboard-next-actions-retry')!.click());await tick(1000);
  expect(host.textContent).toContain('1\u79d2');expect(host.textContent).not.toContain('32\u79d2');expect(useAiSettingsStore.getState().aiEnabled).toBe(true);
});
it("requires confirmation before forwarding the current mocked action",async()=>{
  const confirm=vi.fn(async()=>{});observeActiveSession(target(1));await tick();await render(1,'done','fictional-session',confirm);await read();
  await act(async()=>host.querySelector<HTMLButtonElement>('.cmux-dashboard-next-action')!.click());
  expect(confirm).not.toHaveBeenCalled();expect(host.querySelector('[data-next-action-confirm]')?.textContent).toContain('Inspect fictional sample 1');
});

it("keeps a prepared replacement turn private across an away-and-back visit until a fresh read",async()=>{
  observeActiveSession(target(10));await tick();await render(10);await read();
  expect(host.textContent).toContain('Fictional action 1');
  await act(async()=>observeActiveSession(target(11,'running')));await render(11,'running');await tick(2000);
  await act(async()=>observeActiveSession(target(12)));await render(12);await tick();
  expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-session']?.status).toBe('ready');
  await act(async()=>observeActiveSession(target(0,'running','fictional-away')));await render(0,'running','fictional-away');
  await act(async()=>observeActiveSession(target(12)));await render(12);await tick();
  expect(host.querySelectorAll('.cmux-dashboard-next-action')).toHaveLength(0);
  expect(host.querySelector('section')?.dataset.nextActionStatus).toBe('not-requested');
  const calls=judgeCalls().length;await read();
  expect(host.textContent).toContain('Fictional action 2');expect(host.textContent).not.toContain('Fictional action 1');expect(judgeCalls()).toHaveLength(calls);
});
it("requires a new read for both immediate and prepared states of a later completed turn",async()=>{
  observeActiveSession(target(20));await tick();await render(20);await read();
  expect(host.querySelectorAll('.cmux-dashboard-next-action')).toHaveLength(1);
  await act(async()=>observeActiveSession(target(21)));await render(21);
  expect(host.querySelectorAll('.cmux-dashboard-next-action')).toHaveLength(0);
  await tick();
  expect(useBackgroundAiSuggestionStore.getState().bySession['fictional-session']?.requestKey).toBe(nextActionRequestKey(target(21)));
  expect(host.querySelectorAll('.cmux-dashboard-next-action')).toHaveLength(0);
  expect(host.querySelector('section')?.dataset.nextActionStatus).toBe('not-requested');
  expect(judgeCalls()).toHaveLength(2);await read();
  expect(host.textContent).toContain('Fictional action 2');expect(judgeCalls()).toHaveLength(2);
});
