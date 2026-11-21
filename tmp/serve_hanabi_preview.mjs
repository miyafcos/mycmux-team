import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  configFile: false, root, cacheDir: root + "/tmp/hanabi-vite-cache",
  plugins: [react()], server: { host: "127.0.0.1", port: 14279, strictPort: true, watch: { ignored: ["**/tmp/hanabi*edge*/**", "**/tmp/**/vite-cache/**", "**/tmp/hanabi-vite-cache/**"] } },
});
await server.listen();
console.log("Hanabi preview: http://127.0.0.1:14279/tmp/hanabi-preview.html");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.close(); process.exit(0); });
