import { setTimeout as sleep } from 'node:timers/promises';

export function nativeFlowValues(marks, sessionId) {
  return Object.fromEntries(marks.filter(mark => mark.id === sessionId && mark.name.startsWith('pty.flow.'))
    .map(mark => [mark.name.slice('pty.flow.'.length), mark.value]));
}

export async function startFlowTrace(cdp, sessionId) {
  const supported = await cdp.eval('typeof window.__MYCMUX_PERF__?.setTerminalFlowTrace === "function"');
  if (!supported) throw new Error('This binary does not support the separate flow diagnostic');
  const marks = await cdp.invoke('perf_timeline_read', { flowTraceSession: sessionId });
  if (nativeFlowValues(marks, sessionId).active !== 1) throw new Error('Native isolated flow tracing did not start');
  await cdp.eval(`window.__MYCMUX_PERF__.setTerminalFlowTrace(${JSON.stringify(sessionId)})`);
}

export async function finishFlowTrace(cdp, sessionId) {
  let native, frontend;
  const deadline = Date.now() + 15000;
  for (;;) {
    native = nativeFlowValues(await cdp.invoke('perf_timeline_read'), sessionId);
    frontend = await cdp.eval('window.__MYCMUX_PERF__.readTerminalFlowTrace()');
    if (frontend?.sessionId !== sessionId) throw new Error('Frontend trace session changed');
    if (frontend.pendingWrites === 0 && frontend.receivedBytes >= (native['channel.bytes'] ?? 0)) break;
    if (Date.now() >= deadline) throw new Error('Flow did not drain to the frontend parser callback');
    await sleep(50);
  }
  const frameFence = await cdp.eval(`new Promise(resolve=>{
    let done=false,firstFrame,secondFrame;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(firstFrame);cancelAnimationFrame(secondFrame);resolve({painted:value,atMs:performance.timeOrigin+performance.now()});};
    const timer=setTimeout(()=>finish(false),250);
    firstFrame=requestAnimationFrame(()=>{secondFrame=requestAnimationFrame(()=>finish(true));});
  })`);
  const nativeMarks = await cdp.invoke('perf_timeline_read', { stopFlowTrace: true });
  frontend = await cdp.eval('(()=>{window.__MYCMUX_PERF__.setTerminalFlowTrace(null);return window.__MYCMUX_PERF__.readTerminalFlowTrace();})()');
  const values=nativeFlowValues(nativeMarks, sessionId), issues=[];
  if (!frameFence.painted) issues.push('frame deadline expired');
  if (!(values['channel.bytes']>0) || frontend.receivedBytes!==values['channel.bytes']) issues.push('native/frontend byte counts differ or are empty');
  if (!(frontend.completedWrites>0) || frontend.pendingWrites!==0) issues.push('parser writes are incomplete or absent');
  for (const stage of ['queue_drop','auto_consume','channel_error']) if (values[stage+'.calls']>0) issues.push(stage);
  if (frontend.resyncBatches>0) issues.push('frontend resync occurred');
  return { sessionId, native: values, frontend, frameFence, integrity:{pass:issues.length===0,issues},
    method: 'Separate diagnostic, excluded from normal S5 A/B. Native stage totals overlap across threads and are not additive. Read is blocking read wall time; read_process ends at queue publish; queue is enqueue-to-consume; reserve is the flow-control wait; channel includes wire encoding/send; flush_delay includes scheduler delay. Frontend write ends at the parser callback, render uses onRender, and the final fence is two rAF with a 250 ms deadline. Producer completion also includes ConPTY backpressure and the trailing date process.' };
}
