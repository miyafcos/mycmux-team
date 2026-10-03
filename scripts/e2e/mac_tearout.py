"""37 sequential S4 Mac cases; fresh profiles and app-local synthetic input.

No physical pointer/key injection, production app manipulation or file deletion.
The same stores, drag entry, live serializers, native opacity and receipt path as
the UI are exercised. OS modal dragging and physical feel are explicitly outside
what synthetic events can certify.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from mycmux_e2e import App

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/tearout-s4'
STATE = r"""
const h=window.__mycmuxE2E, list=h.stores.workspaceList.getState(), ui=h.stores.ui.getState();
return {workspaces:list.workspaces,activeWorkspace:list.activeWorkspaceId,activeSession:ui.activePaneId,
  zoom:ui.zoomedPaneId,remembered:list.lastActivePaneByWorkspace};
"""


def js(app, code, label='main'):
    return app.eval(code, label, timeout_ms=24000)


def wait(app, callback, what, timeout=20):
    return app.wait_until(callback, timeout, what, 0.05)


def launch(app, out):
    assert not app.runtime_dir.exists(), app.runtime_dir
    assert str(app.bundle.resolve()).startswith(str(OUT.resolve()) + '/'), app.bundle
    env = {key: value for key, value in os.environ.items() if not key.startswith(('MYCMUX_', 'CLAUDE'))}
    env['MYCMUX_PROFILE_ACTIVATION'] = 'accessory'
    with (out / 'launch.log').open('wb') as stream:
        subprocess.Popen([str(app.binary), '--profile', app.profile], env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    wait(app, app._socket_ready, 'test socket', 45)
    wait(app, lambda: js(app, 'return !!window.__mycmuxE2E?.nativeTearout;'), 'test-only hooks', 30)
    assert js(app, 'return await window.__TAURI_INTERNALS__.invoke("get_test_profile");') == app.profile
    assert app.pids(), 'no test process'
    assert not any(window.get('applicationActive') for window in app.windows()), 'test app activated'


def stop(app):
    if not app.pids(): return
    try:
        app.terminate(200)
        app.wait_exit(15)
    except Exception:
        # The exact bundle/profile has been checked above. This never kills the
        # production mycmux or any other seat's bundle.
        for pid in app.pids():
            command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
            assert command.startswith(str(app.binary) + ' --profile ' + app.profile), command
        app.kill()
        app.wait_exit(10)


def fixture(app, regions, enabled):
    workspace = app.call('workspace.new', {'name': 'S4-source', 'grid': '1x1', 'cwd': str(ROOT)})
    source_id = workspace['workspaceId']
    source = next(item for item in app.workspaces() if item['id'] == source_id)
    anchor = source['panes'][0]['tabs'][0]['sessionId']
    for index in range(regions * 2):
        spawned = app.call('pane.spawn_tab', {'anchorSessionId': anchor, 'activate': False,
            'label': f'S4-clock-{index}', 'commandArgv': ['/bin/sh', '-c',
                'i=0; while :; do i=$((i+1)); printf "S4CLOCK %s %s\\n" "$$" "$i"; sleep 0.1; done']})
        anchor = spawned.get('sessionId', anchor)
    result = js(app, f"""
const h=window.__mycmuxE2E, list=h.stores.workspaceList.getState();
h.stores.settings.getState().setNativePaneTearoutEnabled({str(enabled).lower()});
const source=list.getWorkspace({json.dumps(source_id)}), all=source.panes.flatMap(p=>p.tabs);
const tabs=all.filter(t=>t.type==='terminal'), launcher=all.find(t=>t.type==='launcher');
if(tabs.length!=={regions*2}||!launcher) throw new Error('S4 live fixture missing');
const receiverPane={{...source.panes[0],id:crypto.randomUUID(),tabs:[launcher],activeTabId:launcher.id,sessionId:launcher.sessionId}};
const receiver=list.createWorkspace('S4-receiver','1x1',[receiverPane],[[receiverPane.id]],{{activate:false}});
const panes=Array.from({{length:{regions}}},(_,i)=>({{...source.panes[0],id:i===0?source.panes[0].id:crypto.randomUUID(),
  tabs:tabs.slice(i*2,i*2+2),activeTabId:tabs[i*2+1].id,sessionId:tabs[i*2+1].sessionId,pinnedTabId:tabs[i*2].id}}));
const arranged={{...source,panes,splitColumns:panes.map(p=>[p.id]),columnWidths:{regions}===1?[1]:[.35,.65],
  rowHeightsPerCol:panes.map(()=>[1]),columnDividerPins:{regions}===1?[]:[true],rowDividerPinsPerCol:panes.map(()=>[])}};
list._replaceWorkspaces(h.stores.workspaceList.getState().workspaces.map(w=>w.id===source.id?arranged:w));
list.setActiveWorkspace(source.id); h.stores.ui.getState().setActivePaneId(panes.at(-1).sessionId);
return {{source:arranged,receiver:h.stores.workspaceList.getState().getWorkspace(receiver.id)}};
""")
    time.sleep(0.5)
    return result


def clocks(app, tabs, label):
    result = {}
    for tab in tabs:
        lines = js(app, f'return await window.__mycmuxE2E.readPaneTail({json.dumps(tab["sessionId"])},120,true);', label)
        matches = [re.search(r'S4CLOCK (\d+) (\d+)', line) for line in lines]
        values = [(match.group(1), int(match.group(2))) for match in matches if match]
        assert values, (tab['id'], lines[-5:])
        result[tab['id']] = {'session': tab['sessionId'], 'pid': values[-1][0], 'clock': values[-1][1]}
    return result


def assert_live(before, after):
    assert before.keys() == after.keys()
    for tab_id in before:
        assert before[tab_id]['session'] == after[tab_id]['session'], tab_id
        assert before[tab_id]['pid'] == after[tab_id]['pid'], tab_id
        assert after[tab_id]['clock'] > before[tab_id]['clock'], (before, after)


def assert_layout(state, source, receiver, tabs, case):
    ids = [tab['id'] for tab in tabs]
    owned = next(workspace for workspace in state['workspaces'] if any(tab['id'] in ids for pane in workspace['panes'] for tab in pane['tabs']))
    observed = [tab['id'] for pane in owned['panes'] for tab in pane['tabs'] if tab['id'] in ids]
    assert observed == ids, (ids, observed)
    name = case['destination']
    if name == 'esc': return
    assert state['activeSession'] == tabs[-1]['sessionId'], state
    selected = next(pane for pane in owned['panes'] if any(tab['id'] == ids[-1] for tab in pane['tabs']))
    assert selected['activeTabId'] == ids[-1], selected
    if name in ('strip', 'center'):
        assert owned['id'] == receiver['id'] and selected['id'] == receiver['panes'][0]['id'], owned
        assert len(owned['panes']) == 1, owned
    elif name in ('left', 'right', 'up', 'down'):
        assert owned['id'] == receiver['id'] and len(owned['panes']) == 2, owned
        assert [tab['id'] for tab in selected['tabs']] == ids, selected
        columns = owned['splitColumns']
        old = receiver['panes'][0]['id']
        if name in ('left', 'right'):
            assert len(columns) == 2 and all(len(column) == 1 for column in columns), columns
            assert columns[0 if name == 'left' else 1] == [selected['id']], columns
            assert columns[1 if name == 'left' else 0] == [old], columns
        else:
            assert columns == [[selected['id'], old] if name == 'up' else [old, selected['id']]], columns
    if name in ('keep', 'sidebar'):
        assert [tab['id'] for pane in owned['panes'] for tab in pane['tabs']] == ids, owned
        expected_regions = case['regions'] if case['kind'] == 'workspace' else 1
        assert len(owned['panes']) == expected_regions, owned
        if expected_regions > 1:
            for field in ('splitColumns', 'columnWidths', 'rowHeightsPerCol', 'columnDividerPins', 'rowDividerPinsPerCol'):
                assert owned[field] == source[field], (field, owned[field], source[field])
    if name in ('keep', 'sidebar', 'left', 'right', 'up', 'down') and case['kind'] != 'pane' and case.get('regrab') != 'pill':
        for pane in owned['panes']:
            moved = [tab for tab in pane['tabs'] if tab['id'] in ids]
            if len(moved) >= 2:
                assert pane.get('pinnedTabId') == moved[0]['id'], pane


def hosts(app, tabs):
    fragments = js(app, 'return await window.__TAURI_INTERNALS__.invoke("get_window_fragments");')
    answer = {tab['id']: [] for tab in tabs}
    for fragment in fragments:
        for workspace in fragment.get('workspaces', []):
            for pane in workspace.get('panes', []):
                for tab in pane.get('tabs', []):
                    if tab.get('tab_id') in answer:
                        answer[tab['tab_id']].append((fragment['window_label'], tab.get('session_id')))
    return answer


def pointer_start(app, source, kind, tabs, label='main', entry='default'):
    return js(app, f"""
const h=window.__mycmuxE2E, source={json.dumps(source)}, kind={json.dumps(kind)}, entry={json.dumps(entry)};
const send=(type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{{bubbles:true,cancelable:true,
  pointerId:41,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y}}));
let el,x,y,endX,endY;
if(kind==='workspace') {{
  el=[...document.querySelectorAll('[data-dnd-workspace-target-id]')].find(el=>el.dataset.dndWorkspaceTargetId===source.id);
  if(!el) throw new Error('S4 workspace row missing');
  const r=el.getBoundingClientRect(), sidebar=el.closest('[data-dnd-workspace-sidebar=true]').getBoundingClientRect();
  x=r.left+8;y=r.top+r.height*.5;endX=sidebar.right+13;endY=y;
}} else {{
  const region=[...document.querySelectorAll('[data-dnd-pane-id]')].find(el=>el.dataset.dndPaneId===source.panes.at(-1).id);
  if(!region) throw new Error('S4 region missing');
  const strip=region.querySelector('.pane-tabbar'), r=strip.getBoundingClientRect();
  y=r.top+r.height*.5;endY=r.bottom+13;
  if(kind==='pane'||entry==='pill') {{
    el=region.querySelector('[data-tab-id='+CSS.escape({json.dumps(tabs[-1]['id'])})+']');
    const grip=el.getBoundingClientRect();x=grip.left+grip.width*.5;
  }} else {{
    for(x=r.right-80;x>r.left;x-=4) {{
      const hit=document.elementFromPoint(x,y);
      if(hit&&hit.closest('.pane-tabbar')===strip&&!hit.closest('button,input,textarea,select,[data-tab-id]')) {{el=hit;break;}}
    }}
    if(!el) throw new Error('S4 group whitespace missing');
  }}
  endX=x;
}}
send('pointerdown',el,x,y);send('pointermove',window,endX,endY);
return true;
""", label)


def moving_window(app, tabs, source='main'):
    ids = {tab['id'] for tab in tabs}
    def find():
        for window in app.windows():
            if window['label'] == source or not window.get('visible'): continue
            owned = app.workspaces(window['label'])
            if ids.issubset({tab['id'] for ws in owned for pane in ws['panes'] for tab in pane['tabs']}):
                return window
        return None
    return wait(app, find, 'unique visible live receiver', 25)


def identity(app, label):
    try:
        return js(app, 'return await window.__TAURI_INTERNALS__.invoke("tearout_synthetic_sample",' + json.dumps({
            'id': 's4-identity', 'label': label, 'receiver': None, 'clientX': -1, 'clientY': -1,
            'phase': 'identity', 'escaped': False}) + ');')['window_number']
    except Exception:
        return None


def destination(app, receiver, name):
    js(app, f'window.__mycmuxE2E.stores.workspaceList.getState().setActiveWorkspace({json.dumps(receiver["id"])});return true;')
    time.sleep(0.2)
    return js(app, f"""
const receiver={json.dumps(receiver)},name={json.dumps(name)};
if(name==='sidebar') {{const r=document.querySelector('[data-dnd-workspace-sidebar=true]').getBoundingClientRect();return {{x:r.left+8,y:r.top+12}};}}
const el=[...document.querySelectorAll('[data-dnd-pane-id]')].find(el=>el.dataset.dndPaneId===receiver.panes[0].id),r=el.getBoundingClientRect();
if(name==='strip') {{const p=el.querySelector('[data-tab-id]').getBoundingClientRect();return {{x:p.left+1,y:p.top+p.height*.5}};}}
return {{center:{{x:r.left+r.width*.5,y:r.top+r.height*.5}},left:{{x:r.left+5,y:r.top+r.height*.5}},
  right:{{x:r.right-5,y:r.top+r.height*.5}},up:{{x:r.left+r.width*.5,y:r.top+42}},down:{{x:r.left+r.width*.5,y:r.bottom-5}}}}[name];
""")


def pump(app, move_id, label, source, receiver=None, point=None, escaped=False):
    arguments = {'id': move_id, 'label': label, 'sourceLabel': source, 'receiver': receiver,
                 'clientX': (point or {}).get('x', -1), 'clientY': (point or {}).get('y', -1),
                 'phase': 'move', 'escaped': False}
    hover = js(app, f"""
const args={json.dumps(arguments)},api=window.__TAURI_INTERNALS__,begin=Date.now();let last;
while(Date.now()-begin<450) {{last=await api.invoke('tearout_synthetic_sample',args);await new Promise(r=>window.setTimeout(r,8));}}
return last;
""", source)
    arguments.update(phase='end', escaped=escaped)
    end = js(app, f'return await window.__TAURI_INTERNALS__.invoke("tearout_synthetic_sample",{json.dumps(arguments)});', source)
    return {'hover': hover, 'end': end}


def cases():
    result = [{'kind': kind, 'destination': 'keep', 'off': True, 'regions': 1} for kind in ('pane', 'tab', 'workspace')]
    for kind in ('pane', 'tab', 'workspace'):
        for name in ('keep', 'esc', 'strip', 'center', 'left', 'right', 'up', 'down', 'sidebar'):
            result.append({'kind': kind, 'destination': name, 'regions': 1})
    for name in ('keep', 'esc', 'sidebar'):
        result.append({'kind': 'workspace', 'destination': name, 'regions': 2})
    result += [
        {'kind': 'tab', 'destination': 'sidebar', 'regions': 1, 'regrab': 'band'},
        {'kind': 'workspace', 'destination': 'sidebar', 'regions': 2, 'regrab': 'band'},
        {'kind': 'tab', 'destination': 'center', 'regions': 1, 'regrab': 'whitespace'},
        {'kind': 'tab', 'destination': 'left', 'regions': 1, 'regrab': 'pill'},
    ]
    assert len(result) == 37
    return result


def run_case(app, case, out):
    launch(app, out)
    initial = js(app, 'const s=window.__mycmuxE2E.stores.settings.getState();return {generic:s.nativePaneTearoutEnabled,mac:s.macNativePaneTearoutEnabled};')
    arranged = fixture(app, case['regions'], not case.get('off'))
    source, receiver = arranged['source'], arranged['receiver']
    before_state = js(app, STATE)
    all_tabs = [tab for pane in source['panes'] for tab in pane['tabs']]
    tabs = all_tabs[-1:] if case['kind'] == 'pane' else source['panes'][-1]['tabs'] if case['kind'] == 'tab' else all_tabs
    before = clocks(app, tabs, 'main')
    if case.get('off'):
        # Exercise the legacy production commit directly; the new switch must
        # neither create a spare nor record a native transaction while OFF.
        item = {'kind': 'tab', 'workspaceId': source['id'], 'paneId': source['panes'][-1]['id'], 'tabId': tabs[-1]['id'], 'label': 'S4'} if case['kind'] == 'pane' else {
            'kind': 'pane', 'workspaceId': source['id'], 'paneId': source['panes'][-1]['id'], 'label': 'S4', 'tabCount': len(tabs)}
        if case['kind'] == 'workspace':
            js(app, f'return await window.__mycmuxE2E.tearOutWorkspaceToNewWindow({json.dumps(source["id"])},{{x:700,y:300}});')
        else:
            js(app, f'window.__mycmuxE2E.legacyDrop({json.dumps(item)},{{kind:"new-window",screenX:700,screenY:300}});return true;')
        moving = moving_window(app, tabs)
        after = clocks(app, tabs, moving['label'])
        assert_live(before, after)
        assert js(app, 'return window.__mycmuxE2E.nativeTearout.records.size;') == 0
        return {'initial': initial, 'before': before, 'after': after, 'legacy_label': moving['label']}
    wait(app, lambda: any(not row.get('visible') and row['label'].startswith('mycmux-w') for row in app.windows()), 'hidden spare', 20)
    pointer_start(app, source, case['kind'], tabs)
    moving = moving_window(app, tabs)
    label = moving['label']
    window_number = identity(app, label)
    assert window_number is not None
    during = clocks(app, tabs, label)
    assert_live(before, during)
    selected_session = tabs[-1]['sessionId']
    read_writes = lambda: js(app, 'return window.__mycmuxE2E.terminals.writes.get(' + json.dumps(selected_session) + ')??0;', label)
    writes_before = read_writes()
    writes_during = wait(app, lambda: (value if (value := read_writes()) > writes_before else None), 'live terminal writes during the pending drag', 8)
    move_id = wait(app, lambda: js(app, 'return [...window.__mycmuxE2E.nativeTearout.records.keys()][0]??null;'), 'native transfer record')
    if case.get('regrab'):
        pump(app, move_id, label, 'main')
        wait(app, lambda: js(app, 'return window.__mycmuxE2E.nativeTearout.records.size;') == 0, 'initial keep settled')
        if case['regrab'] == 'band':
            js(app, 'const el=document.querySelector("[data-native-pane-shell]").firstElementChild;const r=el.getBoundingClientRect();const send=(type,target,x)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:42,button:0,buttons:1,clientX:x,clientY:r.top+12}));send("pointerdown",el,r.left+20);send("pointermove",window,r.left+40);return true;', label)
        else:
            child = js(app, STATE, label)['workspaces'][0]
            if case['regrab'] == 'pill': tabs = tabs[-1:]
            pointer_start(app, child, 'pane' if case['regrab'] == 'pill' else 'tab', tabs, label, case['regrab'])
        move_id = wait(app, lambda: js(app, 'return [...window.__mycmuxE2E.nativeTearout.records.keys()][0]??null;', label), 'regrab record')
        if case['regrab'] == 'pill':
            moving = moving_window(app, tabs, label)
            label = moving['label']
        window_number = identity(app, label)
    name = case['destination']
    point = destination(app, receiver, name) if name not in ('keep', 'esc') else None
    owner = moving['label'] if case.get('regrab') and case['regrab'] != 'pill' else 'main'
    if case.get('regrab') and case['regrab'] == 'pill':
        owner = wait(app, lambda: next((row['label'] for row in app.windows() if row['label'] not in ('main', label) and row.get('visible')), None), 'pill source')
    probe = pump(app, move_id, label, owner, 'main' if point else None, point, name == 'esc')
    if point:
        assert probe['end']['approval'], probe
        assert probe['hover']['alpha_calls'] == 1 and probe['end']['alpha_calls'] == 2, probe
    expected_label = label if name == 'keep' else 'main'
    wait(app, lambda: all(rows == [(expected_label, next(tab['sessionId'] for tab in tabs if tab['id'] == tab_id))]
        for tab_id, rows in hosts(app, tabs).items()), 'only the expected window owns each transported session', 25)
    if name != 'keep': wait(app, lambda: identity(app, label) != window_number, 'retired original native window and WebView', 20)
    if name == 'esc':
        observed_state = js(app, STATE)
        (out / 'esc-state.json').write_text(json.dumps({'before': before_state, 'after': observed_state}, indent=2) + '\n', encoding='utf-8')
        assert observed_state == before_state, 'Esc did not restore the complete source state'
    after = clocks(app, tabs, expected_label)
    final_state = js(app, STATE, expected_label)
    assert_layout(final_state, source, receiver, tabs, case)
    # Read the same subset after an individual-pill regrab.
    assert_live({tab['id']: before[tab['id']] for tab in tabs}, after)
    records = wait(app, lambda: [json.loads(line) for line in (app.runtime_dir / 'tearout-log.jsonl').read_text().splitlines()] if (app.runtime_dir / 'tearout-log.jsonl').exists() else None, 'persistent drag log')
    expected = 'kept_window' if name == 'keep' else 'esc_cancelled' if name == 'esc' else 'docked'
    record = wait(app, lambda: next((json.loads(line) for line in (app.runtime_dir / 'tearout-log.jsonl').read_text().splitlines() if json.loads(line)['drag_id'] == move_id), None), 'terminal record')
    assert record['result'] == expected and not record['errors'], record
    assert record['session_id_equal'] and not record['focus_stolen'], record
    assert record['native_started_at'] is None, 'synthetic sample mislabeled as physical OS dragging'
    if name == 'keep': app.snapshot(out / 'kept.png', label)
    elif point: app.snapshot(out / 'docked.png')
    return {'initial': initial, 'before': before, 'during': during, 'after': after, 'source_state': before_state, 'final_state': final_state, 'writes_before': writes_before, 'writes_during': writes_during, 'native_window_number': window_number, 'probe': probe, 'record': record, 'windows': app.windows()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--case', type=int)
    args = parser.parse_args()
    assert sys.platform == 'darwin' and str(ROOT) == '/Users/edu/Developer/mycmux-wt-next-s4-261003'
    bundle = args.bundle.resolve()
    assert OUT.resolve() in bundle.parents and bundle.is_dir(), bundle
    stamp = datetime.now(timezone.utc).strftime('%m%d%H%M%S')
    run = OUT / ('matrix-' + stamp)
    run.mkdir(parents=True, exist_ok=False)
    summary = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'binary_sha256': hashlib.sha256((bundle / 'Contents/MacOS/mycmux').read_bytes()).hexdigest(),
        'bundle': str(bundle), 'results': [], 'total': 37}
    for index, case in enumerate(cases()):
        if args.case is not None and index != args.case: continue
        profile = f's4n{stamp}{index:02}'
        out = run / f'{index:02}'
        out.mkdir()
        app = App(profile, bundle)
        row = {'index': index, 'case': case, 'profile': profile}
        print('MAC_CASE_START ' + json.dumps(row), flush=True)
        try:
            row['evidence'] = run_case(app, case, out)
            row['passed'] = True
        except Exception as error:
            row.update(passed=False, error=str(error))
        finally:
            try: stop(app)
            except Exception as error: row.update(passed=False, cleanup_error=str(error))
        row['remaining_pids'] = app.pids()
        assert not row['remaining_pids'], row
        summary['results'].append(row)
        summary['passed'] = sum(item['passed'] for item in summary['results'])
        (run / 'summary.json').write_text(json.dumps(summary, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
        print('MAC_CASE_RESULT ' + json.dumps(row), flush=True)
        if not row['passed']: return 1
    print(f"MAC_MATRIX {summary['passed']}/{len(summary['results'])}", flush=True)
    return 0


if __name__ == '__main__': raise SystemExit(main())
