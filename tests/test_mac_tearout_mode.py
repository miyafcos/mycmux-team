"""Mac synthetic-mode regression without launching an app or importing its driver."""
import ast
import json
import subprocess
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/e2e/mac_tearout.py'


def helper_functions():
    tree = ast.parse(SCRIPT.read_text(encoding='utf-8'), filename=str(SCRIPT))
    # Only helpers execute: no profile/root assertion, App import, launch or UI.
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    namespace = {'json': json, 'STATE': next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'STATE' for target in node.targets))}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(SCRIPT), 'exec'), namespace)
    return namespace


class BoundMoveApp:
    def __init__(self, mode):
        # The same label may start either mode. Only the recorded start is valid.
        self.bound = {'id': 'move-1', 'label': 'same-child', 'mode': mode}
        self.samples = []

    def wait_until(self, callback, timeout, what, interval):
        result = callback()
        if result is None:
            raise AssertionError(what)
        return result

    def eval(self, code, label, timeout_ms):
        if '__m1Moves' in code:
            return self.bound
        if 'const args=' in code:
            args, _ = json.JSONDecoder().raw_decode(code.split('const args=', 1)[1])
        else:
            args, _ = json.JSONDecoder().raw_decode(code.split('"tearout_synthetic_sample",', 1)[1])
        if args.get('mode') is None:
            raise RuntimeError('tearout_move_mode_required')
        if args['mode'] != self.bound['mode']:
            raise RuntimeError('tearout_move_mode_changed')
        self.samples.append((label, args))
        return {'mode': args['mode'], 'phase': args['phase'], 'escaped': args['escaped']}


class FinalPumpReached(Exception):
    pass


class MatrixEntryApp:
    """Drive the real matrix entry sequence up to its final native pump."""
    def __init__(self, functions):
        self.functions = functions
        self.source = {'id': 'source', 'panes': [{'id': 'pane', 'tabs': [
            {'id': 'one', 'sessionId': 'pty-one'}, {'id': 'two', 'sessionId': 'pty-two'}]}]}
        self.receiver = {'id': 'receiver', 'panes': [{'id': 'receiver-pane'}]}
        self.active = {}
        self.bound = {}
        self.pumps = []
        self.grips = []
        self.counter = 0
        self.writes = 0
        self.last_label = None
        self.clock = 0

    def begin(self, label, mode, moving):
        self.counter += 1
        move_id = str(self.counter)
        self.active[label] = move_id
        self.bound[move_id] = {'mode': mode, 'source': label, 'label': moving}
        self.last_label = moving
        return move_id

    def pointer_start(self, app, source, kind, tabs, label='main', entry='default'):
        if label == 'main':
            self.begin(label, 'detach', 'B')
        elif entry == 'pill':
            self.begin(label, 'detach', 'C')
        else:
            self.begin(label, 'dock', label)

    def pump(self, app, move_id, label, source, receiver=None, point=None, escaped=False):
        bound = self.bound[move_id]
        assert (source, label) == (bound['source'], bound['label'])
        self.pumps.append(bound.copy())
        if receiver:
            raise FinalPumpReached()
        self.active.pop(source, None)
        return {'bound': bound, 'hover': {'approval': None, 'alpha_calls': 0},
                'end': {'approval': None, 'alpha_calls': 0}}

    def clocks(self, app, tabs, label, before=None):
        self.clock += 1
        return {tab['id']: {'session': tab['sessionId'], 'pid': 'same-process', 'clock': self.clock} for tab in tabs}

    def windows(self):
        return [{'label': 'mycmux-w-spare', 'visible': False}] + [{'label': label, 'visible': True} for label in dict.fromkeys(bound['label'] for bound in self.bound.values())]

    def wait_until(self, callback, timeout, what, interval):
        value = callback()
        if value is None or value is False:
            raise AssertionError(what)
        return value

    def eval(self, code, label, timeout_ms):
        if code == self.functions['STATE']:
            return {'workspaces': [self.source]}
        if 'stores.settings.getState()' in code:
            return {'generic': True, 'mac': True}
        if 'send("pointerdown"' in code:
            self.grips.append(label)
            self.begin(label, 'dock', label)
            return True
        if 'nativeTearout.records.keys()' in code:
            return self.active.get(label)
        if 'nativeTearout.records.size' in code:
            return int(label in self.active)
        if 'terminals.writes.get' in code:
            self.writes += 1
            return self.writes
        raise AssertionError(code)


class MacTearoutModeTest(unittest.TestCase):
    def check_move(self, mode, escaped):
        functions = helper_functions()
        app = BoundMoveApp(mode)
        result = functions['pump'](app, 'move-1', 'same-child', 'source', escaped=escaped)
        self.assertEqual([args['mode'] for _, args in app.samples], [mode, mode])
        self.assertEqual([args['phase'] for _, args in app.samples], ['move', 'end'])
        self.assertEqual(result['end']['escaped'], escaped)
        self.assertTrue(all(label == 'source' for label, _ in app.samples))

    def test_detach_keep_uses_bound_mode(self):
        self.check_move('detach', False)

    def test_detach_escape_uses_bound_mode(self):
        self.check_move('detach', True)

    def test_dock_same_label_uses_bound_mode(self):
        self.check_move('dock', False)
    def test_instrument_records_actual_start_arguments_and_preserves_invoke(self):
        functions = helper_functions()
        captured = []
        class App:
            def eval(self, code, label, timeout_ms):
                captured.append(code)
        functions['instrument'](App(), 'source')
        program = r"""
const assert=require('node:assert/strict'), vm=require('node:vm'), calls=[];
const window={fetch:()=>Promise.resolve(),__TAURI_INTERNALS__:{invoke(command,args,...rest){
  assert.equal(this,window.__TAURI_INTERNALS__); calls.push([command,args,...rest]); return 'native-receipt';
}}};
vm.runInNewContext('(function(){'+process.argv[1]+'})()',{window,Date,performance,TextDecoder,URL});
for(const mode of ['detach','dock']) {
  const args={id:mode,label:'same-child',mode}, options={test:true};
  assert.equal(window.__TAURI_INTERNALS__.invoke('tearout_start_move',args,options),'native-receipt');
  args.mode='changed-after-call';
  assert.equal(window.__m1Moves[mode].id,mode);
  assert.equal(window.__m1Moves[mode].label,'same-child');
  assert.equal(window.__m1Moves[mode].mode,mode);
  assert.equal(calls.at(-1)[2],options);
}
"""
        result = subprocess.run(['node', '-e', program, captured[0]], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def check_matrix_entry(self, entry, expected_modes, expected_sources):
        functions = helper_functions()
        app = MatrixEntryApp(functions)
        functions.update(launch=lambda *_: None, instrument=lambda *_: None,
                         fixture=lambda *_: {'source': app.source, 'receiver': app.receiver},
                         clocks=app.clocks, live_clocks=app.clocks, pointer_start=app.pointer_start,
                         moving_window=lambda *_: {'label': app.last_label}, identity=lambda *_: 101,
                         destination=lambda *_: {'x': 150, 'y': 150}, pump=app.pump)
        case = {'kind': 'tab', 'destination': 'center', 'regions': 1}
        if entry:
            case['regrab'] = entry
        with self.assertRaises(FinalPumpReached):
            functions['run_case'](app, case, Path('unused-output'))
        self.assertEqual([bound['mode'] for bound in app.pumps], expected_modes)
        self.assertEqual([bound['source'] for bound in app.pumps], expected_sources)
        self.assertEqual(app.grips[-1:], [expected_sources[-1]])

    def test_old_first_dock_case_now_settles_detach_then_regrabs_whole_child(self):
        self.check_matrix_entry(None, ['detach', 'dock'], ['main', 'B'])

    def test_partial_pill_detaches_then_uses_its_own_whole_child_grip(self):
        self.check_matrix_entry('pill', ['detach', 'detach', 'dock'], ['main', 'B', 'C'])


if __name__ == '__main__':
    unittest.main()
