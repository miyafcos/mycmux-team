"""Frozen-copy regression checks for PKC 004, 006, 011, 012 and 016."""
import importlib.util
import json
import os
from pathlib import Path

import pytest
import dispatch_ledger as ledger
import seat_watch as watch
from test_dispatch_guard import FakeBridge, setup
from test_seat_watch import run, seat, write, tmp_path


@pytest.mark.parametrize('has_done', [False, True])
@pytest.mark.parametrize('has_ready', [False, True])
def test_added_targets_adopt_only_empty_state(tmp_path, capsys, has_done, has_ready):
    old = seat(tmp_path, 'old')
    added = seat(tmp_path, 'added', '## completed\n' if has_done else None)
    ready = tmp_path / 'ready'
    ready.mkdir()
    if has_ready:
        write(ready / 'one.json', '{}')
    pattern = str(ready / '*.json')
    state = tmp_path / 'state.json'
    assert run(['status', '--seat', str(old), '--state', str(state)], capsys)[0] == 0
    code, out, err = run(['wait', '--seat', str(old), '--seat', str(added),
                          '--watch', pattern, '--state', str(state), '--timeout-min', '0'], capsys)
    assert err == ''
    if has_done or has_ready:
        # A DONE.md or matching file the saved state never saw is news for the waiter.
        assert code == 0 and out.startswith('CHANGED\n')
        assert ('added DONE=YES new ##: completed' in out) is has_done
        assert (f'WATCH {pattern}: +one.json' in out) is has_ready
    else:
        assert code == 3 and out.startswith('TIMEOUT\n')
    saved = json.loads(state.read_text(encoding='utf-8'))
    assert watch.display_path(added) in saved['seats']
    assert saved['seats'][watch.display_path(added)]['exists'] is has_done
    assert len(saved['watches'][pattern]) == int(has_ready)


@pytest.mark.parametrize('target', ['seat', 'glob'])
def test_added_target_changes_after_initial_snapshot_are_reported(tmp_path, monkeypatch, capsys, target):
    old = seat(tmp_path, 'old')
    added = seat(tmp_path, 'added', None)
    ready = tmp_path / 'ready'
    ready.mkdir()
    state = tmp_path / 'state.json'
    assert run(['status', '--seat', str(old), '--state', str(state)], capsys)[0] == 0
    slept = []
    def advance(_):
        assert not slept, 'wait failed to report the new change'
        slept.append(True)
        if target == 'seat':
            write(added / 'DONE.md', '## arrived\n')
        else:
            write(ready / 'one.json', '{}')
    monkeypatch.setattr(watch.time, 'sleep', advance)
    code, out, err = run(['wait', '--seat', str(old), '--seat', str(added),
                          '--watch', str(ready / '*.json'), '--state', str(state),
                          '--timeout-min', '0.05'], capsys)
    assert slept == [True] and code == 0 and err == ''
    assert out.startswith('CHANGED\n')
    assert ('added DONE=YES new ##: arrived' if target == 'seat' else '+one.json') in out


def test_adding_target_keeps_existing_saved_changes(tmp_path, capsys):
    old = seat(tmp_path, 'old')
    added = seat(tmp_path, 'added', '## already complete\n')
    state = tmp_path / 'state.json'
    assert run(['status', '--seat', str(old), '--state', str(state)], capsys)[0] == 0
    write(old / 'DONE.md', '## old\n## changed between calls\n')
    code, out, err = run(['wait', '--seat', str(old), '--seat', str(added),
                          '--state', str(state), '--timeout-min', '0'], capsys)
    assert code == 0 and err == ''
    assert 'old DONE=YES new ##: changed between calls' in out
    assert 'added DONE=YES new ##: already complete' in out


@pytest.mark.parametrize('command', ['status', 'wait'])
def test_missing_state_parent_fails_before_snapshot(tmp_path, monkeypatch, capsys, command):
    path = seat(tmp_path, 'sample')
    state = tmp_path / 'missing' / 'state.json'
    monkeypatch.setattr(watch, 'snapshot', lambda *a, **k: pytest.fail('read before state validation'))
    code, out, err = run([command, '--seat', str(path), '--state', str(state)], capsys)
    assert code == 2 and out == ''
    assert err == 'ERROR: --state parent folder must exist\n'
    assert not state.parent.exists()


@pytest.mark.parametrize('command', ['status', 'wait'])
def test_unwritable_state_parent_fails_before_snapshot(tmp_path, monkeypatch, capsys, command):
    path = seat(tmp_path, 'sample')
    def denied(*a, **k):
        raise PermissionError('state directory write denied')
    monkeypatch.setattr(watch.tempfile, 'TemporaryFile', denied)
    monkeypatch.setattr(watch, 'snapshot', lambda *a, **k: pytest.fail('read before write probe'))
    code, out, err = run([command, '--seat', str(path), '--state', str(tmp_path / 'state.json')], capsys)
    assert code == 2 and out == ''
    assert err == 'ERROR: state directory write denied\n'


def test_state_directory_is_rejected_before_snapshot(tmp_path, monkeypatch, capsys):
    path = seat(tmp_path, 'sample')
    state = tmp_path / 'directory'
    state.mkdir()
    monkeypatch.setattr(watch, 'snapshot', lambda *a, **k: pytest.fail('read before destination check'))
    code, out, err = run(['wait', '--seat', str(path), '--state', str(state)], capsys)
    assert code == 2 and out == '' and err == 'ERROR: --state must be a file\n'


@pytest.mark.parametrize('key', ['tab_session_id', 'tabSessionId'])
@pytest.mark.parametrize('tab', [None, 'different-tab', 'own-tab'])
def test_self_registration_does_not_infer_self_parent(tmp_path, monkeypatch, key, tab):
    monkeypatch.setenv('MYCMUX_TAB_ID', 'own-tab')
    monkeypatch.setenv('MYCMUX_PANE_SESSION_ID', 'own-session')
    record = {'slug': '261108-sample', key: 'own-session'}
    if tab is not None:
        record['tab_id'] = tab
    path = tmp_path / 'ledger.jsonl'
    row = ledger.append_record(path, record)
    assert 'parent_tab_id' not in row and 'parent_session_id' not in row
    assert json.loads(path.read_text(encoding='utf-8')) == row


def test_self_registration_preserves_explicit_parent(tmp_path, monkeypatch):
    monkeypatch.setenv('MYCMUX_TAB_ID', 'own-tab')
    monkeypatch.setenv('MYCMUX_PANE_SESSION_ID', 'own-session')
    row = ledger.append_record(tmp_path / 'ledger.jsonl', {
        'slug': '261108-sample', 'tab_session_id': 'own-session',
        'parent_tab_id': 'chosen-tab', 'parent_session_id': 'chosen-session'})
    assert row['parent_tab_id'] == 'chosen-tab' and row['parent_session_id'] == 'chosen-session'


@pytest.mark.parametrize('multi', [False, True])
def test_guard_free_text_cursor_escalates_without_writing(tmp_path, multi):
    check = '[ ] ' if multi else ''
    lines = ['\u2610 Choice', 'Choose one', '1. ' + check + 'First',
             '2. ' + check + 'Second', '\u276f 3. Type something.',
             'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel']
    bridge = FakeBridge(lines)
    guard, _, _, alerts = setup(tmp_path, bridge)
    state = guard.cycle()
    assert state['targets']['s']['verdict']['action'] == 'answer_ask'
    assert not bridge.writes
    assert len(alerts) == 1
    assert 'Free-text option' in alerts[0]['detail']
    # The card's detail line is cut at 36 characters: the reason must fit whole.
    assert 'Free-text option needs a human' in alerts[0]['detail']
    assert not alerts[0]['detail'].endswith(' an')
    events = [json.loads(row) for row in (tmp_path / 'escalations.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(events) == 1 and events[0]['cls'] == 'ask_dialog'
    assert events[0]['detail'] == 'Free-text option needs a human'


@pytest.mark.parametrize('relative', ['relative/sub', './relative/sub', 'relative\\sub'])
def test_explicit_relative_seat_uses_cwd(tmp_path, monkeypatch, capsys, relative):
    if '\\' in relative and os.name != 'nt':
        pytest.skip('backslash is a Windows path separator')
    cwd = tmp_path / 'cwd'
    dispatch = tmp_path / 'dispatch'
    local = cwd / 'relative' / 'sub'
    legacy = dispatch / 'relative' / 'sub'
    local.mkdir(parents=True)
    legacy.mkdir(parents=True)
    write(local / 'DONE.md', '## local\n')
    write(legacy / 'DONE.md', '## wrong root\n')
    with monkeypatch.context() as context:
        context.chdir(cwd)
        context.setattr(watch, 'DISPATCH_ROOT', dispatch)
        code, out, err = run(['status', '--seat', relative, '--json'], capsys)
        assert code == 0 and err == ''
        assert json.loads(out)['seats'][0]['path'] == watch.display_path(local)
        assert json.loads(out)['seats'][0]['latest_heading'] == 'local'


@pytest.mark.parametrize('relative', ['.', '..'])
def test_dot_relative_seat_uses_cwd(tmp_path, monkeypatch, relative):
    nested = tmp_path / 'nested'
    nested.mkdir()
    with monkeypatch.context() as context:
        context.chdir(nested)
        context.setattr(watch, 'DISPATCH_ROOT', tmp_path / 'unrelated')
        assert watch.resolve_seats([relative]) == [(nested / relative).resolve()]


@pytest.mark.parametrize('multi', [False, True])
def test_free_text_escalation_card_passes_real_ops_entry_gate(tmp_path, multi):
    """The card 012 now raises must pass the real ops entry validator (ops_common + ask_validation.json)."""
    spec = importlib.util.spec_from_file_location(
        'ops_common', Path.home() / '.claude' / 'ops' / 'ops_common.py')
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    check = '[ ] ' if multi else ''
    lines = ['☐ Choice', 'Choose one', '1. ' + check + 'First', '2. ' + check + 'Second',
             '❯ 3. ' + check + 'Type something' + ('' if multi else '.'),
             'Enter to select · ↑/↓ to navigate · Esc to cancel']
    captured = []
    bridge = FakeBridge(lines)
    guard, actions, _, _ = setup(tmp_path, bridge)
    actions.alert = lambda card: captured.append(card) or {'enqueue_exit': 0}
    guard.cycle()
    assert captured and not bridge.writes
    for card in captured:
        assert 'Free-text option needs a human' in card['detail']
        ops.validate_ask_card(card['question'], card['detail'], card['options'],
                              card['recommendation_reason'], card['blocking_reason'],
                              card['decision_class'])
