import { defineConfig } from "vitest/config";

const ENGINE_SUFFIX = "/src/components/layout/tabGroupingEngine.ts";
const BLANK_PANE_CALL = "    : workspace.panes.slice(0, 1).map(blankPane);";
const MUTATED_CALL = "    : workspace.panes.slice(0, 1).map((item) => ({ ...item, tabs: [] }));";

export default defineConfig({
  plugins: [{
    name: "gate3-l1b-disable-blank-pane",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.split("?", 1)[0].replaceAll("\\", "/");
      if (!normalizedId.endsWith(ENGINE_SUFFIX)) return null;
      if (!code.includes(BLANK_PANE_CALL)) {
        throw new Error("blankPane mutation target was not found");
      }
      return { code: code.replace(BLANK_PANE_CALL, MUTATED_CALL), map: null };
    },
  }],
});
