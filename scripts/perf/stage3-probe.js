// Installed with Page.addScriptToEvaluateOnNewDocument before a controlled reload.
// All hooks live only in the isolated CDP page, never in the shipped application.
(() => {
  if (window.__stage3Probe) return;
  const state = { timers: {}, rafCalls: 0, rafFires: 0, gaps: [], active: false,
    heap: [], longTasks: [], epoch: performance.timeOrigin, marks: [],
    frameCount:0, maxGapMs:0, rafOver200:0, gapNext:0, webglCreated:0, webglLost:0 };
  const knownCanvas = new WeakSet();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(kind,...args) {
    const context = getContext.call(this,kind,...args);
    if (context && /^(webgl2?|experimental-webgl)$/.test(kind) && !knownCanvas.has(this)) {
      knownCanvas.add(this); state.webglCreated++;
      this.addEventListener('webglcontextlost',()=>state.webglLost++);
    }
    return context;
  };
  const original = { setTimeout: window.setTimeout, setInterval: window.setInterval,
    requestAnimationFrame: window.requestAnimationFrame };
  for (const name of ['setTimeout', 'setInterval']) {
    window[name] = function(callback, wait, ...args) {
      const stack = new Error().stack.split('\n').slice(2, 7).join('\n');
      const key = `${name}:${wait}:${stack}`;
      const slot = state.timers[key] ??= { kind: name, delay: wait, stack, created: 0, fired: 0 };
      slot.created++;
      if (typeof callback !== 'function') return original[name].call(window, callback, wait, ...args);
      return original[name].call(window, function(...values) {
        slot.fired++;
        return callback.apply(this, values);
      }, wait, ...args);
    };
  }
  window.requestAnimationFrame = function(callback) {
    state.rafCalls++;
    return original.requestAnimationFrame.call(window, function(time) {
      state.rafFires++;
      return callback(time);
    });
  };
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ atMs: performance.timeOrigin + entry.startTime, ms: entry.duration });
  });
  observer.observe({ entryTypes: ['longtask'] });
  let last = 0;
  const tick = time => {
    if (last) {
      const gap={ atMs: performance.timeOrigin + time, ms:time-last };
      state.frameCount++;state.maxGapMs=Math.max(state.maxGapMs,gap.ms);
      if(gap.ms>200)state.rafOver200++;
      if(state.gaps.length<12000)state.gaps.push(gap);
      else {state.gaps[state.gapNext]=gap;state.gapNext=(state.gapNext+1)%12000;}
    }
    last = time;
    if (state.active) original.requestAnimationFrame.call(window, tick);
  };
  state.monitorFrames = enabled => {
    const starting = enabled && !state.active;
    state.active = enabled;
    if (starting) { last=0; original.requestAnimationFrame.call(window, tick); }
  };
  state.reset = () => {
    for (const value of Object.values(state.timers)) { value.fired=0; value.created=0; }
    state.rafCalls=0; state.rafFires=0; state.gaps=[]; state.longTasks=[];
    state.frameCount=0;state.maxGapMs=0;state.rafOver200=0;state.gapNext=0;
  };
  state.read = () => ({ timers: Object.values(state.timers), rafCalls: state.rafCalls,
    rafFires: state.rafFires, gaps: state.gaps, longTasks: state.longTasks,
    frameCount:state.frameCount,maxGapMs:state.maxGapMs,rafOver200:state.rafOver200,
    webglCreated:state.webglCreated,webglLost:state.webglLost,
    mountedXterms:document.querySelectorAll('.xterm').length });
  window.__stage3Probe = state;
})();
