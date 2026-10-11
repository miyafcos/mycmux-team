// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
const mocks=vi.hoisted(()=>({write:vi.fn()}));
vi.mock("../../src/components/terminal/terminalCache",()=>({chunkedWrite:mocks.write,registerTerminalCacheEvictionCleanup:()=>{}}));
import {attachTerminalWheelScroll,isXtermVerticalScrollbarTarget,resetFontZoomQueueForTests} from "../../src/components/terminal/terminalMouseInputFilter";
import type {Terminal} from "@xterm/xterm";
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanups.splice(0))fn();document.body.replaceChildren();mocks.write.mockClear();resetFontZoomQueueForTests();});
function attach(type:"normal"|"alternate",accept:boolean) {
 const container=document.createElement("div");document.body.append(container);vi.spyOn(container,"getBoundingClientRect").mockReturnValue({top:0,left:0,width:800,height:600} as DOMRect);
 const scroll=vi.fn();const history=vi.fn((e:WheelEvent)=>accept&&!e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&e.deltaY<0);
 const term={element:container,cols:80,rows:24,buffer:{active:{type,viewportY:0,baseY:type==="normal"?5000:0}},scrollLines:scroll} as unknown as Terminal;
 cleanups.push(attachTerminalWheelScroll(container,term,"wheel-fixture",true,{wheel:history,boundary:()=>false,composing:()=>false,onDragging:()=>{}}));
 return {container,scroll,history};
}
describe("wheel arbitration at the existing input boundary",()=>{
 it.each(["normal","alternate"] as const)("accepted %s entry produces zero local scroll and zero PTY/SGR writes",(type)=>{
  const {container,scroll,history}=attach(type,true);const event=new WheelEvent("wheel",{deltaY:-120,deltaX:0,bubbles:true,cancelable:true});container.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);expect(history).toHaveBeenCalledOnce();expect(scroll).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
 });
 it("unready alternate entry retains the original SGR route",()=>{const {container,scroll}=attach("alternate",false);container.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,bubbles:true,cancelable:true}));expect(mocks.write).toHaveBeenCalledOnce();expect(scroll).not.toHaveBeenCalled();});
 it("unready normal entry retains the original local history route",()=>{const {container,scroll}=attach("normal",false);container.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,bubbles:true,cancelable:true}));expect(scroll).toHaveBeenCalledWith(-3);expect(mocks.write).not.toHaveBeenCalled();});
 it.each(["normal","alternate"] as const)("Shift wheel always reads raw %s terminal history",(type)=>{const {container,scroll}=attach(type,true);container.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,shiftKey:true,bubbles:true,cancelable:true}));expect(scroll).toHaveBeenCalledWith(-3);expect(mocks.write).not.toHaveBeenCalled();});
 it("uses only the installed xterm 6 vertical scrollbar pointer origin",()=>{
  const container=document.createElement("div");container.innerHTML='<div class="xterm-scrollable-element"><div class="scrollbar vertical"><div class="slider"></div></div><div class="scrollbar horizontal"></div><div class="xterm-screen"></div></div>';document.body.append(container);
  expect(isXtermVerticalScrollbarTarget(container.querySelector(".slider"),container)).toBe(true);expect(isXtermVerticalScrollbarTarget(container.querySelector(".horizontal"),container)).toBe(false);expect(isXtermVerticalScrollbarTarget(container.querySelector(".xterm-screen"),container)).toBe(false);
  expect(JSON.parse(readFileSync("node_modules/@xterm/xterm/package.json","utf8")).version).toBe("6.0.0");expect(readFileSync("node_modules/@xterm/xterm/src/vs/base/browser/ui/scrollbar/verticalScrollbar.ts","utf8")).toContain("extraScrollbarClassName: 'vertical'");
 });
 it("integrates fresh/cached terminals through callbacks without changing attach dependencies or pump/ACK",()=>{
  const source=readFileSync("src/components/terminal/XTermWrapper.tsx","utf8");expect(source).toContain("cached.term, sessionId, forceWheelMouseReport, historyAdmission");expect(source).toContain("term, sessionId, forceWheelMouseReport, historyAdmission");
  const key=source.slice(source.indexOf("const attachTerminalKeyHandler"),source.indexOf("const registerInputListeners"));expect(key.indexOf("getActionsForEvent")).toBeLessThan(key.indexOf("isExplicitHistoryKey"));
  const onScroll=source.slice(source.indexOf("const registerScrollListener"),source.indexOf("const registerCompositionGuard"));expect(onScroll).not.toContain("archiveEntryRef");
  expect(source).toContain("}, [sessionId]);");expect(source).not.toMatch(/\}, \[sessionId, (?:archive|conversationHistory|transcriptPanel)/);
 });
});
