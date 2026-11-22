// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeBackgroundPanel } from "../../src/components/theme/ThemeBackgroundPanel";
import { HANABI_SCENES } from "../../src/lib/hanabiScenes";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { useThemeStore } from "../../src/stores/themeStore";

vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn()}));
vi.mock("../../src/lib/wallpaperCache",()=>({
  useWallpaperCache:()=>({paths:{},errors:{},progress:{},totalBytes:0,status:"ready"}),
  refreshWallpaperCache:vi.fn(), clearWallpaperCache:vi.fn(),downloadWallpaper:vi.fn(),
  formatCacheSize:()=>"0 MB",wallpaperCardState:()=>"notDownloaded",
}));
let root:Root,host:HTMLDivElement;
function Harness(){ const background=useThemeStore(s=>s.themeTweaks.background); const set=useThemeStore(s=>s.setThemeBackground);
  return <ThemeBackgroundPanel background={background} setThemeBackground={set}/>; }
beforeEach(()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  useThemeStore.getState().hydrateSettings({themeId:"hanabi",themeTweaks:{background:{...DEFAULT_THEME_BACKGROUND,mode:"scene",sceneId:"winter-night"}}});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  act(()=>root.render(<Harness/>));
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("thumbnail choices in the actual background panel",()=>{
  it("shows exactly five static scene cards and writes each selection to the store",()=>{
    const cards=[...host.querySelectorAll<HTMLButtonElement>('[data-scene-id]')];
    expect(cards.map(card=>card.textContent)).toEqual(HANABI_SCENES.map(scene=>scene.label));
    expect(cards.every(card=>card.querySelector('canvas[data-scene-thumbnail]'))).toBe(true);
    for(const [index,card] of cards.entries()){
      act(()=>card.click());
      expect(useThemeStore.getState().themeTweaks.background).toMatchObject({mode:"scene",sceneId:HANABI_SCENES[index].id});
      expect(card.getAttribute("aria-checked")).toBe("true");
      expect(cards.filter(c=>c.tabIndex===0)).toHaveLength(1);
    }
  });
  it("selects by arrows and Home/End without changing opacity or fireworks",()=>{
    act(()=>useThemeStore.getState().setThemeBackground({terminalOpacity:0.25,panelOpacity:0.55,completionFireworks:false}));
    const group=host.querySelector<HTMLElement>('[aria-label="場面"]')!;
    const cards=[...group.querySelectorAll<HTMLButtonElement>('[role=radio]')];
    act(()=>{cards[0].focus();cards[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));});
    expect(document.activeElement).toBe(cards[1]);
    expect(useThemeStore.getState().themeTweaks.background.sceneId).toBe("summer-seaside");
    act(()=>cards[1].dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true})));
    expect(document.activeElement).toBe(cards[4]);
    act(()=>cards[4].dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true})));
    expect(document.activeElement).toBe(cards[0]);
    expect(useThemeStore.getState().themeTweaks.background).toMatchObject({terminalOpacity:0.25,panelOpacity:0.55,completionFireworks:false});
  });
  it("selects all three surface illustrations and removes the long legend",()=>{
    const group=host.querySelector<HTMLElement>('[aria-label="背景の見え方"]')!;
    expect(group.querySelectorAll('[data-surface-thumbnail]')).toHaveLength(3);
    const click=(id:string)=>act(()=>group.querySelector<HTMLElement>(`[data-surface-thumbnail=${id}]`)!.closest('button')!.click());
    click("clear");expect(useThemeStore.getState().themeTweaks.background).toMatchObject({solidSurfaces:false,panelOpacity:0.25,terminalOpacity:0.15});
    click("solid");expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(true);
    click("frosted");expect(useThemeStore.getState().themeTweaks.background).toMatchObject({solidSurfaces:false,panelOpacity:0.68,terminalOpacity:0.62});
    expect(host.textContent).not.toContain("塗りつぶし: 壁紙を隠す");
  });
});
