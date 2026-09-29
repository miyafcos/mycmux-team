// Windows stage-three measurements; product behavior is never changed here.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { installReactCommitProbe } from './react-commit-probe.mjs';
import { measureProducer } from './throughput-producer.mjs';
import { startFlowTrace, finishFlowTrace } from './flow-trace.mjs';
import { CDP, targets, freePort, socketCall, waitUntil, marks, markAfter, click, point, mouse,
  ensureShell as baselineEnsureShell, traceStop, activateTerminalLink, firstChildFrame, fixtureHtml,
  closePreviewPane, nativeWindowBounds, changedPreviewFrame, verifyPlacementE2e, nativeWindows, placementSnapshot, verifyPlaced } from './run-baseline.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] : fallback;
const out = resolve(arg('--output-dir', join(process.env.USERPROFILE, '_work/mycmux-perf3-260924/base')));
const exe = resolve(arg('--exe', join(out, 'mycmux.exe')));
const profile = arg('--profile-name', 'perf3');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid isolated profile name');
const only = arg('--only', '').split(',').filter(Boolean);
const selected = key => !only.length || only.some(prefix => key === prefix || key.startsWith(prefix + '_'));
const retentionRounds = Number(arg('--retention-round-trips', '100'));
const retentionCooldown = Number(arg('--retention-cooldown-ms', '1000'));
if (!Number.isInteger(retentionRounds) || retentionRounds < 1 || !Number.isFinite(retentionCooldown) || retentionCooldown < 0)
  throw new Error('Invalid retention options');
const heapSnapshots = process.argv.includes('--heap-snapshots');
const naturalInput = process.argv.includes('--natural-input');
const reactProfile = process.argv.includes('--react-profile');
const throughputDetail = process.argv.includes('--throughput-detail');
const flowTrace = process.argv.includes('--flow-trace');
const matchesProfile = row => Array.isArray(row?.cmdline)
  && row.cmdline.indexOf('--profile') >= 0
  && row.cmdline[row.cmdline.indexOf('--profile') + 1] === profile;
const resultPath = join(out, 'stage3.json');
const q = JSON.stringify;
const dataPath = join(process.env.APPDATA, `com.miyazaki.mycmux/profiles/${profile}/data.json`);
const runtime = join(process.env.USERPROFILE, `.mycmux-${profile}`);
if(out.toLowerCase().startsWith(repo.toLowerCase()+'\\'))throw new Error('Results must remain outside the repository');
mkdirSync(out, { recursive:true });
const seedArgument=arg('--layout-seed',null);
if(seedArgument){
  const destination=join(out,'stage3-layout-seed.json');
  const source=readFileSync(resolve(seedArgument));
  if(existsSync(destination)&&!readFileSync(destination).equals(source))throw new Error('Existing layout seed differs from requested seed');
  if(!existsSync(destination))copyFileSync(resolve(seedArgument),destination);
}
const report = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8'))
  : { schemaVersion:3, startedAt:new Date().toISOString(), exe, measurements:{}, errors:[], runs:[], assumptions:[] };
const exeHash=createHash('sha256').update(readFileSync(exe)).digest('hex');
// Capture the loaded driver's identity once; later source edits do not alter this process.
const driverHash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
if(report.binarySha256&&report.binarySha256!==exeHash)throw new Error('Executable changed within existing results; use another output directory');
report.binarySha256=exeHash;
let active;
const liveWindowPath=join(process.env.APPDATA,'com.miyazaki.mycmux/.window-state.json');
const profileWindowPath=join(process.env.APPDATA,`com.miyazaki.mycmux/profiles/${profile}/.window-state.json`);
function fileState(path) {
  if(!existsSync(path))return {exists:false};
  const stat=statSync(path,{bigint:true});
  return {exists:true,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),mtimeNs:String(stat.mtimeNs),bytes:Number(stat.size)};
}
function isolationStop(evidence) {
  writeFileSync(join(out,'ISOLATION_BLOCKED.json'),q(evidence));
  throw new Error('Production window-state changed or isolated close failed; see ISOLATION_BLOCKED.json');
}
function importRows() {
  const sourcePath=arg('--import-rows',null);
  if(!sourcePath)return;
  const groups=arg('--groups','').split(',').filter(Boolean);
  if(!groups.length)throw new Error('--import-rows requires explicit --groups prefixes');
  const source=JSON.parse(readFileSync(resolve(sourcePath),'utf8'));
  const imported=[];
  for(const [name,bucket] of Object.entries(source.measurements)) {
    if(!groups.some(prefix=>name.startsWith(prefix)))continue;
    const present=report.measurements[name];
    if(present) {
      if(q(present)!==q(bucket))throw new Error('Refusing conflicting imported group '+name);
      continue;
    }
    if(bucket.samples.some(row=>!row.binarySha256))throw new Error('Imported rows require original binary SHA: '+name);
    report.measurements[name]=structuredClone(bucket);imported.push({name,rows:bucket.samples.length});
  }
  if(imported.length)(report.imports??=[]).push({source:resolve(sourcePath),sourceSha256:createHash('sha256').update(readFileSync(resolve(sourcePath))).digest('hex'),imported,at:new Date().toISOString()});
  save();
}
const expected = {};
for (const load of ['L0','L24']) for (const temp of ['cold','warm']) expected[`S1_${load}_${temp}`] = temp==='cold'?3:10;
for (const load of ['L0','L24','L24S','L24S+H']) {expected[`S2_${load}`]=5;expected[`S2_control_${load}`]=1;}
expected.Ha_incremental=1;
expected.S4_workspace_retention=1;
if(reactProfile)expected.S4_react_profile=1;
expected.Stability_plateau=1;
for (const load of ['L24','L24S']) expected[`S3_${load}`]=200;
for (const kind of ['tab','pane','workspace']) expected[`S4_${kind}`]=20;
for (const kind of ['seq','cat']) expected[`S5_${kind}`]=10;
expected.S6_terminal=10; expected.S6_preview=10;
for (const kind of ['small','medium','heavy','markdown']) {
  expected[`S7_${kind}_cold`]=kind==='medium'?5:3;
  expected[`S7_${kind}_warm`]=10;
  expected[`S7_${kind}_changed`]=10;
}
expected.S8_continuous=1;
if(arg('--phase','all')==='S8_transfer'||report.measurements.S8_transfer)expected.S8_transfer=20;
for (const [kind,count] of Object.entries({workspace:100,tab:100,detach:20,html:20,split:10,restart:3})) expected[`S8_${kind}`]=count;
if (flowTrace) {
  if (!only.length || !only.every(prefix => prefix === 'S5_trace' || prefix.startsWith('S5_trace_')))
    throw new Error('--flow-trace requires --only S5_trace (or one of its subgroups)');
  expected.S5_trace_seq = 3; expected.S5_trace_cat = 3;
}
for (const prefix of only) if (!Object.keys(expected).some(key => key === prefix || key.startsWith(prefix + '_')))
  throw new Error('Unknown measurement group: ' + prefix);

export function stats(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const p = x => { if (!sorted.length) return null; const i=(sorted.length-1)*x; return sorted[Math.floor(i)]+(sorted[Math.ceil(i)]-sorted[Math.floor(i)])*(i%1); };
  return { n:sorted.length, median:p(.5), p90:p(.9), p99:p(.99), max:sorted.at(-1)??null };
}
function save() {
  report.updatedAt=new Date().toISOString();
  report.completeness={ missing:Object.entries(expected).filter(([key,n])=>selected(key)&&count(key)<n).map(([key,n])=>({key,required:n,actual:count(key)})) };
  report.completeness.invalid=[];
  const requireFinite=(name,row,keys)=>{for(const key of keys)if(!Number.isFinite(row[key]))report.completeness.invalid.push({name,run:row.run,field:key});};
  for(const [name,bucket] of Object.entries(report.measurements))for(const row of bucket.samples){
    if(name.startsWith('S1_')){
      requireFinite(name,row,['processToVisibleMs','processToFrameMs','processToAllPtysMs','processToInputMs','processToAllPtysAndInputMs']);
      if(naturalInput)requireFinite(name,row,['processToNaturalInputMs']);
      if(row.ptyCount<(name.includes('L0')?1:24))report.completeness.invalid.push({name,run:row.run,reason:'missing restored PTYs'});
    }else if(name.startsWith('S2_')){
      requireFinite(name,row,['durationSeconds','appCpuMs','rendererCpuMs','gpuCpuMs','webviewWs','heap','rendererPid']);
      if(row.durationSeconds<59)report.completeness.invalid.push({name,run:row.run,reason:'short idle window'});
      if(!name.includes('control')&&(!existsSync(row.traceFile??'')||!existsSync(row.detailsFile??'')))report.completeness.invalid.push({name,run:row.run,reason:'missing profile evidence'});
    }else if(name.startsWith('S6_')){
      requireFinite(name,row,['childBuiltMs','firstFrameMs','visibleMs','mainFrameMs']);
      requireFinite(name,row,name.endsWith('preview')?['returnShownMs','frameToCreateMs','childCreateMs','createdToShownMs']:['inputPaintMs']);
    }else requireFinite(name,row,['elapsedMs']);
    if(name==='S6_preview'&&(row.childCreateMs<0||row.createdToShownMs<0||!existsSync(row.returnMarksFile??'')))report.completeness.invalid.push({name,run:row.run,reason:'invalid preview return mark pairing'});
    if(name==='S8_restart'&&(!row.idsEqual||row.duplicatePtyStarts?.length||row.newErrors?.length))report.completeness.invalid.push({name,run:row.run,reason:'restart stability failure'});
    if(name==='S4_react_profile'&&(!row.reactProbe?.validated||['tab','pane','workspace'].some(kind=>row.groups?.[kind]?.length!==20||row.groups[kind].every(sample=>sample.commitCount===0))))report.completeness.invalid.push({name,reason:'React commit probe did not observe each switching group'});
    if(name.startsWith('S5_') && (row.inputs?.length!==50||row.inputsDuringOutput!==50||!Number.isFinite(row.outputBytes)||row.outputBytes<1000000))report.completeness.invalid.push({name,run:row.run,reason:'invalid throughput or keystroke count'});
    if(row.diagnosticOnly&&row.flowIntegrity?.pass!==true)report.completeness.invalid.push({name,run:row.run,reason:'flow trace did not fully drain and paint',issues:row.flowIntegrity?.issues});
    if(name.startsWith('S7_')&&name.endsWith('_changed')&&!row.markerVerified)report.completeness.invalid.push({name,run:row.run,reason:'changed content unverified'});
    if(name==='Ha_incremental'&&(!row.available||row.matched!==6))report.completeness.invalid.push({name,reason:'synthetic livebrief probe unavailable'});
    if(name==='S8_continuous'&&(row.checkpoints?.length!==7||row.elapsedMs<1800000))report.completeness.invalid.push({name,reason:'short endurance or missing checkpoints'});
  }
  for(const load of ['L24','L24S'])if(count('S3_'+load)>=200&&!existsSync(join(out,`S3_${load}-slow-keys.json`)))report.completeness.invalid.push({name:'S3_'+load,reason:'missing per-slow-key trace attribution'});
  report.completeness.complete=report.completeness.missing.length===0&&report.completeness.invalid.length===0;
  writeFileSync(resultPath,q(report));
}
function count(name) { return report.measurements[name]?.samples.length??0; }
function add(name,value) {
  const bucket=report.measurements[name]??={samples:[],summary:{}};
  bucket.samples.push({...value,binarySha256:exeHash,driverSha256:driverHash,recordedAt:new Date().toISOString()});
  for (const key of new Set(bucket.samples.flatMap(Object.keys))) {
    const vals=bucket.samples.map(row=>row[key]).filter(Number.isFinite);
    if(vals.length) bucket.summary[key]=stats(vals);
  }
  save();
  console.log(`${name}: ${bucket.samples.length}/${expected[name]??'?'} ${q(bucket.summary.elapsedMs??{})}`);
}
function error(phase,err) { report.errors.push({phase,time:new Date().toISOString(),error:String(err.stack??err)});save(); }
const py = (...args) => JSON.parse(execFileSync('python', [join(repo,'scripts/perf/stage3-snapshot.py'),'--profile-name',profile,...args], {encoding:'utf8',windowsHide:true}));
const rows=()=>py();
const snapshot=test=>py('--pid',String(test.pid),'--profile-name',profile);
const call=(cmd,args={})=>socketCall(profile,cmd,args);
const list=()=>call('pane.list_all');
const tabsOf=state=>state.panes.flatMap(p=>p.tabs.map(t=>({...t,paneId:p.id,workspaceId:p.workspaceId})));

async function launch(load='L24',keep=false,cold=false,observeNaturalInput=false) {
  if(existsSync(join(out,'ISOLATION_BLOCKED.json'))||existsSync(join(process.env.USERPROFILE,'_work/mycmux-perf3-260924/base/ISOLATION_BLOCKED.json')))throw new Error('Isolated launch blocked: window-state plugin writes production app-data; see ISOLATION_BLOCKED.json');
  if(rows().some(row=>matchesProfile(row))) throw new Error(profile + ' is already running');
  const productionBefore=fileState(liveWindowPath);
  writeFileSync(join(out,`isolation-launch-${Date.now()}.json`),q({productionBefore,profile,exe,binarySha256:exeHash}));
  const port=await freePort();
  const env={...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-allow-origins=*`};
  for(const key of Object.keys(env)) if(/^(CLAUDE|MYCMUX_)/i.test(key)) delete env[key];
  const args=['-NoProfile','-File',join(repo,'scripts/perf/launch-stage3.ps1'),'-ExePath',exe,'-Load',load==='L0'?'L0':'L24','-FixtureDirectory',out,'-Name',profile];
  if(keep) args.push('-Keep');
  if(cold) args.push('-Cold');
  const started=Date.now();
  const launchLog=await new Promise((res,rej)=>{
    const child=spawn('powershell.exe',args,{env,cwd:repo,windowsHide:true});let text='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>text+=x);child.stderr.on('data',x=>text+=x);
    child.once('error',rej);child.once('exit',code=>code===0?res(text):rej(new Error(text)));
  });
  // Process enumeration reads command lines for every Windows process and
  // blocks this event loop. Sample immediately after the launcher returns and
  // before that inventory. A failed launch leaves no orphan observation loop.
  const earlyResult=observeNaturalInput?await observeFirstInput(port).catch(error=>({error:String(error)})):null;
  const processRow=await waitUntil(()=>rows().find(row=>matchesProfile(row)&&resolve(row.exe).toLowerCase()===exe.toLowerCase()),30000,'perf3 process');
  const test={profile,pid:processRow.pid,createdAt:processRow.create_time*1000,port,load,started,launchLog,productionBefore};
  active=test;
  if(q(fileState(liveWindowPath))!==q(productionBefore))isolationStop({phase:'launch',pid:test.pid,before:productionBefore,after:fileState(liveWindowPath)});
  const target=await waitUntil(async()=>(await targets(port)).find(t=>t.url.includes('tauri')),60000,'isolated main CDP');
  test.cdp=await CDP.connect(target);test.cdp.profile=profile;test.targetId=target.id;
  if(earlyResult?.error) {
    const stem=join(out,`natural-input-failure-${test.pid}-${Date.now()}`);
    const dom=await test.cdp.eval(`({width:innerWidth,height:innerHeight,text:document.body.innerText,
      active:document.activeElement?.outerHTML,terminals:[...document.querySelectorAll('[data-session-id]')].map(n=>({
        id:n.dataset.sessionId,width:n.getBoundingClientRect().width,visibility:getComputedStyle(n).visibility}))})`).catch(()=>null);
    const transcripts=await Promise.all((dom?.terminals??[]).map(async t=>({id:t.id,...await scrollback(test,t.id).catch(()=>({unavailable:true}))})));
    writeFileSync(stem+'.json',q({pid:test.pid,load,cold,error:earlyResult.error,dom,transcripts,
      marks:await marks(test.cdp).catch(()=>[])}));
    const screen=await test.cdp.call('Page.captureScreenshot',{format:'png'}).catch(()=>null);
    if(screen)writeFileSync(stem+'.png',Buffer.from(screen.data,'base64'));
    throw new Error(earlyResult.error);
  }
  if(earlyResult)test.naturalInput=earlyResult;
  try {
    if(!observeNaturalInput&&await test.cdp.eval('innerWidth<600||innerHeight<400'))await viewport(test);
    await waitUntil(()=>test.cdp.eval('Boolean(window.__MYCMUX_PERF__ && document.querySelector("[data-dnd-pane-id]"))'),60000,'workspace');
  } catch(error) {
    const stem=join(out,`launch-failure-${test.pid}-${Date.now()}`);
    writeFileSync(stem+'.json',q({pid:test.pid,error:String(error),
      dom:await test.cdp.eval('({width:innerWidth,height:innerHeight,text:document.body.innerText})').catch(()=>null),
      marks:await marks(test.cdp).catch(()=>[])}));
    const screen=await test.cdp.call('Page.captureScreenshot',{format:'png'}).catch(()=>null);
    if(screen)writeFileSync(stem+'.png',Buffer.from(screen.data,'base64'));
    throw error;
  }
  const actual=await test.cdp.invoke('get_test_profile');
  if(actual!==profile) throw new Error('CDP profile identity mismatch');
  const viewportMetrics=await test.cdp.eval('({width:innerWidth,height:innerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height})');
  report.runs.push({pid:test.pid,createdAt:test.createdAt,load,keep,cold,port,launchLog,viewport:viewportMetrics,binarySha256:exeHash,driverSha256:driverHash});save();
  return test;
}
async function observeFirstInput(port) {
  let cdp;
  const attached = await waitForPaint(async()=>{
    const target=(await targets(port).catch(()=>[])).find(t=>t.url.includes('tauri'));
    if(!target)return null;
    cdp=await CDP.connect(target);return Date.now();
  }).catch(async()=>{
    const target=await waitUntil(async()=>(await targets(port).catch(()=>[])).find(t=>t.url.includes('tauri')),60000,'early isolated CDP');
    cdp=await CDP.connect(target);return Date.now();
  });
  try {
    await waitUntil(()=>cdp.eval('Boolean(window.__TAURI_INTERNALS__)').catch(()=>false),30000,'early Tauri bridge');
    if(await cdp.invoke('get_test_profile')!==profile)throw new Error('Early CDP profile mismatch');
    const ready=await waitUntil(()=>cdp.eval(`(()=>{
      const marks=window.__MYCMUX_PERF__?.read()??[];
      if(!marks.some(m=>m.name==='window.visible'&&m.id==='main'))return null;
      const area=[...document.querySelectorAll('.xterm-helper-textarea')].find(n=>{
        const box=n.closest('.xterm');return box&&box.getBoundingClientRect().width>20&&getComputedStyle(box).visibility!=='hidden';
      });
      const id=area?.closest('[data-session-id]')?.dataset.sessionId;
      if(!id||!marks.some(m=>m.name==='terminal.first.paint'&&m.id===id))return null;
      area.focus();return {sessionId:id,observedAt:performance.timeOrigin+performance.now()};
    })()`),30000,'natural visible terminal');
    // Escape is the normal launcher-to-shell shortcut; do not tour any session.
    await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitUntil(async()=>/MINGW64|PS [^\n]+>/.test((await scrollback({cdp},ready.sessionId)).text),30000,'natural shell prompt');
    // Another visible terminal can finish initialization and claim focus while
    // this shell starts. Keep the original target; do not visit another pane.
    const inputFocus=await cdp.eval(`(()=>{
      const area=document.querySelector('[data-session-id="'+${q(ready.sessionId)}+'"] .xterm-helper-textarea');
      const box=area?.closest('.xterm'),rect=box?.getBoundingClientRect();
      if(!area||!box||rect.width<=20||rect.height<=20||getComputedStyle(box).visibility==='hidden')return null;
      const previousSessionId=document.activeElement?.closest('[data-session-id]')?.dataset.sessionId??null;
      const refocused=document.activeElement!==area;if(refocused)area.focus();
      return {previousSessionId,refocused,matched:document.activeElement===area,atMs:performance.timeOrigin+performance.now()};
    })()`);
    if(!inputFocus?.matched)throw new Error('Natural input target is not visible and focused');
    const sample=await key({cdp},ready.sessionId,'x');
    return {...sample,attachedAt:attached,readyObservedAt:ready.observedAt,inputFocus,
      method:'Early CDP attach; first visible painted terminal; Escape to shell, confirm the same visible target still owns focus, then x; no pane/workspace visits. Observed input time is an upper bound including CDP dispatch.'};
  } finally {cdp?.close();}
}
async function close(test,{graceful=true}={}) {
  if(!test || test.closed) return;
  const before=fileState(liveWindowPath),profileBefore=fileState(profileWindowPath);
  let native=null,failure=null;
  try {
    const row=rows().find(r=>r.pid===test.pid);
    if(!row || !matchesProfile(row) || resolve(row.exe).toLowerCase()!==exe.toLowerCase())throw new Error('Missing isolated PID identity before close');
    if(graceful) {
      native=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',join(repo,'scripts/perf/close-stage3.ps1'),'-TargetPid',String(test.pid),'-ExePath',exe,'-Name',profile],{windowsHide:true,encoding:'utf8',timeout:50000}));
    } else {
      execFileSync('powershell.exe',['-NoProfile','-Command',`Stop-Process -Id ${test.pid}`],{windowsHide:true});
      native={exitedGracefully:false,method:'Emergency isolated PID termination'};
    }
    await waitUntil(()=>!rows().some(r=>r.pid===test.pid),15000,'test process exit');
  } catch(err) {
    failure={message:String(err),status:err.status??null,stdout:String(err.stdout??""),stderr:String(err.stderr??"")};
    const row=rows().find(r=>r.pid===test.pid);
    if(row&&matchesProfile(row)&&resolve(row.exe).toLowerCase()===exe.toLowerCase())
      execFileSync('powershell.exe',['-NoProfile','-Command',`Stop-Process -Id ${test.pid}`],{windowsHide:true});
  } finally {
    test.cdp?.close();test.closed=true;if(active===test)active=null;
  }
  const after=fileState(liveWindowPath),profileAfter=fileState(profileWindowPath);
  const evidence={pid:test.pid,at:new Date().toISOString(),binarySha256:exeHash,beforeLaunch:test.productionBefore,before,after,profileBefore,profileAfter,native,failure,
    liveUnchanged:q(before)===q(after)&&q(test.productionBefore)===q(after),
    profileStateWritten:profileAfter.exists&&profileAfter.mtimeNs!==profileBefore.mtimeNs};
  evidence.pass=evidence.liveUnchanged&&(!graceful||(native?.exitedGracefully&&evidence.profileStateWritten))&&!failure;
  writeFileSync(join(out,`isolation-close-${test.pid}-${Date.now()}.json`),q(evidence));
  (report.closes??=[]).push(evidence);save();
  if(!evidence.pass)isolationStop(evidence);
  await sleep(1000);
}
async function viewport(test) {
  const view=await test.cdp.eval('({width:innerWidth,height:innerHeight})');
  if(view.width<600||view.height<400) {
    if(!Number.isInteger(test.pid)||await test.cdp.invoke('get_test_profile')!==profile)
      throw new Error('Refusing window setup without isolated identity');
    const native='using System; using System.Runtime.InteropServices; public static class PerfRestore { [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n); }';
    const script=`Add-Type -TypeDefinition '${native}'; $handle=(Get-Process -Id ${test.pid} -ErrorAction Stop).MainWindowHandle; $minimized=[PerfRestore]::IsIconic($handle); if($minimized){[PerfRestore]::ShowWindowAsync($handle,4)|Out-Null}; @{wasMinimized=$minimized} | ConvertTo-Json -Compress`;
    const recovery=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}));
    (report.setupWindowRecoveries??=[]).push({pid:test.pid,at:new Date().toISOString(),view,...recovery,
      method:'Setup only; SW_SHOWNOACTIVATE (4), no foreground activation'});save();
    await sleep(250);
  }
  const b=nativeWindowBounds(test.pid);
  if(b&&(b.width<1440||b.height<900)) nativeWindowBounds(test.pid,1440,900);
  await waitUntil(()=>test.cdp.eval('innerWidth>=600&&innerHeight>=400'),10000,'usable setup viewport');
}
async function installProbe(test) {
  const source=readFileSync(join(repo,'scripts/perf/stage3-probe.js'),'utf8');
  await test.cdp.call('Page.enable');
  await test.cdp.call('Page.addScriptToEvaluateOnNewDocument',{source});
  await test.cdp.call('Page.reload',{ignoreCache:false});
  await waitUntil(()=>test.cdp.eval('Boolean(window.__stage3Probe && window.__MYCMUX_PERF__ && document.querySelector(".xterm"))'),60000,'instrumented page');
  await viewport(test);
}
async function isClickable(cdp,selector) {
  return cdp.eval(`(()=>{
    const node=document.querySelector(${q(selector)});if(!node)return false;
    const r=node.getBoundingClientRect();const style=getComputedStyle(node);
    if(r.width<=0||r.height<=0||style.visibility==='hidden'||style.display==='none')return false;
    const x=r.x+r.width/2,y=r.y+r.height/2;
    if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;
    const hit=document.elementFromPoint(x,y);return hit===node||node.contains(hit);
  })()`);
}
async function waitClickable(cdp,selector) {
  await waitUntil(()=>isClickable(cdp,selector),10000,'positioned click target '+selector);
}
async function ensureShell(cdp) {
  const visible=await cdp.eval(`(()=>{
    const screen=[...document.querySelectorAll('[data-session-id] .xterm-screen')].find(n=>{
      const r=n.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(n).visibility!=='hidden';
    });return screen?.closest('[data-session-id]')?.dataset.sessionId??null;
  })()`);
  return visible??baselineEnsureShell(cdp);
}
async function activate(test,tab) {
  const state=await list();
  const pane=state.panes.find(p=>p.tabs.some(t=>t.id===tab.id));
  if(!pane)throw new Error('Missing pane for setup activation '+tab.id);
  const workspaceId=pane.workspaceId;
  try {
    if(await test.cdp.eval('innerWidth<600||innerHeight<400'))await viewport(test);
    if(state.activeWorkspaceId!==workspaceId) {
      const selector=`[data-dnd-workspace-target-id="${workspaceId}"]`;
      await waitClickable(test.cdp,selector);await click(test.cdp,selector);
    }
    await waitUntil(async()=>(await list()).activeWorkspaceId===workspaceId,15000,'workspace setup selection');
    await waitUntil(()=>test.cdp.eval(`(()=>{const n=document.querySelector('[data-dnd-pane-id="${pane.id}"]');return n&&n.getBoundingClientRect().width>20&&getComputedStyle(n).visibility!=='hidden'})()`),15000,'visible workspace pane mount');
    const pill=`[data-dnd-pane-id="${pane.id}"] .pane-tab-pill[data-tab-id="${tab.id}"]`;
    if(await isClickable(test.cdp,pill)) await click(test.cdp,pill);
    else {
      await click(test.cdp,`[data-dnd-pane-id="${pane.id}"] .pane-tabbar button[aria-expanded]`);
      await waitClickable(test.cdp,`.pane-tab-menu-row[aria-label*="${tab.label}"]`);
      // Setup visits need the menu's activation handler, not pointer timing.
      // An overflowed pill can exist in the DOM under the menu button.
      await test.cdp.eval(`document.querySelector(${q('.pane-tab-menu-row[aria-label*="'+tab.label+'"]')}).click()`);
    }
    await waitUntil(async()=>(await list()).panes.find(p=>p.id===pane.id)?.activeTabId===tab.id,15000,'active setup session '+tab.label);
    await waitUntil(()=>test.cdp.eval(`(()=>{const n=document.querySelector('[data-session-id="${tab.sessionId}"] .xterm-screen');return n&&n.getBoundingClientRect().width>20&&getComputedStyle(n).visibility!=='hidden';})()`),20000,'visible tab activation '+tab.label);
  } catch(err) {
    const stem=join(out,`activation-failure-${test.pid}-${Date.now()}`);
    writeFileSync(stem+'.json',q({tab,state:await list(),marks:await marks(test.cdp),
      dom:await test.cdp.eval('({width:innerWidth,height:innerHeight,text:document.body.innerText,active:document.activeElement?.outerHTML})')}));
    const screenshot=await test.cdp.call('Page.captureScreenshot',{format:'png'}).catch(()=>null);
    if(screenshot)writeFileSync(stem+'.png',Buffer.from(screenshot.data,'base64'));
    throw err;
  }
}
async function scrollback(test,sessionId) {
  return test.cdp.eval(`(async()=>{const b=await window.__TAURI_INTERNALS__.invoke('get_session_scrollback',{sessionId:${q(sessionId)}});
    const view=new DataView(b);return {endOffset:Number(view.getBigUint64(16,true)),text:new TextDecoder().decode(new Uint8Array(b).subarray(24))};})()`);
}
async function plainShell(test,tab) {
  await waitUntil(async()=>{const s=await scrollback(test,tab.sessionId);return /Esc\/q: shell|MINGW64|PS [^\n]+>/.test(s.text);},30000,'PTY initial output');
  await test.cdp.invoke('write_to_session',{sessionId:tab.sessionId,data:'\u0003'});
  await sleep(100);
  for(let attempt=0;attempt<3;attempt++) {
    await sleep(500);
    const marker='P3_'+randomUUID().slice(0,8);
    await test.cdp.invoke('write_to_session',{sessionId:tab.sessionId,data:`\u0015printf 'P3_''${marker.slice(3)}\\n'\r`});
    try{await waitUntil(async()=> (await scrollback(test,tab.sessionId)).text.includes(marker),5000,'plain shell command response');return;}
    catch(e){writeFileSync(join(out,`shell-failure-${test.pid}-${attempt}.json`),q({marker,sessionId:tab.sessionId,scroll:await scrollback(test,tab.sessionId)}));if(attempt===2)throw e;}
  }
}
async function ensureAll(test,{verifyShells=true}={}) {
  const state=await list();
  const tabs=tabsOf(state).filter(t=>t.type==='terminal');
  const before=await test.cdp.invoke('get_session_output_snapshot');
  test.naturalPtyCount=Object.keys(before).length;
  for(const tab of tabs) {
    await activate(test,tab);
    if(verifyShells&&!test.shellReady?.has(tab.sessionId)){await plainShell(test,tab);(test.shellReady??=new Set()).add(tab.sessionId);}
  }
  await activate(test,tabs[0]);
  await ensureShell(test.cdp);
  return tabs;
}
async function fakeLoad(test,{linked=false}={}) {
  const all=test.shellReady?.size>=24?tabsOf(await list()).filter(t=>t.type==='terminal'):await ensureAll(test);
  // Leave the first terminal available for latency probes.
  test.fake=[];
  for(const tab of all.slice(1,7)) {
    const id=randomUUID();
    const script=join(repo,'scripts/perf/fake-agent.ps1').replaceAll('\\','/');
    const command=linked?`'${process.execPath.replaceAll('\\','/')}' '${join(repo,'scripts/perf/fake-claude-agent.mjs').replaceAll('\\','/')}' --session-id ${id} --profile-name ${profile}`
      :`powershell.exe -NoProfile -File '${script}' -SessionId ${id} -Name ${profile}`;
    await test.cdp.invoke('write_to_session',{sessionId:tab.sessionId,data:`\u0015${command}\r`});
    test.fake.push({...tab,transcriptId:id});
  }
  writeFileSync(join(out,`fake-${test.pid}.json`),q(test.fake));
  for(const fake of test.fake){
    const path=join(process.env.USERPROFILE,'.claude/projects/C--Users-miyaz--work-mycmux-perf3-260924-fixtures',fake.transcriptId+'.jsonl');
    try{await waitUntil(()=>existsSync(path)&&readFileSync(path,'utf8').trim().split('\n').length>=3,20000,'three synthetic transcript lines');}
    catch(e){writeFileSync(join(out,`fake-failure-${test.pid}-${fake.id}.json`),q(await scrollback(test,fake.sessionId)));throw e;}
    await waitUntil(async()=>(await scrollback(test,fake.sessionId)).text.includes('Synthetic perf3 line 2'),10000,'synthetic PTY output');
  }
}
async function emitPath(test,path) {
  const sessionId=await ensureShell(test.cdp);test.shellSessionId=sessionId;
  await test.cdp.invoke('write_to_session',{sessionId,data:`\u0015echo '${path}'\r`});
  const first=!test.pathEmits;test.pathEmits=(test.pathEmits??0)+1;
  await sleep(first?9000:800);
  return sessionId;
}
async function openPreview(test,kind='small') {
  const path=join(out,`${kind}.${kind==='markdown'?'md':'html'}`);
  if(!existsSync(path)) writeFileSync(path,kind==='markdown'?'# Synthetic preview\n\n'+('Example text.\n\n'.repeat(4000)):fixtureHtml(kind));
  await emitPath(test,path);
  const start=await activateTerminalLink(test,Date.now(),path.split(/[\\/]/).at(-1));
  if(kind==='markdown')return {path,start,queued:null,loaded:null};
  const queued=await markAfter(test.cdp,'webpane.create.queued',start.atMs);
  const loaded=await markAfter(test.cdp,'webpane.load.finished',start.atMs,queued.id,60000);
  return {path,start,queued,loaded};
}
async function configure(test,load,{probe=true,linkedAgents=false}={}) {
  if(probe)await installProbe(test);else await viewport(test);
  await ensureAll(test);
  if(load.includes('S')) await fakeLoad(test,{linked:linkedAgents});
  if(load.includes('+H')) {
    await openPreview(test);
    const state=await call('workspace.list');
    await call('pane.spawn',{workspaceId:state.activeWorkspaceId,target:'web',preset:'browser',split:true,activate:false,operator:true});
  }
  await sleep(15000);
}
async function traceStart(test) {
  await test.cdp.call('Tracing.start',{categories:'disabled-by-default-devtools.timeline,devtools.timeline,blink,blink.user_timing,cc,v8',transferMode:'ReturnAsStream'});
  test.anchor=await test.cdp.eval(`(()=>{const t=performance.now();performance.mark('perf3.anchor',{startTime:t});return performance.timeOrigin+t})()`);
}
function traceSummary(file,anchor) {
  const events=JSON.parse(gunzipSync(readFileSync(file))).traceEvents;
  const origin=events.find(e=>e.name==='perf3.anchor');
  const pid=origin?.pid;
  const rendererMainTid=events.find(e=>e.pid===pid&&e.name==='thread_name'&&e.args?.name==='CrRendererMain')?.tid??origin?.tid;
  const totals={};
  for(const e of events) if(e.pid===pid&&e.ph==='X'&&Number.isFinite(e.dur)) totals[e.name]=(totals[e.name]??0)+e.dur/1000;
  return {rendererPid:pid,rendererMainTid,totals,events,epochOffset:origin?anchor-origin.ts/1000:null};
}
function profileSummary(profile) {
  const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame]));const sums=new Map();
  for(let i=0;i<(profile.samples?.length??0);i++) sums.set(profile.samples[i],(sums.get(profile.samples[i])??0)+(profile.timeDeltas?.[i]??0)/1000);
  return [...sums].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([id,selfMs])=>({selfMs,...nodes.get(id)}));
}
function delta(before,after,pid) {
  const duration=(after.time_ms-before.time_ms)/1000;
  const diffType=type=>after.webviews.filter(p=>p.type===type).reduce((sum,p)=>sum+p.cpu_ms-(before.webviews.find(b=>b.pid===p.pid)?.cpu_ms??p.cpu_ms),0);
  return {durationSeconds:duration,appCpuMs:after.app.cpu_ms-before.app.cpu_ms,
    rendererCpuMs:(after.webviews.find(p=>p.pid===pid)?.cpu_ms??0)-(before.webviews.find(p=>p.pid===pid)?.cpu_ms??0),
    gpuCpuMs:diffType('gpu-process'),webviewWs:after.webviews.reduce((sum,p)=>sum+p.ws,0),
    ws:after.app.ws,private:after.app.private,handles:after.app.handles,threads:after.app.threads};
}
async function s1() {
  for(const load of ['L0','L24']) for(const temp of ['cold','warm']) {
    const name=`S1_${load}_${temp}`;
    if(!selected(name))continue;
    const resumedAt=count(name);
    for(let i=resumedAt;i<expected[name];i++) {
      // Warm repeats preserve only the preceding verified shell-only S1 state.
      // A resumed batch starts with a freshly normalized layout for isolation.
      const keep=temp==='warm'&&i>resumedAt;
      const test=await launch(load,keep,temp==='cold',naturalInput);
      try {
        const expectedCount=load==='L0'?1:24;
        const initial=await marks(test.cdp);
        const visible=initial.find(m=>m.name==='window.visible'&&m.id==='main')??await markAfter(test.cdp,'window.visible',test.createdAt,'main');
        const frame=initial.find(m=>m.name==='workspace.first.frame'&&m.id==='main')??await markAfter(test.cdp,'workspace.first.frame',test.createdAt,'main');
        const id=await ensureShell(test.cdp);
        await plainShell(test,{sessionId:id});
        await click(test.cdp,`[data-session-id="${id}"] .xterm-screen`);
        const sample=await key(test,id,'x');
        const naturalPtyCount=Object.keys(await test.cdp.invoke('get_session_output_snapshot')).length;
        if(load==='L24')await ensureAll(test,{verifyShells:false});
        await waitUntil(async()=>Object.keys(await test.cdp.invoke('get_session_output_snapshot')).length>=expectedCount,30000,'all visited PTYs');
        const entries=await marks(test.cdp);
        const restored=entries.filter(m=>m.name==='pty.spawn.done');
        const byId=[...new Map(restored.map(m=>[m.id,m])).values()];
        await click(test.cdp,`[data-session-id="${id}"] .xterm-screen`);
        const allReadyInput=await key(test,id,'y');
        const steadyStart=Date.now();
        const steady=[];
        for(let j=0;j<7;j++){steady.push(snapshot(test));if(j<6)await sleep(10000);}
        const completeEntries=[...new Map([...initial,...entries,...await marks(test.cdp)].map(m=>[q(m),m])).values()].sort((a,b)=>a.atMs-b.atMs);
        writeFileSync(join(out,`${name}-${i+1}-startup.json`),q({entries:completeEntries,steady,launchLog:test.launchLog,binarySha256:exeHash}));
        add(name,{run:i+1,restoredPreviousTestState:keep,coldDefinition:'fresh WebView2 user-data folder; OS file cache not flushed',processToVisibleMs:visible.atMs-test.createdAt,
          processToFrameMs:frame.atMs-test.createdAt,processToAllPtysMs:Math.max(...byId.map(m=>m.atMs))-test.createdAt,
          ...(test.naturalInput?{processToNaturalInputMs:test.naturalInput.paintedAt-test.createdAt,naturalInput:test.naturalInput}:{}),
          processToInputMs:sample.paintedAt-test.createdAt,processToAllPtysAndInputMs:allReadyInput.paintedAt-test.createdAt,ptyCount:byId.length,naturalPtyCount,
          fullRestoreRequiredFirstVisits:naturalPtyCount<expectedCount,restorationMethod:'Visit each session to trigger lazy PTY creation; overflow-menu setup uses CDP DOM click; verify text input only in the active pane',steadyObservationEndMs:Date.now()-test.createdAt,
          steadyObservationStartMs:steadyStart-test.createdAt});
      }finally{await close(test);}
    }
  }
}
async function s2() {
  for(const load of ['L0','L24','L24S','L24S+H']) {
    const name=`S2_${load}`;if(count(name)>=5)continue;
    const test=await launch(load);
    try {
      await configure(test,load);
      for(let i=count(name);i<5;i++) {
        await test.cdp.eval('window.__stage3Probe.monitorFrames(false); window.__stage3Probe.reset()');
        const before=snapshot(test);
        await traceStart(test);
        await test.cdp.call('Profiler.enable');await test.cdp.call('Profiler.setSamplingInterval',{interval:1000});
        await test.cdp.call('Profiler.start');
        const started=Date.now();await sleep(60000);
        const {profile:cpuProfile}=await test.cdp.call('Profiler.stop');
        const after=snapshot(test);
        const stem=`${name.replace('+','_')}-${i+1}`;
        const trace=join(out,`${stem}-trace.json.gz`);await traceStop(test.cdp,trace);
        const traced=traceSummary(trace,test.anchor);
        const timers=await test.cdp.eval('window.__stage3Probe.read()');
        const heap=(await test.cdp.call('Runtime.getHeapUsage')).usedSize;
        const timeline=await marks(test.cdp);
        writeFileSync(join(out,`${stem}-profile.json`),q(cpuProfile));
        writeFileSync(join(out,`${stem}-details.json`),q({before,after,timers,timeline,top20:profileSummary(cpuProfile),traceTotals:traced.totals}));
        add(name,{run:i+1,...delta(before,after,traced.rendererPid),heap,rendererPid:traced.rendererPid,
          rafCallbacksPerSecond:timers.rafFires/((Date.now()-started)/1000),frameMaxGapMs:Math.max(0,...timers.gaps.map(g=>g.ms)),
          styleMs:traced.totals.UpdateLayoutTree??0,layoutMs:traced.totals.Layout??0,paintMs:traced.totals.Paint??0,
          compositeMs:traced.totals.CompositeLayers??0,traceFile:trace,detailsFile:join(out,`${stem}-details.json`)});
      }
    }finally{await close(test);}
  }
}
async function livebriefProbe() {
  if(count('Ha_incremental'))return;
  const test=await launch('L24');
  try {
    await configure(test,'L24S',{linkedAgents:true});
    const ids=new Set(test.fake.map(f=>f.transcriptId));
    let initial=[],matched=[];
    await waitUntil(async()=>{
      initial=await test.cdp.invoke('get_live_briefs');
      matched=initial.filter(b=>ids.has(b.agentSessionId)); // LiveBinding is serde(flatten).
      return matched.length===6&&matched.every(b=>b.telemetryHealth==='live');
    },45000,'six live synthetic transcript bindings');
    writeFileSync(join(out,'Ha-initial-briefs.json'),q({initial,matched,fake:test.fake}));
    const target=test.fake[0];
    const path=join(process.env.USERPROFILE,'.claude/projects/C--Users-miyaz--work-mycmux-perf3-260924-fixtures',target.transcriptId+'.jsonl');
    const example=JSON.parse(readFileSync(path,'utf8').trim().split('\n').at(-1));
    const rows=[];
    for(let i=0;i<1280;i++){const row=structuredClone(example);row.uuid=randomUUID();row.message.content=[{type:'text',text:'Synthetic bulk '+'.'.repeat(8192)}];rows.push(q(row));}
    appendFileSync(path,rows.join('\n')+'\n');
    const sizesBefore=readFileSync(path).length;
    await test.cdp.invoke('subscribe_live_briefs');
    const started=Date.now();const nativeBefore=snapshot(test);const collected=[];
    for(let i=0;i<12;i++){await sleep(5000);collected.push(...await marks(test.cdp));}
    const nativeAfter=snapshot(test);
    const unique=[...new Map(collected.map(m=>[q(m),m])).values()].filter(m=>m.atMs>=started);
    await test.cdp.invoke('unsubscribe_live_briefs');
    writeFileSync(join(out,'Ha-incremental-marks.json'),q({nativeBefore,nativeAfter,marks:unique,initialBytes:sizesBefore,finalBytes:readFileSync(path).length,targetId:target.sessionId}));
    add('Ha_incremental',{elapsedMs:Date.now()-started,matched:matched.length,available:true,initialBytes:sizesBefore,
      finalBytes:readFileSync(path).length,appCpuMs:nativeAfter.app.cpu_ms-nativeBefore.app.cpu_ms,
      bootstrapReads:unique.filter(m=>m.name==='livebrief.bootstrap.bytes').length,
      bootstrapBytes:unique.filter(m=>m.name==='livebrief.bootstrap.bytes').reduce((n,m)=>n+(m.value??0),0),
      tailReads:unique.filter(m=>m.name==='livebrief.tail.bytes').length,
      tailBytes:unique.filter(m=>m.name==='livebrief.tail.bytes').reduce((n,m)=>n+(m.value??0),0),
      method:'Extra controlled probe with a synthetic node process recognized by monitor argv and explicit session ID: subscribe to six transcripts; append roughly 10 MiB once to one and continue two-second output'});
  }finally{await close(test);}
}
async function controls() {
  // Quantify profiler/tracing observer cost instead of treating it as app work.
  for(const load of ['L0','L24','L24S','L24S+H']) {
    const name=`S2_control_${load}`;if(count(name))continue;
    const test=await launch(load);
    try {
      await configure(test,load,{probe:false});
      await traceStart(test);await sleep(150);
      const trace=join(out,`control-${load.replace('+','_')}-identity.json.gz`);
      await traceStop(test.cdp,trace);
      const identified=traceSummary(trace,test.anchor);
      await sleep(3000);
      const before=snapshot(test);await sleep(60000);const after=snapshot(test);
      const probe=await test.cdp.eval('({mountedXterms:document.querySelectorAll(".xterm").length,wrappersInstalled:Boolean(window.__stage3Probe)})');
      add(name,{run:1,...delta(before,after,identified.rendererPid),heap:(await test.cdp.call('Runtime.getHeapUsage')).usedSize,
        rendererPid:identified.rendererPid,probe,method:'60 seconds without Profiler, Tracing, timer wrappers, or observer rAF loop; brief renderer identity trace ended before sampling'});
    }finally{await close(test);}
  }
}
async function waitForPaint(action) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const value=await action();if(value)return value;await sleep(5);}
  throw new Error('Input paint timeout');
}
async function key(test,id,char) {
  const cdp=test.cdp;
  const at=await cdp.eval('performance.timeOrigin+performance.now()');
  await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',text:char,key:char,code:`Key${char.toUpperCase()}`,windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0)});
  await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:char,code:`Key${char.toUpperCase()}`,windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0)});
  const pair=await waitForPaint(async()=>{
    const entries=await cdp.eval('window.__MYCMUX_PERF__.read()');
    const begin=entries.find(m=>m.name==='terminal.keydown'&&m.id===id&&m.atMs>=at);
    const end=begin&&entries.find(m=>m.name==='terminal.input.painted'&&m.id===id&&m.atMs>=begin.atMs);
    return end?{elapsedMs:end.atMs-begin.atMs,keydownAt:begin.atMs,paintedAt:end.atMs,sessionId:id}:null;
  });
  return pair;
}
async function burstKeys(test,id,total=50) {
  const cdp=test.cdp;const at=await cdp.eval('performance.timeOrigin+performance.now()');
  const pending=[];
  for(let i=0;i<total;i++){
    const char=String.fromCharCode(97+i%26);
    // WebSocket messages are submitted in down/up order, without waiting for a paint.
    pending.push(cdp.call('Input.dispatchKeyEvent',{type:'keyDown',text:char,key:char,code:`Key${char.toUpperCase()}`,windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0)}));
    pending.push(cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:char,code:`Key${char.toUpperCase()}`,windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0)}));
  }
  await Promise.all(pending);
  return waitForPaint(async()=>{
    const entries=await cdp.eval('window.__MYCMUX_PERF__.read()');
    const begins=entries.filter(m=>m.name==='terminal.keydown'&&m.id===id&&m.atMs>=at);
    if(begins.length!==total)return null;
    const pairs=begins.map(begin=>{
      const end=entries.find(m=>m.name==='terminal.input.painted'&&m.id===id&&m.atMs>=begin.atMs);
      return end?{elapsedMs:end.atMs-begin.atMs,keydownAt:begin.atMs,paintedAt:end.atMs,sessionId:id}:null;
    });
    return pairs.every(Boolean)?pairs:null;
  });
}
async function s3() {
  for(const load of ['L24','L24S']) {
    const name=`S3_${load}`;if(!selected(name)||count(name)>=200)continue;
    const test=await launch(load);
    try {
      await configure(test,load);const id=await ensureShell(test.cdp);
      await click(test.cdp,`[data-session-id="${id}"] .xterm-screen`);
      await traceStart(test);
      for(let i=count(name);i<200;i++) add(name,{run:i+1,...await key(test,id,String.fromCharCode(97+i%26))});
      await test.cdp.invoke('write_to_session',{sessionId:id,data:'\u0003'});
      const trace=join(out,`${name}-trace.json.gz`);await traceStop(test.cdp,trace);
      const parsed=traceSummary(trace,test.anchor);const threshold=report.measurements[name].summary.elapsedMs.p90;
      const slow=report.measurements[name].samples.filter(s=>s.elapsedMs>threshold).map(sample=>{
        const tasks=parsed.events.filter(e=>e.pid===parsed.rendererPid&&e.tid===parsed.rendererMainTid&&e.ph==='X'&&e.dur&&
          e.ts/1000+parsed.epochOffset<sample.paintedAt&&(e.ts+e.dur)/1000+parsed.epochOffset>sample.keydownAt)
          .map(e=>({name:e.name,ms:e.dur/1000,atMs:e.ts/1000+parsed.epochOffset,args:e.args})).sort((a,b)=>b.ms-a.ms);
        return {...sample,tasks};
      });
      writeFileSync(join(out,`${name}-slow-keys.json`),q({threshold,trace,rendererPid:parsed.rendererPid,slow}));
    }finally{await close(test);}
  }
}

async function clickClock(test,selector) {
  await waitClickable(test.cdp,selector);
  await test.cdp.eval(`(()=>{window.__stage3Click=null;document.addEventListener('pointerdown',()=>{
    const at=performance.timeOrigin+performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{
      window.__stage3Click={atMs:at,elapsedMs:performance.timeOrigin+performance.now()-at};
    }));},{once:true,capture:true});})()`);
  await click(test.cdp,selector);
  return waitUntil(()=>test.cdp.eval('window.__stage3Click'),10000,'two frames after pointerdown');
}
async function tabSelector(test,tab) {
  const pill=`[data-dnd-pane-id="${tab.paneId}"] .pane-tab-pill[data-tab-id="${tab.id}"]`;
  if(await isClickable(test.cdp,pill)) return pill;
  await click(test.cdp,`[data-dnd-pane-id="${tab.paneId}"] .pane-tabbar button[aria-expanded]`);
  return `.pane-tab-menu-row[aria-label*="${tab.label}"]`;
}
async function s4() {
  const test=await launch('L24');
  try {
    await configure(test,'L24');
    const state=await list();const tabs=tabsOf(state);const first=tabs.find(t=>t.workspaceId===state.activeWorkspaceId&&tabs.filter(x=>x.paneId===t.paneId).length>=2);
    if(!first)throw new Error('Need two sessions in a foreground pane');
    const siblings=tabs.filter(t=>t.paneId===first.paneId);
    const workspaceIds=(await call('workspace.list')).workspaces.map(w=>w.id);
    for(const kind of ['tab','pane','workspace']) {
      const observationStart=Date.now();
      const name=`S4_${kind}`;
      if(!selected(name))continue;
      await activate(test,first);
      for(let i=count(name);i<20;i++) {
        let selector;
        if(kind==='tab') selector=await tabSelector(test,siblings[(i+1)%2]);
        else if(kind==='workspace') selector=`[data-dnd-workspace-target-id="${workspaceIds[(i+1)%2]}"]`;
        else {
          const paneIds=await test.cdp.eval(`[...document.querySelectorAll('[data-dnd-pane-id]:has(.xterm-screen)')].filter(n=>n.getBoundingClientRect().width>20&&getComputedStyle(n).visibility!=='hidden').map(n=>n.dataset.dndPaneId)`);
          if(paneIds.length<2)throw new Error('S4 needs two visible split panes');
          selector=`[data-dnd-pane-id="${paneIds[(i+1)%2]}"] .xterm-screen`;
        }
        add(name,{run:i+1,...await clickClock(test,selector)});
      }
      const observed=(await marks(test.cdp)).filter(m=>m.atMs>=observationStart);
      const tails=[];for(const tab of siblings.slice(0,2))tails.push({sessionId:tab.sessionId,...await scrollback(test,tab.sessionId)});
      writeFileSync(join(out,`${name}-automatic-input.json`),q({observationStart,marks:observed,tails,
        keydowns:observed.filter(m=>m.name==='terminal.keydown').length,
        acceptedInputs:observed.filter(m=>m.name==='terminal.input.accepted').length}));
    }
    if(selected('S4_workspace_retention')&&!count('S4_workspace_retention')){
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(1000);
      const before={...await counters(test),probe:await test.cdp.eval('window.__stage3Probe.read()')};
      const beforeSnapshot=heapSnapshots?await takeHeapSnapshot(test,'S4-before'):null;
      const started=Date.now(),checkpoints=[];
      for(let i=0;i<retentionRounds;i++){
        for(const id of [workspaceIds[1],workspaceIds[0]])await clickClock(test,`[data-dnd-workspace-target-id="${id}"]`);
        if((i+1)%100===0){
          await test.cdp.call('HeapProfiler.collectGarbage');
          checkpoints.push({roundTrips:i+1,...await counters(test),probe:await test.cdp.eval('window.__stage3Probe.read()')});
          console.log(`Retention ${i+1}/${retentionRounds}`);
        }
      }
      const beforeGc=await counters(test);
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(retentionCooldown);
      await test.cdp.call('HeapProfiler.collectGarbage');
      const after={...await counters(test),probe:await test.cdp.eval('window.__stage3Probe.read()')};
      const afterSnapshot=heapSnapshots?await takeHeapSnapshot(test,'S4-after'):null;
      add('S4_workspace_retention',{elapsedMs:Date.now()-started,roundTrips:retentionRounds,before,beforeGc,after,checkpoints,
        beforeSnapshot,afterSnapshot,cooldownMs:retentionCooldown,
        method:'Same PID, fixed warmed pair; GC every 100 round trips and before/after cooldown; optional complete heap snapshots'});
    }
    if(reactProfile&&!count('S4_react_profile')) {
      const started=Date.now(),groups={};
      const reactProbe=await installReactCommitProbe(test.cdp,async()=>{
        const current=await list(),target=workspaceIds.find(id=>id!==current.activeWorkspaceId);
        if(!target)throw new Error('React diagnostic needs a different workspace');
        await click(test.cdp,`[data-dnd-workspace-target-id="${target}"]`);
        await waitUntil(async()=>(await list()).activeWorkspaceId===target,10000,'React diagnostic workspace change');
      },join(out,`S4-react-instrumented-${Date.now()}.js`));
      for(const kind of ['tab','pane','workspace']) {
        await activate(test,first);groups[kind]=[];
        for(let i=0;i<20;i++) {
          const paneIds=await test.cdp.eval(`[...document.querySelectorAll('[data-dnd-pane-id]:has(.xterm-screen)')].filter(n=>n.getBoundingClientRect().width>20&&getComputedStyle(n).visibility!=='hidden').map(n=>n.dataset.dndPaneId)`);
          const selector=kind==='tab'?await tabSelector(test,siblings[(i+1)%2]):kind==='workspace'?`[data-dnd-workspace-target-id="${workspaceIds[(i+1)%2]}"]`:`[data-dnd-pane-id="${paneIds[(i+1)%2]}"] .xterm-screen`;
          await test.cdp.eval('window.__stage3ReactCommits=[]');
          const timing=await clickClock(test,selector);
          const commits=await test.cdp.eval('window.__stage3ReactCommits');
          groups[kind].push({...timing,commits,commitCount:commits.length,maxCommitMs:Math.max(0,...commits.map(c=>c.durationMs))});
        }
      }
      if(Object.values(groups).some(rows=>rows.every(row=>row.commitCount===0)))throw new Error('React commit diagnostic did not observe each switching group');
      add('S4_react_profile',{elapsedMs:Date.now()-started,groups,reactProbe,
        method:reactProbe.method});
    }
  }finally{await close(test);}
}
async function takeHeapSnapshot(test,label) {
  const file=join(out,label+'.heapsnapshot');
  writeFileSync(file,'');
  const listener=({data})=>{
    const message=JSON.parse(String(data));
    if(message.method==='HeapProfiler.addHeapSnapshotChunk')appendFileSync(file,message.params.chunk);
  };
  test.cdp.ws.addEventListener('message',listener);
  try { await test.cdp.call('HeapProfiler.takeHeapSnapshot',{reportProgress:false,captureNumericValue:true},180000); }
  finally { test.cdp.ws.removeEventListener('message',listener); }
  return file;
}
async function retentionPlateau() {
  if(count('Stability_plateau'))return;
  const test=await launch('L24');
  try {
    await configure(test,'L24');
    const workspaceIds=(await call('workspace.list')).workspaces.map(w=>w.id);
    for(let i=0;i<20;i++)await clickClock(test,`[data-dnd-workspace-target-id="${workspaceIds[(i+1)%2]}"]`);
    const checkpoints=[];
    const capture=async label=>{
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(1000);
      checkpoints.push({label,...await counters(test),probe:await test.cdp.eval('window.__stage3Probe.read()')});
    };
    await capture('before');const started=Date.now();
    let sampling=false,samplingError=null;
    try{await test.cdp.call('HeapProfiler.startSampling',{samplingInterval:32768});sampling=true;}
    catch(err){samplingError=String(err);}
    for(let batch=1;batch<=3;batch++){
      for(let i=0;i<100;i++)for(const id of [workspaceIds[1],workspaceIds[0]])await clickClock(test,`[data-dnd-workspace-target-id="${id}"]`);
      await capture(`after-${batch*100}-roundtrips`);
    }
    let allocationFile=null;
    if(sampling){
      const allocation=await test.cdp.call('HeapProfiler.stopSampling');
      allocationFile=join(out,'Stability-plateau-allocation.json');
      writeFileSync(allocationFile,q(allocation));
    }
    await sleep(30000);await capture('after-30s-cooldown');
    await sleep(30000);await capture('after-60s-cooldown');
    add('Stability_plateau',{elapsedMs:Date.now()-started,roundTrips:300,checkpoints,allocationFile,samplingError,
      method:'Supplemental retention probe: warm 20 switches, three consecutive 100-roundtrip batches in one PID; GC at every checkpoint, then 30/60-second cooldown; allocation sampling only in this probe'});
  }finally{await close(test);}
}
const psCommand=text=>`\u0015powershell.exe -NoProfile -EncodedCommand ${Buffer.from(text,'utf16le').toString('base64')}\r`;
async function s5() {
  const detail = throughputDetail || flowTrace;
  if(detail)await measureProducer(out);
  const textPath=join(out,'throughput-10MiB.txt');
  if(!existsSync(textPath))writeFileSync(textPath,('0123456789abcdef'.repeat(63)+'\n').repeat(Math.ceil(10*1024*1024/1009)).slice(0,10*1024*1024));
  for(const kind of ['seq','cat']) {
    const name=`S5_${flowTrace?'trace_':''}${kind}`;
    const required=flowTrace?3:10;
    if(!selected(name)||count(name)>=required)continue;
    const test=await launch('L24');
    try {
      await configure(test,'L24');
      const state=await list();const all=tabsOf(state);
      const foreground=state.panes.filter(p=>p.workspaceId===state.activeWorkspaceId);
      if(foreground.length<2)throw new Error('Throughput requires two visible split panes');
      const outputTab=all.find(t=>t.id===foreground[0].activeTabId)??all.find(t=>t.paneId===foreground[0].id);
      const inputTab=all.find(t=>t.id===foreground[1].activeTabId)??all.find(t=>t.paneId===foreground[1].id);
      for(let i=count(name);i<required;i++) {
        await activate(test,outputTab);await activate(test,inputTab);
        await click(test.cdp,`[data-session-id="${inputTab.sessionId}"] .xterm-screen`);
        await test.cdp.eval('window.__stage3Probe.monitorFrames(true); window.__stage3Probe.reset()');
        const flowClockBefore=flowTrace?await clockOffset(test.cdp):null;
        if(flowTrace)await startFlowTrace(test.cdp,outputTab.sessionId);
        const commandStart=join(out,`${name}-${i+1}-${Date.now()}-start.txt`).replaceAll('\\','/');
        const program=kind==='seq'?"'C:/Program Files/Git/usr/bin/seq.exe' 1 200000":`'C:/Program Files/Git/usr/bin/cat.exe' '${textPath.replaceAll('\\','/')}'`;
        const commandEnd=commandStart.replace('-start.txt','-end.txt');
        const script=`\u0015'C:/Program Files/Git/usr/bin/date.exe' +%s%3N > '${commandStart}'; ${program}${detail?`; 'C:/Program Files/Git/usr/bin/date.exe' +%s%3N > '${commandEnd}'`:''}\r`;
        const before=await scrollback(test,outputTab.sessionId);
        await test.cdp.invoke('write_to_session',{sessionId:outputTab.sessionId,data:script});
        // Redirection creates an empty file before date.exe writes its value.
        // Do not dispatch the first key until both the timestamp and PTY output exist.
        const begin=await waitUntil(()=>{
          const value=existsSync(commandStart)?Number(readFileSync(commandStart,'utf8')):0;
          return Number.isFinite(value)&&value>=test.createdAt?value:null;
        },20000,'completed throughput start timestamp');
        await waitUntil(async()=>{
          const at=(await test.cdp.invoke('get_session_output_snapshot'))[outputTab.sessionId];
          return Number.isFinite(at)&&at>=begin;
        },20000,'first throughput output');
        const firstOutputObserved=Date.now();
        const keystrokes=[];
        const typing=(async()=>{
          if(kind==='cat')keystrokes.push(...await burstKeys(test,inputTab.sessionId));
          else for(let k=0;k<50;k++)keystrokes.push(await key(test,inputTab.sessionId,String.fromCharCode(97+k%26)));
        })();
        // Keep rejection handled while the output monitor is active; await below rethrows it.
        typing.catch(()=>{});
        let lastWriteAt=null,firstOutput=firstOutputObserved;
        const deadline=Date.now()+180000;
        while(Date.now()<deadline) {
          await sleep(75);
          const outputAt=(await test.cdp.invoke('get_session_output_snapshot'))[outputTab.sessionId];
          if(Number.isFinite(outputAt)&&outputAt>=begin) {
            lastWriteAt=outputAt;
            if(firstOutput===null)firstOutput=Date.now();
          }
          if(lastWriteAt!==null&&Date.now()-lastWriteAt>=500)break;
        }
        if(Date.now()>=deadline)throw new Error('Output did not settle in 180 seconds');
        await typing;
        const flow=flowTrace?await finishFlowTrace(test.cdp,outputTab.sessionId):null;
        const flowClockAfter=flowTrace?await clockOffset(test.cdp):null;
        const frames=await test.cdp.eval('window.__stage3Probe.read()');
        const end=lastWriteAt+500;
        const finalScroll=await scrollback(test,outputTab.sessionId);
        const gaps=frames.gaps.filter(g=>g.atMs>=begin&&g.atMs<=end);
        const inputsDuringOutput=keystrokes.filter(k=>k.keydownAt>=begin&&k.keydownAt<=end);
        const run=Math.max(0,...(report.measurements[name]?.samples??[]).map(row=>row.run))+1;
        const producerDoneAt=detail&&existsSync(commandEnd)?Number(readFileSync(commandEnd,'utf8')):null;
        if(detail&&(!Number.isFinite(producerDoneAt)||producerDoneAt<begin))throw new Error('Missing producer completion timestamp');
        const flowFile=flow?join(out,`${name}-${run}-flow.json`):null;
        if(flow)writeFileSync(flowFile,q({...flow,commandStartedAt:begin,producerDoneAt,backendLastOutputAt:lastWriteAt,clockBefore:flowClockBefore,clockAfter:flowClockAfter}));
        add(name,{run,elapsedMs:end-begin,commandStartedAt:begin,firstObservedOutputAt:firstOutput,
          ...(flow?{flowFile,diagnosticOnly:true,flowIntegrity:flow.integrity}:{}),
          ...(detail?{producerDoneAt,producerThroughConptyMs:producerDoneAt-begin,backendLastOutputAfterProducerMs:lastWriteAt-producerDoneAt}:{}),
          lastObservedWriteAt:lastWriteAt,settledAt:end,outputBytes:finalScroll.endOffset-before.endOffset,
          maxGapMs:Math.max(0,...gaps.map(g=>g.ms)),droppedFrames:gaps.reduce((n,g)=>n+Math.max(0,Math.round(g.ms/(1000/60))-1),0),
          inputs:keystrokes,inputsDuringOutput:inputsDuringOutput.length,inputLatency:stats(keystrokes.map(k=>k.elapsedMs)),
          inputDispatch:kind==='cat'?'50 keydown/up pairs submitted in order as a burst; each key matched to its next input-painted mark, shared frames allowed':'50 keys, next key after previous input-painted mark',
          endpointNote:'Command start timestamp to backend last-output timestamp plus 500 ms; lightweight timestamp map polled every 75 ms, full scrollback fetched only before and after'});
        await test.cdp.invoke('write_to_session',{sessionId:inputTab.sessionId,data:'\u0003'});
      }
    }finally{await close(test);}
  }
}

async function clockOffset(cdp) {
  const samples=[];
  for(let i=0;i<5;i++){
    const before=Date.now();
    const frontend=await cdp.eval('({perf:performance.timeOrigin+performance.now(),wall:Date.now()})');
    const after=Date.now();
    samples.push({before,after,frontend,roundTripMs:after-before,offsetMs:(before+after)/2-frontend.perf});
  }
  const best=[...samples].sort((a,b)=>a.roundTripMs-b.roundTripMs)[0];
  return {offsetMs:best.offsetMs,uncertaintyMs:best.roundTripMs/2+1,samples};
}
async function freshMark(cdp,name,fence,id) {
  return waitUntil(async()=>(await marks(cdp)).find(m=>m.name===name&&!fence.has(q(m))&&(id===undefined||m.id===id)),30000,'new '+name);
}
async function previewTransferState(test, seed=false) {
  const target=await waitUntil(async()=>(await targets(test.port)).find(t=>t.url.includes('asset.localhost')),10000,'preview document target');
  const page=await CDP.connect(target);
  try {
    if(seed)await page.eval(`(()=>{
      window.__stage3TransferNonce=${q(randomUUID())};
      let input=document.getElementById('stage3-transfer-input');
      if(!input){input=document.createElement('input');input.id='stage3-transfer-input';document.body.prepend(input);}
      input.value=window.__stage3TransferNonce;
      let spacer=document.getElementById('stage3-transfer-spacer');
      if(!spacer){spacer=document.createElement('div');spacer.id='stage3-transfer-spacer';spacer.style.height='3000px';document.body.append(spacer);}
      history.replaceState({transfer:window.__stage3TransferNonce},'',location.pathname+'#'+window.__stage3TransferNonce);
      scrollTo(0,123);
    })()`);
    return {targetId:target.id,state:await page.eval(`({nonce:window.__stage3TransferNonce??null,form:document.getElementById('stage3-transfer-input')?.value??null,scrollY,url:location.href,history:history.state})`)};
  } finally {page.close();}
}
async function detachReturn(test,preview=false) {
  const cdp=test.cdp;
  const beforeTargets=new Set((await targets(test.port)).map(t=>t.id));
  const selectedPane=await cdp.eval(`(()=>{
    const shown=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const content=[...document.querySelectorAll(${q(preview?'[data-html-preview-host]':'.xterm-screen')})].find(shown);
    const pane=content?.closest('[data-dnd-pane-id]');
    return pane?{paneId:pane.dataset.dndPaneId,previewId:content.dataset.webPaneHostTabId??null}:null;
  })()`);
  if(!selectedPane)throw new Error('No visible content to detach');
  const selector=`[data-dnd-pane-id="${selectedPane.paneId}"] .pane-tab-pill.is-active`;
  const previewId=preview?selectedPane.previewId:null;
  if(preview&&!previewId)throw new Error("Preview host has no tab identity before detach");
  const stateBeforeDetach=preview?await previewTransferState(test,true):null;
  const {x,y}=await point(cdp,selector);const width=await cdp.eval('innerWidth');
  const mainClock=await clockOffset(cdp);
  const detachFence=new Set((await marks(cdp)).map(q));
  await mouse(cdp,'mouseMoved',x,y);await mouse(cdp,'mousePressed',x,y,{button:'left',clickCount:1});
  for(let step=1;step<=30;step++){await mouse(cdp,'mouseMoved',x+(width+80-x)*step/30,y+5,{button:'left',buttons:1});await sleep(12);}
  await mouse(cdp,'mouseReleased',width+80,y+5,{button:'left',clickCount:1});
  const request=await freshMark(cdp,'detach.request',detachFence);
  const built=await freshMark(cdp,'window.child.built',detachFence);
  const target=await waitUntil(async()=>(await targets(test.port)).find(t=>!beforeTargets.has(t.id)&&t.url.includes('tauri')),30000,'detached main page');
  const child=await CDP.connect(target);child.profile=profile;
  let evidence={previewId,request,built,mainClock};
  const returnMarksFile=join(out,`S6-${preview?'preview':'terminal'}-return-${test.pid}-${Date.now()}.json`);
  try {
    const entry=await waitUntil(async()=>{const m=await child.eval('window.__MYCMUX_PERF__?.read()??[]');return m.some(x=>x.name==='workspace.first.frame')?m:null;},30000,'child first frame');
    const childClock=await clockOffset(child);
    evidence={...evidence,entry,childClock};
    let input;
    if(!preview){const id=await ensureShell(child);await click(child,`[data-session-id="${id}"] .xterm-screen`);input=await key({cdp:child},id,'z');}
    const detachedPreviewReady=preview?await waitUntil(async()=>(await child.eval('window.__MYCMUX_PERF__.read()')).find(m=>m.name==='webpane.create.resolved'&&m.id===previewId),30000,'detached preview ready'):null;
    const stateAfterDetach=preview?await previewTransferState(test):null;
    const stateBeforeReturn=preview?await previewTransferState(test,true):null;
    const returnClock=await clockOffset(cdp);
    const beforeReturn=await marks(cdp),returnFence=new Set(beforeReturn.map(q));
    const returnedAt=Date.now();
    evidence={...evidence,entry,childClock,returnClock,detachedPreviewReady,beforeReturn,returnedAt};
    await child.invoke('plugin:event|emit',{event:'mycmux://detached-dock-request',payload:{toLabel:'main',workspaceId:request.id}}).catch(()=>{});
    await waitUntil(async()=>!(await targets(test.port)).some(t=>t.id===target.id),30000,'dock child close');
    const mainFrame=await freshMark(cdp,'dock.main.painted',returnFence,'main');
    let create,created,shown,createAttempts,reparented,returnCreatedCount=0,detachCreatedCount=0,stateAfterReturn;
    if(preview){
      const mainInvoke=await freshMark(cdp,'webpane.create.invoke',returnFence,previewId);
      shown=await freshMark(cdp,'webpane.child.shown',returnFence,previewId);
      const observed=await marks(cdp);
      const returnMarks=observed.filter(m=>m.id===previewId&&!returnFence.has(q(m)));
      created=returnMarks.find(m=>m.name==='webpane.child.created');
      reparented=returnMarks.find(m=>m.name==='webpane.child.reparented');
      returnCreatedCount=returnMarks.filter(m=>m.name==='webpane.child.created').length;
      detachCreatedCount=beforeReturn.filter(m=>m.id===previewId&&!detachFence.has(q(m))&&m.name==='webpane.child.created').length;
      const enters=returnMarks.filter(m=>m.name==='webpane.create.enter'&&m.atMs<=shown.atMs).sort((a,b)=>a.atMs-b.atMs);
      create=enters.at(-1);createAttempts=enters.length;
      if(!create||(!created&&!reparented))throw new Error('Missing same-preview create or transfer evidence');
      stateAfterReturn=await previewTransferState(test);
      evidence={...evidence,mainInvoke,mainFrame,created,reparented,enters,observed,create,shown,createAttempts,
        stateBeforeDetach,stateAfterDetach,stateBeforeReturn,stateAfterReturn};
    }
    evidence={...evidence,mainFrame,input,clockMethod:'OS wall clock bridged to each frontend with the minimum of five CDP round trips; native durations use native timestamps only; marks selected by pre-action set difference'};
    writeFileSync(returnMarksFile,q(evidence));
    const requestWall=request.atMs+mainClock.offsetMs;
    const mainFrameWall=mainFrame.atMs+returnClock.offsetMs;
    return {childBuiltMs:built.atMs-requestWall,firstFrameMs:entry.find(m=>m.name==='workspace.first.frame').atMs+childClock.offsetMs-requestWall,
      visibleMs:entry.find(m=>m.name==='window.visible').atMs+childClock.offsetMs-requestWall,
      inputPaintMs:input?input.paintedAt+childClock.offsetMs-requestWall:null,keydownToPaintMs:input?.elapsedMs??null,mainFrameMs:mainFrameWall-returnedAt,
      returnedAt,previewId,returnMarksFile,createAttempts,returnCreatedCount,detachCreatedCount,
      detachStateRetained:preview?q(stateBeforeDetach)===q(stateAfterDetach):null,
      returnStateRetained:preview?q(stateBeforeReturn)===q(stateAfterReturn):null,
      detachedPreviewReadyMs:detachedPreviewReady?detachedPreviewReady.atMs+childClock.offsetMs-requestWall:null,
      returnShownMs:shown?shown.atMs-returnedAt:null,frameToCreateMs:create?create.atMs-mainFrameWall:null,
      childCreateMs:created?created.atMs-create.atMs:preview?0:null,createdToShownMs:shown?shown.atMs-(created??reparented).atMs:null,
      clockOffsets:{main:mainClock.offsetMs,child:childClock.offsetMs,returnMain:returnClock.offsetMs},
      clockUncertaintyMs:Math.max(mainClock.uncertaintyMs,childClock.uncertaintyMs,returnClock.uncertaintyMs),
      returnTrigger:'OS timestamp immediately before same detached-dock-request event as native drag detector'};
  }catch(error){writeFileSync(returnMarksFile,q({...evidence,error:String(error),lastMarks:await marks(cdp).catch(()=>[])}));throw error;}
  finally{child.close();}
}
async function s6() {
  for(const kind of ['terminal','preview']) {
    const name=`S6_${kind}`;if(!selected(name)||count(name)>=10)continue;
    const test=await launch('L24');
    try {
      await configure(test,'L24');if(kind==='preview')await openPreview(test);
      for(let i=count(name);i<10;i++)add(name,{run:i+1,...await detachReturn(test,kind==='preview')});
    }finally{await close(test);}
  }
}

async function changedFrame(test,path,marker) {
  if(path.endsWith('.md'))return (await markdownFrame(test,path,marker)).frameAt;
  return waitUntil(async()=>{
    const possible=(await targets(test.port)).filter(t=>t.url.includes('asset.localhost'));
    for(const target of possible){const child=await CDP.connect(target);try {
      if(!await child.eval(`document.body?.textContent?.includes(${q(marker)})`))continue;
      await child.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await child.call('Page.captureScreenshot',{format:'png'});return Date.now();
    }finally{child.close();}}
    return null;
  },30000,'changed document content and frame');
}
async function markdownFrame(test,path,marker='Synthetic preview') {
  let ready;
  try{ready=await waitUntil(()=>test.cdp.eval(`(()=>{
    const frame=[...document.querySelectorAll('iframe')].find(f=>f.title.replaceAll(String.fromCharCode(92),'/').toLowerCase()===${q(path.replaceAll('\\','/').toLowerCase())});
    const doc=frame?.contentDocument;
    if(!doc||doc.readyState!=='complete'||!doc.body?.textContent?.includes(${q(marker)}))return null;
    return {observedAt:Date.now(),title:frame.title,textLength:doc.body.textContent.length};
  })()`),30000,'rendered Markdown iframe content');}
  catch(error){
    const diagnostic={path,marker,targets:await targets(test.port),frames:await test.cdp.call('Page.getFrameTree'),dom:await test.cdp.eval(`({text:document.body.innerText,frames:[...document.querySelectorAll('iframe')].map(f=>{let documentInfo;try{documentInfo={ready:f.contentDocument?.readyState,text:f.contentDocument?.body?.textContent?.slice(0,500)}}catch(e){documentInfo={error:String(e)}}return {title:f.title,src:f.src,srcdoc:f.srcdoc?.slice(0,300),documentInfo}})})`)};
    writeFileSync(join(out,`markdown-failure-${test.pid}.json`),q(diagnostic));throw error;
  }
  await test.cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await test.cdp.call('Page.captureScreenshot',{format:'png'});
  return {...ready,frameAt:Date.now()};
}
async function closeStage3Preview(test,kind) {
  if(kind!=='markdown')return closePreviewPane(test);
  const selector='[data-dnd-pane-id]:has(iframe[title$=".md"]) .pane-tab-pill.is-active';
  const {x,y}=await point(test.cdp,selector);
  await mouse(test.cdp,'mouseMoved',x,y);
  await mouse(test.cdp,'mousePressed',x,y,{button:'middle',buttons:4,clickCount:1});
  await mouse(test.cdp,'mouseReleased',x,y,{button:'middle',buttons:0,clickCount:1});
  await waitUntil(()=>test.cdp.eval('!document.querySelector(\'iframe[title$=".md"]\')'),10000,'Markdown iframe closure');
}
async function previewFrame(test,path) {
  return path.endsWith('.md')?(await markdownFrame(test,path)).frameAt:firstChildFrame(test,path);
}
async function previewSample(test,kind) {
  const value=await openPreview(test,kind);
  if(kind==='markdown'){
    const frame=await markdownFrame(test,value.path);
    return {...value,sample:{elapsedMs:frame.frameAt-value.start.atMs,contentReadyUpperMs:frame.observedAt-value.start.atMs,
      renderKind:'same-origin srcdoc iframe; content ready plus parent two-rAF and screenshot upper bound',nativeWebviewCreated:false,frameEvidence:frame}};
  }
  const created=await markAfter(test.cdp,'webpane.child.created',value.start.atMs,value.queued.id,60000);
  const shown=await markAfter(test.cdp,'webpane.child.shown',value.start.atMs,value.queued.id,60000);
  const frame=await previewFrame(test,value.path);
  return {...value,sample:{createdMs:created.atMs-value.start.atMs,loadedMs:value.loaded.atMs-value.start.atMs,
    shownMs:shown.atMs-value.start.atMs,elapsedMs:frame-value.start.atMs}};
}
async function mediumColdOnly() {
  const name='S7_medium_cold';
  for(let i=count(name);i<5;i++){
    const test=await launch('L0',false,true);
    try{await viewport(test);await ensureAll(test);const p=await previewSample(test,'medium');add(name,{run:i+1,...p.sample});}
    finally{await close(test);}
  }
}
async function s7() {
  for(const kind of ['small','medium','heavy','markdown']) {
    const cold=`S7_${kind}_cold`,warm=`S7_${kind}_warm`,changed=`S7_${kind}_changed`;
    for(let i=count(cold);i<expected[cold];i++) {
      const test=await launch('L0',false,true);
      try{await viewport(test);await ensureShell(test.cdp);const p=await previewSample(test,kind);add(cold,{run:i+1,...p.sample});}
      finally{await close(test);}
    }
    if(count(warm)>=10&&count(changed)>=10)continue;
    const test=await launch('L0');
    try {
      await viewport(test);await ensureShell(test.cdp);
      const prime=await previewSample(test,kind);await closeStage3Preview(test,kind);
      for(let i=count(warm);i<10;i++){const p=await previewSample(test,kind);add(warm,{run:i+1,...p.sample});await closeStage3Preview(test,kind);}
      const initial=await previewSample(test,kind);
      for(let i=count(changed);i<10;i++) {
        const marker=`perf3-change-${kind}-${i}-${Date.now()}`;
        appendFileSync(initial.path,kind==='markdown'?`\n\n${marker}\n`:`<p id="perf-marker">${marker}</p>`);
        await emitPath(test,initial.path);
        const start=await activateTerminalLink(test,Date.now(),initial.path.split(/[\\/]/).at(-1));
        const loaded=kind==='markdown'?null:await markAfter(test.cdp,'webpane.load.finished',start.atMs,initial.queued.id,60000);
        const frame=await changedFrame(test,initial.path,marker);
        const created=(await marks(test.cdp)).filter(m=>m.name==='webpane.child.created'&&m.atMs>=start.atMs);
        add(changed,{run:i+1,elapsedMs:frame-start.atMs,loadedMs:loaded?loaded.atMs-start.atMs:null,childCreatedCount:created.length,marker,markerVerified:true,
          renderKind:kind==='markdown'?'same-origin srcdoc iframe':'native child WebView'});
      }
    }finally{await close(test);}
  }
}

async function counters(test) {
  const native=snapshot(test);
  const heap=(await test.cdp.call('Runtime.getHeapUsage')).usedSize;
  return {atMs:native.time_ms,ws:native.app.ws,private:native.app.private,handles:native.app.handles,
    threads:native.app.threads,webviewWs:native.webviews.reduce((n,p)=>n+p.ws,0),heap,native};
}
async function socketLatency() {
  const result={};
  for(const cmd of ['workspace.list','pane.list_all']){const start=performance.now();await call(cmd);result[cmd]=performance.now()-start;}
  return result;
}
async function cycle(test,name,index,action) {
  await test.cdp.eval('window.__stage3Probe.monitorFrames(true); window.__stage3Probe.reset()');
  const before=await counters(test);const started=Date.now();
  const actionResult=await action();
  const after=await counters(test);const probe=await test.cdp.eval('window.__stage3Probe.read()');
  const diff={};for(const k of ['ws','private','handles','threads','webviewWs','heap'])diff[k+'Delta']=after[k]-before[k];
  add(name,{run:index+1,elapsedMs:Date.now()-started,...diff,before,after,
    rafOver200:probe.rafOver200,maxGapMs:probe.maxGapMs,webglLost:probe.webglLost,actionResult,socketMs:await socketLatency()});
}
async function dragTab(test,source,target,edge=false) {
  const from=await point(test.cdp,source);const to=await point(test.cdp,target);
  const x=edge?to.rect.x+to.rect.width-4:to.x;
  await mouse(test.cdp,'mouseMoved',from.x,from.y);
  await mouse(test.cdp,'mousePressed',from.x,from.y,{button:'left',clickCount:1});
  for(let i=1;i<=25;i++){await mouse(test.cdp,'mouseMoved',from.x+(x-from.x)*i/25,from.y+(to.y-from.y)*i/25,{button:'left',buttons:1});await sleep(15);}
  await waitUntil(()=>test.cdp.eval(`Boolean(document.querySelector('${edge?'.pane-drop-result--split':'.pane-drop-result--merge'}'))`),3000,'visible split/merge drop target');
  await mouse(test.cdp,'mouseReleased',x,to.y,{button:'left',clickCount:1});
  await sleep(500);
}
function identity(data) {
  return {workspaces:data.workspaces.map(w=>w.id).sort(),
    panes:data.workspaces.flatMap(w=>w.panes.map(p=>p.pane_id)).sort(),
    tabs:data.workspaces.flatMap(w=>w.panes.flatMap(p=>p.tabs.map(t=>t.tab_id))).sort(),
    sessions:data.workspaces.flatMap(w=>w.panes.flatMap(p=>p.tabs.map(t=>t.session_id))).sort()};
}
async function leavePreviewDetached(test) {
  const cdp=test.cdp;
  const priorTargets=new Set((await targets(test.port)).map(t=>t.id));
  const priorWindows=new Set(nativeWindows(test.pid).filter(w=>w.class==='Tauri Window').map(w=>w.hwnd));
  const fence=new Set((await marks(cdp)).map(q));
  const tabId=await cdp.eval('document.querySelector("[data-html-preview-host]").dataset.webPaneHostTabId');
  const {x,y}=await point(cdp,'[data-dnd-pane-id]:has([data-html-preview-host]) .pane-tab-pill.is-active');
  const width=await cdp.eval('innerWidth');
  await mouse(cdp,'mouseMoved',x,y);await mouse(cdp,'mousePressed',x,y,{button:'left',clickCount:1});
  for(let step=1;step<=30;step++){await mouse(cdp,'mouseMoved',x+(width+80-x)*step/30,y+5,{button:'left',buttons:1});await sleep(12);}
  await mouse(cdp,'mouseReleased',width+80,y+5,{button:'left',clickCount:1});
  const built=await freshMark(cdp,'window.child.built',fence);
  const target=await waitUntil(async()=>(await targets(test.port)).find(t=>!priorTargets.has(t.id)&&t.url.includes('tauri')),30000,'detached main document');
  const child=await CDP.connect(target);child.profile=profile;
  await waitUntil(async()=>(await child.eval('window.__MYCMUX_PERF__?.read()??[]')).some(m=>m.name==='webpane.create.resolved'&&m.id===tabId),30000,'detached native preview ready');
  const native=await waitUntil(()=>nativeWindows(test.pid).find(w=>w.class==='Tauri Window'&&!priorWindows.has(w.hwnd)),10000,'detached OS window');
  return {child,target,label:built.id,native,tabId};
}
async function windowCloses() {
  for(const first of ['detached','main']) {
    const test=await launch('L24');let detached;
    try {
      await viewport(test);await openPreview(test);
      const mainWindow=nativeWindows(test.pid).find(w=>w.class==='Tauri Window');
      detached=await leavePreviewDetached(test);
      const beforeTargets=await targets(test.port),beforeState=await previewTransferState(test,true);
      const before=fileState(liveWindowPath);
      const closing=first==='main'?{cdp:test.cdp,label:'main',native:mainWindow}: {cdp:detached.child,label:detached.label,native:detached.native};
      const started=Date.now();
      await closing.cdp.invoke('plugin:window|close',{label:closing.label}).catch(()=>{});
      const confirmation=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-File',join(repo,'scripts/perf/close-stage3.ps1'),
        '-TargetPid',String(test.pid),'-ExePath',exe,'-Name',profile,'-ConfirmOnly','-WindowHandle',String(closing.native.hwnd)],
        {windowsHide:true,encoding:'utf8',timeout:50000}));
      const afterTargets=await targets(test.port),nativeAfter=nativeWindows(test.pid),after=fileState(liveWindowPath);
      const afterState=first==='main'?await previewTransferState(test):null;
      const expectedDocument=first==='main'?detached.target.id:test.targetId;
      const otherWindowAlive=afterTargets.some(t=>t.id===expectedDocument);
      const previewPreserved=first==='main'?q(beforeState)===q(afterState):null;
      const previewClosed=first==='detached'?!afterTargets.some(t=>t.id===beforeState.targetId):null;
      const liveUnchanged=q(before)===q(after);
      const row={first,elapsedMs:Date.now()-started,confirmation,beforeTargets,afterTargets,nativeAfter,beforeState,afterState,
        otherWindowAlive,previewPreserved,previewClosed,liveUnchanged,
        pass:confirmation.windowClosed&&otherWindowAlive&&liveUnchanged&&(first==='main'?previewPreserved:previewClosed)};
      add('WindowClose_'+first,row);
      if(!liveUnchanged)isolationStop(row);
      if(!row.pass)throw new Error('Window close lifecycle failed: '+q(row));
    } finally {detached?.child.close();await close(test);}
  }
}
async function monitorPlacement() {
  const test=await launch('L24');
  try {
    await viewport(test);await openPreview(test);
    const tabId=await test.cdp.eval('document.querySelector("[data-html-preview-host]").dataset.webPaneHostTabId');
    const monitors=await test.cdp.invoke('plugin:window|available_monitors');
    const originalPosition=await test.cdp.invoke('plugin:window|outer_position',{label:'main'});
    const originalSize=await test.cdp.invoke('plugin:window|inner_size',{label:'main'});
    test.physicalPlacement=true;
    const checks=[];
    try {
      for(const monitor of monitors) {
        const beforeHost=await placementSnapshot(test.cdp,tabId);
        const beforeDpr=await test.cdp.eval('devicePixelRatio');
        const started=Date.now();
        await test.cdp.invoke('plugin:window|set_size',{label:'main',value:{Logical:{
          width:Math.min(1200,monitor.size.width/monitor.scaleFactor-160),height:Math.min(850,monitor.size.height/monitor.scaleFactor-160)}}});
        await test.cdp.invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:monitor.position.x+80,y:monitor.position.y+80}}});
        const result=await verifyPlaced(test,'monitor placement',tabId,started,true);
        const actualMonitor=await test.cdp.invoke('plugin:window|current_monitor');
        const reached=q(actualMonitor?.position)===q(monitor.position);
        const devicePixelRatio=await test.cdp.eval('devicePixelRatio');
        // With unchanged CSS bounds and DPI, native children move with their
        // OS parent. The placement controller correctly emits no redundant IPC.
        const nativeParentMove=result.backendMarkMs===null&&beforeDpr===devicePixelRatio&&q(beforeHost.host)===q(result.host);
        const timely=nativeParentMove?result.elapsedMs<=100:result.passed;
        checks.push({monitor,actualMonitor,...result,passed:timely&&reached&&result.maximumErrorPx<=1,reached,devicePixelRatio,nativeParentMove,beforeHost});
      }
    } finally {
      await test.cdp.invoke('plugin:window|set_position',{label:'main',value:{Physical:originalPosition}});
      await test.cdp.invoke('plugin:window|set_size',{label:'main',value:{Physical:originalSize}});
    }
    const row={monitors,checks,multipleMonitors:monitors.length>1,
      distinctDpi:new Set(checks.map(c=>c.devicePixelRatio)).size,pass:checks.length>0&&checks.every(c=>c.passed)};
    writeFileSync(join(out,'monitor-placement.json'),q(row));
    if(!row.pass)throw new Error('Monitor placement failed');
  } finally {await close(test);}
}

async function transferCycles() {
  const test=await launch('L24');
  try {
    await configure(test,'L24');
    await openPreview(test);
    for(let i=count('S8_transfer');i<20;i++)await cycle(test,'S8_transfer',i,()=>detachReturn(test,true));
  } finally {await close(test);}
}
async function placement() {
  const test=await launch('L24');
  try {await viewport(test);await verifyPlacementE2e(test, openPreview);}
  finally {await close(test);}
}
async function s8() {
  let test=await launch('L24');
  try {
    await configure(test,only.length && only.every(x=>x==='S8_restart')?'L24':'L24S');
    if(selected('S8_continuous')&&!count('S8_continuous')) {
      const checkpoints=[];const socketSamples=[];const began=Date.now();
      await test.cdp.eval('window.__stage3Probe.monitorFrames(true); window.__stage3Probe.reset()');
      for(let tick=0;tick<=180;tick++) {
        if(tick%30===0){const value=await counters(test);checkpoints.push(value);console.log(`S8 continuous ${tick/6} minutes`);writeFileSync(join(out,'S8-continuous-checkpoints.json'),q({began,checkpoints,socketSamples}));}
        socketSamples.push({atMs:Date.now(),...await socketLatency()});
        if(tick<180)await sleep(Math.max(0,began+(tick+1)*10000-Date.now()));
      }
      const probe=await test.cdp.eval('window.__stage3Probe.read()');
      const diff={};for(const k of ['ws','private','handles','threads','webviewWs','heap'])
        diff[k+'Delta']=stats(checkpoints.slice(-2).map(x=>x[k])).median-stats(checkpoints.slice(0,2).map(x=>x[k])).median;
      add('S8_continuous',{elapsedMs:Date.now()-began,checkpoints,...diff,rafOver200:probe.rafOver200,
        socketSummary:Object.fromEntries(['workspace.list','pane.list_all'].map(cmd=>[cmd,stats(socketSamples.map(s=>s[cmd]))]))});
      writeFileSync(join(out,'S8-continuous-probe.json'),q(probe));
    }
    const ws=(await call('workspace.list')).workspaces.map(w=>w.id);
    for(let i=count('S8_workspace');selected('S8_workspace')&&i<100;i++)await cycle(test,'S8_workspace',i,async()=>{
      for(const id of [ws[1],ws[0]])await clickClock(test,`[data-dnd-workspace-target-id="${id}"]`);
    });
    let state=await list();let all=tabsOf(state);let first=all.find(t=>t.workspaceId===ws[0]&&all.filter(x=>x.paneId===t.paneId).length>=2);
    const siblings=all.filter(t=>t.paneId===first.paneId);
    await activate(test,first);
    for(let i=count('S8_tab');selected('S8_tab')&&i<100;i++)await cycle(test,'S8_tab',i,async()=>{
      await clickClock(test,await tabSelector(test,siblings[(i+1)%2]));
    });
    for(let i=count('S8_detach');selected('S8_detach')&&i<20;i++)await cycle(test,'S8_detach',i,()=>detachReturn(test));
    for(let i=count('S8_html');selected('S8_html')&&i<20;i++)await cycle(test,'S8_html',i,async()=>{await openPreview(test);await closePreviewPane(test);});
    for(let i=count('S8_split');selected('S8_split')&&i<10;i++)await cycle(test,'S8_split',i,async()=>{
      state=await list();all=tabsOf(state);
      first=all.find(t=>t.workspaceId===ws[0]&&all.filter(x=>x.paneId===t.paneId).length>=2);
      if(!first)throw new Error('No original multi-session pane remains for split/merge');
      await activate(test,first);
      const original=state.panes.find(p=>p.id===first.paneId);
      const other=all.find(t=>t.paneId===original.id&&t.id!==first.id);
      if(!other)throw new Error('Split/merge requires a second session in the same pane');
      await activate(test,other);
      await dragTab(test,await tabSelector(test,other),`[data-dnd-pane-id="${original.id}"] .xterm-screen`,true);
      const split=await waitUntil(async()=>{const s=await list();return s.panes.length>state.panes.length?s:null;},15000,'split created');
      const moved=tabsOf(split).find(t=>t.id===other.id);
      await dragTab(test,await tabSelector(test,moved),`[data-dnd-pane-id="${original.id}"] .xterm-screen`);
      await waitUntil(async()=>(await list()).panes.length===state.panes.length,15000,'split merged');
    });
    if(selected('S8_retention_workspace')&&!count('S8_retention_workspace')){
      // Supplement the large observed workspace-switch retention with a
      // within-process, GC-normalized repeat; never join memory across PIDs.
      await test.cdp.eval('window.__stage3Probe.monitorFrames(false)');
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(1000);
      const before=await counters(test);const started=Date.now();
      for(let i=0;i<100;i++)for(const id of [ws[1],ws[0]])await clickClock(test,`[data-dnd-workspace-target-id="${id}"]`);
      const beforeGc=await counters(test);
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(1000);
      const after=await counters(test);
      add('S8_retention_workspace',{elapsedMs:Date.now()-started,roundTrips:100,before,beforeGc,after,
        method:'Supplemental 100 workspace round trips, GC before and after, same PID; observer rAF disabled'});
    }
    if(selected('S8_retention')&&!count('S8_retention')){
      const before=await counters(test);const started=Date.now();
      await test.cdp.call('HeapProfiler.collectGarbage');await sleep(1000);
      const after=await counters(test);add('S8_retention',{elapsedMs:Date.now()-started,before,after,heapAfterGc:after.heap,heapBeforeGc:before.heap});
    }
    // Synthetic mappings must never become real agent resumes on restart.
    for(const fake of test.fake??[])await test.cdp.invoke('write_to_session',{sessionId:fake.sessionId,data:'\u0003'});
    await sleep(3000);
    await close(test,{graceful:true});test=null;
    for(let i=count('S8_restart');selected('S8_restart')&&i<3;i++) {
      const saved=JSON.parse(readFileSync(dataPath,'utf8'));
      const idsBefore=identity(saved);
      copyFileSync(dataPath,join(out,`S8-restart-${i+1}-before.json`));
      execFileSync('python',[join(repo,'scripts/perf/prepare-stage3-profile.py'),'--load','L24','--cwd',out,'--restart','--profile-name',profile],{windowsHide:true});
      const diagPath=join(runtime,'diag.log');const diagBefore=existsSync(diagPath)?readFileSync(diagPath).length:0;
      const started=Date.now();test=await launch('L24',true);
      await ensureAll(test,{verifyShells:false});
      const activeId=await ensureShell(test.cdp);await plainShell(test,{sessionId:activeId});
      await waitUntil(async()=>Object.keys(await test.cdp.invoke('get_session_output_snapshot')).length>=idsBefore.sessions.length,30000,'all restarted PTYs');await sleep(5000);
      const entries=await marks(test.cdp);
      const spawnIds=entries.filter(m=>m.name==='pty.spawn.done').map(m=>m.id);
      const duplicated=spawnIds.filter((id,index)=>spawnIds.indexOf(id)!==index);
      await close(test,{graceful:true});test=null;
      const after=JSON.parse(readFileSync(dataPath,'utf8'));const idsAfter=identity(after);
      copyFileSync(dataPath,join(out,`S8-restart-${i+1}-after.json`));
      const diag=existsSync(diagPath)?readFileSync(diagPath).subarray(diagBefore).toString('utf8'):'';
      const newErrors=diag.split(/\r?\n/).filter(line=>/error|timeout/i.test(line));
      const same=q(idsBefore)===q(idsAfter);
      add('S8_restart',{run:i+1,elapsedMs:Date.now()-started,idsEqual:same,idsBefore,idsAfter,duplicatePtyStarts:duplicated,newErrors});
      if(!same||duplicated.length||newErrors.length)(report.stabilityFailures??=[]).push({run:i+1,idsEqual:same,duplicated,newErrors});
    }
  }finally{if(test)await close(test);}
}

async function externalObservers() {
  const installed=join(process.env.LOCALAPPDATA,'mycmux/mycmux.exe').toLowerCase();
  const production=rows().find(r=>resolve(r.exe).toLowerCase()===installed);
  if(!production)throw new Error('Installed production process is unavailable');
  const tasks=[];
  const launchObserver=(name,command,args)=>{
    const child=spawn(command,args,{cwd:repo,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let log='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
    tasks.push(new Promise(resolve=>{child.on('error',error=>resolve({name,code:-1,error:String(error)}));child.on('exit',code=>{writeFileSync(join(out,name+'-observer.log'),log);resolve({name,code});});}));
  };
  const externalPath=join(out,'production-30min-v2.jsonl');
  if(!existsSync(externalPath))launchObserver('production','python',[join(repo,'scripts/perf/observe-production.py'),'--pid',String(production.pid),'--output',externalPath]);
  else if(!readFileSync(externalPath,'utf8').trim().split('\n').at(-1).includes('"complete"'))throw new Error('Incomplete external observation exists; preserve it and choose a fresh evidence path');
  const pdh=join(out,'production-pdh.jsonl');
  if(!existsSync(pdh))launchObserver('pdh','powershell.exe',['-NoProfile','-File',join(repo,'scripts/perf/observe-pdh.ps1'),'-TargetPid',String(production.pid),'-Output',pdh]);
  return {finish:async()=>{
    const results=await Promise.all(tasks);report.externalObservers=results;
    if(results.some(r=>r.code!==0))throw new Error('An external observer failed: '+q(results));
    execFileSync('python',[join(repo,'scripts/perf/summarize-production.py'),'--output-dir',out],{windowsHide:true,stdio:'pipe'});
  }};
}
async function main() {
  importRows();
  if(process.argv.includes('--validate-only')) {
    save();const phase=arg('--phase','all');
    const belongs=key=>selected(key)&&(phase==='all'||key===phase||(phase==='S7medium'?key==='S7_medium_cold':phase==='S2'?key.startsWith('S2_')&&!key.startsWith('S2_control_'):key.startsWith(phase+'_')));
    const missing=report.completeness.missing.filter(x=>belongs(x.key));const invalid=report.completeness.invalid.filter(x=>belongs(x.name));
    const result={phase,missing,invalid,complete:!missing.length&&!invalid.length};console.log(q(result));if(!result.complete)process.exitCode=1;return;
  }
  const phase=arg('--phase','all');
  const phases={S1:s1,S2:s2,S2_control:controls,Ha:livebriefProbe,S3:s3,S4:s4,S5:s5,S6:s6,S7:s7,S7medium:mediumColdOnly,S8:s8,S8_transfer:transferCycles,Placement:placement,WindowClose:windowCloses,Monitors:monitorPlacement,Stability:retentionPlateau};
  if(phase!=='all'&&phase!=='smoke'&&phase!=='import'&&!phases[phase])throw new Error('Unknown phase '+phase);
  if(phase==='import'){save();return;}
  if(phase==='smoke') {
    const test=await launch('L24');
    try {
      await viewport(test);
      const state=await list();
      console.log(q({state,metadata:await test.cdp.invoke('get_pty_metadata_snapshot'),marks:await marks(test.cdp)}));
      await ensureAll(test);
      const id=await ensureShell(test.cdp);await click(test.cdp,`[data-session-id="${id}"] .xterm-screen`);
      console.log(q(await key(test,id,'x')));
      writeFileSync(join(out,'smoke.json'),q({state:await list(),marks:await marks(test.cdp)}));
      if(process.argv.includes('--hold-for-e2e')) {
        const release=join(out,`e2e-release-${test.pid}.json`);
        writeFileSync(join(out,'e2e-ready.json'),q({pid:test.pid,port:test.port,profile,release,createdAt:test.createdAt}));
        console.log('Ready for isolated CDP E2E: '+q({pid:test.pid,port:test.port,release}));
        await waitUntil(()=>existsSync(release),900000,'E2E release marker');
      }
    }finally{await close(test);}
    return;
  }
  const observers=phase==='all'&&!process.argv.includes('--skip-production')?await externalObservers():null;
  try {
  for(const [name,fn] of Object.entries(phases)) if((phase==='all'||phase===name) && (!only.length || only.some(x=>x===name||x.startsWith(name+'_')))) {
    if(phase==='all'&&['S8_transfer','Placement','WindowClose','Monitors'].includes(name))continue;
    const required=Object.entries(expected).filter(([key])=>selected(key)).filter(([key])=>name==='S7medium'?key==='S7_medium_cold':name==='S2'?key.startsWith('S2_')&&!key.startsWith('S2_control_'):key.startsWith(name+'_'));
    if(required.length&&required.every(([key,n])=>count(key)>=n)){console.log(`Skipping completed ${name}`);continue;}
    console.log(`Starting ${name} at ${new Date().toISOString()}`);
    try{await fn();}catch(err){error(name,err);throw err;}
  }
  } finally {if(observers)await observers.finish();}
  save();
}
main().catch(async err=>{console.error(err);if(active)await close(active).catch(e=>console.error(e));process.exitCode=1;});
