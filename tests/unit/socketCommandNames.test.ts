import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SOCKET_COMMAND_NAMES } from "../../src/components/layout/socketCommands";

describe("public socket command table", () => {
  it("matches every dispatch case and rejects one-sided API additions", () => {
    const file = ts.createSourceFile("socketCommands.ts", readFileSync(
      new URL("../../src/components/layout/socketCommands.ts", import.meta.url), "utf8",
    ), ts.ScriptTarget.Latest, true);
    const cases: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "handleSocketCommand") {
        function collect(child: ts.Node) {
          if (ts.isCaseClause(child)) {
            expect(ts.isStringLiteral(child.expression)).toBe(true);
            cases.push((child.expression as ts.StringLiteral).text);
          }
          ts.forEachChild(child, collect);
        }
        ts.forEachChild(node, collect);
      } else ts.forEachChild(node, visit);
    }
    visit(file);
    expect(SOCKET_COMMAND_NAMES.length).toBeGreaterThan(0);
    expect(new Set(SOCKET_COMMAND_NAMES).size).toBe(SOCKET_COMMAND_NAMES.length);
    expect(cases.sort()).toEqual([...SOCKET_COMMAND_NAMES].sort());
  });
});
