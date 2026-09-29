"""Independent summaries of stage-three evidence; no application interaction."""
import argparse
from collections import defaultdict
from datetime import datetime
import json
import math
import re
from pathlib import Path


def stats(values):
    values=sorted(v for v in values if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v))
    def quantile(p):
        if not values:return None
        x=(len(values)-1)*p;i=int(x)
        return values[i]+(values[min(i+1,len(values)-1)]-values[i])*(x-i)
    return dict(n=len(values),median=quantile(.5),p90=quantile(.9),p99=quantile(.99),max=max(values) if values else None)


def pairs(marks,begin,end):
    pending=defaultdict(list);result=[]
    for m in sorted(marks,key=lambda x:x['atMs']):
        key=m.get('id')
        if m['name']==begin:pending[key].append(m['atMs'])
        elif m['name']==end and pending[key]:
            start=pending[key].pop(0)
            result.append(dict(id=key,begin=start,end=m['atMs'],ms=m['atMs']-start))
    return result


COMPONENTS={
    'crsmList':('crsm.list.enter','crsm.list.done'),
    'crsmBackgroundRefresh':('crsm.background-refresh.enter','crsm.background-refresh.done'),
    'storeRead':('store.load.enter','store.load.read'),
    'storeSanitize':('store.load.read','store.load.sanitized'),
    'agentRestoreDecision':('session.create.enter','session.restore.checked'),
    'scrollbackLoad':('session.scrollback.load.enter','session.scrollback.load.done'),
    'ptySpawn':('pty.spawn.enter','pty.spawn.done'),
    'sessionCreate':('session.create.enter','session.create.done'),
    'xtermMount':('xterm.mount.enter','xterm.mount.opened'),
    'xtermBackendReplay':('xterm.backend-replay.enter','xterm.backend-replay.done'),
    'xtermInitialReplay':('xterm.replay.enter','xterm.replay.done'),
    'storeSave':('store.save.enter','store.save.done'),
    'liveRefresh':('livebrief.refresh.enter','livebrief.refresh.done'),
    'liveBootstrap':('livebrief.bootstrap.enter','livebrief.bootstrap.done'),
    'liveTail':('livebrief.tail.enter','livebrief.tail.done'),
}


def derive(root):
    raw=json.loads((root/'stage3.json').read_bytes())
    result={'binarySha256':raw.get('binarySha256'),'groups':{},'startup':{},'idle':{},'slowKeys':{},'endurance':{}}
    for name,bucket in raw['measurements'].items():
        samples=bucket['samples'];fields=set().union(*(s.keys() for s in samples))
        result['groups'][name]={'n':len(samples),'metrics':{k:stats([s.get(k) for s in samples]) for k in sorted(fields) if any(isinstance(s.get(k),(int,float)) and not isinstance(s.get(k),bool) for s in samples)}}
    for name in [n for n in raw['measurements'] if n.startswith('S1_')]:
        component=defaultdict(list);concurrency=[];steady=[];crsm=defaultdict(list)
        for file in sorted(root.glob(name+'-*-startup.json')):
            d=json.loads(file.read_bytes());marks=d['entries']
            for key,(a,b) in COMPONENTS.items():component[key].extend(x['ms'] for x in pairs(marks,a,b))
            for item in pairs(marks,'crsm.list.enter','crsm.list.done'):crsm[str(item['id'])].append(item['ms'])
            events=[]
            for pair in pairs(marks,*COMPONENTS['ptySpawn']):events.extend([(pair['begin'],1),(pair['end'],-1)])
            current=peak=0
            for _,change in sorted(events):current+=change;peak=max(peak,current)
            concurrency.append(peak)
            points=d['steady'];windows=[]
            for a,b in zip(points,points[1:]):windows.append({'seconds':(b['time_ms']-a['time_ms'])/1000,'cpuMs':b['app']['cpu_ms']-a['app']['cpu_ms']})
            settled=None
            for i in range(2,len(windows)):
                if all(w['cpuMs']/w['seconds']<100 for w in windows[i-2:i+1]):
                    settled=points[i+1]['time_ms']-points[0]['app']['created']*1000
                    break
            steady.append({'file':str(file),'windows':windows,'startupCpuMs':points[0]['app']['cpu_ms'],'startupReadBytes':points[0]['app']['read_bytes'],
                           'steadyCriterion':'Three consecutive 10-second windows below 10 percent of one CPU core; operational threshold, not proof all background work stopped',
                           'steadyConfirmedAtMs':settled})
        result['startup'][name]={'componentsMs':{k:stats(v) for k,v in component.items()},'peakConcurrentPtySpawns':stats(concurrency),'steadyWindows':steady,'crsmOperationsMs':{k:stats(v) for k,v in crsm.items()}}
    for name,bucket in raw['measurements'].items():
        if not name.startswith('S2_') or name.startswith('S2_control_'):continue
        components=defaultdict(list);function_times=defaultdict(float);timers=defaultdict(lambda:{'fires':0,'created':0});coverage=[];webgl=[]
        for row in bucket['samples']:
            d=json.loads(Path(row['detailsFile']).read_bytes());start=d['before']['time_ms'];end=d['after']['time_ms']
            marks=[m for m in d['timeline'] if start<=m['atMs']<=end]
            for key,(a,b) in COMPONENTS.items():components[key].extend(x['ms'] for x in pairs(marks,a,b))
            profile_file=Path(row['detailsFile']).with_name(Path(row['detailsFile']).name.replace('-details.json','-profile.json'))
            profile=json.loads(profile_file.read_bytes());nodes={n['id']:n['callFrame'] for n in profile['nodes']}
            for sample,delta in zip(profile.get('samples',[]),profile.get('timeDeltas',[])):
                n=nodes[sample];key=(n.get('functionName',''),n.get('url',''),n.get('lineNumber',-1)+1,n.get('columnNumber',-1)+1)
                function_times[key]+=delta/1000
            for timer in d['timers']['timers']:
                key=(timer['kind'],str(timer.get('delay')),timer['stack']);timers[key]['fires']+=timer['fired'];timers[key]['created']+=timer['created']
            webgl.append({k:d['timers'].get(k) for k in ['webglCreated','webglLost','mountedXterms','visibleXterms']})
            f=Path(row['detailsFile']).parent/f"fake-{d['before']['app']['pid']}.json"
            if f.exists():
                for fake in json.loads(f.read_bytes()):
                    transcript=Path.home()/'.claude/projects/C--Users-miyaz--work-mycmux-perf3-260924-fixtures'/f"{fake['transcriptId']}.jsonl"
                    timestamps=[datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', json.loads(line)['timestamp']).replace('Z','+00:00')).timestamp()*1000 for line in transcript.read_text(encoding='utf-8').splitlines()]
                    inside=[t for t in timestamps if start<=t<=end]
                    coverage.append({'run':row['run'],'sessionId':fake['sessionId'],'linesDuringWindow':len(inside),'gapMs':stats([b-a for a,b in zip(inside,inside[1:])]),'firstAt':min(timestamps),'lastAt':max(timestamps),'windowStart':start,'windowEnd':end})
        result['idle'][name]={'componentsMs':{k:stats(v) for k,v in components.items()},'top20':[dict(function=k[0],file=k[1],line=k[2],column=k[3],selfMs=v) for k,v in sorted(function_times.items(),key=lambda x:x[1],reverse=True)[:20]],'timers':[dict(kind=k[0],delay=k[1],stack=k[2],**v) for k,v in sorted(timers.items(),key=lambda x:x[1]['fires'],reverse=True)],'syntheticCoverage':coverage,'webgl':webgl}
    for name in ['S3_L24','S3_L24S']:
        path=root/(name+'-slow-keys.json')
        if not path.exists():continue
        d=json.loads(path.read_bytes());rows=[]
        for sample in d['slow']:
            tasks=sample['tasks'];functions=[t for t in tasks if t['name']=='FunctionCall']
            rows.append({k:sample[k] for k in ['run','elapsedMs','keydownAt','paintedAt']}|{'largestOverlappingTask':tasks[0] if tasks else None,'functionCalls':functions,'causality':'temporal overlap only; not automatic attribution'})
        result['slowKeys'][name]={'threshold':d['threshold'],'keys':rows}
    for name,bucket in raw['measurements'].items():
        if not name.startswith('S8_'):continue
        rows=bucket['samples'];item={'n':len(rows)}
        if rows and 'before' in rows[0] and 'after' in rows[-1] and rows[0]['before']['native']['app']['pid']==rows[-1]['after']['native']['app']['pid']:
            item['firstToLast']={k:rows[-1]['after'][k]-rows[0]['before'][k] for k in ['ws','private','handles','threads','webviewWs','heap']}
            item['rafOver200']=sum(r.get('rafOver200',0) for r in rows)
        if name=='S8_continuous':item['samples']=rows
        if name=='S8_restart':item['samples']=rows
        result['endurance'][name]=item
    ha=root/'Ha-incremental-marks.json'
    if ha.exists():
        d=json.loads(ha.read_bytes());result['livebriefProbe']={'initialBytes':d['initialBytes'],'finalBytes':d['finalBytes'],'componentsMs':{k:stats(x['ms'] for x in pairs(d['marks'],*v)) for k,v in COMPONENTS.items() if k.startswith('live')},'byteReads':{name:stats(m['value'] for m in d['marks'] if m['name']==name and 'value' in m) for name in ['livebrief.bootstrap.bytes','livebrief.tail.bytes']}}
    text=json.dumps(result,ensure_ascii=True,indent=2)
    target=root/'stage3-summary.json';target.write_text(text,encoding='utf-8');assert target.read_text(encoding='utf-8')==text and '\ufffd' not in text
    print(json.dumps({'groups':{k:v['n'] for k,v in result['groups'].items()},'summary':str(target)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output-dir',required=True)
    derive(Path(parser.parse_args().output_dir))
