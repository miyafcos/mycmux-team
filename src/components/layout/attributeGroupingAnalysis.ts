import { boundedGroupingWait } from "../../lib/groupingWaits";
import { paneRegistry } from "../../lib/paneEvidence";
import { evidenceAnalysis, runEvidenceGroupingAnalysis } from "./evidenceGrouping";
import {
  ATTRIBUTE_GROUPING_VERSION, buildAttributeGrouping, buildAttributeGroupingPrompt,
  collectAttributeTabs, fallbackAttributeGrouping,
} from "./attributeGrouping";
import type { GroupingAnalysisDependencies, GroupingAnalysisResult } from "./tabGrouping";
import { withRequestedGroupingPlan } from "./groupingLocalPlan";

/** The attribute prompt and the Jev role schema use the same bounded coordinator. */
export async function analyzeAttributeWithEvidence(
  deps: GroupingAnalysisDependencies, aiEnabled: boolean, useJev: boolean,
  abort: (requestId: string) => Promise<unknown>,
  mode: "background" | "foreground" = "foreground",
): Promise<GroupingAnalysisResult> {
  const startedAt = Date.now();
  deps.onProgress?.("scanning");
  const scan = await deps.scan(), registry = paneRegistry();
  let attribute = fallbackAttributeGrouping(scan, registry, aiEnabled ? "判定待ち" : "AI がオフ");
  let raw = "", attributeRetryable = false;
  if (aiEnabled && scan.tabs.length) {
    deps.onProgress?.("judging");
    try {
      raw = await deps.judge(ATTRIBUTE_GROUPING_VERSION + "\n" + buildAttributeGroupingPrompt(collectAttributeTabs(scan, registry), registry), deps.requestId());
      attribute = buildAttributeGrouping(scan, registry, raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String((error as { code?: unknown })?.code ?? error);
      if (reason === "cancelled" || reason === "grouping_precompute_obsolete") throw error;
      const message = reason === "timeout" ? "時間切れ"
        : reason === "grouping_precompute_background_gate" ? "今日の上限または待機条件"
          : reason === "cli_failed" ? "AI の呼び出しに失敗" : reason || "呼び出しの失敗";
      attribute = fallbackAttributeGrouping(scan, registry, message);
      attributeRetryable = true;
    }
  }
  let result = evidenceAnalysis(scan);
  if (useJev) {
    let activeRoleRequest: string | null = null;
    try {
      // Leave time to publish the attribute result even if the optional role service stalls.
      result = await boundedGroupingWait(runEvidenceGroupingAnalysis({ ...deps, scan: async () => scan,
        judge: (prompt, requestId) => { activeRoleRequest = requestId; return deps.judge(prompt, requestId); } }, true),
        mode === "background" ? 30_000 : Math.max(1, 55_000 - (Date.now() - startedAt)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "cancelled" || reason === "grouping_precompute_obsolete") throw error;
      if (activeRoleRequest) void abort(activeRoleRequest).catch(() => {});
      attribute.issues.push({ id: "role", kind: "役割の判定なし", detail: reason });
    }
  }
  deps.onProgress?.("validating");
  if (result.parsed.status === "ok") result = { ...result, raw, parsed: { ...result.parsed, raw,
    droppedPlans: attribute.issues.map(issue => ({ scope: "response", reason: `${issue.id}: ${issue.kind} (${issue.detail})` })) } };
  return { ...withRequestedGroupingPlan(result, "attribute", attribute.plan), ...(attributeRetryable ? { attributeRetryable: true } : {}) };
}
