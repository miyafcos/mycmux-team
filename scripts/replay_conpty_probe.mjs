// Replay a conpty_resize_probe.py log through @xterm/headless and print where the
// viewport sits at each step, in the same xterm.js build the app renders with.
//
//   node scripts/replay_conpty_probe.mjs <log.jsonl> [windowsPty|windowsMode|plain]
//
// windowsPty (default) matches production: the ConPTY reflow path, where a taller
// terminal gets blank rows pushed in below the text and conhost is expected to
// reprint. Each step prints the buffer plus lastTextLine / blankRowsBelowText,
// which is the number that has to reach zero for an agent prompt to sit on the
// bottom row.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless/lib-headless/xterm-headless.js");
const [,, logPath, mode = "windowsPty"] = process.argv;
const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const start = events.find((e) => e.kind === "start");
const opts = { cols: start.cols, rows: start.rows, scrollback: 5000, allowProposedApi: true };
if (mode === "windowsPty") opts.windowsPty = { backend: "conpty", buildNumber: 26100 };
if (mode === "windowsMode") opts.windowsMode = true;
const term = new Terminal(opts);
const write = (data) => new Promise((r) => term.write(Uint8Array.from(Buffer.from(data, "latin1")), r));
const esc = (s) => s.replace(/\x1b/g, "ESC").replace(/\r/g, "\r").replace(/\n/g, "\n");
function dump(label) {
  const b = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    rows.push(`${String(y).padStart(2)}|${line ? line.translateToString(true) : "<none>"}`);
  }
  const lastText = (() => { for (let i = b.length - 1; i >= 0; i--) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) return i; } return -1; })();
  console.log(`\n===== ${label}: cols=${term.cols} rows=${term.rows} cursor=(${b.cursorX},${b.cursorY}) baseY=${b.baseY} viewportY=${b.viewportY} length=${b.length} lastTextLine=${lastText} (from viewport top: ${lastText - b.viewportY}) blankRowsBelowText=${b.viewportY + term.rows - 1 - lastText}`);
  console.log(rows.join("\n"));
}
let sinceResize = null;
for (const e of events) {
  if (e.kind === "out") {
    await write(e.data);
    if (sinceResize !== null) sinceResize += e.data;
  } else if (e.kind === "resize") {
    if (sinceResize !== null) { console.log(`\n--- bytes conhost emitted since previous resize (${sinceResize.length} B):\n${esc(sinceResize).slice(0, 1500)}`); }
    dump(`before resize ${e.cols}x${e.rows} (t=${e.t})`);
    term.resize(e.cols, e.rows);
    dump(`after xterm resize ${e.cols}x${e.rows} (before conhost reacts)`);
    sinceResize = "";
  } else if (e.kind === "key") {
    if (sinceResize !== null) { console.log(`\n--- bytes conhost emitted since previous resize (${sinceResize.length} B):\n${esc(sinceResize).slice(0, 1500)}`); sinceResize = null; }
    dump(`before key ${JSON.stringify(e.data)} (t=${e.t})`);
  } else if (e.kind === "terminate") {
    if (sinceResize !== null) { console.log(`\n--- bytes conhost emitted since previous resize (${sinceResize.length} B):\n${esc(sinceResize).slice(0, 1500)}`); sinceResize = null; }
    dump(`final (t=${e.t})`);
  }
}
