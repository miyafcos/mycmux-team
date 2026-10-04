"""Additional W9 cases: all tear-out kinds, grouping, screen loss, downgrade."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from mycmux_e2e import App
from mac_tearout import ROOT, OUT, SEAT, STATE, js, wait, launch, stop, fixture, moving_window
from mac_tearout_lifecycle import kept, persisted_shape, restart, materialize_layout_defaults


def observe(app):
    return {row['label']: {'shape':persisted_shape(js(app,STATE,row['label'])),
        'frame':{key:row[key] for key in ('x','y','width','height')},
        'native_child':js(app,'return window.__mycmuxE2E.nativeTearout.isTearoutChild();',row['label'])}
        for row in app.windows() if row.get('visible')}


def data_path(profile):
    return Path.home()/f'Library/Application Support/com.miyazaki.mycmux.e2e.{SEAT}/profiles'/profile/'data.json'


def saved_quit(app):
    app.menu_key('q',['command'],200)
    app.wait_exit(25)
    return json.loads(data_path(app.profile).read_text(encoding='utf-8'))


def all_tab_ids(data):
    return sorted(tab['tab_id'] for workspace in data['workspaces'] for pane in workspace['panes'] for tab in pane.get('tabs',[]))


def run(app, case, out, old_bundle):
    launch(app,out)
    kind=case if case in ('pane','tab','workspace') else 'workspace'
    if case=='ordinary':
        arranged=fixture(app,2,False)
        materialize_layout_defaults(app)
        tabs=[tab for pane in arranged['source']['panes'] for tab in pane['tabs']]
        js(app,'return await window.__mycmuxE2E.tearOutWorkspaceToNewWindow('+json.dumps(arranged['source']['id'])+',{x:700,y:300});')
        label=moving_window(app,tabs)['label']
        # Re-enable native tear-out: the ordinary child must retain its own shell.
        js(app,'window.__mycmuxE2E.stores.settings.setState({nativePaneTearoutEnabled:true,macNativePaneTearoutEnabled:true});return true;')
    else:
        arranged,tabs,label=kept(app,2 if kind=='workspace' else 1,kind)
    if case in ('grouped','downgrade'):
        js(app,r'''
const list=window.__mycmuxE2E.stores.workspaceList.getState(), id=crypto.randomUUID(), tabId=crypto.randomUUID();
const tab={id:tabId,sessionId:'launcher-'+tabId,agentId:'shell-starter',type:'launcher'};
const pane={id,sessionId:tab.sessionId,agentId:tab.agentId,tabs:[tab],activeTabId:tabId};
const added=list.createWorkspace('I4-second-workspace','1x1',[pane],[[id]],{activate:false});
list.setActiveWorkspace(added.id); return added.id;
''',label)
    materialize_layout_defaults(app,label)
    if case=='pane':
        js(app,'return await window.__TAURI_INTERNALS__.invoke("plugin:window|set_size",{value:{Logical:{width:300,height:200}}});',label)
        wait(app,lambda:observe(app).get(label,{}).get('frame',{}).get('width')==300 and observe(app)[label]['frame']['height']==200,'small native window size')
    before=observe(app)
    stage={'before':before}
    (out/'stage-state.json').write_text(json.dumps(stage,indent=2)+'\n',encoding='utf-8')
    data=saved_quit(app)
    if case=='downgrade':
        assert old_bundle is not None
        old=App(SEAT+'compat'+datetime.now(timezone.utc).strftime('%m%d%H%M%S%f'),old_bundle)
        path=data_path(old.profile)
        path.parent.mkdir(parents=True,exist_ok=False)
        encoded=json.dumps(data,indent=2)+'\n'
        path.write_bytes(encoded.encode('utf-8'))
        assert path.read_text(encoding='utf-8')==encoded and '\ufffd' not in encoded
        try:
            old_out=out/'old-binary'
            old_out.mkdir()
            launch(old,old_out)
            expected=sorted(workspace['id'] for workspace in data['workspaces'])
            def owned():
                return sorted(workspace['id'] for row in old.windows() if row.get('visible') for workspace in js(old,STATE,row['label'])['workspaces'])
            wait(old,lambda: owned()==expected,'old binary opened every new-schema workspace')
            downgraded=saved_quit(old)
            assert sorted(workspace['id'] for workspace in downgraded['workspaces'])==expected
            assert all_tab_ids(downgraded)==all_tab_ids(data)
            assert downgraded['schema_version']==data['schema_version']==1
            return {'old_bundle':str(old_bundle),'old_binary_sha256':hashlib.sha256(old.binary.read_bytes()).hexdigest(),
                'workspace_ids':expected,'tab_ids':all_tab_ids(data),'old_saved_data':downgraded,'new_saved_data':data}
        finally:
            stop(old)
            assert not old.pids()
    if case=='offscreen':
        for config in data['workspaces']:
            if config.get('window_group',{}).get('label')==label:
                config['window_group']['frame'].update(x=-30000,y=-30000)
        encoded=json.dumps(data,indent=2)+'\n'
        data_path(app.profile).write_bytes(encoded.encode('utf-8'))
        assert data_path(app.profile).read_text(encoding='utf-8')==encoded and '\ufffd' not in encoded
    restart(app,out)
    def restored():
        observed=observe(app)
        stage['observed']=observed
        (out/'stage-state.json').write_text(json.dumps(stage,indent=2)+'\n',encoding='utf-8')
        return observed if {key:row['shape'] for key,row in observed.items()}=={key:row['shape'] for key,row in before.items()} else None
    after=wait(app,restored,'complete saved window groups',20)
    for key in before:
        assert after[key]['native_child']==before[key]['native_child'],(key,before,after)
        for dimension,value in before[key]['frame'].items():
            if case=='offscreen' and key==label and dimension in ('x','y'):continue
            assert abs(after[key]['frame'][dimension]-value)<=1,(key,dimension,before,after)
    if case=='offscreen':
        monitors=js(app,'return await window.__TAURI_INTERNALS__.invoke("plugin:window|available_monitors");',label)
        frame=after[label]['frame']
        def overlaps(monitor):
            scale=monitor['scaleFactor']
            x=monitor['position']['x']/scale;y=monitor['position']['y']/scale
            width=monitor['size']['width']/scale;height=monitor['size']['height']/scale
            return frame['x']<x+width and frame['x']+frame['width']>x and frame['y']<y+height and frame['y']+frame['height']>y
        assert any(overlaps(monitor) for monitor in monitors),(frame,monitors)
    # A second real restart detects cumulative frame inflation and conversion drift.
    stage['first_after']=after
    second_data=saved_quit(app)
    stage['second_saved_groups']=[{'id':row['id'],'window_group':row.get('window_group')} for row in second_data['workspaces']]
    restart(app,out)
    second=wait(app,restored,'second restart preserved groups',20)
    for key in after:
        assert second[key]['native_child']==after[key]['native_child'],(key,after,second)
        for dimension,value in after[key]['frame'].items():
            assert abs(second[key]['frame'][dimension]-value)<=1,(after,second)
    return {'case':case,'before':before,'after':after,'second_restart':second,'saved_data':data,'second_saved_data':second_data}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--case',choices=['pane','tab','workspace','grouped','offscreen','downgrade','ordinary'],required=True)
    parser.add_argument('--old-bundle',type=Path)
    args=parser.parse_args()
    bundle=args.bundle.resolve()
    assert OUT.resolve() in bundle.parents
    if args.old_bundle:assert OUT.resolve() in args.old_bundle.resolve().parents
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out=OUT/('window-persistence-'+args.case+'-'+stamp)
    out.mkdir(parents=True)
    app=App(SEAT+'persist'+stamp+args.case,bundle)
    result={'case':args.case,'profile':app.profile,'bundle':str(bundle),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'binary_sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest()}
    began=time.monotonic()
    try:
        result['evidence']=run(app,args.case,out,args.old_bundle)
        result['passed']=True
    except Exception as error:result.update(passed=False,error=str(error))
    finally:
        try:stop(app)
        except Exception as error:result.update(passed=False,cleanup_error=str(error))
    result['remaining_pids']=app.pids()
    result['elapsed_ms']=round((time.monotonic()-began)*1000,3)
    (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print('I4_WINDOW_PERSISTENCE',args.case,result.get('passed'),result.get('error',''),str(out/'summary.json'),flush=True)
    return 0 if result.get('passed') and not result['remaining_pids'] else 1


if __name__=='__main__':raise SystemExit(main())
