from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

EXPECTED_SHA = '7a030f48a64fc7242d3e20cb04afc89ad3d8240cc35939d28b4636631466bf6f'
EXPECTED_SIZE = 77128704


class Startup(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('reserved', wintypes.LPWSTR), ('desktop', wintypes.LPWSTR), ('title', wintypes.LPWSTR),
                ('x', wintypes.DWORD), ('y', wintypes.DWORD), ('xsize', wintypes.DWORD), ('ysize', wintypes.DWORD),
                ('xcount', wintypes.DWORD), ('ycount', wintypes.DWORD), ('fill', wintypes.DWORD), ('flags', wintypes.DWORD),
                ('show', wintypes.WORD), ('reserved_size', wintypes.WORD), ('reserved_bytes', ctypes.c_void_p),
                ('stdin', wintypes.HANDLE), ('stdout', wintypes.HANDLE), ('stderr', wintypes.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [('process', wintypes.HANDLE), ('thread', wintypes.HANDLE), ('pid', wintypes.DWORD), ('thread_id', wintypes.DWORD)]


class BasicLimit(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong), ('flags', wintypes.DWORD),
                ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t), ('active_limit', wintypes.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ['read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes']]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [('basic', BasicLimit), ('io', IoCounters), ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]


class Accounting(ctypes.Structure):
    _fields_ = [(name, ctypes.c_longlong) for name in ['user', 'kernel', 'period_user', 'period_kernel']] + [
        ('faults', wintypes.DWORD), ('total', wintypes.DWORD), ('active', wintypes.DWORD), ('terminated', wintypes.DWORD)]


class Memory(ctypes.Structure):
    _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [(name, ctypes.c_ulonglong) for name in [
        'total', 'available', 'page_total', 'page_available', 'virtual_total', 'virtual_available', 'extended']]


def bind(library, name: str, arguments: list, result):
    function = getattr(library, name)
    function.argtypes, function.restype = arguments, result
    return function


def tcp_listener_owners(port: int) -> list[dict]:
    library = ctypes.WinDLL('iphlpapi', use_last_error=True)
    get_table = library.GetExtendedTcpTable
    get_table.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL, wintypes.ULONG, ctypes.c_int, wintypes.ULONG]
    get_table.restype = wintypes.DWORD
    size = wintypes.DWORD()
    result = get_table(None, ctypes.byref(size), False, 2, 3, 0)
    if result != 122:
        raise OSError(result, 'TCP listener table size query')
    for attempt in range(3):
        buffer = ctypes.create_string_buffer(size.value)
        result = get_table(buffer, ctypes.byref(size), False, 2, 3, 0)
        if result == 122:
            continue
        if result != 0:
            raise OSError(result, 'TCP listener table query')
        values = memoryview(buffer.raw).cast('I')
        count = values[0]
        if 1 + count * 6 > len(values):
            raise ValueError('TCP table is truncated')
        listeners = []
        for index in range(count):
            state, address, local_port, _remote, _remote_port, owner = values[1 + index * 6:7 + index * 6]
            if state == 2 and socket.ntohs(local_port & 65535) == port:
                listeners.append({'LocalAddress': socket.inet_ntoa(int(address).to_bytes(4, 'little')), 'OwningProcess': int(owner)})
        return listeners
    raise RuntimeError('TCP listener table changed repeatedly')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--probe', type=Path, required=True)
    args = parser.parse_args()
    assert os.name == 'nt' and os.environ.get('GITHUB_ACTIONS') == 'true', 'CI-only execution'
    assert os.environ.get('GITHUB_REPOSITORY') == 'miyafcos/mycmux-team'
    probe = args.probe.resolve()
    assert probe.is_file() and probe.name == 'webview_probe_0886.mjs'
    binary = args.exe.resolve()
    assert binary.is_file() and binary.stat().st_size == EXPECTED_SIZE
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == EXPECTED_SHA
    output = args.out.resolve()
    output.mkdir(exist_ok=False)
    profile = 'ci0886_' + os.environ['GITHUB_RUN_ID'] + '_' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
    assert re.fullmatch(r'ci0886_\d+_\d+', profile)
    home = Path.home()
    runtime = home / ('.mycmux-' + profile)
    data_root = Path(os.environ['APPDATA']) / 'com.miyazaki.mycmux'
    profile_root = data_root / 'profiles' / profile
    assert not runtime.exists() and not profile_root.exists()
    assert not (data_root / 'data.json').exists() and not (home / '.mycmux').exists()
    runtime.mkdir()
    owned = {'at': datetime.now().astimezone().isoformat(), 'profile': profile, 'binary_sha256': EXPECTED_SHA,
             'binary_size': EXPECTED_SIZE, 'production_update': False, 'checks': [], 'status': 'started'}
    system = ctypes.WinDLL('kernel32', use_last_error=True)
    window = ctypes.WinDLL('user32', use_last_error=True)
    create_desktop = bind(window, 'CreateDesktopW', [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p], wintypes.HANDLE)
    close_desktop = bind(window, 'CloseDesktop', [wintypes.HANDLE], wintypes.BOOL)
    open_input = bind(window, 'OpenInputDesktop', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE)
    object_info = bind(window, 'GetUserObjectInformationW', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
    foreground = bind(window, 'GetForegroundWindow', [], wintypes.HWND)
    window_pid = bind(window, 'GetWindowThreadProcessId', [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    enum_desktop = bind(window, 'EnumDesktopWindows', [wintypes.HANDLE, callback_type, wintypes.LPARAM], wintypes.BOOL)
    create_process = bind(system, 'CreateProcessW', [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(Startup), ctypes.POINTER(ProcessInfo)], wintypes.BOOL)
    create_job = bind(system, 'CreateJobObjectW', [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE)
    set_job = bind(system, 'SetInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL)
    assign_job = bind(system, 'AssignProcessToJobObject', [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL)
    query_job = bind(system, 'QueryInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL)
    terminate_job = bind(system, 'TerminateJobObject', [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL)
    terminate_process = bind(system, 'TerminateProcess', [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL)
    resume = bind(system, 'ResumeThread', [wintypes.HANDLE], wintypes.DWORD)
    wait_process = bind(system, 'WaitForSingleObject', [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD)
    close_handle = bind(system, 'CloseHandle', [wintypes.HANDLE], wintypes.BOOL)
    memory_status = bind(system, 'GlobalMemoryStatusEx', [ctypes.POINTER(Memory)], wintypes.BOOL)
    info = ProcessInfo()
    desktop = job = input_desktop = None
    assigned = False
    diagnostic_port = None
    environment = None
    open_process = bind(system, 'OpenProcess', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE)
    in_job = bind(system, 'IsProcessInJob', [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL)

    def require(result, description: str):
        if not result:
            raise OSError(ctypes.get_last_error(), description)
        return result

    def memory_gib() -> float:
        state = Memory()
        state.length = ctypes.sizeof(state)
        require(memory_status(ctypes.byref(state)), 'memory query')
        return state.available / 1024**3

    def desktop_name(handle) -> str:
        buffer = ctypes.create_unicode_buffer(256)
        length = wintypes.DWORD()
        require(object_info(handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(length)), 'desktop identity')
        return buffer.value

    def root_windows(handle) -> list[int]:
        result = []
        @callback_type
        def collect(hwnd, _parameter):
            pid = wintypes.DWORD()
            window_pid(hwnd, ctypes.byref(pid))
            if pid.value == info.pid:
                result.append(int(hwnd))
            return True
        require(enum_desktop(handle, collect, 0), 'enumerate owned windows')
        return result

    def call(name: str, values: dict | None = None):
        port = int((runtime / 'mycmux.port').read_text(encoding='utf-8').strip())
        token = (runtime / 'mycmux.token').read_text(encoding='utf-8').strip()
        assert 0 < port < 65536 and token
        request = {'cmd': name, 'args': values or {}, 'token': token}
        with socket.create_connection(('127.0.0.1', port), timeout=10) as connection:
            connection.settimeout(15)
            connection.sendall((json.dumps(request) + '\n').encode())
            with connection.makefile('rb') as reader:
                line = reader.readline(4 * 1024 * 1024)
        response = json.loads(line)
        if response.get('error') is not None:
            raise RuntimeError(name + ': ' + str(response['error']))
        return response.get('result')

    def until(predicate, seconds: int, label: str):
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            if memory_gib() < 2:
                raise RuntimeError('runtime stop gate: free RAM below 2 GiB')
            if info.process and wait_process(info.process, 0) == 0:
                raise RuntimeError('test application exited before ' + label)
            try:
                value = predicate()
                if value:
                    return value
            except (OSError, ValueError, RuntimeError) as error:
                last = type(error).__name__ + ': ' + str(error)
            time.sleep(0.25)
        raise TimeoutError(label + ': ' + str(last))

    def scrub(text: str) -> str:
        token_path = runtime / 'mycmux.token'
        if token_path.is_file():
            token = token_path.read_text(encoding='utf-8').strip()
            if token:
                text = text.replace(token, '<redacted>')
        return '\n'.join('<sensitive diagnostic line omitted>' if re.search(
            r'token|authorization|password|credential|api[_-]?key|private[_-]?key', line, re.I) else line
            for line in text.splitlines())

    def filtered(value):
        if isinstance(value, str):
            return scrub(value)
        if isinstance(value, dict):
            return {str(key): filtered(item) for key, item in value.items()}
        if isinstance(value, list):
            return [filtered(item) for item in value]
        return value

    def diagnostic_snapshot() -> dict:
        detail = {'raw_profile_uploaded': False, 'cdp': {'status': 'not_started'}}
        if desktop:
            detail['root_windows_hidden'] = len(root_windows(desktop))
        current = require(open_input(0, False, 0x0041), 'inspect input desktop')
        try:
            detail['input_desktop_unchanged'] = desktop_name(current) == owned['input_desktop_before']
            detail['root_windows_input'] = len(root_windows(current))
            detail['foreground_after'] = int(foreground() or 0)
        finally:
            close_desktop(current)
        if not detail['input_desktop_unchanged'] or detail['root_windows_input']:
            owned['status'] = 'failed'
            detail['isolation_failure'] = True
        for name in ['diag.log', 'diag.log.1']:
            path = runtime / name
            if path.is_file():
                payload = path.read_bytes()
                detail[name] = {'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
                                'tail': scrub(payload[-32768:].decode('utf-8', errors='replace'))}
        if not diagnostic_port or not assigned:
            return detail
        held = []
        try:
            listeners = tcp_listener_owners(diagnostic_port)
            assert listeners and all(row['LocalAddress'] in ['127.0.0.1', '::1'] for row in listeners), 'non-loopback CDP listener'
            owners = sorted({int(row['OwningProcess']) for row in listeners})
            for process_id in owners:
                handle = require(open_process(0x1000, False, process_id), 'hold CDP owner')
                held.append(handle)
                belongs = wintypes.BOOL()
                require(in_job(handle, job, ctypes.byref(belongs)), 'check CDP owner job')
                assert belongs.value, 'CDP owner is outside the isolated job'
            detail['cdp'] = {'status': 'owned_listener_verified', 'owners': owners, 'port': diagnostic_port}
            raw_path = output / 'webview-diagnostic-private.json'
            result = subprocess.run(['node', str(probe), str(diagnostic_port), profile, str(raw_path)],
                                    capture_output=True, text=True, timeout=60, env=environment)
            detail['cdp']['probe_exit'] = result.returncode
            detail['cdp']['probe_stdout'] = scrub(result.stdout)
            detail['cdp']['probe_stderr'] = scrub(result.stderr)
            if raw_path.is_file():
                detail['webview'] = filtered(json.loads(raw_path.read_text(encoding='utf-8')))
        except Exception as error:
            detail['cdp']['error'] = scrub(type(error).__name__ + ': ' + str(error))
        finally:
            for handle in held:
                close_handle(handle)
        return detail

    try:
        free = memory_gib()
        owned['start_free_gib'] = free
        assert free >= 5.2, 'start RAM gate'
        webview_roots = [Path(os.environ[key]) / 'Microsoft/EdgeWebView/Application' for key in ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'] if key in os.environ]
        webview_binaries = [path for root in webview_roots for path in root.glob('*/msedgewebview2.exe') if path.is_file()]
        assert webview_binaries, 'existing WebView2 runtime is required; no installation performed'
        owned['existing_webview_versions'] = sorted({path.parent.name for path in webview_binaries})
        input_desktop = require(open_input(0, False, 0x0041), 'open input desktop')
        owned['input_desktop_before'] = desktop_name(input_desktop)
        owned['foreground_before'] = int(foreground() or 0)
        desktop = require(create_desktop('mycmux-' + profile, None, None, 0, 0x01FF, None), 'create isolated desktop')
        assert desktop_name(desktop) != owned['input_desktop_before']
        job = require(create_job(None, None), 'create owned job')
        limits = ExtendedLimit()
        limits.basic.flags = 0x2000
        require(set_job(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)), 'set kill-on-close job')
        allowed = {'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
                   'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
                   'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'USERNAME', 'USERDOMAIN',
                   'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'}
        environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        environment['WEBVIEW2_USER_DATA_FOLDER'] = str(runtime / 'webview2')
        for candidate_port in range(9300, 9400):
            with socket.socket() as reservation:
                try:
                    reservation.bind(('127.0.0.1', candidate_port))
                except OSError:
                    continue
                diagnostic_port = candidate_port
                break
        assert diagnostic_port, 'no unused diagnostic port'
        environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--disable-background-networking --disable-component-update --disable-sync --remote-debugging-address=127.0.0.1 --remote-debugging-port=' + str(diagnostic_port)
        assert not any(key.upper().startswith(('GH_', 'GITHUB_', 'CLAUDE', 'ANTHROPIC', 'OPENAI', 'MYCMUX_')) for key in environment)
        owned['child_environment_keys'] = sorted(environment)
        block = ctypes.create_unicode_buffer('\0'.join(f'{key}={value}' for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + '\0\0')
        startup = Startup()
        startup.cb = ctypes.sizeof(startup)
        startup.desktop = 'WinSta0\\mycmux-' + profile
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(binary), '--profile', profile]))
        require(create_process(str(binary), command, None, None, False, 0x0404, block, str(output), ctypes.byref(startup), ctypes.byref(info)), 'create suspended isolated app')
        require(assign_job(job, info.process), 'assign app to owned job')
        assigned = True
        require(resume(info.thread) != 0xFFFFFFFF, 'resume isolated app')
        owned['pid'] = int(info.pid)
        backend = until(lambda: call('system.version'), 30, 'backend socket ready')
        assert backend['app_version'] == '0.88.6'
        owned['checks'].append({'name': 'backend-ready', 'passed': True, 'app_version': backend['app_version'], 'api': backend['api']})
        ready = until(lambda: call('workspace.list'), 90, 'frontend socket ready')
        owned['checks'].append({'name': 'frontend-ready', 'passed': True, 'initial_workspaces': len(ready['workspaces'])})
        created = call('workspace.new', {'name': 'Synthetic CI smoke', 'grid': '1x1', 'cwd': str(output)})
        workspace_id = created['workspaceId']
        emitter = output / 'synthetic_clock.py'
        emitter.write_text('import time\nfor counter in range(180):\n    print("SYNTHETIC-CI-CLOCK", counter, flush=True)\n    time.sleep(0.5)\n', encoding='utf-8')
        spawned = call('pane.spawn', {'workspaceId': workspace_id, 'commandArgv': [sys.executable, '-I', '-u', str(emitter)],
                                     'activate': False, 'label': 'Synthetic clock', 'cwd': str(output)})
        session_id = spawned['sessionId']

        def counter():
            lines = call('pane.read', {'sessionId': session_id, 'lines': 100})['lines']
            matches = re.findall(r'SYNTHETIC-CI-CLOCK\s+(\d+)', '\n'.join(lines))
            return max(map(int, matches)) if matches else None

        first = until(lambda: (value if (value := counter()) is not None and value >= 1 else None), 45, 'first PTY output')
        second = until(lambda: (value if (value := counter()) is not None and value > first else None), 20, 'continued PTY output')
        owned['checks'].append({'name': 'same-session-output-advances', 'passed': second > first, 'first': first, 'second': second})
        saved = profile_root / 'data.json'

        def persisted():
            if not saved.exists():
                return None
            data = json.loads(saved.read_text(encoding='utf-8'))
            return data if any(workspace.get('id') == workspace_id for workspace in data.get('workspaces', [])) else None

        stored = until(persisted, 30, 'isolated workspace persistence')
        assert not (data_root / 'data.json').exists() and not (home / '.mycmux').exists()
        owned['checks'].append({'name': 'profile-only-persistence', 'passed': True, 'workspace_count': len(stored['workspaces'])})
        current = require(open_input(0, False, 0x0041), 'reopen input desktop')
        try:
            assert desktop_name(current) == owned['input_desktop_before']
            assert not root_windows(current)
        finally:
            close_desktop(current)
        hidden_windows = root_windows(desktop)
        assert hidden_windows, 'no real application windows on isolated desktop'
        owned['checks'].append({'name': 'hidden-desktop-only', 'passed': True, 'owned_windows': len(hidden_windows)})
        owned['foreground_after'] = int(foreground() or 0)
        owned['status'] = 'passed'
    except Exception as error:
        owned.update(status='failed', error=type(error).__name__ + ': ' + str(error))
    finally:
        try:
            diagnostic = diagnostic_snapshot()
            (output / 'safe-diagnostic.json').write_text(json.dumps(diagnostic, indent=2) + '\n', encoding='utf-8')
            owned['diagnostic_file'] = 'safe-diagnostic.json'
        except Exception as error:
            owned['diagnostic_error'] = type(error).__name__
        cleanup = {'job_assigned': assigned}
        if job and assigned:
            cleanup['job_terminate_ok'] = bool(terminate_job(job, 0))
            deadline = time.monotonic() + 15
            state = Accounting()
            queried = False
            while time.monotonic() < deadline:
                queried = bool(query_job(job, 1, ctypes.byref(state), ctypes.sizeof(state), None))
                if not queried or state.active == 0:
                    break
                time.sleep(0.2)
            cleanup['active_owned_processes'] = int(state.active) if queried else None
            cleanup['job_query_ok'] = queried
            if not queried or state.active or not cleanup['job_terminate_ok']:
                owned['status'] = 'failed'
        elif info.process:
            cleanup['suspended_root_terminated'] = bool(terminate_process(info.process, 1))
        if info.process:
            cleanup['root_exited'] = wait_process(info.process, 10000) == 0
        for handle in [info.thread, info.process, job]:
            if handle:
                close_handle(handle)
        if desktop:
            cleanup['desktop_closed'] = bool(close_desktop(desktop))
        if input_desktop:
            close_desktop(input_desktop)
        if cleanup.get('root_exited') is False or cleanup.get('desktop_closed') is False:
            owned['status'] = 'failed'
        owned['cleanup'] = cleanup
        owned['finished_at'] = datetime.now().astimezone().isoformat()
        owned['scope'] = 'distribution executable hidden startup, PTY output and profile persistence; not I0 transfer or AI-log GUI acceptance'
        (output / 'smoke-receipt.json').write_text(json.dumps(owned, indent=2) + '\n', encoding='utf-8')
        print('HIDDEN_SMOKE', owned['status'], owned.get('error', ''), flush=True)
    return 0 if owned['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
