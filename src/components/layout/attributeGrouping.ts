import { resolvePaneIdentities, type ProjectReason, type ProjectRegistration } from "../../lib/paneIdentity";
import type { GroupingScan, GroupingPlan } from "./tabGrouping";
import { bundleAttributeGrouping } from "./attributeGroupingBundle";
import { attributeDefaultShort } from "./attributeGroupingNames";
export { bundleAttributeGrouping } from "./attributeGroupingBundle";

export const ATTRIBUTE_GROUPING_VERSION = "attribute-grouping-v4";
export const ATTRIBUTE_BIG_PROJECT_TABS = 4;
export const ATTRIBUTE_BUNDLE_MAX_PROJECTS = 3;
export const ATTRIBUTE_BUNDLE_MAX_TABS = 8;
export const ATTRIBUTE_HOST_MAX_GUESTS = 2;
export const ATTRIBUTE_HOST_MAX_TABS = 16;
export const ATTRIBUTE_WORKING_WORKSPACE = "稼働";
export const ATTRIBUTE_VALUES = ["編集・制作", "アプリ・開発", "整理・事務", "不明"] as const;
export type ProjectAttribute = typeof ATTRIBUTE_VALUES[number];
export interface AttributeIssue { id: string; kind: string; detail: string }
export interface AttributeTab {
  id: string; tabId: string; workspaceId: string; workspaceName: string;
  title: string; label: string; cwd: string; registration: ProjectRegistration | null;
  fixedProject: string; fixedShort: string; fixedKey: string; projectReason: ProjectReason; pinned: boolean;
}
export interface JudgedAttributeTab extends AttributeTab {
  project: string; source: "fixed" | "ai" | "rejected"; confidence: number; evidence: string;
}
export interface AttributeProject {
  name: string; short: string; attribute: ProjectAttribute; evidence: string; tabIds: string[];
}
export interface AttributeUnit extends AttributeProject { movable: string[] }
export interface AttributeBundle {
  kind: "単独" | "まとめ" | "同居"; attribute: ProjectAttribute; units: AttributeUnit[];
  how: string; keepsWorkspaceId: string | null; name: string; renameHint: string | null; tabIds: string[];
}
export interface AttributeMove { id: string; tabId: string; from: string; to: string }
export interface AttributeGroupingResult {
  tabs: JudgedAttributeTab[]; projects: AttributeProject[]; issues: AttributeIssue[];
  groups: AttributeBundle[]; moves: AttributeMove[]; plan: GroupingPlan; fallbackReason?: string;
}
interface AiProject { name: string; short: string; attribute: ProjectAttribute; evidence: string }
export interface AttributeJudgement {
  tabs: JudgedAttributeTab[]; projects: AttributeProject[]; issues: AttributeIssue[];
  bundles: Array<{ projects: string[]; reason: string }>;
}
const FIXED_REASONS = new Set<ProjectReason>(["folder_registry", "folder_words", "alias", "lineage"]);
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const normalizeAttributeName = (value: string): string => value.replace(/[\s・/_\-\.]+/gu, "").toLowerCase();
export const stripAttributeParenthesis = (value: string): string => value.replace(/\s*[（(][^）)]*[）)]\s*$/u, "").trim();
const pathKey = (value: string): string => value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
export const attributeNamePrefix = (value: string, count = 8): string => [...value].slice(0, count).join("");
function registeredAt(cwd: string, registry: readonly ProjectRegistration[]): ProjectRegistration | null {
  const key = pathKey(cwd);
  return [...registry].filter(entry => {
    const path = pathKey(entry.path);
    return path && (key === path || key.startsWith(path + "/"));
  }).sort((a, b) => pathKey(b.path).length - pathKey(a.path).length)[0] ?? null;
}

/** Request IDs follow the scan order; persistent IDs and source order are unchanged. */
export function collectAttributeTabs(scan: GroupingScan, registry: readonly ProjectRegistration[]): AttributeTab[] {
  const identities = resolvePaneIdentities({
    registry, workspaces: scan.workspaces, tabs: scan.tabs.map(tab => ({ ...tab, parentTabId: tab.origin?.parentTabId })),
  });
  const pinned = new Set(scan.workspaces.flatMap(workspace => workspace.panes.flatMap(pane =>
    pane.pinnedTabId ? [pane.pinnedTabId] : [])));
  return scan.tabs.map((tab, index) => {
    const identity = identities.tabs.get(tab.id);
    const fixed = identity?.project && FIXED_REASONS.has(identity.projectReason) ? identity.project : null;
    return {
      id: `p${index + 1}`, tabId: tab.id, workspaceId: tab.workspaceId, workspaceName: tab.workspaceName,
      title: tab.displayName?.trim() || tab.sessionTitle?.trim() || tab.taskTitle?.trim() || "",
      label: tab.label.trim(), cwd: tab.cwd, registration: registeredAt(tab.cwd, registry),
      fixedProject: stripAttributeParenthesis(fixed?.display ?? ""), fixedShort: fixed?.short ?? "",
      fixedKey: fixed?.key ?? "", projectReason: identity?.projectReason ?? null, pinned: pinned.has(tab.id),
    };
  });
}

export function buildAttributeGroupingPrompt(tabs: readonly AttributeTab[], registry: readonly ProjectRegistration[]): string {
  const registrations = registry.map(entry => `- [${entry.section === "anken" ? "案件" : "開発"}] ${entry.label}`);
  const lines = tabs.map(tab => {
    const parts = [`id=${tab.id}`, `題名=${tab.title || "(なし)"}`];
    if (tab.label && tab.label !== tab.title) parts.push(`ラベル=${tab.label}`);
    const cwd = tab.cwd.replace(/\\/gu, "/").replace(/\/+$/u, "")
      .replace(/^[a-z]:\/users\/[^/]+(?=\/|$)/iu, "~").replace(/^\/home\/[^/]+(?=\/|$)/u, "~")
      .replace(/^\/Users\/[^/]+(?=\/|$)/u, "~");
    parts.push(`フォルダ=${cwd || "~"}`);
    if (tab.registration) parts.push(`登録=${tab.registration.label}`);
    if (tab.fixedProject) parts.push(`案件=${tab.fixedProject} (確定)`);
    return "- " + parts.join(" | ");
  });
  return `あなたは端末アプリ mycmux のタブ再配置の判定役です。ツールは使わず、この文面だけで答えてください。
やることは 3 つです。(1) 各タブがどの案件の仕事かを決める。(2) 案件ごとに属性を 1 つ決める。(3) 小さい案件を組み合わせる。

「案件=… (確定)」と書いたタブは、その案件のまま変えないでください。

案件の決め方 (確定していないタブ):
- 案件登録にある取引先・商品・アプリ (例: ひかりスタ、北斗学院、サンプル企画) の仕事なら、その名前にする
- フォルダ名に案件登録の名前やそのローマ字・英字が入っていれば (例: hikarista_… はひかりスタ、mycmux-wt-… は mycmux)、その案件とする
- 登録にない仕事は、タブの題名にあるテーマをそのまま案件名にする (例: 「来期の予算計算」「PCの保守」)
- 同じ案件・同じテーマのタブは、すべて同じ名前にそろえる
- 名前は、その案件のいずれかのタブの題名・ラベル・フォルダ、またはフォルダが一致した登録の名前とその / 区切りの部分にある語だけで書く。登録一覧に載っているだけの名前や新しい言葉は使わない。「運用」「教材」「開発」「作業」のような総称は使わない
- 題名とフォルダが食い違うときは題名を優先する。ただし確定の案件は変えない
- 題名が無いか「作業内容未取得」で、ラベルもフォルダもホーム (~) だけのタブは、project を空文字にする

属性 (案件ごとに 1 つ):
- 編集・制作: 教材・スライド・動画・原稿・問題・校正など、取引先へ納める物を作る仕事
- アプリ・開発: mycmux や自作ツール、AI ツールの設定・調査・改善など、道具を作る・整える仕事
- 整理・事務: 見積・請求・予算・シフト・振り返り・PC の保守・記録やメモの整理など、運営の仕事
- 不明: 材料から属性を決められない案件
登録の区分 ([案件] / [開発]) は手がかりにしてよいが、中身で決める。

案件の short は、案件名の一部をそのまま切り出した 2〜8 字の呼び名 (例: 「記録の整理と振り返り」→「振り返り」)。案件名が短ければ同じでよい。

組み合わせ (bundles):
- タブが 3 つ以下の小さい案件を、属性が同じで中身の近いものどうし 2〜3 個ずつ組にする。1 組は 8 タブまで
- 中身が近いとは、同じ道具・同じ取引先・同じ種類の仕事 (例: AI ツールの設定どうし、記録の整理どうし、校正どうし) のこと
- 1 つの案件は 1 つの組にだけ入れる。近い相手がいない案件は組に入れなくてよい
- タブが 4 つ以上の案件は組に入れない

案件登録の一覧:
${registrations.join("\n")}

タブの一覧:
${lines.join("\n")}

出力は次の形の JSON だけにしてください (前後に文章やコードフェンスを付けない)。panes には全タブを 1 回ずつ出してください。projects には確定の案件も含め、使った案件をすべて出してください。
{"projects":[{"name":"…","short":"…","attribute":"編集・制作|アプリ・開発|整理・事務|不明","evidence":"根拠"}],"panes":[{"id":"p1","project":"… (不明なら空文字)","confidence":0.9,"evidence":"根拠"}],"bundles":[{"projects":["案件名A","案件名B"],"reason":"中身が近い理由"}]}`;
}

export function parseAttributeGroupingOutput(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("JSON を読めません");
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { throw new Error("JSON を読めません"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(object(parsed).panes) || !Array.isArray(object(parsed).projects)) throw new Error("JSON の形が不正です");
  return object(parsed);
}

export function attributeNameHasMaterial(name: string, tabs: readonly JudgedAttributeTab[]): boolean {
  const key = normalizeAttributeName(name);
  return Boolean(key) && tabs.some(tab => {
    if (tab.source === "fixed" && normalizeAttributeName(tab.fixedProject) === key) return true;
    const material = normalizeAttributeName([tab.title, tab.label, tab.cwd].join(" "));
    const label = stripAttributeParenthesis(tab.registration?.label ?? "");
    return material.includes(key) || [label, ...label.split("/")].some(part => normalizeAttributeName(part) === key);
  });
}

function registeredAttribute(tab: AttributeTab, registry: readonly ProjectRegistration[]): ProjectAttribute {
  const registration = tab.registration ?? registry.find(entry => stripAttributeParenthesis(entry.label) === stripAttributeParenthesis(tab.fixedKey));
  return registration?.section === "anken" ? "編集・制作" : registration?.section === "dev" ? "アプリ・開発" : "不明";
}

export function judgeAttributeGrouping(tabs: readonly AttributeTab[], ai: Record<string, unknown>, registry: readonly ProjectRegistration[] = []): AttributeJudgement {
  const issues: AttributeIssue[] = [];
  const note = (id: string, kind: string, detail: string) => issues.push({ id, kind, detail });
  const info = new Map<string, AiProject>();
  for (const value of array(ai.projects)) {
    const project = object(value);
    const name = stripAttributeParenthesis(text(project.name));
    if (!normalizeAttributeName(name)) continue;
    let attribute = text(project.attribute) as ProjectAttribute;
    if (!ATTRIBUTE_VALUES.includes(attribute)) {
      note(name, "属性が一覧外", text(project.attribute)); attribute = "不明";
    }
    let short = text(project.short);
    if (!short || !name.includes(short) || [...short].length > 8) {
      if (short) note(name, !name.includes(short) ? "呼び名が名前の一部でない" : "呼び名が長すぎる",
        `「${short}」→「${attributeDefaultShort(name)}」`);
      short = attributeDefaultShort(name);
    }
    info.set(normalizeAttributeName(name), { name, short, attribute, evidence: text(project.evidence) });
  }
  const answers = new Map<string, Record<string, unknown>>();
  const ids = new Set(tabs.map(tab => tab.id));
  for (const value of array(ai.panes)) {
    const answer = object(value), id = text(answer.id);
    if (!ids.has(id)) { note(id, "存在しないタブ", "返答だけにある ID"); continue; }
    if (answers.has(id)) note(id, "重複", "AI が 2 回以上出した");
    answers.set(id, answer);
  }
  const judged: JudgedAttributeTab[] = tabs.map(tab => {
    const answer = answers.get(tab.id) ?? {};
    if (!answers.has(tab.id)) note(tab.id, "欠落", "AI の出力にない");
    let project = stripAttributeParenthesis(text(answer.project));
    if (tab.fixedProject) {
      if (project && normalizeAttributeName(project) !== normalizeAttributeName(tab.fixedProject))
        note(tab.id, "確定を上書きしかけた", `AI「${project}」→ 確定「${tab.fixedProject}」`);
      project = tab.fixedProject;
    }
    return { ...tab, project, source: tab.fixedProject ? "fixed" : "ai",
      confidence: typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : 0,
      evidence: tab.fixedProject ? `確定: ${tab.projectReason}` : text(answer.evidence) };
  });
  const members = new Map<string, JudgedAttributeTab[]>();
  for (const tab of judged) if (tab.project) {
    const key = normalizeAttributeName(tab.project);
    members.set(key, [...(members.get(key) ?? []), tab]);
  }
  const rejectedAttributes = new Map<string, AiProject>();
  for (const [key, items] of members) {
    if (!attributeNameHasMaterial(items[0].project, items)) {
      for (const tab of items) {
        const rejected = info.get(key);
        note(tab.id, "名前の材料なし", `「${tab.project}」を題名のテーマへ差し戻し`);
        tab.project = tab.title && !tab.title.includes("作業内容未取得") ? stripAttributeParenthesis(tab.title) : "";
        tab.source = "rejected";
        if (rejected) {
          rejectedAttributes.set(tab.id, rejected);
          note(tab.id, "差し戻しで属性を引き継ぐ", `AI「${rejected.name}」→「${tab.project || "(不明)"}」: ${rejected.attribute}`);
        }
      }
    } else if (!info.has(key) && !items.some(tab => tab.fixedProject)) note(items[0].project, "属性なし", "projects に無い案件 → 不明");
  }
  const projects = new Map<string, AttributeProject>();
  for (const tab of judged) {
    if (!normalizeAttributeName(tab.project)) { tab.project = ""; continue; }
    const key = normalizeAttributeName(tab.project), matching = info.get(key);
    const fixed = judged.find(candidate => candidate.fixedProject && normalizeAttributeName(candidate.fixedProject) === key);
    const name = fixed?.fixedProject ?? matching?.name ?? tab.project;
    tab.project = name;
    let short = matching?.short ?? fixed?.fixedShort ?? attributeDefaultShort(name);
    if (!short || !name.includes(short) || [...short].length > 8) short = attributeDefaultShort(name);
    let project = projects.get(key);
    if (!project) {
      const attributeInfo = tab.source === "rejected" ? rejectedAttributes.get(tab.id) : matching;
      let attribute = attributeInfo?.attribute ?? "不明", evidence = attributeInfo?.evidence ?? "";
      if (fixed && attribute === "不明") {
        const candidates = [...info].filter(([candidate, value]) => value.attribute !== "不明"
          && (candidate.includes(key) || key.includes(candidate)));
        if (candidates.length === 1) {
          const inferred = candidates[0][1];
          attribute = inferred.attribute; evidence = inferred.evidence;
          note(name, "確定案件の属性を補完", `AI名の包含: 「${inferred.name}」→${attribute}`);
        } else {
          attribute = judged.filter(member => member.fixedProject && normalizeAttributeName(member.fixedProject) === key)
            .map(member => registeredAttribute(member, registry)).find(value => value !== "不明") ?? "不明";
          note(name, "確定案件の属性を補完", attribute === "不明"
            ? `不明: AI名の包含候補${candidates.length}件、登録の区分なし`
            : `登録の区分: ${attribute} (AI名の包含候補${candidates.length}件)`);
        }
      }
      project = { name, short, attribute, evidence, tabIds: [] };
    }
    project.tabIds.push(tab.id); projects.set(key, project);
  }
  return { tabs: judged, projects: [...projects.values()], issues, bundles: array(ai.bundles).map(value => {
    const bundle = object(value);
    return { projects: array(bundle.projects).map(text), reason: text(bundle.reason) };
  }) };
}

export function buildAttributeGrouping(scan: GroupingScan, registry: readonly ProjectRegistration[], raw: string): AttributeGroupingResult {
  return bundleAttributeGrouping(scan, judgeAttributeGrouping(collectAttributeTabs(scan, registry), parseAttributeGroupingOutput(raw), registry));
}

export function fallbackAttributeGrouping(scan: GroupingScan, registry: readonly ProjectRegistration[], reason: string): AttributeGroupingResult {
  const tabs = collectAttributeTabs(scan, registry), projects = new Map<string, Record<string, unknown>>();
  for (const tab of tabs) if (tab.fixedProject) {
    projects.set(tab.fixedProject, { name: tab.fixedProject, short: tab.fixedShort,
      attribute: registeredAttribute(tab, registry), evidence: "登録の区分" });
  }
  return bundleAttributeGrouping(scan, judgeAttributeGrouping(tabs, { projects: [...projects.values()],
    panes: tabs.map(tab => ({ id: tab.id, project: tab.fixedProject })), bundles: [] }, registry), reason);
}
