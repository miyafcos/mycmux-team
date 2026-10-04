"""M5 unseen-pane read regression; run each invocation under COMMON.md's lockf."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/e2e'))
from mac_tearout import App, SEAT, OUT, launch, stop
from mac_robust import configure_tearout, fixture, clocks, prepare_background_read


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--expect', choices=['empty', 'output'], required=True)
    parser.add_argument('--tearout', choices=['off', 'on'], required=True)
    parser.add_argument('--sample', type=int, required=True)
    args = parser.parse_args()
    assert SEAT == 'm5' and sys.platform == 'darwin'
    assert OUT.resolve() in args.bundle.resolve().parents
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out = OUT / f'read-{args.expect}-{args.tearout}-{args.sample}-{stamp}'
    out.mkdir(parents=True)
    app = App('m5read'+stamp.lower(), args.bundle)
    record = dict(bundle=str(args.bundle), profile=app.profile, expectation=args.expect,
                  tearout=args.tearout, sample=args.sample, binary_sha256=hashlib.sha256(app.binary.read_bytes()).hexdigest())
    try:
        launch(app, out)
        record['settings'] = configure_tearout(app, args.tearout == 'on')
        sessions = fixture(app, 3)
        record['pty'] = clocks(app, sessions)
        target = sessions[0]
        record['before_read'] = app.eval('''const h=window.__mycmuxE2E,sid='''+json.dumps(target)+''';
            const terms=h.terminals;return {live:terms.live.has(sid),cached:terms.cached.has(sid),
            workspaces:h.stores.workspaceList.getState().workspaces,activeSession:h.stores.ui.getState().activePaneId};''')
        for workspace in record['before_read']['workspaces']:
            for pane in workspace['panes']:
                tab = next((t for t in pane['tabs'] if t.get('sessionId') == target), None)
                if tab:
                    assert pane['activeTabId'] != tab['id'], pane
        begin = time.monotonic()
        unseen = app.call('pane.read', {'sessionId': target})
        record['unseen_read_ms'] = (time.monotonic()-begin)*1000
        record['unseen'] = unseen
        has_clock = 'M2CLOCK' in json.dumps(unseen)
        assert has_clock == (args.expect == 'output'), unseen
        if args.expect == 'empty':
            assert unseen['lines'] == []
            assert record['before_read']['live'] or record['before_read']['cached'], record['before_read']
        record['displayed_then_background'] = prepare_background_read(app, target)
        # A displayed terminal intentionally cleared by a TUI must remain empty,
        # despite the old clock output that is still present in backend scrollback.
        app.eval('''const h=window.__mycmuxE2E,sid='''+json.dumps(target)+''';
            for(const w of h.stores.workspaceList.getState().workspaces)for(const p of w.panes){
              const t=p.tabs.find(t=>t.sessionId===sid);if(t){h.stores.workspaceList.getState().setActiveWorkspace(w.id);
              h.stores.layout.getState().setActivePaneTab(w.id,p.id,t.id);h.stores.ui.getState().setActivePaneId(sid);}}
            return true;''')
        app.wait_until(lambda: app.eval('return window.__mycmuxE2E.terminals.live.has('+json.dumps(target)+');'), 15, 'visible terminal')
        record['visible'] = app.wait_until(lambda: (r if 'M2CLOCK' in json.dumps(r) else None) if (r := app.call('pane.read', {'sessionId': target})) else None, 15, 'visible clock read')
        record['cleared'] = app.eval('''const h=window.__mycmuxE2E,sid='''+json.dumps(target)+''';
            const term=h.terminals.live.get(sid);return await new Promise((resolve,reject)=>{
            term.write("\\x1b[3J\\x1b[2J\\x1b[H",()=>h.readPaneTail(sid,60).then(lines=>resolve({lines}),reject));});''')
        assert record['cleared']['lines'] == [], record['cleared']
        record['status'] = 'PASS'
    except BaseException as error:
        record.update(status='FAIL', error=repr(error))
        raise
    finally:
        try:
            stop(app)
            record['remaining_pids'] = app.pids()
            assert not record['remaining_pids']
        finally:
            (out / 'result.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
            print('M5_READ', args.expect, args.tearout, args.sample, record.get('status'), str(out / 'result.json'), flush=True)


if __name__ == '__main__':
    main()
