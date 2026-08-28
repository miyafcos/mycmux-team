import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");
const TESTS = join(ROOT, "tests", "unit");
const GROUPING_MUTATION_CAPABILITY_MODULE = "workspaceGroupingMutationCapability.internal";
const GROUPING_MUTATION_CAPABILITY_EXPORT = "workspaceGroupingMutationCapability";
const GROUPING_MUTATION_PORT = "workspaceGroupingMutationPort";
const TYPESCRIPT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const WORKSPACE_STORE_MODULE_SUFFIXES = ["/workspaceListStore", "/workspaceStore"] as const;
const GROUPING_MUTATION_METHODS = new Set([
  "_replaceWorkspaces",
  "_restoreGroupingLayout",
  "replaceWorkspaces",
  "restoreGroupingLayout",
]);
// G3-L1 physically removed these exports from tabGrouping.ts; re-adding any is a regression.
const REMOVED_TAB_GROUPING_EXPORTS = new Set([
  "compileGroupingPlan",
  "commitGroupingPlan",
  "defaultCommitDependencies",
  "restoreGroupingUndo",
  "getGroupingUndoMemory",
  "subscribeGroupingUndo",
  "dismissGroupingUndo",
  "recallGroupingUndo",
  "clearGroupingUndo",
  "expireGroupingUndo",
]);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (path === join(SRC, "mock")) return []; // Standalone mock harness is not part of the production bundle.
    if (entry.isDirectory()) return sourceFiles(path);
    return TYPESCRIPT_SOURCE_EXTENSIONS.includes(
      extname(entry.name) as (typeof TYPESCRIPT_SOURCE_EXTENSIONS)[number],
    ) ? [path] : [];
  });
}

function normalized(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function moduleWithoutTypeScriptExtension(specifier: string): string {
  return specifier.replace(/\.(?:ts|tsx|mts|cts)$/u, "");
}

function isWorkspaceStoreModule(specifier: string): boolean {
  const normalizedSpecifier = moduleWithoutTypeScriptExtension(specifier);
  return WORKSPACE_STORE_MODULE_SUFFIXES.some((suffix) => normalizedSpecifier.endsWith(suffix));
}

function parseSource(path: string, text = readFileSync(path, "utf8")): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function workspaceStorePublisherStatements(source: ts.SourceFile): string[] {
  return source.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      return statement.declarationList.declarations.some((declaration) => (
        ts.isIdentifier(declaration.name) && declaration.name.text === "useWorkspaceListStore"
      ));
    }
    if (!ts.isExportDeclaration(statement)) return false;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.some((element) => (
        (element.propertyName ?? element.name).text === "useWorkspaceListStore"
      ));
    }
    return !statement.isTypeOnly
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && isWorkspaceStoreModule(statement.moduleSpecifier.text)
      && (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause));
  }).map((statement) => statement.getText(source));
}

function rawGroupingImports(path: string, source = parseSource(path)): string[] {
  const imports: string[] = [];
  const record = (specifier: string): void => {
    const normalizedSpecifier = moduleWithoutTypeScriptExtension(specifier);
    if (normalizedSpecifier.endsWith("/tabGroupingEngine") || normalizedSpecifier.endsWith("/groupingStoreAdapter")) {
      imports.push(specifier);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      record(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function legacyTabGroupingImports(path: string, source = parseSource(path)): string[] {
  const hits: string[] = [];
  const isLegacyModule = (specifier: string): boolean => (
    moduleWithoutTypeScriptExtension(specifier).endsWith("/tabGrouping")
  );
  const record = (description: string, specifier: string): void => {
    hits.push(`${normalized(path)} -> ${description} from ${specifier}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && isLegacyModule(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        record(`namespace import ${bindings.name.text}`, node.moduleSpecifier.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (REMOVED_TAB_GROUPING_EXPORTS.has(importedName)) {
            record(`import ${importedName}`, node.moduleSpecifier.text);
          }
        }
      }
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && isLegacyModule(node.moduleSpecifier.text)) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        record("export all", node.moduleSpecifier.text);
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportedName = (element.propertyName ?? element.name).text;
          if (REMOVED_TAB_GROUPING_EXPORTS.has(exportedName)) {
            record(`export ${exportedName}`, node.moduleSpecifier.text);
          }
        }
      }
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && isLegacyModule(node.arguments[0].text)) {
      record("dynamic import", node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)
      && isLegacyModule(node.moduleReference.expression.text)) {
      record(`namespace import ${node.name.text}`, node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function workspaceGroupingPortImports(path: string, source = parseSource(path)): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && moduleWithoutTypeScriptExtension(node.moduleSpecifier.text).endsWith("/workspaceListStore")) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        hits.push(`${normalized(path)} -> namespace import from ${node.moduleSpecifier.text}`);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === GROUPING_MUTATION_PORT) {
            hits.push(`${normalized(path)} -> import ${GROUPING_MUTATION_PORT} from ${node.moduleSpecifier.text}`);
          }
        }
      }
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && moduleWithoutTypeScriptExtension(node.moduleSpecifier.text).endsWith("/workspaceListStore")) {
      const exportsPort = !node.exportClause
        || (ts.isNamedExports(node.exportClause) && node.exportClause.elements.some((element) => (
          (element.propertyName ?? element.name).text === GROUPING_MUTATION_PORT
        )));
      if (exportsPort) {
        hits.push(`${normalized(path)} -> export ${GROUPING_MUTATION_PORT} from ${node.moduleSpecifier.text}`);
      }
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && moduleWithoutTypeScriptExtension(node.arguments[0].text).endsWith("/workspaceListStore")) {
      hits.push(`${normalized(path)} -> dynamic import from ${node.arguments[0].text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function groupingMutationCapabilityImports(path: string, source = parseSource(path)): string[] {
  const imports: string[] = [];
  const capabilityBindings = new Set<string>();
  const capabilityNamespaceBindings = new Set<string>();
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const isCapabilityModule = (specifier: string): boolean => (
    moduleWithoutTypeScriptExtension(specifier).endsWith(`/${GROUPING_MUTATION_CAPABILITY_MODULE}`)
  );
  const record = (specifier: string): void => {
    if (isCapabilityModule(specifier)) {
      imports.push(`${normalized(path)} -> ${specifier}`);
    }
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && isCapabilityModule(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) capabilityBindings.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        capabilityBindings.add(clause.namedBindings.name.text);
        capabilityNamespaceBindings.add(clause.namedBindings.name.text);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === GROUPING_MUTATION_CAPABILITY_EXPORT) {
            capabilityBindings.add(element.name.text);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(source);

  function blockReturnsCapability(block: ts.Block): boolean {
    let found = false;
    const visitReturn = (node: ts.Node): void => {
      if (found) return;
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)
        && node.expression
        && expressionReferencesCapability(node.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visitReturn);
    };
    block.statements.forEach(visitReturn);
    return found;
  }
  function expressionReferencesCapability(expression: ts.Expression): boolean {
    if (ts.isIdentifier(expression)) return capabilityBindings.has(expression.text);
    if (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)) {
      return expressionReferencesCapability(expression.expression);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return expressionReferencesCapability(property.name);
        }
        if (ts.isPropertyAssignment(property)) {
          return expressionReferencesCapability(property.initializer);
        }
        if (ts.isSpreadAssignment(property)) {
          return expressionReferencesCapability(property.expression);
        }
        return ts.isMethodDeclaration(property)
          && Boolean(property.body)
          && blockReturnsCapability(property.body!);
      });
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) => (
        ts.isSpreadElement(element)
          ? expressionReferencesCapability(element.expression)
          : expressionReferencesCapability(element)
      ));
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return ts.isBlock(expression.body)
        ? blockReturnsCapability(expression.body)
        : expressionReferencesCapability(expression.body);
    }
    if (ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && capabilityNamespaceBindings.has(expression.expression.text)) {
      return expression.name.text === GROUPING_MUTATION_CAPABILITY_EXPORT;
    }
    return ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && capabilityNamespaceBindings.has(expression.expression.text)
      && ts.isStringLiteral(expression.argumentExpression)
      && expression.argumentExpression.text === GROUPING_MUTATION_CAPABILITY_EXPORT;
  }
  let foundAlias: boolean;
  do {
    foundAlias = false;
    for (const declaration of variableDeclarations) {
      if (!declaration.initializer) continue;
      if (ts.isIdentifier(declaration.name)
        && !capabilityBindings.has(declaration.name.text)
        && expressionReferencesCapability(declaration.initializer)) {
        capabilityBindings.add(declaration.name.text);
        foundAlias = true;
      } else if (ts.isObjectBindingPattern(declaration.name)
        && ts.isIdentifier(declaration.initializer)
        && capabilityNamespaceBindings.has(declaration.initializer.text)) {
        for (const element of declaration.name.elements) {
          const property = element.propertyName ?? element.name;
          if ((ts.isIdentifier(property) || ts.isStringLiteral(property))
            && property.text === GROUPING_MUTATION_CAPABILITY_EXPORT
            && ts.isIdentifier(element.name)
            && !capabilityBindings.has(element.name.text)) {
            capabilityBindings.add(element.name.text);
            foundAlias = true;
          }
        }
      }
    }
  } while (foundAlias);

  const reportExportedBinding = (binding: string): void => {
    imports.push(`${normalized(path)} -> re-export capability binding ${binding}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const directlyFromCapability = node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)
          && isCapabilityModule(node.moduleSpecifier.text);
        for (const element of node.exportClause.elements) {
          const binding = (element.propertyName ?? element.name).text;
          if (capabilityBindings.has(binding)
            || (directlyFromCapability && binding === GROUPING_MUTATION_CAPABILITY_EXPORT)) {
            reportExportedBinding(binding);
          }
        }
      }
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        record(node.moduleSpecifier.text);
      }
    } else if (ts.isExportAssignment(node) && expressionReferencesCapability(node.expression)) {
      reportExportedBinding("default");
    } else if (ts.isVariableStatement(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && capabilityBindings.has(declaration.name.text)) {
          reportExportedBinding(declaration.name.text);
        }
      }
    } else if (ts.isFunctionDeclaration(node)
      && node.body
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && blockReturnsCapability(node.body)) {
      reportExportedBinding(node.name?.text ?? "default");
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      record(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function groupingMutationCallsites(path: string, source = parseSource(path)): string[] {
  const hits: string[] = [];
  const workspaceStoreBindings = new Set<string>();
  const workspaceStoreNamespaceBindings = new Set<string>();
  const workspaceStateBindings = new Set<string>();
  const workspaceGetStateBindings = new Set<string>();
  const mutationAliases = new Map<string, string>();
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const collectContext = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && isWorkspaceStoreModule(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        workspaceStoreNamespaceBindings.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "useWorkspaceListStore") {
            workspaceStoreBindings.add(element.name.text);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
    }
    ts.forEachChild(node, collectContext);
  };
  collectContext(source);
  const unwrap = (input: ts.Expression): ts.Expression => {
    let expression = input;
    while (ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)) {
      expression = expression.expression;
    }
    return expression;
  };
  const isWorkspaceStoreHook = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (ts.isIdentifier(expression)) return workspaceStoreBindings.has(expression.text);
    return ts.isPropertyAccessExpression(expression)
      && expression.name.text === "useWorkspaceListStore"
      && ts.isIdentifier(unwrap(expression.expression))
      && workspaceStoreNamespaceBindings.has((unwrap(expression.expression) as ts.Identifier).text);
  };
  const isWorkspaceState = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (ts.isIdentifier(expression)) return workspaceStateBindings.has(expression.text);
    if (!ts.isCallExpression(expression) || expression.arguments.length > 1) return false;
    const callee = unwrap(expression.expression);
    if (isWorkspaceStoreHook(callee)) return true;
    if (expression.arguments.length !== 0) return false;
    if (ts.isIdentifier(callee) && workspaceGetStateBindings.has(callee.text)) return true;
    return ts.isPropertyAccessExpression(callee)
      && callee.name.text === "getState"
      && isWorkspaceStoreHook(callee.expression);
  };
  const mutationMethodFromStateAccess = (input: ts.Expression): string | null => {
    const expression = unwrap(input);
    if (ts.isPropertyAccessExpression(expression) && isWorkspaceState(expression.expression)) {
      return GROUPING_MUTATION_METHODS.has(expression.name.text) ? expression.name.text : null;
    }
    if (ts.isElementAccessExpression(expression)
      && ts.isStringLiteral(expression.argumentExpression)
      && isWorkspaceState(expression.expression)
      && GROUPING_MUTATION_METHODS.has(expression.argumentExpression.text)) {
      return expression.argumentExpression.text;
    }
    return null;
  };
  const mutationMethodFromWorkspaceSelector = (input: ts.Expression): string | null => {
    const expression = unwrap(input);
    if (!ts.isCallExpression(expression)
      || expression.arguments.length !== 1
      || !isWorkspaceStoreHook(expression.expression)) {
      return null;
    }
    const selector = unwrap(expression.arguments[0]);
    if (!ts.isArrowFunction(selector)
      || selector.parameters.length !== 1
      || !ts.isIdentifier(selector.parameters[0].name)
      || ts.isBlock(selector.body)) {
      return null;
    }
    const body = unwrap(selector.body);
    return ts.isPropertyAccessExpression(body)
      && ts.isIdentifier(unwrap(body.expression))
      && (unwrap(body.expression) as ts.Identifier).text === selector.parameters[0].name.text
      && GROUPING_MUTATION_METHODS.has(body.name.text)
      ? body.name.text
      : null;
  };
  let foundAlias: boolean;
  do {
    foundAlias = false;
    for (const declaration of variableDeclarations) {
      if (!declaration.initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        const initializer = unwrap(declaration.initializer);
        if (!workspaceStoreBindings.has(name) && isWorkspaceStoreHook(initializer)) {
          workspaceStoreBindings.add(name);
          foundAlias = true;
        }
        const aliasesGetState = (ts.isPropertyAccessExpression(initializer)
          && initializer.name.text === "getState"
          && isWorkspaceStoreHook(initializer.expression))
          || (ts.isIdentifier(initializer) && workspaceGetStateBindings.has(initializer.text));
        if (!workspaceGetStateBindings.has(name) && aliasesGetState) {
          workspaceGetStateBindings.add(name);
          foundAlias = true;
        }
        if (!workspaceStateBindings.has(name) && isWorkspaceState(declaration.initializer)) {
          workspaceStateBindings.add(name);
          foundAlias = true;
        }
        const selectorMethod = mutationMethodFromWorkspaceSelector(declaration.initializer);
        const directMethod = mutationMethodFromStateAccess(declaration.initializer);
        const aliasedMethod = ts.isIdentifier(initializer) ? mutationAliases.get(initializer.text) : undefined;
        const method = selectorMethod ?? directMethod ?? aliasedMethod;
        if (method && mutationAliases.get(name) !== method) {
          mutationAliases.set(name, method);
          foundAlias = true;
        }
      } else if (ts.isObjectBindingPattern(declaration.name) && isWorkspaceState(declaration.initializer)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName ?? element.name;
          if ((ts.isIdentifier(property) || ts.isStringLiteral(property))
            && GROUPING_MUTATION_METHODS.has(property.text)
            && mutationAliases.get(element.name.text) !== property.text) {
            mutationAliases.set(element.name.text, property.text);
            foundAlias = true;
          }
        }
      }
    }
  } while (foundAlias);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let method: string | null = null;
      if (ts.isPropertyAccessExpression(node.expression)) {
        method = node.expression.name.text;
      } else if (ts.isElementAccessExpression(node.expression)
        && ts.isStringLiteral(node.expression.argumentExpression)) {
        method = node.expression.argumentExpression.text;
      } else if (ts.isIdentifier(node.expression)) {
        method = mutationAliases.get(node.expression.text) ?? null;
      }
      if (method && GROUPING_MUTATION_METHODS.has(method)) {
        hits.push(`${normalized(path)} -> call ${method}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function directWorkspaceSetStateWrites(path: string, source = parseSource(path)): string[] {
  const hits: string[] = [];
  const nodeWritesWorkspaces = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
      const name = property.name;
      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "workspaces";
    })) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && nodeWritesWorkspaces(child)) found = true;
    });
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "setState"
      && node.arguments.some(nodeWritesWorkspaces)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${normalized(path)}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("grouping production boundary contract", () => {
  const srcFiles = sourceFiles(SRC);
  const testFiles = sourceFiles(TESTS);
  const parsedSources = new Map(
    [...srcFiles, ...testFiles].map((path) => [path, parseSource(path)] as const),
  );
  const cachedSource = (path: string): ts.SourceFile => {
    const source = parsedSources.get(path);
    if (!source) throw new Error(`AST cache miss: ${normalized(path)}`);
    return source;
  };
  const mutationCallsitesBySource = new Map(srcFiles.map((path) => (
    [path, groupingMutationCallsites(path, cachedSource(path))] as const
  )));
  const capabilityImportsBySource = new Map(srcFiles.map((path) => (
    [path, groupingMutationCapabilityImports(path, cachedSource(path))] as const
  )));
  const legacyImportsBySource = new Map(srcFiles.map((path) => (
    [path, legacyTabGroupingImports(path, cachedSource(path))] as const
  )));
  const scanProductionMutationCallsites = (overrides = new Map<string, ts.SourceFile>()): string[] => (
    [...new Set([...srcFiles, ...overrides.keys()])]
      .flatMap((path) => {
        const override = overrides.get(path);
        return override ? groupingMutationCallsites(path, override) : mutationCallsitesBySource.get(path) ?? [];
      })
      .sort()
  );
  const scanProductionCapabilityImports = (overrides = new Map<string, ts.SourceFile>()): string[] => (
    [...new Set([...srcFiles, ...overrides.keys()])]
      .flatMap((path) => {
        const override = overrides.get(path);
        return override ? groupingMutationCapabilityImports(path, override) : capabilityImportsBySource.get(path) ?? [];
      })
      .sort()
  );
  const scanProductionLegacyTabGroupingImports = (overrides = new Map<string, ts.SourceFile>()): string[] => (
    [...new Set([...srcFiles, ...overrides.keys()])]
      .filter((path) => !normalized(path).endsWith("src/components/layout/tabGrouping.ts"))
      .flatMap((path) => {
        const override = overrides.get(path);
        return override ? legacyTabGroupingImports(path, override) : legacyImportsBySource.get(path) ?? [];
      })
      .sort()
  );

  it("publishes exactly one runtime value from the public facade", async () => {
    const module = await import("../../src/components/layout/groupingBoundary");
    expect(Object.keys(module).sort()).toEqual(["groupingBoundary"]);
    expect(Object.keys(module.groupingBoundary).sort()).toEqual(["commit", "prepare", "preview", "undo"]);
  }, 120_000);

  it("pins every production raw import and replacement primitive callsite", () => {
    const rawImports = srcFiles.flatMap((path) => (
      rawGroupingImports(path, cachedSource(path)).map((specifier) => `${normalized(path)} -> ${specifier}`)
    ));
    expect(rawImports.sort()).toEqual([
      "src/components/layout/groupingBoundary.ts -> ./groupingStoreAdapter",
      "src/components/layout/groupingBoundary.ts -> ./tabGroupingEngine",
      "src/components/layout/groupingStoreAdapter.ts -> ./tabGroupingEngine",
      "src/stores/groupingRuntimeStore.ts -> ../components/layout/tabGroupingEngine",
      "src/stores/workspaceListStore.ts -> ../components/layout/tabGroupingEngine",
    ]);

    expect(scanProductionMutationCallsites()).toEqual([
      "src/components/layout/groupingStoreAdapter.ts -> call _restoreGroupingLayout",
      "src/components/layout/socketCommands.ts -> call _replaceWorkspaces",
      "src/components/layout/tabGroupingEngine.ts -> call replaceWorkspaces",
      "src/hooks/usePaneDragSource.ts -> call _replaceWorkspaces",
      "src/hooks/usePaneDragSource.ts -> call _replaceWorkspaces",
    ]);
  }, 120_000);

  it("keeps legacy grouping commit and undo APIs behind the production facade", () => {
    expect(scanProductionLegacyTabGroupingImports()).toEqual([]);
  }, 120_000);

  it("keeps removed legacy tabGrouping exports physically absent", () => {
    const source = cachedSource(join(SRC, "components", "layout", "tabGrouping.ts"));
    const exportedNames = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)
        && statement.exportClause
        && ts.isNamedExports(statement.exportClause)) {
        statement.exportClause.elements.forEach((element) => exportedNames.add(element.name.text));
        continue;
      }
      const exported = ts.canHaveModifiers(statement)
        && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isVariableStatement(statement)) {
        statement.declarationList.declarations.forEach((declaration) => {
          if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text);
        });
      } else if ((ts.isFunctionDeclaration(statement)
          || ts.isClassDeclaration(statement)
          || ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)
          || ts.isEnumDeclaration(statement)
          || ts.isModuleDeclaration(statement))
        && statement.name
        && ts.isIdentifier(statement.name)) {
        exportedNames.add(statement.name.text);
      }
    }
    expect([...REMOVED_TAB_GROUPING_EXPORTS].filter((name) => exportedNames.has(name))).toEqual([]);
  }, 120_000);

  it("pins the Panel to one facade ticket for confirm preview and commit", () => {
    const panelPath = join(SRC, "components", "layout", "TabGroupingPanel.tsx");
    const source = cachedSource(panelPath);
    let importsBoundary = false;
    const commitTicketArguments: string[] = [];
    let ticketStateBindings = 0;
    let applyDeclaration = "";
    let previewAfterDeclaration = "";
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)
        && ts.isStringLiteral(node.moduleSpecifier)
        && moduleWithoutTypeScriptExtension(node.moduleSpecifier.text).endsWith("/groupingBoundary")
        && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some((element) => (
          (element.propertyName ?? element.name).text === "groupingBoundary"
        ))) {
        importsBoundary = true;
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isArrayBindingPattern(node.name)
          && node.name.elements.some((element) => (
            ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === "ticket"
          ))) {
          ticketStateBindings += 1;
        } else if (ts.isIdentifier(node.name) && node.name.text === "apply") {
          applyDeclaration = node.getText(source);
        } else if (ts.isIdentifier(node.name) && node.name.text === "previewAfter") {
          previewAfterDeclaration = node.getText(source);
        }
      }
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "groupingBoundary"
        && node.expression.name.text === "commit") {
        const ticketArgument = node.arguments[1];
        commitTicketArguments.push(ticketArgument?.getText(source) ?? "");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(importsBoundary).toBe(true);
    expect(ticketStateBindings).toBe(1);
    expect(commitTicketArguments).toEqual(["ticket"]);
    expect(applyDeclaration).toContain("preparedPlan !== edited");
    expect(applyDeclaration).toContain("groupingBoundary.commit(edited, ticket)");
    expect(previewAfterDeclaration).toContain('mode === "confirm" && ticket && preparedPlan === edited');
    expect(previewAfterDeclaration).toContain("ticket.transaction.workspaces");
  }, 120_000);

  it("keeps the grouping mutation capability off public production import surfaces", async () => {
    const publicStoreModule = await import("../../src/stores/workspaceListStore");
    expect(publicStoreModule).not.toHaveProperty(GROUPING_MUTATION_PORT);

    const portImports = srcFiles.flatMap((path) => workspaceGroupingPortImports(path, cachedSource(path)));
    expect(portImports).toEqual([]);

    expect(scanProductionCapabilityImports()).toEqual([
      "src/components/layout/groupingStoreAdapter.ts -> ../../stores/workspaceGroupingMutationCapability.internal",
      "src/stores/workspaceListStore.ts -> ./workspaceGroupingMutationCapability.internal",
    ]);
  }, 120_000);

  it("detects the audited production bypass with the production contract scanner", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.productionBypass.fixture.txt");
    const productionPath = join(SRC, "components", "a09ProductionBypass.ts");
    const text = readFileSync(fixture, "utf8");

    expect([
      ...workspaceGroupingPortImports(productionPath, parseSource(productionPath, text)),
      ...groupingMutationCallsites(productionPath, parseSource(productionPath, text)),
    ]).toEqual([
      "src/components/a09ProductionBypass.ts -> import workspaceGroupingMutationPort from ../stores/workspaceListStore",
      "src/components/a09ProductionBypass.ts -> call replaceWorkspaces",
      "src/components/a09ProductionBypass.ts -> call restoreGroupingLayout",
    ]);
  }, 120_000);

  it("detects a capability import whose module specifier includes the .ts extension", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.capabilityTsExtension.fixture.txt");
    const productionPath = join(SRC, "components", "capabilityTsExtensionBypass.ts");
    const text = readFileSync(fixture, "utf8");

    expect(groupingMutationCapabilityImports(productionPath, parseSource(productionPath, text))).toEqual([
      "src/components/capabilityTsExtensionBypass.ts -> ../stores/workspaceGroupingMutationCapability.internal.ts",
    ]);
  }, 120_000);

  it("detects a capability re-export from an otherwise allowed importer", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.capabilityReexport.fixture.txt");
    const productionPath = join(SRC, "stores", "workspaceListStore.ts");
    const text = readFileSync(fixture, "utf8");

    expect(groupingMutationCapabilityImports(productionPath, parseSource(productionPath, text))).toEqual([
      "src/stores/workspaceListStore.ts -> ./workspaceGroupingMutationCapability.internal",
      "src/stores/workspaceListStore.ts -> re-export capability binding leaked",
    ]);
  }, 120_000);

  it("detects a workspace store mutation imported through the audited barrel", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.barrelImport.fixture.txt");
    const productionPath = join(SRC, "components", "barrelImportBypass.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionMutationCallsites();

    expect(scanProductionMutationCallsites(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      "src/components/barrelImportBypass.ts -> call _replaceWorkspaces",
    ].sort());
  }, 120_000);

  it("detects hook and getState value aliases through the fixed-point sweep", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.hookValueAlias.fixture.txt");
    const productionPath = join(SRC, "components", "hookValueAliasBypass.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionMutationCallsites();

    expect(scanProductionMutationCallsites(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      "src/components/hookValueAliasBypass.ts -> call _replaceWorkspaces",
      "src/components/hookValueAliasBypass.ts -> call _restoreGroupingLayout",
    ].sort());
  }, 120_000);

  it("detects a capability array re-export in the production sweep", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.capabilityArrayReexport.fixture.txt");
    const productionPath = join(SRC, "stores", "workspaceListStore.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionCapabilityImports();

    expect(scanProductionCapabilityImports(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      "src/stores/workspaceListStore.ts -> re-export capability binding caps",
    ].sort());
  }, 120_000);

  it("scans real .mts and .cts production-source fixtures", () => {
    expect([...TYPESCRIPT_SOURCE_EXTENSIONS]).toEqual([".ts", ".tsx", ".mts", ".cts"]);
    const fixtureDirectory = join(TESTS, "fixtures");
    const fixturePaths = sourceFiles(fixtureDirectory)
      .filter((path) => path.includes("groupingBoundary.moduleExtension.fixture."));

    expect(fixturePaths.map(normalized).sort()).toEqual([
      "tests/unit/fixtures/groupingBoundary.moduleExtension.fixture.cts",
      "tests/unit/fixtures/groupingBoundary.moduleExtension.fixture.mts",
    ]);
    expect(fixturePaths.flatMap((path) => groupingMutationCallsites(path, cachedSource(path))).sort()).toEqual([
      "tests/unit/fixtures/groupingBoundary.moduleExtension.fixture.cts -> call _replaceWorkspaces",
      "tests/unit/fixtures/groupingBoundary.moduleExtension.fixture.mts -> call _replaceWorkspaces",
    ]);
  }, 120_000);

  it("pins every source module that publishes useWorkspaceListStore", () => {
    const publishers = srcFiles.filter((path) => {
      const source = cachedSource(path);
      return workspaceStorePublisherStatements(source).length > 0;
    });

    expect(publishers.map(normalized).sort()).toEqual([
      "src/stores/workspaceListStore.ts",
      "src/stores/workspaceStore.ts",
    ]);
  }, 120_000);

  it("detects export-all workspace store publishers", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.starBarrelPublisher.fixture.txt");
    const source = parseSource(fixture, readFileSync(fixture, "utf8"));

    expect(workspaceStorePublisherStatements(source)).toEqual([
      'export * from "./workspaceListStore";',
      'export * as workspaceList from "./workspaceStore";',
    ]);
  });

  it("detects a grouping mutation invoked through a destructured alias", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.destructuredAlias.fixture.txt");
    const productionPath = join(SRC, "components", "destructuredAliasBypass.ts");
    const text = readFileSync(fixture, "utf8");

    expect(groupingMutationCallsites(productionPath, parseSource(productionPath, text))).toEqual([
      "src/components/destructuredAliasBypass.ts -> call _restoreGroupingLayout",
    ]);
  }, 120_000);

  it("detects a workspace store mutation invoked through a property alias in the production sweep", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.propertyAlias.fixture.txt");
    const productionPath = join(SRC, "components", "propertyAliasBypass.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionMutationCallsites();

    expect(scanProductionMutationCallsites(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      "src/components/propertyAliasBypass.ts -> call _restoreGroupingLayout",
    ].sort());
  }, 120_000);

  it("detects wrapped capability re-exports in the production sweep", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.capabilityWrappedReexport.fixture.txt");
    const productionPath = join(SRC, "stores", "workspaceListStore.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionCapabilityImports();

    expect(scanProductionCapabilityImports(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      "src/stores/workspaceListStore.ts -> re-export capability binding bag",
      "src/stores/workspaceListStore.ts -> re-export capability binding default",
      "src/stores/workspaceListStore.ts -> re-export capability binding leak",
    ].sort());
  }, 120_000);

  it("ignores unrelated same-name mutation aliases in the production sweep", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.unrelatedAlias.fixture.txt");
    const productionPath = join(SRC, "components", "unrelatedAlias.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));

    expect(scanProductionMutationCallsites(new Map([[productionPath, source]]))).toEqual(
      scanProductionMutationCallsites(),
    );
  }, 120_000);

  it("detects every forbidden legacy tabGrouping import form", () => {
    const fixture = join(TESTS, "fixtures", "groupingBoundary.legacyTabGroupingImports.fixture.txt");
    const productionPath = join(SRC, "components", "layout", "legacyTabGroupingImportsBypass.ts");
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));

    expect(legacyTabGroupingImports(productionPath, source)).toEqual([
      "src/components/layout/legacyTabGroupingImportsBypass.ts -> import commitGroupingPlan from ./tabGrouping.ts",
      "src/components/layout/legacyTabGroupingImportsBypass.ts -> namespace import grouping from ./tabGrouping",
      "src/components/layout/legacyTabGroupingImportsBypass.ts -> export defaultCommitDependencies from ./tabGrouping",
      "src/components/layout/legacyTabGroupingImportsBypass.ts -> export all from ./tabGrouping.ts",
      "src/components/layout/legacyTabGroupingImportsBypass.ts -> dynamic import from ./tabGrouping",
    ]);
  }, 120_000);

  it.each([
    ["selectorAlias", "groupingBoundary.selectorAlias.fixture.txt"],
    ["hookDestructuredAlias", "groupingBoundary.hookDestructuredAlias.fixture.txt"],
    ["namespaceAlias", "groupingBoundary.namespaceAlias.fixture.txt"],
  ] as const)("detects the %s workspace store mutation alias in the production sweep", (fixtureName, fixtureFile) => {
    const fixture = join(TESTS, "fixtures", fixtureFile);
    const productionPath = join(SRC, "components", `${fixtureName}Bypass.ts`);
    const source = parseSource(productionPath, readFileSync(fixture, "utf8"));
    const baseline = scanProductionMutationCallsites();

    expect(scanProductionMutationCallsites(new Map([[productionPath, source]]))).toEqual([
      ...baseline,
      `src/components/${fixtureName}Bypass.ts -> call _restoreGroupingLayout`,
    ].sort());
  }, 120_000);

  it("requires tests to use the test-only raw engine entrypoint", () => {
    const violations = testFiles
      .filter((path) => !normalized(path).endsWith("helpers/groupingTestEntrypoint.ts"))
      .flatMap((path) => rawGroupingImports(path, cachedSource(path)).map((specifier) => `${normalized(path)} -> ${specifier}`));
    expect(violations).toEqual([]);
  }, 120_000);

  it("rejects production direct setState workspaces writes", () => {
    const violations = srcFiles.flatMap((path) => directWorkspaceSetStateWrites(path, cachedSource(path)));
    expect(violations).toEqual([]);
  }, 120_000);
});

function removedTabGroupingExportNames(source: ts.SourceFile): string[] {
  const exportedNames = new Set<string>();
  const recordBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (REMOVED_TAB_GROUPING_EXPORTS.has(name.text)) exportedNames.add(name.text);
      return;
    }
    name.elements.forEach((element) => {
      if (ts.isBindingElement(element)) recordBindingName(element.name);
    });
  };

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        REMOVED_TAB_GROUPING_EXPORTS.forEach((name) => exportedNames.add(name));
      } else if (ts.isNamedExports(statement.exportClause)) {
        statement.exportClause.elements.forEach((element) => {
          if (REMOVED_TAB_GROUPING_EXPORTS.has(element.name.text)) exportedNames.add(element.name.text);
        });
      }
      continue;
    }
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => recordBindingName(declaration.name));
    } else if ((ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isModuleDeclaration(statement))
      && statement.name
      && ts.isIdentifier(statement.name)
      && REMOVED_TAB_GROUPING_EXPORTS.has(statement.name.text)) {
      exportedNames.add(statement.name.text);
    }
  }
  return [...exportedNames].sort();
}

describe("Gate 3 L1b removed export negative fixtures", () => {
  const tabGroupingPath = join(SRC, "components", "layout", "tabGrouping.ts");

  it("keeps removed exports absent across star namespace and binding export forms", () => {
    expect(removedTabGroupingExportNames(
      parseSource(tabGroupingPath, readFileSync(tabGroupingPath, "utf8")),
    )).toEqual([]);
  });

  it.each([
    ["export star", "groupingBoundary.removedExportStar.fixture.txt"],
    ["namespace export", "groupingBoundary.removedExportNamespace.fixture.txt"],
    ["destructured export", "groupingBoundary.removedExportDestructured.fixture.txt"],
  ] as const)("detects the injected %s tombstone regression", (_fixtureName, fixtureFile) => {
    const fixture = join(TESTS, "fixtures", fixtureFile);
    const injected = `${readFileSync(tabGroupingPath, "utf8")}\n${readFileSync(fixture, "utf8")}`;
    const source = parseSource(tabGroupingPath, injected);

    expect(removedTabGroupingExportNames(source)).toContain("compileGroupingPlan");
  });
});
