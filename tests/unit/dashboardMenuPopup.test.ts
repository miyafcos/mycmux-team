// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { syncDashboardMenuPopup } from "../../src/components/dashboard/dashboardMenuKeys";
afterEach(()=>{document.body.innerHTML="";});
it("lifts a clipped first-column menu into the native top layer and restores it on close",()=>{
  document.body.innerHTML='<article class="cmux-dashboard-chat-column"><details open><summary>Fictional menu</summary><div data-dashboard-menu-popup>Fictional actions</div></details></article>';
  const column=document.querySelector("article")!,menu=document.querySelector("details")!,panel=menu.querySelector<HTMLElement>("div")!,summary=menu.querySelector("summary")!;
  vi.spyOn(column,"getBoundingClientRect").mockReturnValue({left:208,right:312,top:50,bottom:800,width:104,height:750} as DOMRect);
  vi.spyOn(panel,"getBoundingClientRect").mockReturnValue({left:72,right:312,top:110,bottom:410,width:240,height:300} as DOMRect);
  vi.spyOn(summary,"getBoundingClientRect").mockReturnValue({left:260,right:300,top:70,bottom:100,width:40,height:30} as DOMRect);
  panel.showPopover=vi.fn();panel.hidePopover=vi.fn();
  syncDashboardMenuPopup(menu);
  expect(panel.showPopover).toHaveBeenCalledTimes(1);expect(panel.getAttribute("popover")).toBe("manual");
  expect(panel.style.position).toBe("fixed");expect(panel.style.left).toBe("60px");expect(panel.style.top).toBe("100px");
  expect(panel.closest("details")).toBe(menu);
  menu.open=false;syncDashboardMenuPopup(menu);
  expect(panel.hidePopover).toHaveBeenCalledTimes(1);expect(panel.hasAttribute("popover")).toBe(false);expect(panel.style.position).toBe("");
});
it("retains ordinary inline menus when they fit inside the column",()=>{
  document.body.innerHTML='<article class="cmux-dashboard-chat-column"><details open><summary>Fictional menu</summary><div data-dashboard-menu-popup>Fictional actions</div></details></article>';
  const column=document.querySelector("article")!,menu=document.querySelector("details")!,panel=menu.querySelector<HTMLElement>("div")!;
  vi.spyOn(column,"getBoundingClientRect").mockReturnValue({left:208,right:742,top:50,bottom:800} as DOMRect);
  vi.spyOn(panel,"getBoundingClientRect").mockReturnValue({left:402,right:742,top:100,bottom:400} as DOMRect);
  panel.showPopover=vi.fn();syncDashboardMenuPopup(menu);
  expect(panel.showPopover).not.toHaveBeenCalled();expect(panel.hasAttribute("popover")).toBe(false);
});
