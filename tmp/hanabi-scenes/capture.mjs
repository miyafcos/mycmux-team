import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
const root = process.cwd();
// Run from the repository root. --out <directory> overrides the screenshot/report
// directory (relative to that root or absolute); --draft keeps its existing default.
const { values: args } = parseArgs({ options: {
  out: { type: "string" }, draft: { type: "boolean" }, metrics: { type: "boolean" },
  audit: { type: "boolean" }, "settings-only": { type: "boolean" }, "side-only": { type: "boolean" },
} });
const output = resolve(root, args.out ?? join("tmp", "hanabi-scenes", ...(args.draft ? ["round3", "draft-shots"] : ["shots"])));
const profile = join(root, "tmp", "hanabi-scenes-edge-" + Date.now());
const server = await createServer({ configFile: false, root, cacheDir: join(root, "tmp", "hanabi-scenes", "vite-cache"),
  optimizeDeps: { entries: ["tmp/hanabi-preview.html"] },
  plugins: [react({ exclude: /(?:node_modules|vite-cache)/ })], server: { host: "127.0.0.1", port: 14289, strictPort: true, watch: { ignored: ["**/tmp/hanabi*edge*/**", "**/tmp/**/vite-cache/**", "**/tmp/hanabi-vite-cache/**"] } } });
let edge, page, browser;
const errors = [];
async function poll(read, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch {} await new Promise(r => setTimeout(r, 60)); }
  throw new Error("Timed out waiting for preview");
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.fail(new Error(JSON.stringify(message.error))); else entry.done(message.result ?? {});
  });
  return { close: () => socket.close(), send(method, params = {}) { return new Promise((done, fail) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); fail(new Error("CDP timeout: " + method)); }, 60000);
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }));
  }); } };
}
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
async function viewport(width, height, dpr = 1) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  await evaluate(`window.__hanabiPreview.size(${width},${height})`);
  await settle();
}

const ids = ["winter-night", "summer-seaside", "sakura-night", "harbor-night", "onsen-autumn"];
const result = { shots: [], metrics: [], layers: [], reduced: [], errors };
async function shot(name, width, height, scale = 1) {
  const data = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
    ...(scale === 1 ? {} : { clip: { x: 0, y: 0, width: width / scale, height: height / scale, scale } }) });
  const file = join(output, name + ".png");
  await writeFile(file, Buffer.from(data.data, "base64"));
  result.shots.push({ path: file, width, height }); console.log("SHOT", name);
}

async function settingsShot() {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1380, deviceScaleFactor: 1, mobile: false });
  await evaluate("window.__hanabiPreview.view('settings')"); await settle();
  await evaluate("[...document.querySelectorAll('[role=radio]')].find(e=>e.textContent==='\u3059\u308a\u30ac\u30e9\u30b9').click()"); await settle();
  // Lazy thumbnails may not have decoded after two RAFs on a busy workstation.
  await evaluate("Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode()}))");
  const loaded = await evaluate("[...document.images].every(img=>img.complete && img.naturalWidth>0)");
  if (!loaded) throw new Error("Settings thumbnails have not decoded");
  result.thumbnailRects = await evaluate("[...document.querySelectorAll('[data-surface-thumbnail]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.surfaceThumbnail,left:r.left,top:r.top,width:r.width,height:r.height}})");
  await shot("12-background-settings", 900, 1380);
}
try {
  await server.listen(); await mkdir(profile, { recursive: true }); await mkdir(output, { recursive: true });
  edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--disable-sync", "--hide-scrollbars", "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, stdio: "ignore" });
  const port = await poll(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/));
  browser = await connect(`ws://127.0.0.1:${port[0]}${port[1]}`);
  const targets = await fetch(`http://127.0.0.1:${port[0]}/json/list`).then(r => r.json());
  page = await connect(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable"); await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: "http://127.0.0.1:14289/tmp/hanabi-preview.html" });
  await poll(() => evaluate("!!window.__hanabiPreview"));
  result.browser = await browser.send("Browser.getVersion");
  if (process.argv.includes("--side-only")) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 6400, height: 836, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__hanabiPreview.freeze(undefined,8000,false,true);window.__hanabiPreview.view('side-by-side')"); await settle();
    await new Promise(r => setTimeout(r, 250));
    result.sideBySide = await evaluate("[...document.querySelectorAll('.side-by-side .stage')].map(stage=>({stageWidth:stage.getBoundingClientRect().width,canvasWidth:stage.querySelector('[data-hanabi-scene]').width,sidebar:stage.querySelector('.sidebar').getBoundingClientRect().width}))");
    if (result.sideBySide.length !== 5 || !result.sideBySide.every(item => item.stageWidth === 1280 && item.canvasWidth === 1280 && item.sidebar === 328)) throw new Error("Scaled layout affected scene geometry");
    await shot("14-scenes-side-by-side", 3200, 418, 0.5);
  }
  if (process.argv.includes("--settings-only")) await settingsShot();
  if (!process.argv.includes("--metrics") && !process.argv.includes("--audit") && !process.argv.includes("--settings-only") && !process.argv.includes("--side-only")) {
    await viewport(1280, 800);
    for (const [index, id] of ids.entries()) {
      await evaluate(`window.__hanabiPreview.scene(${JSON.stringify(id)}); window.__hanabiPreview.view('scene'); window.__hanabiPreview.freeze(undefined,8000,false,true)`);
      await settle(); await new Promise(r => setTimeout(r, 250));
      await shot(`${String(index + 1).padStart(2, "0")}-${id}-still`, 1280, 800);
      await evaluate("window.__hanabiPreview.freeze('merge',4100,false,true)"); await settle();
      await shot(`${String(index + 1).padStart(2, "0")}-${id}-merge`, 1280, 800);
      result.layers.push(await evaluate(`({id:${JSON.stringify(id)},surface:document.querySelectorAll('[data-hanabi-terminal-light]').length,
        css:getComputedStyle(document.querySelector('.terminal-surface')).backgroundColor,
        xterm:window.__previewTerminal.options.theme.background, input:(()=>{const r=document.querySelector('.input').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})(),
        text:document.querySelector('.message.assistant').textContent})`));
    }
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1312, height: 1350, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__hanabiPreview.freeze(undefined,0,true,false);window.__hanabiPreview.view('gallery')"); await settle();
    await shot("11-five-scenes", 1312, 1350);
    await settingsShot();
    await page.send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 836, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__hanabiPreview.scene('winter-night');window.__hanabiPreview.freeze('merge',1800,false,true);window.__hanabiPreview.view('compare')"); await settle();
    await shot("13-terminal-before-after", 2560, 836);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 6400, height: 836, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__hanabiPreview.freeze(undefined,8000,false,true);window.__hanabiPreview.view('side-by-side')"); await settle();
    await shot("14-scenes-side-by-side", 3200, 418, 0.5);
    await viewport(1280, 800);
    await evaluate("window.__hanabiPreview.view('scene');window.__hanabiPreview.scene('winter-night');window.__hanabiPreview.freeze('merge',3650,false,false)"); await settle();
    const raw = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    result.winterFull = join(root, "tmp", "hanabi-scenes", "round3", "winter-merge-full.png");
    await writeFile(result.winterFull, Buffer.from(raw.data, "base64"));
  }
  if (process.argv.includes("--audit")) {
    result.audit = {};
    result.audit.rayMask = await evaluate(`(async()=>{
      const {createHanabiScene}=await import('/src/lib/hanabiScenery.ts');
      const {createNightFireworks}=await import('/src/lib/hanabiScene.ts');
      const {paintNightFireworks}=await import('/src/lib/hanabiCanvas.ts');
      const scene=createHanabiScene('winter-night',1280,800,42);
      const burst={...createNightFireworks('done',1280,800,0,42)[0],x:400,y:300,radius:180};
      const render=(reading)=>{const c=document.createElement('canvas');c.width=1280;c.height=800;const ctx=c.getContext('2d');ctx.fillStyle='#18123e';ctx.fillRect(0,0,1280,800);
        paintNightFireworks(ctx,{...scene,layout:{conversationRect:reading}},1800,[burst]);return ctx.getImageData(0,0,1280,800).data;};
      const a=render(undefined),r={left:500,top:200,right:700,bottom:500},b=render(r);
      let outsideMax=0;const ratios=[],outside=[];
      for(let y=0;y<800;y++)for(let x=0;x<1280;x++){const i=(y*1280+x)*4;
        if(x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom){const light=a[i]-24;if(light>30)ratios.push((b[i]-24)/light);}
        else if(x<r.left-2||x>=r.right+2||y<r.top-2||y>=r.bottom+2)for(let c=0;c<3;c++){const delta=Math.abs(a[i+c]-b[i+c]);if(delta>outsideMax){outsideMax=delta;outside.push({x,y,c,a:a[i+c],b:b[i+c],delta});}}}
      return {pixels:ratios.length,mean:ratios.reduce((a,b)=>a+b,0)/ratios.length,outsideMax,outside,edgeExcluded:2};
    })()`);
    if(result.audit.rayMask.pixels<30 || Math.abs(result.audit.rayMask.mean-0.5)>0.025 || result.audit.rayMask.outsideMax>1)
      throw new Error('Ray mask failed: '+JSON.stringify(result.audit.rayMask));
    await evaluate(`(()=>{window.__thumbnailDraws=[];const original=CanvasRenderingContext2D.prototype.drawImage;
      window.__restoreThumbnailDraw=()=>{CanvasRenderingContext2D.prototype.drawImage=original};
      CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.dataset.sceneThumbnail && this.canvas.closest("[data-scene-id]") && args.length===9)
        window.__thumbnailDraws.push({id:this.canvas.dataset.sceneThumbnail,sourceHeight:args[0].height,rect:args.slice(1)});return original.apply(this,args)};})()`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__hanabiPreview.view('settings')"); await settle();
    result.audit.thumbnailDraws = await evaluate("window.__restoreThumbnailDraw();window.__thumbnailDraws");
    if(result.audit.thumbnailDraws.length!==5 || !result.audit.thumbnailDraws.every(d=>d.sourceHeight===546 && d.rect[1]===246 && d.rect[2]===480 && d.rect[3]===300 && d.rect[6]/d.rect[2]===d.rect[7]/d.rect[3]))
      throw new Error('Distorted thumbnail: '+JSON.stringify(result.audit.thumbnailDraws));
    result.audit.narrow = await evaluate(`(()=>{const cards=[...document.querySelectorAll('[data-scene-id]')];return {count:cards.length,
      viewport:innerWidth,width:document.documentElement.scrollWidth,rows:new Set(cards.map(c=>c.getBoundingClientRect().top)).size,
      right:Math.max(...cards.map(c=>c.getBoundingClientRect().right))}})()`);
    await evaluate("document.querySelector('[data-scene-id=winter-night]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");await settle();
    result.audit.keyboard = await evaluate("document.querySelector('[data-scene-id=summer-seaside]').getAttribute('aria-checked')==='true' && document.activeElement.dataset.sceneId==='summer-seaside'");
    for (const id of ["solid","frosted","clear"]) {
      await evaluate(`document.querySelector('[data-surface-thumbnail=${id}]').closest('button').click()`);await settle();
      result.audit[id] = await evaluate(`document.querySelector('[data-surface-thumbnail=${id}]').closest('button').getAttribute('aria-checked')==='true'`);
    }
    const a = await evaluate("[...document.querySelectorAll('[data-scene-thumbnail]')].map(c=>c.toDataURL())");
    await new Promise(r=>setTimeout(r,1100));
    const b = await evaluate("[...document.querySelectorAll('[data-scene-thumbnail]')].map(c=>c.toDataURL())");
    result.audit.thumbnailsStatic = JSON.stringify(a)===JSON.stringify(b);
    result.audit.noLiveSceneInSettings = await evaluate("!document.querySelector('[data-hanabi-scene]') && !document.querySelector('[data-hanabi-terminal-light]')");
    await viewport(1280,800,3);await evaluate("window.__hanabiPreview.view('scene');window.__hanabiPreview.freeze('done',1800,false,true)");await settle();
    result.audit.dpr = await evaluate("({ratio:devicePixelRatio,width:document.querySelector('[data-hanabi-scene]').width,height:document.querySelector('[data-hanabi-scene]').height})");
    if(result.audit.narrow.width>320 || result.audit.narrow.count!==5 || result.audit.narrow.rows<2 || !result.audit.keyboard || !result.audit.solid || !result.audit.frosted || !result.audit.clear || !result.audit.thumbnailsStatic || !result.audit.noLiveSceneInSettings || result.audit.dpr.width!==2560) throw new Error(JSON.stringify(result.audit));
    console.log("AUDIT",JSON.stringify(result.audit));
  }
  if (process.argv.includes("--metrics")) {
    await viewport(1920, 1080);
    result.viewport = { width: 1920, height: 1080, dpr: 1 };
    await evaluate("window.__hanabiBenchmarkToken='stable-metrics'");
    await evaluate("window.__hanabiPreview.view('scene')"); await settle();
    for (const panes of [1, 4]) for (const id of ids) {
      await evaluate("window.__hanabiPreview.panes(" + panes + ")");
      await evaluate("window.__hanabiPreview.resume();window.__hanabiPreview.scene(" + JSON.stringify(id) + ");window.__hanabiPreview.mock(true)"); await settle();
      await new Promise(r => setTimeout(r, 3400));
      const normal = await evaluate("window.__hanabiPreview.measurements.splice(0)");
      await evaluate("window.__hanabiPreview.resume();window.__hanabiPreview.mock(true);window.__hanabiPreview.run('merge')");
      // Five samples include the final opening at 3260ms and its peak.
      await new Promise(r => setTimeout(r, 5500));
      const fireworks = await evaluate("window.__hanabiPreview.measurements.splice(0)");
      const identity = await evaluate("({token:window.__hanabiBenchmarkToken,id:document.querySelector('[data-hanabi-scene]')?.dataset.hanabiScene,width:document.querySelector('[data-hanabi-scene]')?.width,panes:document.querySelectorAll('[data-hanabi-terminal-light]').length})");
      if (identity.token !== "stable-metrics" || identity.id !== id || identity.width !== 1920 || identity.panes !== panes || normal.length < 3 || fireworks.length < 5)
        throw new Error("Incomplete benchmark: " + JSON.stringify({ identity, normal: normal.length, merge: fireworks.length }));
      for (const [kind, samples] of [["normal", normal], ["merge", fireworks]]) {
        const frames = samples.reduce((sum, x) => sum + x.frames, 0);
        result.metrics.push({ id, panes, kind, samples, frames,
          averageMs: samples.reduce((sum, x) => sum + x.averageMs * x.frames, 0) / frames, maxMs: Math.max(...samples.map(x => x.maxMs)) });
      }
      console.log("METRIC", panes, id, result.metrics.slice(-2).map(x => ({ kind: x.kind, avg: x.averageMs, max: x.maxMs })));
      await evaluate("window.__hanabiPreview.freeze('merge',3650,true,true)"); await settle();
      const before = await evaluate("[...document.querySelectorAll('.stage canvas')].map(c=>c.toDataURL())");
      await new Promise(r => setTimeout(r, 1100));
      const after = await evaluate("[...document.querySelectorAll('.stage canvas')].map(c=>c.toDataURL())");
      result.reduced.push({ id, panes, static: JSON.stringify(before) === JSON.stringify(after) });
      if (result.reduced.at(-1).static !== true) throw new Error("Reduced motion changed");
    }
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally {
  await writeFile(join(output, process.argv.includes("--side-only") ? "side-only.json" : process.argv.includes("--settings-only") ? "settings-only.json" : process.argv.includes("--metrics") ? "performance.json" : process.argv.includes("--audit") ? "browser-audit.json" : "visual.json"),JSON.stringify(result,null,2));
  try { await browser?.send("Browser.close"); } catch {} page?.close(); browser?.close();
  if (edge && edge.exitCode === null) edge.kill(); await server.close();
}
