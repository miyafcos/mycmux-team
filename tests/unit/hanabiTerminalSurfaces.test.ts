// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHanabiTerminalSurfaces } from "../../src/lib/hanabiTerminalSurfaces";
import { createHanabiScene } from "../../src/lib/hanabiScenery";
import { createNightFireworks } from "../../src/lib/hanabiScene";
import { paintNightFireworks } from "../../src/lib/hanabiCanvas";
vi.mock("../../src/lib/hanabiCanvas",()=>({paintNightFireworks:vi.fn()}));
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("single-owner scene surface compositing",()=>{
  it("copies scenery, applies exactly one stored coat, then paints light before the existing xterm child",()=>{
    const order:string[]=[];
    const ctx={drawImage:vi.fn(()=>order.push("scenery")),fillRect:vi.fn(()=>order.push("tint")),save:vi.fn(),restore:vi.fn(),translate:vi.fn(),setTransform:vi.fn(),globalAlpha:1};
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.mocked(paintNightFireworks).mockImplementation(()=>{order.push("fireworks");});
    const raf=vi.fn();vi.stubGlobal("requestAnimationFrame",raf);
    const root=document.createElement("div");root.dataset.cmuxThemedRoot="true";document.body.append(root);
    const source=document.createElement("canvas");root.append(source);
    const host=document.createElement("div");host.dataset.hanabiTerminalSurface="true";root.append(host);
    const xterm=document.createElement("div");xterm.className="xterm";host.append(xterm);
    vi.spyOn(root,"getBoundingClientRect").mockReturnValue({left:0,top:0,width:1280,height:800} as DOMRect);
    vi.spyOn(host,"getBoundingClientRect").mockReturnValue({left:176,top:77,width:1104,height:723} as DOMRect);
    const surface=createHanabiTerminalSurfaces(source,"#171535",0.25);
    const scene=createHanabiScene("winter-night",1280,800);
    surface.resize(scene,2); surface.resize(scene,2);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    expect(host.firstElementChild?.tagName).toBe("CANVAS");expect(host.lastElementChild).toBe(xterm);
    expect(host.querySelector("canvas")!.width).toBe(2208);
    const fireworks=createNightFireworks("done",1280,800,0,1);
    surface.paint(1800,fireworks,false);
    expect(order).toEqual(["scenery","tint","fireworks"]);
    expect(ctx.drawImage).toHaveBeenCalledWith(source,352,154,2208,1446,0,0,1104,723);
    expect(paintNightFireworks).toHaveBeenCalledWith(ctx,scene,1800,fireworks,{color:"#171535",opacity:0.25});
    order.length=0;surface.paint(1800,fireworks,true);expect(order).toEqual(["scenery","tint"]);
    expect(raf).not.toHaveBeenCalled();
    host.setAttribute("aria-hidden","true");surface.resize(scene,2);expect(host.querySelector("canvas")).toBeNull();
    host.removeAttribute("aria-hidden");surface.resize(scene,2);expect(host.querySelectorAll("canvas")).toHaveLength(1);
    surface.dispose();expect(host.children).toHaveLength(1);
  });
  it("adds the light surface when a modal's aria-hidden lifts after surfaces were rebuilt behind it",async()=>{
    const ctx={drawImage:vi.fn(),fillRect:vi.fn(),save:vi.fn(),restore:vi.fn(),translate:vi.fn(),setTransform:vi.fn(),globalAlpha:1};
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const root=document.createElement("div");root.dataset.cmuxThemedRoot="true";document.body.append(root);
    const source=document.createElement("canvas");root.append(source);
    const shell=document.createElement("div");shell.setAttribute("aria-hidden","true");root.append(shell);
    const host=document.createElement("div");host.dataset.hanabiTerminalSurface="true";shell.append(host);
    const invalidate=vi.fn();
    // A scene picked in the settings dialog recreates the surfaces while the shell is hidden.
    const surface=createHanabiTerminalSurfaces(source,"#171535",0.25,invalidate);
    surface.resize(createHanabiScene("sakura-night",1280,800),2);
    expect(host.querySelector("canvas")).toBeNull();
    shell.removeAttribute("aria-hidden");await new Promise(resolve=>setTimeout(resolve));
    expect(host.querySelectorAll("canvas[data-hanabi-terminal-light]")).toHaveLength(1);expect(invalidate).toHaveBeenCalledTimes(1);
    // Hiding again keeps the last frame; an unrelated aria-hidden toggle is not layout work.
    shell.setAttribute("aria-hidden","true");const other=document.createElement("div");root.append(other);
    other.setAttribute("aria-hidden","true");other.removeAttribute("aria-hidden");await new Promise(resolve=>setTimeout(resolve));
    expect(host.querySelectorAll("canvas")).toHaveLength(1);expect(invalidate).toHaveBeenCalledTimes(1);
    surface.dispose();expect(host.children).toHaveLength(0);
  });
});
