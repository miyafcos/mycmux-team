import { describe, expect, it } from "vitest";
import { completedPublishStepCount } from "../../src/components/online/PublishProgress";

describe("completedPublishStepCount", () => {
  it.each([
    [null, 0],
    ["digest", 1],
    ["handoff", 2],
    ["bundle", 3],
    ["register", 4],
    ["done", 4],
  ] as const)("maps %s to %i completed steps", (stage, count) => {
    expect(completedPublishStepCount(stage)).toBe(count);
  });
});
