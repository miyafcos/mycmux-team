// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
const source=(name:string)=>readFileSync(join(__dirname,"../../src/components/dashboard",name),"utf8");
const selectorList=(text:string)=>{let depth=0,start=0;const result:string[]=[];for(let i=0;i<text.length;i++){if('(['.includes(text[i]))depth++;if(')]'.includes(text[i]))depth--;if(text[i]===','&&depth===0){result.push(text.slice(start,i).trim());start=i+1;}}result.push(text.slice(start).trim());return result;};
const rules=(text:string)=>[...text.replace(/\/\*[\s\S]*?\*\//g,"").matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(r=>selectorList(r[1]).map(selector=>({selector,body:r[2]})));
const all=rules(["DashboardView.css","DashboardChatSurface.css","DashboardA.css"].map(source).join("\n"));
const rank=(s:string)=>(s.match(/\.[\w-]+|\[[^\]]+\]|:only-child/g)||[]).length;
const width=(e:Element)=>all.filter(r=>/\bwidth\s*:/.test(r.body)&&e.matches(r.selector)).sort((a,b)=>rank(a.selector)-rank(b.selector)).at(-1);
it("history popup icon buttons override the fixed icon width without changing header icon buttons",()=>{
  const host=document.createElement('div');host.className='cmux-dashboard-view';
  host.innerHTML='<header><div class="cmux-archive-actions"><button><svg></svg></button></div></header><details class="cmux-dashboard-chat-history"><div class="cmux-dashboard-chat-navigation"><div class="cmux-archive-actions"><button><svg></svg></button></div><div class="cmux-dashboard-user-turn-nav"><div class="cmux-dashboard-user-turn-nav-buttons"><button><svg></svg></button></div></div></div></details>';
  const popup=host.querySelector('details button')!,header=host.querySelector('header button')!;
  const popupWidth=width(popup)!,headerWidth=width(header)!;
  expect(popupWidth.body).toMatch(/(?:^|;)\s*width:\s*auto\s*;/);
  expect(popupWidth.body).toMatch(/padding-inline:\s*var\(--cmux-chat-space-4\)/);
  expect(headerWidth.body).toMatch(/width:\s*var\(--cmux-chat-nav-size\)/);
  expect(header.matches(popupWidth.selector)).toBe(false);expect(rank(popupWidth.selector)).toBeGreaterThan(rank(headerWidth.selector));
  const legacy=host.querySelector('.cmux-dashboard-user-turn-nav-buttons button')!;
  expect(width(legacy)?.body).toBe(popupWidth.body);
  const layout=all.find(r=>r.selector.includes('.cmux-dashboard-chat-history')&&r.selector.includes('.cmux-dashboard-user-turn-nav-buttons')&&!r.selector.includes('button:'))!;
  expect(legacy.parentElement!.matches(layout.selector)).toBe(true);
  expect(legacy.parentElement!.parentElement!.matches(layout.selector)).toBe(true);
  expect(layout.body).toMatch(/flex-direction:\s*column/);expect(layout.body).toMatch(/overflow-x:\s*hidden/);
});
it("only expanded minimap chips receive the vertical tile layout",()=>{
  const host=document.createElement('div');host.className='cmux-dashboard-view';host.innerHTML='<button class="cmux-minimap-chip is-collapsed"></button><button class="cmux-minimap-chip is-expanded"></button>';
  const collapsed=host.firstElementChild!,expanded=host.lastElementChild!;
  const vertical=rules(source('DashboardA.css')).filter(r=>r.selector.includes('.cmux-minimap-chip')&&/flex-direction:\s*column/.test(r.body));
  expect(vertical).toHaveLength(1);expect(collapsed.matches(vertical[0].selector)).toBe(false);expect(expanded.matches(vertical[0].selector)).toBe(true);
});
it("read and retry share the existing framed header-action skin",()=>{
  const shared=rules(source('DashboardA.css'));const pin=shared.find(r=>r.selector.endsWith('.cmux-dashboard-chat-header-action'))!;
  for(const ending of ['[data-next-action-status="not-requested"] > button','[role="status"] > button','.cmux-dashboard-next-actions-retry']){
    const rule=shared.find(r=>r.selector.endsWith(ending))!;expect(rule.body).toBe(pin.body);expect(rule.body).toContain('border: 1px solid var(--cmux-border)');expect(rule.body).toContain('padding: 0 var(--cmux-space-4)');
  }
});

it("status retry band shares the one-line layout and text-width button",()=>{
  const shared=rules(source('DashboardA.css'));
  const base='.cmux-dashboard-view .cmux-dashboard-next-actions[role="status"]';
  const band=shared.find(r=>r.selector===base)!;expect(band).toBeDefined();expect(band.body).toMatch(/display:\s*flex/);expect(band.body).toMatch(/flex-direction:\s*row/);
  expect(shared.find(r=>r.selector===base+' > span')!.body).toContain('white-space: nowrap');
  const button=shared.filter(r=>r.selector===base+' > button').at(-1)!;
  expect(button.body).toContain('width: auto');expect(button.body).toContain('flex: 0 0 auto');expect(button.body).toContain('white-space: nowrap');
});
it("every framed action has disabled styling and enabled read/retry buttons have hover feedback",()=>{
  const shared=rules(source('DashboardA.css')),pin=shared.find(r=>r.selector.endsWith('.cmux-dashboard-chat-header-action'))!;
  const framed=shared.filter(r=>r.body===pin.body);expect(framed.length).toBeGreaterThan(3);
  for(const base of framed){const disabled=shared.find(r=>r.selector===base.selector+':disabled')!;expect(disabled).toBeDefined();expect(disabled.body).toMatch(/opacity:\s*0\.5/);expect(disabled.body).toMatch(/cursor:\s*default/);}
  for(const base of framed.filter(r=>r.selector.includes('.cmux-dashboard-next-actions'))){const hover=shared.find(r=>r.selector===base.selector+':hover:not(:disabled)')!;expect(hover.body).toContain('background: var(--cmux-hover)');}
});
it("empty history is hidden while its portal destination remains in the DOM",()=>{
  const host=document.createElement('div');host.className='cmux-dashboard-view';host.innerHTML='<details class="cmux-dashboard-chat-history"><summary>History</summary><div class="cmux-dashboard-chat-navigation"></div></details>';
  const details=host.querySelector('details')!,destination=host.querySelector('.cmux-dashboard-chat-navigation')!;
  const rule=rules(source('DashboardA.css')).find(r=>r.selector.includes('.cmux-dashboard-chat-history:has('))!;
  expect(rule).toBeDefined();expect(rule.body).toMatch(/display:\s*none/);expect(details.matches(rule.selector)).toBe(true);
  destination.innerHTML='<div class="cmux-archive-actions"><button>First</button></div>';
  expect(details.matches(rule.selector)).toBe(false);expect(host.querySelector('.cmux-dashboard-chat-navigation')).toBe(destination);
});

it("one-column header lane allows popups without affecting multiple-column lanes",()=>{
  const selector='.cmux-dashboard-view .cmux-dashboard-chat-columns[data-visible-columns="1"] .cmux-dashboard-chat-header .cmux-dashboard-chat-header-lane';
  const rule=rules(source('DashboardA.css')).find(r=>r.selector===selector)!;
  expect(rule).toBeDefined();expect(rule.body).toMatch(/overflow:\s*visible/);
  const host=document.createElement('div');host.className='cmux-dashboard-view';
  for(const count of [1,2,3,4,5]){
    host.innerHTML=`<div class="cmux-dashboard-chat-columns" data-visible-columns="${count}"><header class="cmux-dashboard-chat-header"><div class="cmux-dashboard-chat-header-lane"></div></header></div>`;
    const lane=host.querySelector('.cmux-dashboard-chat-header-lane')!;
    expect(lane.matches(rule.selector)).toBe(count===1);
    if(count===1){const clipped=all.find(r=>r.selector==='.cmux-dashboard-view .cmux-dashboard-chat-columns[data-visible-columns="1"] .cmux-dashboard-chat-header-lane'&&/overflow:\s*hidden/.test(r.body))!;expect(clipped).toBeDefined();expect(lane.matches(clipped.selector)).toBe(true);expect(rank(rule.selector)).toBeGreaterThan(rank(clipped.selector));}
  }
  host.innerHTML='<div class="cmux-dashboard-chat-header"><div class="cmux-dashboard-chat-header-lane"></div></div>';
  expect(host.querySelector('.cmux-dashboard-chat-header-lane')!.matches(rule.selector)).toBe(false);
});

it("toolbar display popup clears the old bottom anchor only for column options",()=>{
  const selector='.cmux-dashboard-view .cmux-dashboard-column-options > .cmux-dashboard-column-limit';
  const rule=rules(source('DashboardA.css')).find(r=>r.selector===selector)!;
  expect(rule).toBeDefined();expect(rule.body).toMatch(/bottom:\s*auto/);
  const previous=rules(source('DashboardChatSurface.css')).find(r=>r.selector===selector)!;
  expect(previous.body).toMatch(/bottom:\s*100%/);
  expect(all.filter(r=>r.selector===selector&&/bottom:/.test(r.body)).at(-1)?.body).toBe(rule.body);
  const host=document.createElement('div');host.className='cmux-dashboard-view';
  host.innerHTML='<details class="cmux-dashboard-column-options"><div class="cmux-dashboard-column-limit"></div></details><details class="cmux-dashboard-chat-history"><div class="cmux-dashboard-chat-navigation"></div></details><details class="cmux-dashboard-chat-details"><div class="cmux-dashboard-chat-detail-content"></div></details>';
  expect(host.querySelector('.cmux-dashboard-column-limit')!.matches(rule.selector)).toBe(true);
  for(const popup of host.querySelectorAll('.cmux-dashboard-chat-navigation,.cmux-dashboard-chat-detail-content'))expect(popup.matches(rule.selector)).toBe(false);
});
