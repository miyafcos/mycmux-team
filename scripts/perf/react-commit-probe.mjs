// Production React omits Profiler.actualDuration. Intercept one diagnostic
// reload instead of mutating a paused frame's binding (which can be ineffective).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export async function instrumentReactCommitSource(source) {
  const { default: ts } = await import('typescript');
  const tree=ts.createSourceFile('asset.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const matches=[];
  function visit(node){
    if(ts.isFunctionDeclaration(node)&&node.name?.text==='commitRoot'&&node.body)matches.push(node.body);
    ts.forEachChild(node,visit);
  }
  visit(tree);
  if(matches.length!==1)throw new Error(`Expected one commitRoot body, found ${matches.length}`);
  const body=matches[0],start=body.getStart(tree)+1,end=body.getEnd()-1;
  const opening='\nconst __stage3CommitStart=window.performance.now();try{\n';
  const closing='\n}finally{window.__stage3ReactCommitCount++;const rows=window.__stage3ReactCommits;rows.push({atMs:window.performance.timeOrigin+__stage3CommitStart,durationMs:window.performance.now()-__stage3CommitStart});if(rows.length>2048)rows.shift();}\n';
  return 'window.__stage3ReactCommits=[];window.__stage3ReactCommitCount=0;window.__stage3ReactProbeReady=true;\n'
    +source.slice(0,start)+opening+source.slice(start,end)+closing+source.slice(end);
}

export async function installReactCommitProbe(cdp, trigger, sourceOutputPath) {
  if(!cdp.profile || await cdp.invoke('get_test_profile')!==cdp.profile)throw new Error('React diagnostic profile mismatch');
  let installed=null,failure=null;
  const pending=new Set();
  const hash=s=>createHash('sha256').update(s).digest('hex');
  const handle=async event=>{
    let fulfilled=false;
    try{
      if(event.responseStatusCode===200&&!installed){
        const response=await cdp.call('Fetch.getResponseBody',{requestId:event.requestId});
        const original=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;
        if(/function commitRoot\s*\(/.test(original)){
          const modified=await instrumentReactCommitSource(original);
          if(sourceOutputPath)writeFileSync(sourceOutputPath,modified,'utf8');
          installed={url:event.request.url,originalSha256:hash(original),instrumentedSha256:hash(modified),sourceOutputPath};
          await cdp.call('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,
            responseHeaders:[...(event.responseHeaders??[]).filter(h=>!['content-length','content-encoding','cache-control'].includes(h.name.toLowerCase())),
              {name:'Cache-Control',value:'no-store'}],
            body:Buffer.from(modified).toString('base64')});
          fulfilled=true;
        }
      }
    }catch(error){failure=error;}
    if(!fulfilled)await cdp.call('Fetch.continueRequest',{requestId:event.requestId}).catch(error=>{failure??=error;});
  };
  const listener=({data})=>{
    const message=JSON.parse(String(data));
    if(message.method!=='Fetch.requestPaused')return;
    const work=handle(message.params);pending.add(work);void work.finally(()=>pending.delete(work));
  };
  cdp.ws.addEventListener('message',listener);
  try{
    await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*/assets/*.js',resourceType:'Script',requestStage:'Response'}]});
    await cdp.call('Page.reload',{ignoreCache:true});
    const deadline=Date.now()+60000;
    let ready=false;
    while(Date.now()<deadline){
      if(failure)throw failure;
      ready=await cdp.eval('Boolean(window.__stage3ReactProbeReady&&window.__stage3ReactCommits?.length&&document.querySelector(".xterm-screen"))').catch(()=>false);
      if(ready)break;
      await sleep(100);
    }
    if(!ready||!installed)throw new Error('Instrumented React diagnostic did not commit after reload');
    await Promise.all([...pending]);
    await sleep(1000);
    const before=await cdp.eval('window.__stage3ReactCommitCount');
    await trigger();
    await sleep(250);
    const after=await cdp.eval('window.__stage3ReactCommitCount');
    if(after<=before)throw new Error(`React diagnostic trigger produced no recorded commit (${before} -> ${after})`);
    return {...installed,validated:true,validationCommits:{before,after},method:'Separate CDP Fetch-intercepted diagnostic reload; synchronous commitRoot body measured with try/finally; primary timing and heap snapshots precede this reload; production actualDuration is unavailable.'};
  }catch(error){
    const observed=await cdp.eval('({ready:window.__stage3ReactProbeReady,count:window.__stage3ReactCommitCount,rows:window.__stage3ReactCommits?.slice(-10),marks:window.__MYCMUX_PERF__?.read()?.slice(-15)})').catch(()=>null);
    if(sourceOutputPath)writeFileSync(sourceOutputPath+'.error.json',JSON.stringify({error:String(error),installed,observed},null,2)+'\n');
    throw error;
  }finally{
    await cdp.call('Fetch.disable').catch(()=>{});
    await Promise.allSettled([...pending]);
    cdp.ws.removeEventListener('message',listener);
  }
}
