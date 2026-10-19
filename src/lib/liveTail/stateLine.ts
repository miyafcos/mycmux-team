import type { SessionAttentionKind } from "../ipc";
import type { LiveTailCrop } from "./crop";
import type { LiveTailFact } from "./facts";

export interface LiveTailStateLineInput {
  fact: Readonly<LiveTailFact>;
  status: "working" | "waiting" | "idle" | "unknown";
  attentionKind: SessionAttentionKind | null;
  attentionSince?: number | null;
  cropState: LiveTailCrop["state"] | null;
  now: number;
}

export interface LiveTailStateLine {
  text: string;
  tone: "waiting" | "progress" | "cmd" | "stopped" | "neutral";
  badge: string | null;
}

function elapsedSeconds(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1_000)) : 0;
}

export function formatLiveTailAgo(ms: number): string {
  const seconds = elapsedSeconds(ms), minutes = Math.floor(seconds / 60);
  if (seconds < 60) return `${seconds}秒前`;
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60), remaining = minutes % 60;
  if (hours < 24) return `${hours}時間${remaining ? `${remaining}分` : ""}前`;
  return `${Math.floor(hours / 24)}日前`;
}

export function formatLiveTailDuration(ms: number): string {
  const seconds = elapsedSeconds(ms), minutes = Math.floor(seconds / 60);
  if (seconds < 60) return `${seconds}秒`;
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** Ordered task presentation; acquisition clocks never establish a state age. */
export function liveTailStateLine({
  fact, status, attentionKind, attentionSince, cropState, now,
}: LiveTailStateLineInput): LiveTailStateLine | null {
  const line = (text: string, tone: LiveTailStateLine["tone"], badge: string | null = null): LiveTailStateLine => ({ text, tone, badge });
  const attentionTime = (text: string, suffix = "から") => typeof attentionSince === "number"
    && Number.isFinite(attentionSince) && attentionSince > 0
    ? `${text} · ${formatLiveTailAgo(now - attentionSince)}${suffix}` : text;
  if (attentionKind === "input") return line(attentionTime("回答待ち"), "waiting", "回答待ち");
  if (attentionKind === "approval") return line(attentionTime("承認待ち"), "waiting", "承認待ち");
  if (attentionKind === "rate_limited") return line(attentionTime("利用上限"), "stopped", "利用上限");
  if (attentionKind === "error") return line(attentionTime("エラー"), "stopped", "エラー");
  if (fact.kind === "error") return line("エラー", "stopped", "エラー");
  if (status === "waiting") return line("回答待ち", "waiting", "回答待ち");
  if (attentionKind === "done" && status !== "working") return line(attentionTime("完了", ""), "neutral");
  if (status === "idle" || fact.kind === "idle") return line(cropState === "done" ? "完了" : "入力待ち", "neutral");
  if (fact.kind === "frozen") return line(`画面が止まっている · ${formatLiveTailAgo(now - fact.sinceMs)}から`, "stopped", "止まっている");
  if (fact.kind === "stale") return line(`進んでいない · ${formatLiveTailAgo(now - fact.sinceMs)}から`, "stopped", "進んでいない");
  if (fact.kind === "progress") return line(`作業中 · ${formatLiveTailAgo(now - fact.sinceMs)}に進んだ`, "progress");
  if (fact.kind === "cmd") return line(`コマンド実行中 · ${formatLiveTailDuration(now - fact.sinceMs)}`, "cmd");
  if (status === "working" || cropState === "working") return line("作業中", "neutral");
  return null;
}
