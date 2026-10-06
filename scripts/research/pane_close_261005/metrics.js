/* CDP test instrumentation only. Never imported by the application. */
(async () => {
  if (window.__s4) return true;
  const entry = document.querySelector('script[type=module][src]');
  const modules = await import(entry.src);
  const values = Object.values(modules).flatMap(v => v?.useWorkspaceListStore ? Object.values(v) : [v]);
  const store = predicate => values.find(v => typeof v?.getState === 'function' && predicate(v.getState()));
  const L = store(s => Array.isArray(s.workspaces));
  const A = store(s => typeof s.setActivePaneTab === 'function');
  const U = store(s => typeof s.setActivePaneId === 'function');
  const S = store(s => 'nativePaneTearoutEnabled' in s);
  const M = store(s => typeof s.setMetadata === 'function');
  const command = Object.values(modules).find(v => typeof v === 'function' && v.name === 'handleSocketCommand');
  if (!L || !A || !U) throw new Error('s4 release export access missing');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const shown = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 &&
    getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' &&
    !e.closest('[aria-hidden="true"]');
  const center = e => { const r = e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; };
  const region = id => [...document.querySelectorAll('[data-dnd-pane-id]')].find(e => e.dataset.dndPaneId === id && shown(e));
  const pill = id => [...document.querySelectorAll('[data-tab-id]')].find(e => e.dataset.tabId === id && shown(e));
  const button = (title, root=document) => [...root.querySelectorAll('button')].find(e => shown(e) && e.title === title);
  const text = value => [...document.querySelectorAll('button,[role=button]')].find(e => shown(e) && e.textContent.trim() === value);
  const pe = (type, target, p, extra={}) => target.dispatchEvent(new PointerEvent(type, {
    bubbles:true,cancelable:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,
    clientX:p.x,clientY:p.y,screenX:window.screenX+p.x,screenY:window.screenY+p.y,
    button:type==='pointermove'?-1:0,buttons:type==='pointerup'?0:1,...extra
  }));
  const key = (name, flags={}) => window.dispatchEvent(new KeyboardEvent('keydown', {key:name, code:name,bubbles:true,cancelable:true,...flags}));
  const snapshot = () => ({workspaces:L.getState().workspaces, activeWorkspace:L.getState().activeWorkspaceId,
    activeSession:U.getState().activePaneId, zoom:U.getState().zoomedPaneId});
  const canvasIds = new WeakMap(); let nextCanvas=1;
  const currentCanvases = () => [...document.querySelectorAll('.xterm-screen canvas')].filter(shown).map(e => {
    if (!canvasIds.has(e)) canvasIds.set(e,nextCanvas++);
    return {id:canvasIds.get(e),width:e.width,height:e.height};
  });
  const visual = () => {
    const active = L.getState().getWorkspace(L.getState().activeWorkspaceId);
    const elements = [...document.querySelectorAll('[data-dnd-pane-id]')].filter(shown);
    const rects = elements.map(e => {const r=e.getBoundingClientRect();return [e.dataset.dndPaneId,...[r.x,r.y,r.width,r.height].map(n=>Math.round(n*10)/10)];});
    const canvases=currentCanvases();
    return {at:performance.now(),rects,canvases,visibleXterms:[...document.querySelectorAll('.xterm')].filter(shown).length,
      activeSession:U.getState().activePaneId, zoom:U.getState().zoomedPaneId,
      activeElement:document.activeElement?.className||document.activeElement?.tagName,
      logicalFocusValid:!U.getState().activePaneId || active?.panes.some(p => p.tabs.some(t => t.sessionId===U.getState().activePaneId)),
      order:active?.panes.map(p => [p.id,p.activeTabId,p.pinnedTabId,p.tabs.map(t=>[t.id,t.label])])};
  };
  const signature = v => JSON.stringify([v.rects,v.order,v.activeSession,v.zoom]);
  const errors=[];
  const warnings=[];const warn=console.warn.bind(console);
  console.warn=(...args)=>{warnings.push({at:Date.now(),message:args.map(a=>String(a?.stack||a)).join(' ')});warn(...args);};
  window.addEventListener('error',e=>errors.push({at:Date.now(),type:'error',message:String(e.error?.stack||e.message)}));
  window.addEventListener('unhandledrejection',e=>errors.push({at:Date.now(),type:'unhandledrejection',message:String(e.reason?.stack||e.reason)}));
  const measure = async (name,action,expected,budget=6500) => {
    const before=snapshot(), samples=[], errorStart=errors.length;
    let running=true, releaseAt=null;
    const loop=async()=>{while(running){samples.push(visual());await frame();}};
    const sampling=loop();
    const begin=performance.now();
    let actionResult=null, actionError=null;
    try {actionResult=await action(()=>{releaseAt=performance.now();});}catch(e){actionError=String(e.stack||e);}
    releaseAt ??= performance.now();
    let last=null,lastChanged=releaseAt,firstExpected=null,passed=false;
    while(performance.now()-releaseAt < budget){
      const v=visual(),sig=signature(v);
      if(sig!==last){last=sig;lastChanged=performance.now();}
      let ok=false;try{ok=!!expected();}catch{}
      if(ok){firstExpected??=performance.now();if(performance.now()-lastChanged>=100){passed=true;break;}}
      await frame();
    }
    running=false; await sampling;
    const end=performance.now(), after=snapshot();
    const post=samples.filter(v=>v.at>=releaseAt);
    const allIds=new Set(samples.flatMap(v=>v.canvases.map(c=>c.id)));
    const initialIds=new Set(samples[0]?.canvases.map(c=>c.id)||[]);
    const activeElements=post.map(v=>String(v.activeElement));
    return {name,pass:passed&&!actionError,actionResult,actionError,before,after,
      action_ms:releaseAt-begin,release_to_expected_ms:firstExpected===null?null:firstExpected-releaseAt,
      release_to_settled_ms:end-releaseAt,settle_quiet_window_ms:100,sample_n:samples.length,
      geometry_changes:post.slice(1).filter((v,i)=>JSON.stringify(v.rects)!==JSON.stringify(post[i].rects)).length,
      zero_region_frames:post.filter(v=>v.rects.length===0).length,
      invalid_logical_focus_frames:post.filter(v=>!v.logicalFocusValid).length,
      active_element_transitions:activeElements.slice(1).filter((v,i)=>v!==activeElements[i]).length,
      new_canvas_elements:[...allIds].filter(id=>!initialIds.has(id)).length,
      visible_xterm_min:post.length?Math.min(...post.map(v=>v.visibleXterms)):null,
      errors:errors.slice(errorStart),samples};
  };
  const drag = async (el,end,release) => {
    if(!el)throw new Error('drag source missing');
    const start=center(el); pe('pointerdown',el,start);
    for(let i=1;i<=8;i++){pe('pointermove',window,{x:start.x+(end.x-start.x)*i/8,y:start.y+(end.y-start.y)*i/8});await frame();}
    release(); pe('pointerup',window,end);await frame();
    return {start,end};
  };
  const setNative = async enabled => {
    if(S){const setter=S.getState().setNativePaneTearoutEnabled;if(setter)setter(enabled);else S.setState({nativePaneTearoutEnabled:enabled});}
    else {
      const open=button('\u8a2d\u5b9a');if(!open)throw new Error('settings missing');open.click();await sleep(200);
      text('\u901a\u77e5\u3068\u30ec\u30a4\u30a2\u30a6\u30c8')?.click();await sleep(200);
      const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('\u30da\u30a4\u30f3\u306e\u5207\u308a\u96e2\u3057\u3092\u65b0\u3057\u3044\u52d5\u304d\u306b\u3059\u308b'));
      const box=label?.querySelector('input[type=checkbox]');if(!box)throw new Error('native preference missing');
      if(box.checked!==enabled)box.click();document.querySelector('.cmux-settings-close-button').click();
    }
    await sleep(900);return enabled;
  };
  const nativeCapture = () => {
    if(window.__s4Capture)return;
    const api=window.__TAURI_INTERNALS__, original=api.invoke.bind(api);
    window.__s4Records=[];
    const capture=(cmd,args)=>{
      if(cmd==='tearout_log_record'&&Array.isArray(args.record?.errors)&&!window.__s4Records.some(r=>r.drag_id===args.record.drag_id))window.__s4Records.push(structuredClone(args.record));
      if(cmd==='tearout_start_move'){window.__s4Moving=args;return Promise.resolve(null);}
      if(cmd==='tearout_show'&&window.__s4SyntheticReveal)return (async()=>{
        const shown_at=Date.now();
        await original('plugin:window|set_position',{label:args.label,value:{Logical:{x:40,y:50}}});
        await original('plugin:window|set_size',{label:args.label,value:{Logical:{width:720,height:520}}});
        await original('plugin:window|show',{label:args.label});
        return {shown_at,visible_at:Date.now(),scale:1,monitor:null,focus_stolen:false};
      })();
      return null;
    };
    api.invoke=function(cmd,args,...rest){
      const intercepted=capture(cmd,args);if(intercepted)return intercepted;
      return original(cmd,args,...rest);
    };
    // The bundled Tauri core can retain the original invoke function. Intercept
    // both transport routes, as the repository's I3 synthetic E2E does.
    const fetch=window.fetch.bind(window);
    window.fetch=function(input,options){
      const url=String(input),match=url.match(/\/(tearout_start_move|tearout_log_record|tearout_show)(?:\?|$)/);
      if(match){
        const args=JSON.parse(options.body);
        const intercepted=capture(match[1],args);
        if(intercepted)return intercepted.then(value=>new Response(JSON.stringify(value),{headers:{'Tauri-Response':'ok','Content-Type':'application/json'}}));
      }
      return fetch(input,options);
    };
    const bridge=window.chrome.webview,post=bridge.postMessage.bind(bridge);
    bridge.postMessage=function(data){
      const msg=typeof data==='string'?JSON.parse(data):data;
      const intercepted=capture(msg.cmd,msg.payload);if(intercepted){intercepted.then(value=>api.runCallback(msg.callback,value),error=>api.runCallback(msg.error,String(error)));return;}
      return post(data);
    };
    window.__s4Capture=true;
  };
  window.__s4={L,A,U,S,M,command,sleep,frame,shown,center,region,pill,button,text,pe,key,snapshot,visual,measure,drag,setNative,nativeCapture,errors,warnings};
  return {access:true,settings:!!S,command:!!command};
})()
