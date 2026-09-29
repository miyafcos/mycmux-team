import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, type Plugin } from "vite";

const repoRoot = __dirname;
const mockRoot = resolve(repoRoot, "src", "mock");
const mockInput = resolve(mockRoot, "index.html");
const tauriStub = normalizePath(resolve(mockRoot, "tauriStub.ts"));
const tabGroupingActual = normalizePath(resolve(repoRoot, "src", "components", "layout", "tabGrouping.ts"));
const virtualAnalysisId = "\0mycmux-grouping-live-analysis";

function liveAnalysisProxy(): Plugin {
  return {
    name: "mycmux-grouping-live-analysis",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./tabGrouping" && importer?.endsWith("/TabGroupingPanel.tsx")) {
        return virtualAnalysisId;
      }
      return null;
    },
    load(id) {
      if (id !== virtualAnalysisId) return null;
      return [
        `export * from ${JSON.stringify(tabGroupingActual)};`,
        `export { scanGroupingContextMock as scanGroupingContext, runGroupingAnalysisMock as runGroupingAnalysis } from ${JSON.stringify(tauriStub)};`,
      ].join("\n");
    },
  };
}

function inlineSingleHtml(): Plugin {
  return {
    name: "mycmux-grouping-live-inline-html",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.bundle) return html;
        const scripts: string[] = [];
        const styles: string[] = [];

        for (const [fileName, output] of Object.entries(context.bundle)) {
          if (output.type === "chunk") {
            if (!output.isEntry && output.code.trim()) {
              throw new Error(`Unexpected non-entry JavaScript chunk: ${fileName}`);
            }
            let code = output.code
              .replaceAll("</script", "<\\/script")
              .replaceAll("https://", "https:\\/\\/")
              .replaceAll("http://", "http:\\/\\/");
            scripts.push(`<script type="module">${code}</script>`);
            delete context.bundle[fileName];
            continue;
          }
          if (fileName.endsWith(".css")) {
            const css = String(output.source).replaceAll("</style", "<\\/style");
            styles.push(`<style>${css}</style>`);
            delete context.bundle[fileName];
            continue;
          }
          throw new Error(`Unexpected external asset in live mock: ${fileName}`);
        }

        const withoutExternalTags = html
          .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, "")
          .replace(/<link\b[^>]*\bhref=[^>]*>/gi, "");
        const inlineHtml = withoutExternalTags
          .replace("</head>", `${styles.join("\n")}\n</head>`)
          .replace("</body>", `${scripts.join("\n")}\n</body>`);

        if (/<script\b[^>]*\bsrc=/i.test(inlineHtml) || /<link\b[^>]*\bhref=/i.test(inlineHtml)) {
          throw new Error("Live mock still contains an external script or stylesheet.");
        }
        if (/https?:\/\//i.test(inlineHtml)) {
          throw new Error("Live mock still contains an external URL scheme.");
        }
        return inlineHtml;
      },
    },
  };
}

export default defineConfig({
  root: mockRoot,
  base: "./",
  publicDir: false,
  clearScreen: false,
  plugins: [liveAnalysisProxy(), react(), inlineSingleHtml()],
  resolve: {
    alias: [{ find: /^@tauri-apps\/api(?:\/.*)?$/, replacement: tauriStub }],
  },
  esbuild: {
    minifyIdentifiers: false,
    minifySyntax: false,
  },
  build: {
    modulePreload: false,
    emptyOutDir: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: {
      input: mockInput,
      output: { inlineDynamicImports: true },
    },
  },
});
