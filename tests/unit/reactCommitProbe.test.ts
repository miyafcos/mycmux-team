import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { instrumentReactCommitSource } from "../../scripts/perf/react-commit-probe.mjs";

it("instruments the actual body without changing returns, thrown errors or nested braces", async () => {
  const source = await instrumentReactCommitSource(`function commitRoot(value) {
    if (value === 0) return "}";
    if (value < 0) throw new Error("negative");
    return { value, nested: { valid: true } };
  }`);
  let tick = 0;
  const context = { window: { performance: { timeOrigin: 1000, now: () => tick++ } } };
  runInNewContext(source, context);
  expect(runInNewContext("commitRoot(0)", context)).toBe("}");
  expect(runInNewContext("commitRoot(2).nested.valid", context)).toBe(true);
  expect(() => runInNewContext("commitRoot(-1)", context)).toThrow("negative");
  expect(runInNewContext("window.__stage3ReactCommits.length", context)).toBe(3);
  expect(runInNewContext("window.__stage3ReactCommits.every(r=>r.durationMs===1)", context)).toBe(true);
});

it("bounds commit rows and rejects absent or ambiguous function identities", async () => {
  const source = await instrumentReactCommitSource("function commitRoot() { return 1; }");
  const context = { window: { performance: { timeOrigin: 0, now: () => 1 } } };
  runInNewContext(source, context);
  runInNewContext("for(let i=0;i<5000;i++)commitRoot()", context);
  expect(runInNewContext("window.__stage3ReactCommits.length", context)).toBe(2048);
  expect(runInNewContext("window.__stage3ReactCommitCount", context)).toBe(5000);
  await expect(instrumentReactCommitSource("function other() {}" )).rejects.toThrow("found 0");
  await expect(instrumentReactCommitSource("function commitRoot() {} function outer(){ function commitRoot() {} }" )).rejects.toThrow("found 2");
});
