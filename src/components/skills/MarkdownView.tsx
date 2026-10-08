import { useEffect, useRef } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { skillsStrings as s } from "./skillsStrings";
import "./skills.css";

export function MarkdownView({ html, query = "", notify, headingPrefix = "skill-heading" }: { html: string; query?: string; notify: (message: string) => void; headingPrefix?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = root.current; if (!host) return;
    host.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => { heading.id = `${headingPrefix}-${index}`; });
    const term = query.trim().toLocaleLowerCase(); if (!term) return;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent ?? ""; const lower = text.toLocaleLowerCase(); let at = 0, next = lower.indexOf(term);
      if (next < 0) continue; const fragment = document.createDocumentFragment();
      while (next >= 0) { fragment.append(text.slice(at, next)); const mark = document.createElement("mark"); mark.textContent = text.slice(next, next + term.length); fragment.append(mark); at = next + term.length; next = lower.indexOf(term, at); }
      fragment.append(text.slice(at)); node.replaceWith(fragment);
    }
  }, [html, query, headingPrefix]);
  return <div ref={root} className="skills-markdown" onClick={event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a"); if (!link) return; event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) root.current?.querySelectorAll<HTMLElement>("[id]").forEach(el => { if (`#${el.id}` === href) el.scrollIntoView({ block: "start" }); });
    else if (/^(https?:\/\/|mailto:)/i.test(href)) void shellOpen(href).catch(error => notify(s.error(String(error))));
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
