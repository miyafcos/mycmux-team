import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CDP, targets, socketCall } from './run-baseline.mjs';

export function validateTerminalState(state, dom, expectedSessionId) {
  const violations = [];
  if (!dom.panes.length && !dom.detached) violations.push({reason:'No terminal workspace or detached shell found'});
  for (const pane of dom.panes) {
    const current = state.panes.find(p=>p.id===pane.paneId);
    if (!current) { violations.push({paneId:pane.paneId,reason:'stale pane in DOM'});continue; }
    const active = current.tabs.find(t=>t.id===current.activeTabId);
    const shown = pane.terminals.filter(t=>t.visible);
    const isTerminal=active && (active.type===undefined || active.type==='terminal');
    if (pane.visible && isTerminal && (shown.length!==1 || shown[0].sessionId!==active.sessionId))
      violations.push({paneId:pane.paneId,expected:active.sessionId,shown});
    if (pane.visible && !isTerminal && shown.length)
      violations.push({paneId:pane.paneId,reason:'Non-terminal active tab has a stale visible terminal',shown});
    if (!pane.visible && shown.length) violations.push({paneId:pane.paneId,reason:'hidden pane has painted terminal',shown});
  }
  if (dom.detached) {
    const shown = dom.detached.terminals.filter(t=>t.visible);
    if (!expectedSessionId || shown.length!==1 || shown[0].sessionId!==expectedSessionId)
      violations.push({reason:'Detached terminal identity or visibility mismatch',expected:expectedSessionId,shown});
  } else if (expectedSessionId && !dom.panes.some(p=>p.visible && p.terminals.some(t=>t.visible && t.sessionId===expectedSessionId))) {
    violations.push({reason:'Expected session is not visible',expected:expectedSessionId});
  }
  return violations;
}

export async function captureTerminalState({port, profile, output, label, targetId, expectedSessionId}) {
if (!/^\d+$/.test(String(port)) || !/^[\w-]{1,64}$/.test(profile??'') || !/^[\w-]+$/.test(label??''))
  throw new Error('Usage: port isolated-profile output-dir ASCII-label [target-id expected-session-id]');
const candidates = (await targets(Number(port))).filter(t=>t.url.includes('tauri'));
if (!targetId && candidates.length!==1) throw new Error('Select a target explicitly when more than one window exists');
const target = targetId ? candidates.find(t=>t.id===targetId) : candidates[0];
if (!target) throw new Error('No matching isolated target');
const cdp = await CDP.connect(target);
try {
  if (await cdp.invoke('get_test_profile') !== profile) throw new Error('Profile mismatch');
  const state = await socketCall(profile, 'pane.list_all');
  const dom = await cdp.eval(`(()=>{
    const shown=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const terminal=n=>({sessionId:n.closest('[data-session-id]')?.dataset.sessionId,visible:shown(n),
      width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,
      fontFamily:getComputedStyle(n).fontFamily,fontSize:getComputedStyle(n).fontSize,
      background:getComputedStyle(n).backgroundColor,
      canvases:[...n.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height}))});
    const detached=document.querySelector('[data-detached-pane-shell]');
    return {atMs:performance.timeOrigin+performance.now(),width:innerWidth,height:innerHeight,
      activeSession:document.activeElement?.closest('[data-session-id]')?.dataset.sessionId,
      detached:detached?{terminals:[...detached.querySelectorAll('.xterm-screen')].map(terminal)}:null,
      panes:[...document.querySelectorAll('[data-dnd-pane-id]')].map(p=>({
        paneId:p.dataset.dndPaneId,workspaceId:p.dataset.dndWorkspaceId,visible:shown(p),
        terminals:[...p.querySelectorAll('.xterm-screen')].map(terminal),
      }))};
  })()`);
  const violations = validateTerminalState(state, dom, expectedSessionId);
  const stem=join(resolve(output), label);
  const capture=await cdp.call('Page.captureScreenshot',{format:'png'});
  writeFileSync(stem+'.png',Buffer.from(capture.data,'base64'));
  const evidence={profile,targetId:target.id,expectedSessionId,state,dom,violations,pass:!violations.length};
  writeFileSync(stem+'.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({label,pass:!violations.length,visiblePanes:dom.panes.filter(p=>p.visible).length,violations}));
  return evidence;
} finally { cdp.close(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [port, profile, output, label, targetId, expectedSessionId]=process.argv.slice(2);
  const evidence=await captureTerminalState({port,profile,output,label,targetId,expectedSessionId});
  if (!evidence.pass) process.exitCode=1;
}
