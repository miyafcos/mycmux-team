import type { AgentDesignCatalog, DesignItem, DesignService, DesignSize } from "../../lib/agentDesignApi";
import { bytes, chars, number } from "./agentDesignStrings";

export const mapLayers = [3, 4, 5, 2, 6, 7] as const;
export const layerRoles = ["", "AI を動かす製品", "使うモデルと、許可する操作を決める", "AI の作業方針を決める", "過去に決めたことを探す", "作業の手順と、外の道具を用意する", "出来事や時刻に合わせて処理する", "必要なときに詳しい資料を開く"];
export const layerEffects = ["", "製品を変えると、組み込みの動作が変わります。", "使うモデルや、確認を求める操作が変わります。", "作業方針や、最初に読む量が変わります。", "過去の決定や詳しい記憶を探す道筋が変わります。", "手順の選びやすさや、使える道具が変わります。", "処理する場面・時刻・対象が変わります。", "参照できる情報や、資料の探しやすさが変わります。"];
export function dateTime(value: number | string | null | undefined): string {
  if (value == null) return "日時は未取得";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ja-JP", { hour12: false }) : "日時は未取得";
}
export function sizeText(size: DesignSize): string {
  const values = [size.chars == null ? null : chars(size.chars), size.lines == null ? null : number(size.lines) + " 行", size.bytes == null ? null : bytes(size.bytes)];
  return values.filter(Boolean).join(" · ") || "大きさは未計測";
}
export function sumSize(items: DesignItem[]): { size: DesignSize; partial: boolean } {
  const total = (key: keyof DesignSize) => {
    const values = items.map(item => item.size[key]).filter((value): value is number => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return { size: { chars: total("chars"), lines: total("lines"), bytes: total("bytes") }, partial: items.some(item => item.size.chars == null || item.size.bytes == null) };
}
export function itemRole(item: DesignItem, catalog: AgentDesignCatalog): string {
  if (["instruction", "override", "shadowedInstruction"].includes(item.kind)) {
    const root = catalog.services.find(service => service.id === item.service)?.root.replace(/\\/g, "/") ?? "";
    const path = item.path?.replace(/\\/g, "/") ?? "";
    const global = /^[a-z]:/i.test(root) ? path.toLowerCase().startsWith(root.toLowerCase() + "/") : path.startsWith(root + "/");
    return item.kind === "shadowedInstruction" ? "優先する別の指示がある文書" : global ? "共通の作業方針" : "この作業場所の作業方針";
  }
  return ({ memoryIndex: "詳しい記憶を探すための案内", memoryDirectory: "詳しい記憶のファイル", skillListing: "先に渡されるスキルの名前と説明", skill: "作業の進め方を教える手順", hooks: "出来事に合わせて動く処理の登録", script: "PC が実行する処理の台本", mcp: "外の道具との接続", plugins: "スキルや道具を追加するまとまり", rule: "条件に合うときの作業方針", agent: "別の担当に渡す指示", privateCount: "鍵のファイル（値は伏せて表示）" } as Record<string, string>)[item.kind] ?? layerRoles[item.layer] ?? "項目の内容を確認";
}
export function initialLayerChars(service: DesignService, layer: number): number | null {
  return ({ 3: service.context.instructions, 4: service.context.memory, 5: service.context.listing, 6: service.context.startup } as Record<number, number | null>)[layer] ?? null;
}
export function usageDefinition(layer: number): string {
  return ({ 1: "会話開始の記録は、製品の起動回数とは別です。", 2: "適用された設定と、設定ファイルを読んだ回数は別です。", 3: "設定上の条件と、指示が会話に入った記録は別です。", 4: "索引の掲載と、詳しい記憶の本文を読んだ記録は別です。", 5: "一覧への掲載・呼び出し・本文の読取・成功を分けて確認します。", 6: "登録件数と、処理が動いた記録・成功は別です。", 7: "読み込みの要求と、読み終えたこと・回答への反映は別です。" } as Record<number, string>)[layer];
}
export function documentAvailability(item: DesignItem, catalog: AgentDesignCatalog): string {
  if (item.status === "absent") return "ファイルがありません";
  const doc = catalog.documents[item.id];
  if (doc?.body != null) return "取得済みの本文";
  return "開いたときに本文・ファイルを取得";
}
