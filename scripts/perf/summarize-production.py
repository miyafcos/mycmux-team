"""Aggregate external observations without exposing evidence in the repository."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
from pathlib import Path
import statistics


def read_json(path):
    data = Path(path).read_bytes()
    return json.loads(data.decode('utf-16') if data[:2] in (b'\xff\xfe', b'\xfe\xff') else data.decode('utf-8-sig'))


def summary(values):
    values = sorted(x for x in values if isinstance(x, (int, float)))
    def percentile(p):
        if not values:
            return None
        pos = (len(values)-1)*p
        lo = int(pos)
        hi = min(lo+1, len(values)-1)
        return values[lo]+(values[hi]-values[lo])*(pos-lo)
    return dict(n=len(values), median=percentile(.5), p90=percentile(.9), p99=percentile(.99), max=max(values) if values else None)


def activity(row):
    response = row['activity']
    if 'error' in response:
        return 'unknown'
    tabs = [t for p in response.get('panes', []) for t in p.get('tabs', [])]
    # Any working agent OR output in the last 10 s counts as active.
    current = datetime.fromisoformat(row['time']).timestamp()*1000
    active = any(t.get('agentStatus') == 'working' or
                 isinstance(t.get('lastOutputAt'), (int, float)) and 0 <= current-t['lastOutputAt'] < 10000
                 for t in tabs)
    return 'active' if active else 'inactive'


def category(path):
    p = Path(path)
    if '.pre-replace-' in p.name:
        return 'data.json.pre-replace-*.bak'
    if p.parent.name in ('pane-sessions', 'scrollback'):
        return p.parent.name+'/*'
    return p.name


def aggregate(root):
    rows = [json.loads(line) for line in (root/'production-30min-v2.jsonl').open(encoding='utf-8')]
    samples = [r for r in rows if r['kind'] == 'process']
    start, end = rows[0], rows[-1]
    by_activity = defaultdict(list)
    for row in samples:
        if 'interval_seconds' in row['production']:
            label = activity(row)
            by_activity[label].append(row)
    metrics = {}
    fields = ('cpu_ms_delta', 'read_bytes_per_second', 'write_bytes_per_second', 'ws', 'private', 'handles', 'threads')
    for label in ('active', 'inactive', 'unknown'):
        selected = by_activity[label]
        metrics[label] = {key: summary([r['production'][key] for r in selected]) for key in fields}
        metrics[label]['cpu_ms_per_10s'] = summary([r['production']['cpu_ms_delta']/r['production']['interval_seconds']*10 for r in selected])
        metrics[label]['cpu_one_core_percent'] = summary([r['production']['cpu_ms_delta']/r['production']['interval_seconds']/10 for r in selected])
        metrics[label]['seconds'] = sum(r['production']['interval_seconds'] for r in selected)
    file_times = defaultdict(list)
    class_times = defaultdict(set)
    for row in rows:
        if row['kind'] != 'files':
            continue
        for item in row['changes']:
            if item['before'] is None or item['before'][0] != item['after'][0]:
                file_times[item['path']].append(row['elapsed'])
                class_times[category(item['path'])].add(row['elapsed'])
    frequencies = []
    for path, times in file_times.items():
        frequencies.append(dict(path=path, category=category(path), writes=len(times),
                                intervals_seconds=summary([b-a for a, b in zip(times, times[1:])]), times=times))
    frequencies.sort(key=lambda row: row['writes'], reverse=True)
    classes = []
    for name, values in class_times.items():
        times = sorted(values)
        classes.append(dict(category=name, seconds_with_write=len(times),
                            intervals_seconds=summary([b-a for a, b in zip(times, times[1:])]),
                            files=sum(category(p)==name for p in file_times)))
    classes.sort(key=lambda row: row['seconds_with_write'], reverse=True)
    names_path = root/'production-thread-names.json'
    names = {row['id']: row['name'] for row in read_json(names_path)} if names_path.exists() else {}
    address_path = root/'production-thread-addresses.json'
    addresses = {row['Id']: row['StartAddress'] for row in read_json(address_path)} if address_path.exists() else {}
    thread_intervals = defaultdict(list)
    for row in rows:
        if row['kind'] == 'threads':
            for thread in row['all']:
                thread_intervals[thread['id']].append(thread['cpu_ms_delta'])
                if thread.get('name'):
                    names[thread['id']] = thread['name']
    thread_totals = [dict(id=tid, name=names.get(tid), startAddress=addresses.get(tid),
                          totalCpuMs=sum(values), delta30s=summary(values),
                          nameSource='in-sample or end-of-observation read-only GetThreadDescription')
                     for tid, values in thread_intervals.items()]
    thread_totals.sort(key=lambda row: row['totalCpuMs'], reverse=True)
    web = {}
    for label in ('active','inactive','unknown'):
        groups = defaultdict(lambda: defaultdict(list))
        for row in by_activity[label]:
            types = defaultdict(list)
            for view in row['webviews']:
                types[('production' if view['production_descendant'] else 'other', view['type'])].append(view)
            for (scope, kind), values in types.items():
                group = groups[scope+'/'+kind]
                group['count'].append(len(values))
                group['ws'].append(sum(v['ws'] for v in values))
                group['cpu_ms_per_10s'].append(sum(v.get('cpu_ms_delta',0) for v in values)/row['production']['interval_seconds']*10)
        web[label] = {group: {key: summary(values) for key,values in data.items()} for group,data in groups.items()}
    per_pid = defaultdict(list)
    for row in samples:
        for view in row['webviews']:
            if view['production_descendant']:
                per_pid[view['pid']].append(view)
    web_pids = [dict(pid=pid,parent=values[-1]['parent'],type=values[-1]['type'],
                    userDataDir=values[-1]['user_data_dir'],webviewExeName=values[-1]['webview_exe_name'],
                    cpuDeltaMs=sum(v.get('cpu_ms_delta',0) for v in values),ws=summary([v['ws'] for v in values]))
                for pid,values in per_pid.items()]
    web_pids.sort(key=lambda row:row['cpuDeltaMs'],reverse=True)
    result = dict(start=start,end=end,completed=end['kind']=='complete',samples=len(samples),
                  activity=metrics,webviews=web,webviewPids=web_pids,threadTop10=thread_totals[:10],
                  threads=thread_totals,fileCategories=classes,fileFrequencies=frequencies,
                  observerCpuMs=samples[-1]['observer']['cpu_ms']-samples[0]['observer']['cpu_ms'],
                  scanMs=summary([r['scan_ms'] for r in rows if r['kind']=='files']),
                  scanCount=sum(r['kind']=='files' for r in rows),
                  activityDefinition='Any working agent or any output less than 10 seconds old; unknown is never called inactive')
    pdh_path = root/'production-pdh.jsonl'
    if pdh_path.exists():
        raw=pdh_path.read_bytes()
        text=raw.decode('utf-16') if raw[:2] in (b'\xff\xfe',b'\xfe\xff') else raw.decode('utf-8-sig')
        pdh=[json.loads(line) for line in text.splitlines() if line.strip()]
        verified=[r for r in pdh if any(s['Path'].lower().endswith('\\id process') and int(s['CookedValue'])==start['production']['pid'] for s in r['samples'])]
        result['pdh']={'samples':len(pdh),'verifiedPidSamples':len(verified),'start':pdh[0]['timestamp'],'end':pdh[-1]['timestamp'],
          'readBytesPerSecond':summary([s['CookedValue'] for r in verified for s in r['samples'] if s['Path'].lower().endswith('\\io read bytes/sec')]),
          'writeBytesPerSecond':summary([s['CookedValue'] for r in verified for s in r['samples'] if s['Path'].lower().endswith('\\io write bytes/sec')]),
          'scope':'Process I/O includes files, pipes and other devices; it is not physical disk throughput'}
    text=json.dumps(result,ensure_ascii=True,indent=2)
    path=root/'production-summary.json';path.write_text(text,encoding='utf-8')
    assert path.read_text(encoding='utf-8')==text and '\ufffd' not in text
    print(json.dumps({k:result[k] for k in ['completed','samples','activity','threadTop10','scanMs']},ensure_ascii=True))


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output-dir',required=True)
    aggregate(Path(parser.parse_args().output_dir))
