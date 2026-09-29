"""Normalize only the copied perf3 layout before any PTY can start."""
import argparse
import json
import os
import re
import time
from pathlib import Path


def prepare(load, cwd, restart=False, profile_name='perf3'):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', profile_name):
        raise ValueError('Invalid isolated profile name')
    path = Path(os.environ['APPDATA']) / f'com.miyazaki.mycmux/profiles/{profile_name}/data.json'
    raw = path.read_bytes()
    data = json.loads(raw)
    backup = path.with_name('data.json.pre-stage3-' + ('restart-' + str(time.time_ns()) if restart else load) + '.bak')
    if not backup.exists():
        backup.write_bytes(raw)
    # Freeze the first verified clone so live layout edits do not change loads.
    seed_path = Path(cwd) / 'stage3-layout-seed.json'
    if not restart:
        if seed_path.exists():
            data = json.loads(seed_path.read_bytes())
        else:
            seed_text = json.dumps(data, ensure_ascii=True, indent=2) + '\n'
            seed_path.write_text(seed_text, encoding='utf-8')
            assert seed_path.read_text(encoding='utf-8') == seed_text
    workspaces = data['workspaces']
    panes = [p for w in workspaces for p in w['panes']]
    if restart:
        for pane in panes:
            for record in [pane, *pane['tabs']]:
                for key in ('agent_session_id', 'claude_session_id', 'agent_kind',
                            'suppressed_agent_sessions', 'launch_env'):
                    record.pop(key, None)
                record['agent_id'] = 'shell'
        # Retire only isolated test mappings, preserving them rather than deleting.
        mapping_dir = Path.home() / f'.mycmux-{profile_name}/pane-sessions'
        for mapping in mapping_dir.glob('*.txt'):
            mapping.rename(mapping.with_suffix('.txt.retired-' + str(time.time_ns())))
        text = json.dumps(data, ensure_ascii=True, indent=2) + '\n'
        path.write_text(text, encoding='utf-8')
        assert path.read_text(encoding='utf-8') == text and '\ufffd' not in text
        return
    # The standard launcher preserves scrollback/history. A new load condition
    # must not inherit synthetic output from the preceding condition.
    runtime = (Path.home() / f'.mycmux-{profile_name}').resolve()
    for name in ('scrollback', 'history.db', 'history.db-wal', 'history.db-shm'):
        source = runtime / name
        destination = runtime / (name + '.pre-stage3-' + str(time.time_ns()))
        if source.exists():
            assert source.resolve().is_relative_to(runtime)
            assert destination.resolve().is_relative_to(runtime) and not destination.exists()
            source.rename(destination)
    profile_scrollback = path.parent / 'scrollback'
    if profile_scrollback.exists():
        destination = path.parent / ('scrollback.pre-stage3-' + str(time.time_ns()))
        assert profile_scrollback.resolve().is_relative_to(path.parent.resolve())
        assert destination.resolve().is_relative_to(path.parent.resolve()) and not destination.exists()
        profile_scrollback.rename(destination)
    if load == 'L0':
        data['workspaces'] = workspaces[:1]
        workspaces = data['workspaces']
        workspaces[0]['panes'] = workspaces[0]['panes'][:1]
        panes = workspaces[0]['panes']
        panes[0]['tabs'] = panes[0]['tabs'][:1]
        workspaces[0]['split_columns'] = [[0]]
        workspaces[0]['grid_template_id'] = '1x1'
    else:
        assert len(workspaces) == 4 and len(panes) == 8, 'Clone topology changed; do not silently fabricate it'
        while sum(len(p['tabs']) for p in panes) > 24:
            max(panes, key=lambda p: len(p['tabs']))['tabs'].pop()
        assert sum(len(p['tabs']) for p in panes) == 24, 'Need 24 copied sessions'
    for index, pane in enumerate(panes):
        for record in [pane, *pane['tabs']]:
            for key in ('agent_session_id', 'claude_session_id', 'agent_kind', 'suppressed_agent_sessions',
                        'launch_env', 'terminal_snapshot', 'turn_marks', 'declared_prompt', 'declared_target', 'origin'):
                record.pop(key, None)
            record['agent_id'] = 'shell'
            record['cwd'] = str(Path(cwd).resolve())
            record.pop('last_process', None)
        for tab_index, tab in enumerate(pane['tabs']):
            tab['type'] = 'terminal'
            tab['label'] = f'P{index+1:02}-{tab_index+1:02}'
            tab.pop('lifecycle', None)
        pane['active_tab_id'] = pane['tabs'][0]['tab_id']
        pane['label'] = f'Pane {index+1:02}'
        pane.pop('pinned_tab_id', None)
    data['active_workspace_id'] = workspaces[0]['id']
    data['active_pane_id'] = panes[0]['pane_id']
    data['active_tab_id'] = panes[0]['tabs'][0]['tab_id']
    for workspace in workspaces:
        workspace['detached'] = False
        workspace.pop('window_frame', None)
    # ASCII escapes keep all copied Japanese text byte-safe in this new test file.
    text = json.dumps(data, ensure_ascii=True, indent=2) + '\n'
    path.write_text(text, encoding='utf-8')
    assert path.read_text(encoding='utf-8') == text and '\ufffd' not in text
    print(json.dumps(dict(load=load, workspaces=len(workspaces), panes=len(panes),
                          sessions=sum(len(p['tabs']) for p in panes))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--load', choices=['L0', 'L24'], required=True)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--restart', action='store_true')
    parser.add_argument('--profile-name', default='perf3')
    args = parser.parse_args()
    prepare(args.load, args.cwd, args.restart, args.profile_name)
