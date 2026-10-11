import type { ArchiveItem } from "../../lib/livebrief";

export const ARCHIVE_MOUNT_LIMIT = 120;
export class ArchiveHeights {
  private heights = new Map<string, number>();
  get(item: ArchiveItem): number { return this.heights.get(item.occurrenceId) ?? Math.min(960, 56 + Math.ceil(item.text.length / 70) * 19); }
  set(id: string, height: number): boolean {
    if (!(height > 0) || this.heights.get(id) === height) return false;
    this.heights.delete(id); this.heights.set(id,height);
    if (this.heights.size > 1024) this.heights.delete(this.heights.keys().next().value!);
    return true;
  }
  get size(): number { return this.heights.size; }
}
export function archiveLayout(items: readonly ArchiveItem[], heights: ArchiveHeights): number[] {
  const tops=[0]; for (const item of items) tops.push(tops[tops.length-1]+heights.get(item)); return tops;
}
export function indexAt(tops: readonly number[], y: number): number {
  let low=0,high=Math.max(0,tops.length-2);
  while(low<high) { const mid=Math.ceil((low+high)/2); if(tops[mid]<=y) low=mid; else high=mid-1; }
  return low;
}
export function archiveWindow(tops: readonly number[], scrollTop: number, viewport: number, max=ARCHIVE_MOUNT_LIMIT): {start:number;end:number;top:number;bottom:number} {
  const count=Math.max(0,tops.length-1); if(!count) return {start:0,end:0,top:0,bottom:0};
  const visible=indexAt(tops,scrollTop); let start=indexAt(tops,Math.max(0,scrollTop-viewport*2));
  let end=Math.min(count,indexAt(tops,scrollTop+viewport*3)+1);
  if(end-start>max) { start=Math.max(start,visible-Math.floor(max/3)); end=Math.min(count,start+max); }
  return {start,end,top:tops[start],bottom:tops[count]-tops[end]};
}
export interface ArchiveAnchor { id:string; offset:number }
export function anchoredScrollTop(anchor:ArchiveAnchor,items:readonly ArchiveItem[],tops:readonly number[]):number|null {
  const index=items.findIndex((i)=>i.occurrenceId===anchor.id); return index<0?null:Math.max(0,tops[index]-anchor.offset);
}
export function archiveBodyBlocks(text:string):string[] {
  const blocks:string[]=[];
  for(let start=0;start<text.length;) { let end=Math.min(text.length,start+4096); if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--; blocks.push(text.slice(start,end));start=end; }
  return blocks;
}
