import { describe, expect, it } from "vitest";

import { autonomySettingsStrings } from "../../src/components/settings/settingsStrings";

const forbidden = ["WorkOrder", "AttentionGate", "advance", "DAG", "Outbox", "dispatch", "upsert"];

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

describe("autonomy settings vocabulary", () => {
  it("keeps forbidden implementation terms out of autonomy setting strings", () => {
    const strings = stringLeaves(autonomySettingsStrings);
    for (const term of forbidden) {
      expect(strings.some((value) => value.includes(term)), term).toBe(false);
    }
  });
});
