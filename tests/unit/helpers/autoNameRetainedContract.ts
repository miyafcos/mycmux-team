import { expect } from "vitest";
import { UNKNOWN_AUTO_NAME, type AutoNameMeaning } from "../../../src/lib/autoNamePolicy";

/** The 2026-10-14 ruling permits a literal previous name only with an explicit stale marker. */
export function uncertainName(meaning: AutoNameMeaning | undefined, previous: string): string {
  if (meaning?.staleSince === undefined) return UNKNOWN_AUTO_NAME;
  expect(meaning.fresh).toBe(false);
  expect(meaning.fullName).toBe(previous);
  expect(meaning.unknownReason).toBeDefined();
  return previous;
}
/** Existing literal topic/count oracles remain exact; new reason/previous hints have separate tests. */
export function topicDescription(description: string): string {
  return description.split("\n").filter(line => !line.startsWith("未取得:")
    && !line.startsWith("前回の作業名") && !line.startsWith("最新の作業内容は未取得")).join("\n");
}
