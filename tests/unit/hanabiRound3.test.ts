import { describe, expect, it } from "vitest";
import { createNightFireworks, createWinterNightScene, doneFireworkPlacement, fireworkEnd, nightBranchExtent, nightEmissionColor, nightFireworkLight, nightSkyColor, nightSnowAsterisk, nightTreeBranches } from "../../src/lib/hanabiScene";

describe("Round3 symbol forest and clearings", () => {
  it.each([[1280,800],[1920,1080],[900,1400]])("leaves separate silhouettes and a tree-free cabin at %sx%s", (w,h) => {
    const scene = createWinterNightScene(w,h);
    const near = scene.trees.filter(t => t.layer === "near");
    for (const side of ["left","right"]) {
      const trees = near.filter(t => t.side === side).sort((a,b) => a.x-b.x);
      for (let i=1;i<trees.length;i++) expect(trees[i].x-trees[i-1].x).toBeGreaterThanOrEqual(Math.max(trees[i].width,trees[i-1].width)*0.7);
    }
    const clearing = { left:scene.house.x-scene.pixel*5,right:scene.house.x+scene.house.width+scene.pixel*5,
      top:scene.house.y-scene.house.height*1.9,bottom:scene.house.y+scene.pixel*2 };
    for (const tree of near) {
      const branches = nightTreeBranches(tree,scene.pixel);
      expect(branches).toHaveLength(5);
      branches.forEach((branch,index) => {
        expect(branch.bottom-branch.shadowTop).toBe(scene.pixel*2);
        for (let y=branch.top;y<branch.bottom;y+=scene.pixel) {
          const half=nightBranchExtent(branch,y,scene.pixel,index===0);
          if (y>=clearing.top && y<clearing.bottom) expect(tree.x+half<=clearing.left || tree.x-half>=clearing.right).toBe(true);
        }
        if(index>0) {
          const previous=branches[index-1];
          const previousWidth=nightBranchExtent(previous,previous.bottom-scene.pixel,scene.pixel,index===1);
          expect(nightBranchExtent(branch,branch.top,scene.pixel)).toBeLessThanOrEqual(previousWidth*0.85);
        }
      });
    }
  });
  it("enlarges the portrait firs beyond the old short forest", () => {
    const scene=createWinterNightScene(900,1400);
    const tallest=Math.max(...scene.trees.filter(t=>t.layer==="near").map(t=>t.height));
    expect(tallest).toBeGreaterThanOrEqual(450);
    expect(tallest).toBeLessThanOrEqual(550);
  });
  it("places the done burst next to a visible crown while retaining the UI clearance", () => {
    const scene=createWinterNightScene(1280,800,undefined,{sidebarWidth:176,
      conversationRect:{left:408,right:1048,top:185,bottom:522},inputRect:{left:408,right:1048,top:700,bottom:753}});
    const tip=scene.layout.rightForestTip!;
    const burst=doneFireworkPlacement(1280,800,scene.layout);
    expect(burst.y+burst.radius*0.6).toBeCloseTo(tip.y);
    expect(Math.hypot(burst.x-tip.x,burst.y-tip.y)).toBeLessThan(burst.radius);
    expect(burst.x-burst.radius).toBeGreaterThan(1048);
    expect(burst.y+burst.radius).toBeLessThan(700);
  });
  it("uses a crisp five-pixel snow symbol even at fractional animation positions", () => {
    const rectangles=nightSnowAsterisk(100.49,210.51);
    const pixels=new Set<string>();
    for(const r of rectangles) {
      expect([r.x,r.y,r.width,r.height].every(Number.isInteger)).toBe(true);
      for(let y=r.y;y<r.y+r.height;y++) for(let x=r.x;x<r.x+r.width;x++) pixels.add(x+","+y);
    }
    expect(pixels.size).toBe(13);
    expect(pixels.has("98,209")).toBe(true); expect(pixels.has("102,213")).toBe(true);
    expect(pixels.has("100,211")).toBe(true);
  });
  it("warms the middle sky without changing the lower endpoint", () => {
    for(const t of [0.2,0.4,0.6,0.75]) {
      const [r,g]=nightSkyColor(t);
      expect(r-g).toBeGreaterThanOrEqual(6); expect(r-g).toBeLessThanOrEqual(9);
    }
    expect(nightSkyColor(1)).toEqual([46,44,94]);
  });
});

describe("Round3 light-only fireworks", () => {
  it.each([[1280,800],[1920,1080],[900,1400]])("separates the ring from every overlapping burst at %sx%s", (w,h) => {
    const fireworks=createNightFireworks("merge",w,h,0,7);
    const ring=fireworks.find(f=>f.style==="ring")!;
    expect(ring.rays).toHaveLength(28);
    for(const other of fireworks) {
      if(other===ring || other.startedAt>=fireworkEnd(ring) || ring.startedAt>=fireworkEnd(other)) continue;
      expect(Math.hypot(ring.x-other.x,ring.y-other.y)).toBeGreaterThanOrEqual(ring.radius*2.2);
    }
  });
  it("keeps the willow gold, downward and without a residual alpha floor", () => {
    const willow=createNightFireworks("merge",1280,800,0,9).find(f=>f.style==="willow")!;
    expect(willow.color).toBe("#f2cc8f");
    for(const ray of willow.rays) expect(Math.abs(ray.angle-Math.PI/2)).toBeLessThanOrEqual(70*Math.PI/180+1e-10);
    expect(nightFireworkLight(willow,0.99).alpha).toBeLessThan(0.001);
    expect(nightFireworkLight(willow,1).alpha).toBe(0);
  });
  it("removes inner chrysanthemum spokes and then leaves only sparks", () => {
    const firework=createNightFireworks("done",1280,800,0,1)[0];
    expect(nightFireworkLight(firework,0.71).outerOnly).toBe(true);
    expect(nightFireworkLight(firework,0.79).sparksOnly).toBe(false);
    expect(nightFireworkLight(firework,0.83).sparksOnly).toBe(true);
    const alphas=[0.71,0.8,0.9,0.99,1].map(p=>nightFireworkLight(firework,p).alpha);
    for(let i=1;i<alphas.length;i++) expect(alphas[i]).toBeLessThan(alphas[i-1]);
    expect(alphas.at(-1)).toBe(0);
  });
  it("never leaves a center halo after the non-chrysanthemum half-life", () => {
    for(const firework of createNightFireworks("merge",1280,800,0,4)) {
      const end=firework.style==="chrysanthemum"?0.7:0.5;
      for(const p of [end,end+0.1,0.99,1]) {
        expect(nightFireworkLight(firework,p).glowAlpha).toBe(0);
        expect(nightFireworkLight(firework,p).coreAlpha).toBe(0);
      }
    }
  });
  it("uses positive calibrated emission that restores the authored coral and gold on the sky", () => {
    for(const color of ["#F08A6C","#f2cc8f"]) for(const t of [0.2,0.5,0.8]) {
      const channels=nightEmissionColor(color,t).match(/\d+/g)!.map(Number);
      const sky=nightSkyColor(t);
      channels.forEach((n,i)=>{
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n+sky[i]).toBeCloseTo(parseInt(color.slice(1+i*2,3+i*2),16),0);
      });
    }
  });
});
