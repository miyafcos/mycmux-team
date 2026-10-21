import { writeFileSync } from 'node:fs';

const [portText, expectedProfile, outputPath] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || port < 9300 || port > 9399 || !/^ci0886_\d+_\d+$/.test(expectedProfile) || !outputPath) throw new Error('Invalid diagnostic arguments');
const result = { targets: [], pages: [], errors: [] };
let sequence = 0;

function allowedPage(raw) {
  if (raw === 'about:blank') return true;
  try {
    const address = new URL(raw);
    return ['http:', 'https:', 'tauri:'].includes(address.protocol) && address.hostname === 'tauri.localhost' && !address.username && !address.password;
  } catch { return false; }
}

async function inspect(target) {
  const address = new URL(target.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || Number(address.port) !== port || address.username || address.password) throw new Error('Unexpected CDP endpoint');
  const socket = new WebSocket(address);
  const pending = new Map();
  const page = { url: target.url, events: [], profile_verified: false };
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const task = pending.get(message.id);
        clearTimeout(task.timer);
        pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
      } else if (['Runtime.exceptionThrown', 'Log.entryAdded'].includes(message.method) && page.events.length < 30) {
        page.events.push(message);
      }
    } catch { page.message_parse_error = true; }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); }, { once: true });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 7000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    await send('Log.enable');
    const snapshot = await send('Runtime.evaluate', {
      expression: '({href:location.href,readyState:document.readyState,visibility:document.visibilityState,rootChildren:document.querySelector("#root")?.childElementCount,tauri:!!window.__TAURI_INTERNALS__,userAgent:navigator.userAgent,scripts:[...document.scripts].map(script=>script.src),resources:performance.getEntriesByType("resource").map(item=>({name:item.name,duration:item.duration,transferSize:item.transferSize})).slice(-30)})',
      returnByValue: true,
    });
    page.snapshot = snapshot.result?.value ?? snapshot;
    if (page.snapshot.tauri) {
      const identity = await send('Runtime.evaluate', {
        expression: 'window.__TAURI_INTERNALS__.invoke("get_test_profile")',
        awaitPromise: true, returnByValue: true, timeout: 5000,
      });
      page.profile_verified = identity.result?.value === expectedProfile;
      if (!page.profile_verified) page.profile_error = identity.exceptionDetails ? 'profile invoke failed' : 'profile identity mismatch';
      if (page.profile_verified) {
        const body = await send('Runtime.evaluate', {
          expression: 'document.body?.innerText.slice(0,2000)', returnByValue: true,
        });
        page.synthetic_body = body.result?.value;
      }
    }
  } catch (error) {
    page.error = String(error);
  } finally {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP closed')); }
    socket.close();
  }
  result.pages.push(page);
}

async function main() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('CDP target HTTP ' + response.status);
    const targets = await response.json();
    if (!Array.isArray(targets) || targets.length > 50) throw new Error('Invalid CDP target list');
    for (const target of targets) {
      const allowed = target.type === 'page' && allowedPage(target.url);
      result.targets.push({ type: target.type, url: allowed ? target.url : '<not-inspected>', inspected: allowed });
      if (allowed) await inspect(target);
    }
  } catch (error) {
    result.errors.push(String(error));
  }
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log('WEBVIEW_DIAGNOSTIC', result.targets.length, result.pages.length, result.errors.length);
}

await main();
