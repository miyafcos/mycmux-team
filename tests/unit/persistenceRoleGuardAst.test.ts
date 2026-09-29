import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}
function unparen(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
}
function functionScope(node: ts.Node): ts.Node | undefined {
  let parent = node.parent;
  while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
  return parent;
}
function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node); ts.forEachChild(node, (child) => visit(child, callback));
}
function rejectsWrites(statement: ts.Statement): statement is ts.IfStatement {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = unparen(statement.expression);
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
  const terms = [unparen(condition.left), unparen(condition.right)];
  const negative = terms.map((term) => ts.isPrefixUnaryExpression(term)
    && term.operator === ts.SyntaxKind.ExclamationToken ? unparen(term.operand) : undefined);
  const role = negative.some((term) => term && ts.isPropertyAccessExpression(term)
    && term.name.text === "current" && ts.isIdentifier(term.expression) && term.expression.text === "isLeader");
  const schema = negative.some((term) => term && ts.isCallExpression(term)
    && ts.isIdentifier(term.expression) && term.expression.text === "isPersistenceWriteAllowed");
  const branch = statement.thenStatement;
  const exits = ts.isReturnStatement(branch) || (ts.isBlock(branch)
    && branch.statements.length > 0 && ts.isReturnStatement(branch.statements[branch.statements.length - 1]));
  return role && schema && exits;
}
function guardFor(call: ts.CallExpression): ts.IfStatement | undefined {
  const scope = functionScope(call);
  for (let node: ts.Node = call; node.parent && node.parent !== scope; node = node.parent) {
    if (!ts.isBlock(node.parent)) continue;
    const statements = node.parent.statements;
    const index = statements.findIndex((statement) => statement === node);
    for (let i = index - 1; i >= 0; i--) if (rejectsWrites(statements[i])) return statements[i] as ts.IfStatement;
  }
  return undefined;
}
interface Write { call: ts.CallExpression; guard?: ts.IfStatement; file: ts.SourceFile }
// Search all source files, including future split modules, instead of slicing a named function.
const writes: Write[] = [];
for (const path of files("src")) {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["savePersistentData"]);
  visit(file, (node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "savePersistentData") names.add(node.name.text);
  });
  visit(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const target = node.expression;
    if ((ts.isIdentifier(target) && names.has(target.text))
      || (ts.isPropertyAccessExpression(target) && target.name.text === "savePersistentData")) {
      writes.push({ call: node, guard: guardFor(node), file });
    }
  });
}
function location(write: Write): string {
  return `${write.file.fileName}:${write.file.getLineAndCharacterOfPosition(write.call.getStart()).line + 1}`;
}
function preflightBeforeGuard(write: Write, name: string) {
  expect(write.guard, location(write)).toBeDefined();
  const calls: ts.CallExpression[] = [];
  const scope = functionScope(write.call)!;
  visit(scope, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
      && functionScope(node) === scope) calls.push(node);
  });
  expect(calls.length, `${location(write)} ${name} preflight`).toBeGreaterThan(0);
  for (const call of calls) {
    expect(ts.isAwaitExpression(call.parent), `${name} must be awaited`).toBe(true);
    expect(call.end, location(write)).toBeLessThan(write.guard!.getStart());
  }
}

// R3-2: these FOUR AST tests are mandatory; runtime tests cannot replace them.
describe("mandatory persistence role guard AST", () => {
  it("guards every data write with a rejecting role and schema check in the same execution scope", () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write.guard, location(write)).toBeDefined();
  });
  it("allows no await between the final guard and save invocation including save arguments", () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.guard, location(write)).toBeDefined();
      const awaits: ts.Node[] = [];
      const scope = functionScope(write.call)!;
      visit(scope, (node) => {
        if (ts.isAwaitExpression(node) && functionScope(node) === scope
          && node.getStart() >= write.guard!.getStart() && node.getStart() < write.call.end
          // `await savePersistentData(...)` suspends only AFTER the guarded invocation.
          && node.expression !== write.call) awaits.push(node);
      });
      expect(awaits.map((node) => node.getText()), location(write)).toEqual([]);
    }
  });
  it("completes mapping preflight awaits before the final write-time role guard", () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) preflightBeforeGuard(write, "readAgentSessionMappings");
  });
  it("completes fragment preflight awaits before the final write-time role guard", () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) preflightBeforeGuard(write, "getWindowFragments");
  });
});
