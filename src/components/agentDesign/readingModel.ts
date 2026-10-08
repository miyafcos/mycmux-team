import type { AgentDesignCatalog, DesignItem, DesignService } from "../../lib/agentDesignApi";
export type ReadingStep = AgentDesignCatalog["readingFlows"][number]["steps"][number];
export const stepIds = ["settings", "instructions", "memory", "listing", "startup", "request", "tools", "conditional", "skillBody", "references", "response", "end"];
export const stepLayers = [2, 3, 4, 5, 6, 6, 6, 3, 5, 7, 6, 6];
export const stageEvents: Record<string, string[]> = { startup: ["SessionStart"], request: ["UserPromptSubmit", "UserPrompt"], tools: ["PreToolUse", "PostToolUse", "PreToolCall", "PostToolCall"], response: ["Stop", "AfterAgent", "Response"], end: ["SessionEnd"] };
export const phaseNames = ["起動", "会話の始め", "依頼", "道具を使う", "返事", "会話の終わり"];
export const phaseSteps = [[0], [1, 2, 3, 4], [5, 7], [6, 8, 9], [10], [11]];
export const stepDescriptions = ["モデルと、許可する操作を用意。設定は会話の本文とは別です。", "共通と作業場所の指示を読む。条件つきの指示は別の段で追加します。", "詳しい記憶を探す案内を先に読む。詳しい本文とは別です。", "名前と説明が先に渡されます。掲載は本文を読んだ証拠とは別です。", "会話の始めに動く処理。出力の量と登録件数を分けます。", "依頼が入った場面の処理。登録は実行済みの証拠とは別です。", "道具を使う前後の処理。AIが読む文書とは別の処理です。", "作業場所やファイルの条件が合ったときに追加する指示。", "必要なスキルの手順を開く。初期一覧の量には含めません。", "参照資料や詳しい記憶を必要なときに開く。", "返事に伴う処理。回答の内容や成功を証明するものではありません。", "会話の終了時の処理。時刻で動く作業は会話の外です。"];
export function stepItems(catalog: AgentDesignCatalog, service: DesignService, index: number): DesignItem[] {
  const kinds = [["settings", "settingsLocal", "permissionRules"], ["instruction", "override", "rule"], ["memoryIndex"], ["skillListing"], ["hooks", "script"], ["hooks", "script"], ["hooks", "script"], ["rule", "instruction"], ["skill", "command"], ["reference", "memoryDirectory"], ["hooks", "script"], ["hooks", "script"]][index];
  const events = stageEvents[stepIds[index]];
  const scripts = events ? service.hooks.filter(hook => events.includes(hook.event)).map(hook => hook.script) : [];
  return catalog.items.filter(item => item.service === service.id && kinds.includes(item.kind)
    && (index !== 1 || (item.active && item.readTiming === "always"))
    && (index !== 7 || item.readTiming === "conditional")
    && (!events || item.kind === "hooks" || scripts.some(script => item.displayName === script || item.path?.replace(/\\/g, "/").endsWith("/" + script))));
}
export function readingSteps(catalog: AgentDesignCatalog, service: DesignService): ReadingStep[] {
  if (service.id === "hermes") return catalog.readingFlows.find(flow => flow.service === "hermes")?.steps ?? [];
  const declared = catalog.readingFlows.find(flow => flow.service === service.id)?.steps;
  const quantities = [null, service.context.instructions, service.context.memory, service.context.listing, service.context.startup];
  return stepIds.map((id, index) => {
    const saved = declared?.find(step => step.id === id);
    return { id, stage: [0, 1, 1, 1, 1, 2, 3, 4, 4, 4, 5, 6][index], timing: index === 0 || index > 9 ? "outside" : index < 5 ? "always" : index === 7 ? "conditional" : index === 8 || index === 9 ? "onDemand" : "event",
      chars: saved?.chars ?? quantities[index] ?? null, evidence: saved?.evidence ?? (index === 3 && quantities[index] != null ? "measured" : "declaration"),
      itemIds: stepItems(catalog, service, index).map(item => item.id),
      hookScripts: saved?.hookScripts ?? service.hooks.filter(hook => stageEvents[id]?.includes(hook.event)).map(hook => hook.script) };
  });
}
