import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SkillsPanel } from "../../../src/components/skills/SkillsPanel";
import { SkillsIcon, AiLogIcon } from "../../../src/components/icons/ChromeIcons";
import { skillsApi, type SkillCatalog, type SkillDocument, type SkillLocations, type SkillRow, type SkillFolder } from "../../../src/lib/skillsApi";
import { searchSkills } from "../../../src/components/skills/skillSearch";
import { skillsStrings as s } from "../../../src/components/skills/skillsStrings";
import defaults from "../../../src-tauri/src/skills/defaults.json";
import "../../../src/global.css";

const categories = defaults.categories;
const labels = ["\u5317\u6597\u5b66\u9662\u306e\u691c\u53ce", "\u3072\u304b\u308a\u30b9\u30bf\u306e\u91cf\u7523", "\u30b5\u30f3\u30d7\u30eb\u4f01\u753b\u306e\u5831\u544a", "\u56f3\u3068\u8868\u306e\u78ba\u8a8d", "\u8cc7\u6599\u306e\u8aad\u307f\u76f4\u3057", "\u30b3\u30fc\u30c9\u306e\u30c6\u30b9\u30c8"];
const body = "# \u691c\u53ce\u306e\u624b\u9806\n\n\u5317\u6597\u5b66\u9662\u306e\u5408\u6210\u30c7\u30fc\u30bf\u3092\u4f7f\u3063\u3066\u78ba\u8a8d\u3057\u307e\u3059\u3002\n\n## \u3044\u3064\u4f7f\u3046\u304b\n\n\u539f\u7a3f\u306e\u691c\u53ce\u3092\u983c\u307e\u308c\u305f\u3068\u304d\u306b\u4f7f\u3044\u307e\u3059\u3002\n\n## \u9032\u3081\u65b9\n\n1. \u6b63\u672c\u3092\u8aad\u3080\n2. \u539f\u7a3f\u3068\u4ed5\u69d8\u3092\u7167\u3089\u3059\n3. \u5168\u6570\u3092\u5831\u544a\u3059\u308b\n\nHTML \u306e\u5831\u544a\u3082\u6271\u3044\u307e\u3059\u3002\n";
const html = "<h1>\u691c\u53ce\u306e\u624b\u9806</h1><p>\u5317\u6597\u5b66\u9662\u306e\u5408\u6210\u30c7\u30fc\u30bf\u3092\u4f7f\u3063\u3066\u78ba\u8a8d\u3057\u307e\u3059\u3002</p><h2>\u3044\u3064\u4f7f\u3046\u304b</h2><ul><li>\u539f\u7a3f\u306e\u691c\u53ce\u3092\u983c\u307e\u308c\u305f\u3068\u304d</li><li>\u4ed5\u69d8\u3068\u539f\u7a3f\u3092\u7167\u3089\u3057\u305f\u3044\u3068\u304d</li></ul><h2>\u9032\u3081\u65b9</h2><table><thead><tr><th>\u6bb5</th><th>\u78ba\u304b\u3081\u308b\u3053\u3068</th></tr></thead><tbody><tr><td>1</td><td>\u6b63\u672c\u3092\u8aad\u3080</td></tr><tr><td>2</td><td>\u5168\u6570\u3092\u7167\u3089\u3059</td></tr><tr><td>3</td><td>\u51fa\u529b\u3092\u5831\u544a\u3059\u308b</td></tr></tbody></table><h2>\u5831\u544a\u306e\u5f62</h2><p>HTML \u3067\u6839\u62e0\u3068\u8981\u5224\u65ad\u3092\u6b8b\u3057\u307e\u3059\u3002</p><pre><code>python check_sample.py --input sample.pdf</code></pre>";
const rows: SkillRow[] = Array.from({ length: 162 }, (_, index) => {
  const category = categories[index === 0 ? 1 : index % 12]; const id = index === 0 ? "sample-review" : `sample-${String(index).padStart(3, "0")}`;
  return { id, label: labels[index % labels.length] + (index > 5 ? ` ${index}` : ""), description: "\u539f\u7a3f\u3068\u4ed5\u69d8\u3092\u7167\u3089\u3057\u3001\u8a08\u7b97\u3068\u8868\u8a18\u3092\u78ba\u304b\u3081\u307e\u3059\u3002", line: index % 4 === 1 ? "HTML \u306e\u5831\u544a\u3092\u4f5c\u3063\u3066\u78ba\u304b\u3081\u308b" : "\u539f\u7a3f\u3092\u8aad\u307f\u3001\u4ed5\u69d8\u306b\u7167\u3089\u3057\u3066\u5831\u544a\u3059\u308b", kind: index < 130 ? "own" : index < 145 ? "plugin" : "builtin", plugin: null, category: category.id, symbol: category.symbol, glyph: "S", duplicateCodex: index === 0, hasWrapper: index === 0, agents: index === 0 || index % 3 ? ["claude", "codex"] : ["claude"], aliases: [], curation: "manual", isNew: index > 157, docPath: `C:/Synthetic/.claude/skills/${id}/SKILL.md`, calls: { claude: `/${id}`, codex: `$${id}` }, usageCount: 250 - index, usage: { claude: 160 - Math.min(index, 150), codex: 90 }, lastUsedAt: Date.now() - index * 86400000, body: index === 2 ? body.replace(/HTML/g, "PDF") : body, triggers: index % 5 === 0 ? ["HTML", "\u9001\u4ed8\u524d\u30c1\u30a7\u30c3\u30af"] : ["\u691c\u53ce"], modifiedAt: Date.now() - index * 86400000, fileSize: 4096, codexRecorded: true };
});
const catalog: SkillCatalog = { generatedAt: new Date().toISOString(), categories, skills: rows, hiddenSkills: [], hiddenCount: 0, newCount: 4 };
const document: SkillDocument = { frontmatter: { name: "sample-review", description: rows[0].description, "allowed-tools": ["Read", "Bash", "Glob"], metadata: { triggers: ["\u691c\u53ce", "\u9001\u4ed8\u524d\u306b\u78ba\u8a8d", "\u539f\u7a3f\u306e\u7167\u5408", "\u30ec\u30d3\u30e5\u30fc\u3057\u3066"], exclusions: ["\u914d\u4fe1"] } }, body, html, toc: [ {level:1,text:"\u691c\u53ce\u306e\u624b\u9806"}, {level:2,text:"\u3044\u3064\u4f7f\u3046\u304b"}, {level:2,text:"\u9032\u3081\u65b9"}, {level:2,text:"\u5831\u544a\u306e\u5f62"} ], size: 4096, lines: 84, modifiedAt: Date.now() };
const locations: SkillLocations = { id: "sample-review", duplicateCodex: true, codexCount: 2, items: [
  {path:"C:/Synthetic/.claude/skills/sample-review/SKILL.md",folder:"C:/Synthetic/.claude/skills/sample-review",relation:"source",modifiedAt:Date.now(),lines:84,fileCount:12,allowImplicitInvocation:null,target:null,targetExists:null,descriptionSame:null,sameContent:null,description:"Current",originalDescription:"Current",hash:"a"},
  {path:"C:/Synthetic/.codex/skills/sample-review/SKILL.md",folder:"C:/Synthetic/.codex/skills/sample-review",relation:"wrapper",modifiedAt:Date.now()-86400000*50,lines:14,fileCount:2,allowImplicitInvocation:false,target:"C:/Synthetic/.claude/skills/sample-review/SKILL.md",targetExists:true,descriptionSame:false,sameContent:null,description:"Old",originalDescription:"Current",hash:"b"},
  {path:"C:/Synthetic/.agents/skills/sample-review/SKILL.md",folder:"C:/Synthetic/.agents/skills/sample-review",relation:"copy",modifiedAt:Date.now()-86400000*90,lines:32,fileCount:4,allowImplicitInvocation:false,target:null,targetExists:null,descriptionSame:null,sameContent:false,description:"Old copy",originalDescription:"Current",hash:"c"},
] };
const folder: SkillFolder = {
  root: "C:/Synthetic/.claude/skills/sample-review", rootName: "sample-review", single: false,
  files: [
    { path:"SKILL.md", name:"SKILL.md", depth:0, dir:false, size:4096, kind:"md", reason:null },
    { path:"scripts/check.py", name:"check.py", depth:1, dir:false, size:842, kind:"text", reason:null },
    { path:"reference/notes.md", name:"notes.md", depth:1, dir:false, size:1220, kind:"md", reason:null },
    { path:"reports/result.json", name:"result.json", depth:1, dir:false, size:2048, kind:"text", reason:"output" },
    { path:"logs/run.log", name:"run.log", depth:1, dir:false, size:1040, kind:"text", reason:"record" },
    { path:"__pycache__/check.pyc", name:"check.pyc", depth:1, dir:false, size:884, kind:"binary", reason:"cache" },
  ], entries: [], blocked: [{path:"private.env",name:"private.env",reason:"private"}],
  selected:["SKILL.md","scripts/check.py","reference/notes.md"], size:6158, limits:{bytes:50*1024*1024,files:5000},
};
folder.entries = [{path:"SKILL.md", name:"SKILL.md", depth:0, dir:false, size:4096, kind:"md"},
  ...["scripts","reference","reports","logs","__pycache__"].flatMap(path => {
    const children = folder.files.filter(file=>file.path.startsWith(path+"/"));
    return [{path,name:path,depth:0,dir:true,size:children.reduce((sum,file)=>sum+file.size,0),kind:"folder"}, ...children];
  })];
const api: typeof skillsApi = { ...skillsApi, peek: () => catalog, cached: async () => catalog, refresh: async () => catalog, document: async () => document, locations: async () => locations, folder: async () => folder, preview: async (_id, relative) => ({ kind:relative.endsWith(".md") ? "md" : "text", path:folder.root+"/"+relative, content:relative.endsWith(".md") ? body : "# Synthetic script\nprint(\"Checked\")\n", html }),
  diff: async () => ({ truncated:false, lines:[{kind:"equal",left:1,right:1,text:"name: sample-review"},{kind:"remove",left:2,text:"description: Old review"},{kind:"add",right:2,text:"description: Current review"},{kind:"add",right:3,text:"metadata:"},{kind:"add",right:4,text:"  triggers: [review, verify]"}] }) };
const light = new URLSearchParams(location.search).get("theme") === "light";
documentGlobalTheme();
function documentGlobalTheme() {
  globalThis.document.body.dataset.cmuxThemedRoot = "true"; globalThis.document.body.style.margin = "0";
  globalThis.document.body.style.background = light ? "#eeeef1" : "#101010";
  if (light) for (const [key,value] of Object.entries({ "--cmux-bg":"#fff","--cmux-surface":"#f6f6f8","--cmux-surface-raised":"#f0f0f3","--cmux-text":"#202124","--cmux-text-secondary":"#595b60","--cmux-hover":"rgba(0,0,0,.04)","--cmux-selected":"rgba(10,132,255,.1)","--cmux-border":"rgba(0,0,0,.13)","--cmux-border-hairline":"rgba(0,0,0,.08)","--cmux-accent":"#007aff","--cmux-title-bg":"#e8e8eb" })) globalThis.document.body.style.setProperty(key,value);
}
function Harness() {
  const [open,setOpen] = useState(true);
  (globalThis as unknown as { skillsHarness: unknown }).skillsHarness = { open: () => setOpen(true), close: () => setOpen(false), search: (term: string) => searchSkills(rows,term), catalog };
  return <><header style={{height:36,display:"flex",alignItems:"center",padding:"0 12px",gap:10,color:"var(--cmux-text-secondary)"}}><span>{labels[0]}</span><span style={{flex:1}} /><AiLogIcon /><button title={s.title} aria-label={s.title} onClick={() => setOpen(true)}><SkillsIcon /></button></header>{open && <SkillsPanel open onClose={() => setOpen(false)} api={api} initialCatalog={catalog} />}</>;
}
createRoot(globalThis.document.getElementById("root")!).render(<Harness />);
