import { describe,expect,it } from "vitest";
import { ArchiveHeights,archiveLayout,archiveWindow,anchoredScrollTop } from "../../src/components/dashboard/archiveWindow";
import type { ArchiveItem } from "../../src/lib/livebrief";
const item=(n:number)=>({occurrenceId:`g:${n}`,text:"x"} as ArchiveItem);
describe("archive viewport geometry",()=>{
  it("caps mounted blocks at 120 across an entire loaded window",()=>{
    const items=Array.from({length:1000},(_,i)=>item(i));const h=new ArchiveHeights();for(const i of items)h.set(i.occurrenceId,10);const layout=archiveLayout(items,h);
    for(let y=0;y<10000;y+=123){const w=archiveWindow(layout,y,900);expect(w.end-w.start).toBeLessThanOrEqual(120);expect(w.top).toBe(layout[w.start]);expect(w.bottom).toBe(layout[1000]-layout[w.end]);}
  });
  it("restores the same occurrence and pixel offset after prepend and variable height changes",()=>{
    const heights=new ArchiveHeights();const before=[item(5),item(6),item(7)];before.forEach((i)=>heights.set(i.occurrenceId,100));
    const anchor={id:"g:6",offset:-17.5};expect(anchoredScrollTop(anchor,before,archiveLayout(before,heights))).toBe(117.5);
    const after=[item(1),...before];heights.set("g:1",341.25);expect(anchoredScrollTop(anchor,after,archiveLayout(after,heights))).toBe(458.75);
    heights.set("g:5",207.5);expect(anchoredScrollTop(anchor,after,archiveLayout(after,heights))).toBe(566.25);
    expect(anchoredScrollTop({id:"other-generation",offset:0},after,archiveLayout(after,heights))).toBeNull();
  });
  it("bounds measured height metadata after long traversal",()=>{const h=new ArchiveHeights();for(let i=0;i<10000;i++)h.set(`g:${i}`,80+i);expect(h.size).toBe(1024);});
});
