import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Mechanical factory-bypass detector.
 *
 * A workspace construction literal is a value object `{ ... }` whose own
 * property list includes all of `gridTemplateId`, `createdAt`, and
 * `splitColumns`. Type/interface bodies are ignored. Functions whose names
 * include "projection" or "canonical" are ignored because they serialize an
 * existing workspace instead of creating one. Arguments to
 * `buildWorkspaceRecord(` are the single allowed construction site.
 *
 * If a later change rebuilds a Workspace with `{ id, gridTemplateId,
 * createdAt, splitColumns, ... }` inside compileGroupingPlanCore (or any
 * other non-projection helper), this test fails.
 */
const ENGINE_PATH = join(process.cwd(), "src/components/layout/tabGroupingEngine.ts");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\\n])\/\/.*$/gm, "$1");
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripBalancedAfter(source: string, pattern: RegExp): string {
  let next = source;
  let match = pattern.exec(next);
  while (match) {
    const openIndex = next.indexOf("{", match.index + match[0].length - 1);
    if (openIndex < 0) break;
    const closeIndex = matchingBrace(next, openIndex);
    if (closeIndex < 0) break;
    next = `${next.slice(0, match.index)}${next.slice(closeIndex + 1)}`;
    pattern.lastIndex = 0;
    match = pattern.exec(next);
  }
  return next;
}

function ownPropertyKeys(literal: string): string[] {
  const body = literal.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "{") {
      const close = matchingBrace(body, index);
      index = close < 0 ? body.length : close + 1;
      continue;
    }
    if (char === "(" || char === "[") {
      const opener = char;
      const closer = char === "(" ? ")" : "]";
      let nested = 1;
      index += 1;
      while (index < body.length && nested > 0) {
        if (body[index] === opener) nested += 1;
        else if (body[index] === closer) nested -= 1;
        index += 1;
      }
      continue;
    }
    if (depth === 0) {
      const rest = body.slice(index);
      const property = rest.match(/^(\.\.\.[A-Za-z0-9_]+|[A-Za-z0-9_]+)\s*:/);
      if (property && !property[1].startsWith("...")) {
        keys.push(property[1]);
        index += property[0].length;
        continue;
      }
    }
    index += 1;
  }
  return keys;
}

function isAllowedConstruction(source: string, openIndex: number): boolean {
  const prefix = source.slice(Math.max(0, openIndex - 48), openIndex);
  return /buildWorkspaceRecord\s*\(\s*$/.test(prefix);
}

function workspaceConstructionLiterals(source: string): string[] {
  const withoutTypes = stripBalancedAfter(
    stripBalancedAfter(stripComments(source), /(?:export\s+)?(?:interface|type)\s+[A-Za-z0-9_]+\s*(?:=\s*)?\{/g),
    /(?:export\s+)?function\s+[A-Za-z0-9_]*([Pp]rojection|[Cc]anonical)[A-Za-z0-9_]*\s*\([^)]*\)\s*(?::[^{]+)?\{/g,
  );
  const hits: string[] = [];
  for (let index = 0; index < withoutTypes.length; index += 1) {
    if (withoutTypes[index] !== "{") continue;
    const close = matchingBrace(withoutTypes, index);
    if (close < 0) break;
    const literal = withoutTypes.slice(index, close + 1);
    const keys = new Set(ownPropertyKeys(literal));
    if (keys.has("gridTemplateId") && keys.has("createdAt") && keys.has("splitColumns")) {
      if (!isAllowedConstruction(withoutTypes, index)) hits.push(literal);
    }
  }
  return hits;
}

describe("workspace factory single source", () => {
  it("keeps compileGroupingPlanCore from constructing a Workspace object literal", () => {
    const source = readFileSync(ENGINE_PATH, "utf8");
    expect(workspaceConstructionLiterals(source)).toEqual([]);
  });
});
