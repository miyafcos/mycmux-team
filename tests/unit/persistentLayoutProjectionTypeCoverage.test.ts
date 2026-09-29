import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { expectGroupingRuntimeTypeCoverage } from "./helpers/groupingRuntimeTypeCoverageAssertions";

interface TypeCoverageCompilation {
  status: number | null;
  diagnostics: string;
}

let cachedCompilation: TypeCoverageCompilation | undefined;

function getTypeCoverageCompilation(): TypeCoverageCompilation {
  if (cachedCompilation) return cachedCompilation;
  const tsc = resolve(process.cwd(), "node_modules/typescript/bin/tsc");
  const persistentFixture = resolve(
    process.cwd(),
    "tests/unit/fixtures/persistentLayoutProjection.futureField.fixture.ts",
  );
  const groupingFixture = resolve(
    process.cwd(),
    "tests/unit/fixtures/runLayoutTransition.async.fixture.ts",
  );
  const viteTypes = resolve(process.cwd(), "src/vite-env.d.ts");
  const result = spawnSync(process.execPath, [
    tsc,
    "--pretty", "false",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target", "ES2022",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--lib", "ES2022,DOM,DOM.Iterable",
    "--jsx", "react-jsx",
    "--types", "vite/client",
    viteTypes,
    persistentFixture,
    groupingFixture,
  ], { encoding: "utf8" });
  cachedCompilation = {
    status: result.status,
    diagnostics: `${result.stdout}\n${result.stderr}`,
  };
  return cachedCompilation;
}

describe.sequential("persistent projection compile-time coverage", () => {
  it("fails compilation when raw persistent types gain unprojected fields", () => {
    const { status, diagnostics } = getTypeCoverageCompilation();
    expect(status).not.toBe(0);
    expect(diagnostics).toContain("__fixtureWorkspacePersistent");
    expect(diagnostics).toContain("__fixturePanePersistent");
    expect(diagnostics).toContain("__fixtureTabPersistent");
  }, 120_000);

  it("rejects Promise and thenable callbacks at compile time", () => {
    const { status, diagnostics } = getTypeCoverageCompilation();
    expectGroupingRuntimeTypeCoverage(status, diagnostics);
  }, 120_000);
});
