import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Plugin } from "vite";

// Load the actual pinned base tree in a separate module graph. Never edit or
// check out another worktree. IPC and display metadata are deliberately shared
// so both graphs receive the SAME input and the SAME event/await ordering.
export const NARROW_BASE = "cc4dae78e832c3439875d7611b72cf0b78452a77";
export const NARROW_CANDIDATE = "a9f3492fb1672e5aad56fdb6f5946a5de20aca6f";
export function narrowBasePlugin(): Plugin {
  const root = process.cwd();
  const graphs = [
    { alias: "codex-base:", prefix: "/__codex_narrow_base__/", revision: NARROW_BASE },
    { alias: "codex-merge:", prefix: "/__codex_narrow_merge__/", revision: NARROW_CANDIDATE },
  // Node's file URLs need a drive on Windows, including for these virtual modules.
  ].map(graph => ({ ...graph, prefix: root.replaceAll("\\", "/") + graph.prefix,
    files: new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", graph.revision], { cwd: root, encoding: "utf8" }).trim().split("\n")) }));
  const shared = new Set(["src/lib/ipc.ts", "src/stores/paneMetadataStore.ts", "src/lib/windowContext.ts",
    // Detached parity compares the actual component's launch props. Use the
    // same renderer boundary in both graphs; no launch calculation is shared.
    "src/components/terminal/XTermWrapper.tsx"]);
  const resolve = (file: string, graph: typeof graphs[number]) => {
    const target = [file, file + ".ts", file + ".tsx", file + "/index.ts", file + "/index.tsx"].find(candidate => graph.files.has(candidate));
    if (!target) throw new Error(`Missing pinned base module: ${file}`);
    return shared.has(target) || !/\.tsx?$/.test(target) ? path.join(root, target).replaceAll("\\", "/") : graph.prefix + target;
  };
  return {
    name: "codex-narrow-base-parity", enforce: "pre",
    resolveId(id) {
      for (const graph of graphs) {
        if (id.startsWith(graph.alias)) return resolve(id.slice(graph.alias.length), graph);
        if (id.startsWith(graph.prefix)) return id;
      }
    },
    load(id) {
      const graph = graphs.find(graph => id.startsWith(graph.prefix));
      if (!graph) return;
      const file = id.slice(graph.prefix.length);
      const text = execFileSync("git", ["show", `${graph.revision}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      return text.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'])(\.[^"']+)(["'])/g,
        (_match, start: string, relative: string, end: string) => start + resolve(path.posix.normalize(path.posix.join(path.posix.dirname(file), relative)), graph) + end);
    },
  };
}
