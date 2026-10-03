"""M1 W9-W11: real saved state, GUI close and caller-window socket spawn."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from mycmux_e2e import App
from mac_tearout import ROOT, OUT, SEAT, STATE, js, wait, launch, stop, fixture, pointer_start, moving_window, pump, clocks, hosts, identity


def materialize_layout_defaults(app, label='main'):
    # Fully specified real store state makes restart comparisons exact. The
    # source fixture already has weighted columns and divider pins.
    js(app,r'''
const list=window.__mycmuxE2E.stores.workspaceList.getState();
list._replaceWorkspaces(list.workspaces.map(workspace=>{
  const columns=workspace.splitColumns??workspace.panes.map(pane=>[pane.id]);
  return {...workspace,columnWidths:workspace.columnWidths??columns.map(()=>1/columns.length),
    rowHeightsPerCol:workspace.rowHeightsPerCol??columns.map(column=>column.map(()=>1/column.length)),
    columnDividerPins:workspace.columnDividerPins??Array(Math.max(0,columns.length-1)).fill(false),
    rowDividerPinsPerCol:workspace.rowDividerPinsPerCol??columns.map(column=>Array(Math.max(0,column.length-1)).fill(false))};
})); return true;
''',label)


def kept(app, regions, kind):
    arranged = fixture(app, regions, True)
    materialize_layout_defaults(app)
    source = arranged['source']
    all_tabs = [tab for pane in source['panes'] for tab in pane['tabs']]
    tabs = all_tabs[-1:] if kind == 'pane' else all_tabs
    wait(app, lambda: any(not row.get('visible') and row['label'].startswith('mycmux-w') for row in app.windows()), 'ready spare')
    pointer_start(app, source, kind, tabs)
    moving = moving_window(app, tabs)
    move_id = wait(app, lambda: js(app, 'return [...window.__mycmuxE2E.nativeTearout.records.keys()][0]??null;'), 'native record')
    pump(app, move_id, moving['label'], 'main')
    wait(app, lambda: js(app, 'return window.__mycmuxE2E.nativeTearout.records.size;') == 0, 'kept transfer settled')
    wait(app, lambda: all(value and value[0][0] == moving['label'] for value in hosts(app,tabs).values()), 'child ownership')
    return arranged, tabs, moving['label']


def persisted_shape(state):
    fields = ('id','name','gridTemplateId','splitColumns','columnWidths','rowHeightsPerCol','columnDividerPins','rowDividerPinsPerCol','detached','detachedFrom')
    return [{**{key: workspace[key] for key in fields if key in workspace},
        'panes': [{'id':pane['id'],'activeTabId':pane['activeTabId'],'pinnedTabId':pane.get('pinnedTabId'),
            'tabs':[{'id':tab['id'],'label':tab.get('label'),'type':tab.get('type')} for tab in pane['tabs']]} for pane in workspace['panes']]}
        for workspace in state['workspaces']]


def restart(app, out):
    log = str(out/'restart.log')
    subprocess.run(['open','-n','-g','-a',str(app.bundle),'--env','MYCMUX_PROFILE_ACTIVATION=accessory',
        '--stdout',log,'--stderr',log,'--args','--profile',app.profile], check=True)
    wait(app, app._socket_ready, 'restarted test socket',45)
    wait(app, lambda: js(app,'return !!window.__mycmuxE2E?.nativeTearout;'), 'restarted hooks',30)
    assert not any(row.get('applicationActive') for row in app.windows()), 'restart activated test app'


def run(app, mode, out):
    launch(app, out)
    if mode=='restart':
        arranged,tabs,label=kept(app,2,'workspace')
        wait(app,lambda: clocks(app,tabs,label), 'all live child PTYs')
        windows=app.windows()
        before={row['label']:persisted_shape(js(app,STATE,row['label'])) for row in windows if row.get('visible')}
        geometry={row['label']:{key:row[key] for key in ('x','y','width','height')} for row in windows if row.get('visible')}
        quit_result=app.menu_key('q',['command'],200)
        app.wait_exit(25)
        root=Path.home()/f'Library/Application Support/com.miyazaki.mycmux.e2e.{SEAT}/profiles'/app.profile
        data=json.loads((root/'data.json').read_text())
        restart(app,out)
        def restored():
            rows=[row for row in app.windows() if row.get('visible')]
            if {row['label'] for row in rows} != set(before): return None
            observed={row['label']:persisted_shape(js(app,STATE,row['label'])) for row in rows}
            return observed if observed==before else None
        try:
            after=wait(app,restored,'all window groups and layouts restored',12)
        except Exception:
            rows=[row for row in app.windows() if row.get('visible')]
            observed={row['label']:persisted_shape(js(app,STATE,row['label'])) for row in rows}
            failure={'before':before,'after':observed,'geometry_before':geometry,
                'windows_after':rows,'saved_workspaces':data.get('workspaces',[]),
                'data_path':str(root/'data.json')}
            (out/'restart-failure.json').write_text(json.dumps(failure,indent=2)+'\n',encoding='utf-8')
            raise AssertionError('W9 expected visible windows '+str(sorted(before))
                +'; observed '+str(sorted(observed))+'; see '+str(out/'restart-failure.json'))
        positions={row['label']:{key:row[key] for key in ('x','y','width','height')} for row in app.windows() if row.get('visible')}
        for key in geometry:
            for dimension in geometry[key]:
                assert abs(positions[key][dimension]-geometry[key][dimension])<=1,(geometry,positions)
        return {'before':before,'after':after,'geometry_before':geometry,'geometry_after':positions,'data_path':str(root/'data.json'),'saved_workspaces':data.get('workspaces',[]),'quit':quit_result}
    arranged,tabs,label=kept(app,1,'pane')
    before=clocks(app,tabs,label)
    if mode=='spawn':
        spawned=app.call('pane.spawn_tab',{'anchorSessionId':tabs[-1]['sessionId'],'activate':False,
            'label':'M1-caller-child-spawn','commandArgv':['/bin/sh','-c','while :; do printf "M1SPAWN %s\n" "$$"; sleep 0.1; done']})
        session=spawned['sessionId']
        def locations():
            result=[]
            for row in app.windows():
                if not row.get('visible'): continue
                for workspace in app.workspaces(row['label']):
                    for pane in workspace['panes']:
                        for tab in pane['tabs']:
                            if tab['sessionId']==session: result.append(row['label'])
            return result
        observed=wait(app,lambda:locations() or None,'spawn location',15)
        assert observed==[label],(spawned,observed,label)
        assert clocks(app,tabs,label)[tabs[-1]['id']]['pid']==before[tabs[-1]['id']]['pid']
        return {'spawn':spawned,'locations':observed,'caller_window':label,'caller_before':before}
    number=identity(app,label)
    js(app,"const el=document.querySelector('[data-native-pane-shell] > div > button');if(!el) throw new Error('native shell close button missing');el.click();return true;",label)
    # The application uses its real in-app confirmation queue. Answer only the
    # dialog in this checked test window, without OS pointer/key injection.
    def closed():
        if identity(app,label)!=number: return True
        try:
            js(app,"const el=document.querySelector('[role=dialog] button[data-action=confirm], [role=dialog] button:last-child');if(el) el.click();return true;",label)
        except Exception:
            pass
        return False
    wait(app,closed,'native shell close retired its WindowServer identity',20)
    alive=js(app,'return await window.__TAURI_INTERNALS__.invoke("is_session_alive",'+json.dumps({'sessionId':tabs[-1]['sessionId']})+');')
    assert alive is False, ('closed session survived',tabs[-1]['sessionId'])
    pid=before[tabs[-1]['id']]['pid']
    p=subprocess.run(['ps','-p',pid,'-o','command='],capture_output=True,text=True)
    assert p.returncode!=0,('clock process survived close',pid,p.stdout)
    remaining=app.workspaces()
    assert any(workspace['id']==arranged['source']['id'] for workspace in remaining),'neighbor workspace was closed'
    return {'window':label,'window_number':number,'session_alive':alive,'pid':pid,'remaining':remaining}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--case',choices=['restart','close','spawn'],required=True)
    args=parser.parse_args()
    bundle=args.bundle.resolve()
    assert OUT.resolve() in bundle.parents
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out=OUT/('lifecycle-'+args.case+'-'+stamp)
    out.mkdir(parents=True)
    app=App(SEAT+'life'+stamp+args.case,bundle)
    result={'case':args.case,'bundle':str(bundle),'binary_sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest(),'profile':app.profile}
    try:
        result['evidence']=run(app,args.case,out)
        result['passed']=True
    except Exception as error:
        result.update(passed=False,error=str(error))
    finally:
        try: stop(app)
        except Exception as error: result.update(passed=False,cleanup_error=str(error))
    result['remaining_pids']=app.pids()
    (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print('M1_LIFECYCLE',args.case,result.get('passed'),result.get('error',''),str(out/'summary.json'),flush=True)
    return 0 if result.get('passed') and not result['remaining_pids'] else 1


if __name__=='__main__': raise SystemExit(main())
