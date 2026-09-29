import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const host = env.TAURI_DEV_HOST;
  const isCmuxVariant = env.VITE_UI_VARIANT === "mycmux" || env.VITE_UI_VARIANT === "cmux";

  return {
    plugins: [react()],
    clearScreen: false,
    build: {
      outDir: env.VITE_OUT_DIR || (mode === "production" && isCmuxVariant ? "dist-cmux-ui" : "dist"),
    },
    // @xterm/xterm@6.0.0 ships pre-minified ESM; esbuild's re-minification drops
    // a `let` declaration in InputHandler.requestMode (minifySyntax) and upstream
    // also reports broken closure renames (minifyIdentifiers), crashing on the
    // first DECRQM query from TUI apps in production builds only
    // (xtermjs/xterm.js#5800). Verified: with these off, DECRQM 2026 replies
    // correctly; with defaults it throws ReferenceError. Whitespace minify stays on.
    esbuild: {
      minifyIdentifiers: false,
      minifySyntax: false,
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
