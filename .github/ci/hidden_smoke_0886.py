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


SOCKET_RECEIVE_SECONDS = 35.0
SOCKET_FRAME_LIMIT = 4 * 1024 * 1024


def remaining_timeout(deadline: float, ceiling: float | None = None) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('socket operation deadline expired')
    return min(remaining, ceiling) if ceiling is not None else remaining


def socket_exchange(port: int, request: dict, deadline: float) -> dict:
    payload = (json.dumps(request) + '\n').encode('utf-8')
    with socket.create_connection(('127.0.0.1', port), timeout=remaining_timeout(deadline, 10.0)) as connection:
        connection.settimeout(remaining_timeout(deadline))
        connection.sendall(payload)
        response_bytes = bytearray()
        while True:
            connection.settimeout(remaining_timeout(deadline))
            chunk = connection.recv(min(65536, SOCKET_FRAME_LIMIT + 1 - len(response_bytes)))
            if not chunk:
                raise ConnectionError('socket closed before a complete response')
            response_bytes.extend(chunk)
            newline = response_bytes.find(b'\n')
            if newline >= 0:
                if newline > SOCKET_FRAME_LIMIT:
                    raise ValueError('socket response exceeds frame limit')
                response = json.loads(response_bytes[:newline])
                if not isinstance(response, dict):
                    raise ValueError('socket response must be an object')
                return response
            if len(response_bytes) > SOCKET_FRAME_LIMIT:
                raise ValueError('socket response exceeds frame limit')


def listener_state(listeners: list[dict]) -> str:
    if not listeners:
        return 'no_ipv4_listener'
    if any(not isinstance(row.get('OwningProcess'), int) or isinstance(row.get('OwningProcess'), bool)
           or row['OwningProcess'] <= 0 or not isinstance(row.get('LocalAddress'), str) for row in listeners):
        return 'invalid_listener_metadata'
    if any(row['LocalAddress'] != '127.0.0.1' for row in listeners):
        return 'non_loopback_listener'
    return 'loopback_owner_unverified'


class ProcessCommandLine(ctypes.Structure):
    _fields_ = [('length', wintypes.USHORT), ('maximum_length', wintypes.USHORT), ('buffer', ctypes.c_void_p)]


def command_line_flags(command_line: str, expected_port: int, expected_directory: Path) -> dict:
    def argument(name: str):
        match = re.search(r'(?:^|\s)"?' + re.escape(name) + r'=(?:"([^"]*)"|([^\s"]+))', command_line)
        return (match.group(1) if match.group(1) is not None else match.group(2)) if match else None
    port = argument('--remote-debugging-port')
    directory = argument('--user-data-dir')
    process_type = argument('--type')
    allowed_types = {'renderer', 'gpu-process', 'utility', 'crashpad-handler', 'broker', 'service-worker'}
    return {'process_type': process_type if process_type in allowed_types else ('browser-or-host' if process_type is None else 'other'),
            'remote_debugging_port_present': port is not None, 'remote_debugging_port_matches': port == str(expected_port),
            'user_data_dir_present': directory is not None,
            'user_data_dir_matches': directory is not None and os.path.normcase(os.path.normpath(directory)) == os.path.normcase(str(expected_directory)),
            'remote_debugging_pipe': '--remote-debugging-pipe' in command_line,
            'disable_background_networking': '--disable-background-networking' in command_line,
            'no_sandbox': '--no-sandbox' in command_line}


def process_summary(handle, expected_port: int, expected_directory: Path) -> dict:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    query_image = bind(kernel, 'QueryFullProcessImageNameW', [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
    exit_code = bind(kernel, 'GetExitCodeProcess', [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
    size = wintypes.DWORD(32768)
    image = ctypes.create_unicode_buffer(size.value)
    if not query_image(handle, 0, image, ctypes.byref(size)):
        raise OSError(ctypes.get_last_error(), 'owned process image query')
    status = wintypes.DWORD()
    if not exit_code(handle, ctypes.byref(status)):
        raise OSError(ctypes.get_last_error(), 'owned process status query')
    result = {'image': Path(image.value).name, 'exit_code': int(status.value), 'active': status.value == 259}
    native = ctypes.WinDLL('ntdll')
    query = bind(native, 'NtQueryInformationProcess', [wintypes.HANDLE, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)], ctypes.c_long)
    required = ctypes.c_ulong()
    query(handle, 60, None, 0, ctypes.byref(required))
    if required.value < ctypes.sizeof(ProcessCommandLine) or required.value > 262144:
        result['argument_query'] = 'size_unavailable'
        return result
    payload = ctypes.create_string_buffer(required.value)
    status_code = query(handle, 60, payload, len(payload), ctypes.byref(required))
    if status_code != 0:
        result['argument_query'] = 'ntstatus_' + hex(status_code & 0xFFFFFFFF)
        return result
    descriptor = ProcessCommandLine.from_buffer(payload)
    start = ctypes.addressof(payload)
    pointer = int(descriptor.buffer or 0)
    if descriptor.length % 2 or pointer < start or pointer + descriptor.length > start + len(payload):
        result['argument_query'] = 'invalid_buffer'
        return result
    command_line = ctypes.string_at(pointer, descriptor.length).decode('utf-16-le')
    result.update(argument_query='filtered', flags=command_line_flags(command_line, expected_port, expected_directory))
    return result


def owned_process_diagnostics(job, expected_port: int, expected_directory: Path) -> dict:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    query = bind(kernel, 'QueryInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL)
    open_owned = bind(kernel, 'OpenProcess', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE)
    belongs_to_job = bind(kernel, 'IsProcessInJob', [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL)
    close = bind(kernel, 'CloseHandle', [wintypes.HANDLE], wintypes.BOOL)
    payload = ctypes.create_string_buffer(8 + 4096 * ctypes.sizeof(ctypes.c_size_t))
    if not query(job, 3, payload, len(payload), None):
        raise OSError(ctypes.get_last_error(), 'owned job process enumeration')
    assigned, count = (wintypes.DWORD * 2).from_buffer(payload)
    if count > 4096 or assigned != count:
        raise RuntimeError('owned job process list changed or exceeded limit')
    identifiers = (ctypes.c_size_t * count).from_buffer(payload, 8)
    records = []
    for process_id in identifiers:
        entry = {'pid': int(process_id)}
        handle = open_owned(0x1000, False, process_id)
        if not handle:
            entry['error'] = 'process_handle_unavailable'
            records.append(entry)
            continue
        try:
            belongs = wintypes.BOOL()
            if not belongs_to_job(handle, job, ctypes.byref(belongs)) or not belongs.value:
                entry['error'] = 'job_membership_not_confirmed'
            else:
                entry.update(process_summary(handle, expected_port, expected_directory))
        except Exception as error:
            entry['error'] = type(error).__name__
        finally:
            close(handle)
        records.append(entry)
    return {'assigned': int(assigned), 'records': records, 'raw_arguments_recorded': False}


def create_medium_process(binary, command, block, directory, startup, info, evidence: dict) -> dict:
    security = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    open_token = bind(security, 'OpenProcessToken', [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)], wintypes.BOOL)
    token_information = bind(security, 'GetTokenInformation', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
    create_restricted = bind(security, 'CreateRestrictedToken', [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.HANDLE)], wintypes.BOOL)
    convert_sid = bind(security, 'ConvertStringSidToSidW', [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)], wintypes.BOOL)
    set_token = bind(security, 'SetTokenInformation', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL)
    sid_length = bind(security, 'GetLengthSid', [ctypes.c_void_p], wintypes.DWORD)
    count_subauthorities = bind(security, 'GetSidSubAuthorityCount', [ctypes.c_void_p], ctypes.POINTER(ctypes.c_ubyte))
    subauthority = bind(security, 'GetSidSubAuthority', [ctypes.c_void_p, wintypes.DWORD], ctypes.POINTER(wintypes.DWORD))
    equal_sid = bind(security, 'EqualSid', [ctypes.c_void_p, ctypes.c_void_p], wintypes.BOOL)
    create_as_user = bind(security, 'CreateProcessAsUserW', [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
                          wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(Startup), ctypes.POINTER(ProcessInfo)], wintypes.BOOL)
    current_process = bind(kernel, 'GetCurrentProcess', [], wintypes.HANDLE)
    close = bind(kernel, 'CloseHandle', [wintypes.HANDLE], wintypes.BOOL)
    local_free = bind(kernel, 'LocalFree', [ctypes.c_void_p], ctypes.c_void_p)

    class SidAttributes(ctypes.Structure):
        _fields_ = [('sid', ctypes.c_void_p), ('attributes', wintypes.DWORD)]

    def checked(result, label: str):
        if not result:
            raise OSError(ctypes.get_last_error(), label)
        return result

    def information(token, kind: int):
        size = wintypes.DWORD()
        token_information(token, kind, None, 0, ctypes.byref(size))
        assert 0 < size.value < 65536
        payload = ctypes.create_string_buffer(size.value)
        checked(token_information(token, kind, payload, len(payload), ctypes.byref(size)), 'read token information ' + str(kind))
        return payload

    def summary(token) -> dict:
        integrity = information(token, 25)
        descriptor = SidAttributes.from_buffer(integrity)
        count = int(count_subauthorities(descriptor.sid).contents.value)
        assert count > 0
        level = int(subauthority(descriptor.sid, count - 1).contents.value)
        elevation = information(token, 20)
        return {'integrity_rid': level, 'elevated': bool(wintypes.DWORD.from_buffer(elevation).value)}

    original = wintypes.HANDLE()
    restricted = wintypes.HANDLE()
    child = wintypes.HANDLE()
    medium_sid = ctypes.c_void_p()
    try:
        checked(open_token(current_process(), 0x008B, ctypes.byref(original)), 'open own process token')
        parent_state = summary(original)
        evidence['parent'] = parent_state
        assert parent_state['integrity_rid'] > 8192, 'host is not high integrity; do not vary this condition'
        checked(create_restricted(original, 5, 0, None, 0, None, 0, None, ctypes.byref(restricted)), 'restrict own token privileges and admin groups')
        checked(convert_sid('S-1-16-8192', ctypes.byref(medium_sid)), 'create medium integrity SID')
        label = SidAttributes(medium_sid.value, 0x20)
        checked(set_token(restricted, 25, ctypes.byref(label), ctypes.sizeof(label) + sid_length(medium_sid)), 'lower restricted token integrity')
        restricted_state = summary(restricted)
        evidence['restricted'] = restricted_state
        assert restricted_state == {'integrity_rid': 8192, 'elevated': False}, restricted_state
        original_user = information(original, 1)
        restricted_user = information(restricted, 1)
        assert equal_sid(SidAttributes.from_buffer(original_user).sid, SidAttributes.from_buffer(restricted_user).sid)
        checked(create_as_user(restricted, str(binary), command, None, None, False, 0x0404, block, str(directory), ctypes.byref(startup), ctypes.byref(info)),
                'create suspended same-user medium-integrity app')
        checked(open_token(info.process, 0x0008, ctypes.byref(child)), 'read suspended child token')
        child_state = summary(child)
        child_user = information(child, 1)
        assert child_state == restricted_state
        assert equal_sid(SidAttributes.from_buffer(original_user).sid, SidAttributes.from_buffer(child_user).sid)
        return {'parent': parent_state, 'restricted': restricted_state, 'child': child_state,
                'same_user': True, 'user_sid_logged': False, 'privileges_added': False}
    finally:
        if medium_sid:
            local_free(medium_sid)
        for token in [child, restricted, original]:
            if token:
                close(token)


class NoninteractiveStation:
    def __init__(self, name: str):
        assert re.fullmatch(r'mycmux-ci0886_\d+_\d+', name)
        self.name = name
        self.station = None
        self.desktop = None
        self.original_station = None
        self.original_desktop = None
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.security = ctypes.WinDLL('advapi32', use_last_error=True)
        self.get_station = bind(self.user, 'GetProcessWindowStation', [], wintypes.HANDLE)
        self.set_station = bind(self.user, 'SetProcessWindowStation', [wintypes.HANDLE], wintypes.BOOL)
        self.get_thread = bind(self.kernel, 'GetCurrentThreadId', [], wintypes.DWORD)
        self.get_desktop = bind(self.user, 'GetThreadDesktop', [wintypes.DWORD], wintypes.HANDLE)
        self.set_desktop = bind(self.user, 'SetThreadDesktop', [wintypes.HANDLE], wintypes.BOOL)
        self.close_station = bind(self.user, 'CloseWindowStation', [wintypes.HANDLE], wintypes.BOOL)
        self.close_desktop = bind(self.user, 'CloseDesktop', [wintypes.HANDLE], wintypes.BOOL)
        self.object_info = bind(self.user, 'GetUserObjectInformationW', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)

    def checked(self, value, label: str):
        if not value:
            raise OSError(ctypes.get_last_error(), label)
        return value

    def flags(self, handle) -> int:
        class UserObjectFlags(ctypes.Structure):
            _fields_ = [('inherit', wintypes.BOOL), ('reserved', wintypes.BOOL), ('flags', wintypes.DWORD)]
        flags = UserObjectFlags()
        size = wintypes.DWORD()
        self.checked(self.object_info(handle, 1, ctypes.byref(flags), ctypes.sizeof(flags), ctypes.byref(size)), 'read window station visibility')
        return int(flags.flags)

    def create(self) -> None:
        class SecurityAttributes(ctypes.Structure):
            _fields_ = [('length', wintypes.DWORD), ('descriptor', ctypes.c_void_p), ('inherit', wintypes.BOOL)]
        class SidAttributes(ctypes.Structure):
            _fields_ = [('sid', ctypes.c_void_p), ('attributes', wintypes.DWORD)]
        current = bind(self.kernel, 'GetCurrentProcess', [], wintypes.HANDLE)
        open_token = bind(self.security, 'OpenProcessToken', [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)], wintypes.BOOL)
        query = bind(self.security, 'GetTokenInformation', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
        sid_to_text = bind(self.security, 'ConvertSidToStringSidW', [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)], wintypes.BOOL)
        descriptor_from_text = bind(self.security, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
        create_station = bind(self.user, 'CreateWindowStationW', [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SecurityAttributes)], wintypes.HANDLE)
        create_desktop = bind(self.user, 'CreateDesktopW', [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SecurityAttributes)], wintypes.HANDLE)
        local_free = bind(self.kernel, 'LocalFree', [ctypes.c_void_p], ctypes.c_void_p)
        close = bind(self.kernel, 'CloseHandle', [wintypes.HANDLE], wintypes.BOOL)
        token = wintypes.HANDLE()
        sid_text = ctypes.c_void_p()
        descriptor = ctypes.c_void_p()
        self.original_station = self.checked(self.get_station(), 'get original station')
        self.original_desktop = self.checked(self.get_desktop(self.get_thread()), 'get original thread desktop')
        try:
            self.checked(open_token(current(), 8, ctypes.byref(token)), 'query own SID for private station ACL')
            size = wintypes.DWORD()
            query(token, 1, None, 0, ctypes.byref(size))
            assert 0 < size.value < 65536
            payload = ctypes.create_string_buffer(size.value)
            self.checked(query(token, 1, payload, len(payload), ctypes.byref(size)), 'read own token user')
            user_sid = SidAttributes.from_buffer(payload).sid
            self.checked(sid_to_text(user_sid, ctypes.byref(sid_text)), 'format own SID for private ACL')
            sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;' + ctypes.wstring_at(sid_text) + ')'
            self.checked(descriptor_from_text(sddl, 1, ctypes.byref(descriptor), None), 'build same-user and system station ACL')
            attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor.value, False)
            self.station = self.checked(create_station(self.name, 1, 0x000F037F, ctypes.byref(attributes)), 'create new noninteractive station')
            assert self.flags(self.station) & 1 == 0, 'station must not be visible'
            self.checked(self.set_station(self.station), 'connect host temporarily to private station')
            self.desktop = self.checked(create_desktop('Default', None, None, 0, 0x01FF, ctypes.byref(attributes)), 'create private Default desktop')
        finally:
            if self.original_station:
                self.checked(self.set_station(self.original_station), 'restore original station after create')
            for pointer in [descriptor, sid_text]:
                if pointer:
                    local_free(pointer)
            if token:
                close(token)

    def enter(self) -> None:
        self.checked(self.set_station(self.station), 'connect to private station')
        self.checked(self.set_desktop(self.desktop), 'connect own thread to private desktop')

    def restore(self) -> None:
        self.checked(self.set_station(self.original_station), 'restore own process station')
        self.checked(self.set_desktop(self.original_desktop), 'restore own thread desktop')

    def close(self) -> dict:
        if self.original_station:
            self.restore()
        result = {'host_station_restored': True, 'host_thread_desktop_restored': True}
        if self.desktop:
            result['private_desktop_closed'] = bool(self.close_desktop(self.desktop))
        if self.station:
            result['private_station_nonvisible'] = not bool(self.flags(self.station) & 1)
            result['private_station_closed'] = bool(self.close_station(self.station))
        return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--probe', type=Path, required=True)
    parser.add_argument('--version', choices=['0.88.5', '0.88.6'], required=True)
    args = parser.parse_args()
    assert os.name == 'nt' and os.environ.get('GITHUB_ACTIONS') == 'true', 'CI-only execution'
    assert os.environ.get('GITHUB_REPOSITORY') == 'miyafcos/mycmux-team'
    probe = args.probe.resolve()
    assert probe.is_file() and probe.name == 'webview_probe_0886.mjs'
    expected_sha, expected_size = {
        '0.88.5': ('87dff21cc99029708cea4428412c58d8e0fa7b8d02a91239dc01b4bc50d858aa', 75944448),
        '0.88.6': (EXPECTED_SHA, EXPECTED_SIZE),
    }[args.version]
    binary = args.exe.resolve()
    assert binary.is_file() and binary.stat().st_size == expected_size
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected_sha
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
    owned = {'at': datetime.now().astimezone().isoformat(), 'profile': profile, 'binary_sha256': expected_sha, 'version': args.version,
             'binary_size': expected_size, 'production_update': False, 'checks': [], 'status': 'started'}
    system = ctypes.WinDLL('kernel32', use_last_error=True)
    window = ctypes.WinDLL('user32', use_last_error=True)
    create_desktop = bind(window, 'CreateDesktopW', [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p], wintypes.HANDLE)
    close_desktop = bind(window, 'CloseDesktop', [wintypes.HANDLE], wintypes.BOOL)
    open_input = bind(window, 'OpenInputDesktop', [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE)
    object_info = bind(window, 'GetUserObjectInformationW', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL)
    foreground = bind(window, 'GetForegroundWindow', [], wintypes.HWND)
    window_text = bind(window, 'GetWindowTextW', [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int)
    class_name = bind(window, 'GetClassNameW', [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int)
    is_visible = bind(window, 'IsWindowVisible', [wintypes.HWND], wintypes.BOOL)
    show_window = bind(window, 'ShowWindowAsync', [wintypes.HWND, ctypes.c_int], wintypes.BOOL)
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
    station = None
    assigned = False
    diagnostic_port = None
    environment = None
    active_wait_deadline = None
    owned['socket_calls'] = []
    owned['job_samples'] = []
    job_clock = time.monotonic()
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
        if station is not None and handle == desktop:
            station.enter()
            try:
                require(enum_desktop(handle, collect, 0), 'enumerate owned private windows')
            finally:
                station.restore()
        else:
            require(enum_desktop(handle, collect, 0), 'enumerate owned windows')
        return result

    def record_job_sample():
        if not assigned:
            return
        state = Accounting()
        require(query_job(job, 1, ctypes.byref(state), ctypes.sizeof(state), None), 'sample owned job')
        sample = {'total': int(state.total), 'active': int(state.active), 'terminated': int(state.terminated)}
        previous = owned['job_samples'][-1] if owned['job_samples'] else None
        if previous is None or any(previous[key] != value for key, value in sample.items()):
            sample['elapsed_seconds'] = round(time.monotonic() - job_clock, 3)
            owned['job_samples'].append(sample)

    def call(name: str, values: dict | None = None):
        started = time.monotonic()
        outcome = {'command': name}
        try:
            port = int((runtime / 'mycmux.port').read_text(encoding='utf-8').strip())
            token = (runtime / 'mycmux.token').read_text(encoding='utf-8').strip()
            assert 0 < port < 65536 and token
            deadline = started + SOCKET_RECEIVE_SECONDS
            if active_wait_deadline is not None:
                deadline = min(deadline, active_wait_deadline)
            response = socket_exchange(port, {'cmd': name, 'args': values or {}, 'token': token}, deadline)
            if response.get('error') is not None:
                outcome['backend_error'] = scrub(str(response['error']))
                raise RuntimeError(name + ': ' + str(response['error']))
            outcome['status'] = 'response_received'
            return response.get('result')
        except Exception as error:
            outcome['status'] = 'failed'
            outcome['error_type'] = type(error).__name__
            raise
        finally:
            outcome['elapsed_seconds'] = round(time.monotonic() - started, 3)
            if len(owned['socket_calls']) < 200:
                owned['socket_calls'].append(outcome)

    def until(predicate, seconds: int, label: str):
        nonlocal active_wait_deadline
        deadline = time.monotonic() + seconds
        previous_deadline = active_wait_deadline
        active_wait_deadline = min(deadline, previous_deadline) if previous_deadline is not None else deadline
        last_error = None
        try:
            while time.monotonic() < active_wait_deadline:
                record_job_sample()
                if memory_gib() < 2:
                    raise RuntimeError('runtime stop gate: free RAM below 2 GiB')
                if info.process and wait_process(info.process, 0) == 0:
                    raise RuntimeError('test application exited before ' + label)
                try:
                    value = predicate()
                    if value:
                        return value
                except (OSError, ValueError, RuntimeError) as error:
                    last_error = type(error).__name__ + ': ' + str(error)
                delay = active_wait_deadline - time.monotonic()
                if delay > 0:
                    time.sleep(min(0.25, delay))
            raise TimeoutError(label + ': ' + str(last_error))
        finally:
            active_wait_deadline = previous_deadline

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
        record_job_sample()
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
        try:
            detail['owned_processes'] = owned_process_diagnostics(job, diagnostic_port, runtime / 'webview2')
        except Exception as error:
            detail['owned_processes'] = {'error_type': type(error).__name__}
        held = []
        try:
            listeners = tcp_listener_owners(diagnostic_port)
            detail['cdp'] = {'status': listener_state(listeners), 'address_family': 'IPv4', 'port': diagnostic_port, 'listeners': listeners}
            if detail['cdp']['status'] != 'loopback_owner_unverified':
                return detail
            owners = sorted({int(row['OwningProcess']) for row in listeners})
            for process_id in owners:
                handle = require(open_process(0x1000, False, process_id), 'hold CDP owner')
                held.append(handle)
                belongs = wintypes.BOOL()
                require(in_job(handle, job, ctypes.byref(belongs)), 'check CDP owner job')
                if not belongs.value:
                    detail['cdp']['status'] = 'owner_outside_job'
                    raise RuntimeError('CDP owner is outside the isolated job')
            detail['cdp'].update(status='owned_listener_verified', owners=owners)
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
        station = NoninteractiveStation('mycmux-' + profile)
        station.create()
        desktop = station.desktop
        owned['window_station'] = {'name': station.name, 'desktop': 'Default', 'visible': bool(station.flags(station.station) & 1), 'acl_same_user_and_system_only': True}
        assert not owned['window_station']['visible']
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
        startup.desktop = station.name + '\\Default'
        startup.flags = 1
        startup.show = 5
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(binary), '--profile', profile]))
        owned['token_probe'] = {}
        station.enter()
        try:
            owned['token_probe'].update(create_medium_process(binary, command, block, output, startup, info, owned['token_probe']))
        finally:
            station.restore()
        require(assign_job(job, info.process), 'assign app to owned job')
        assigned = True
        require(resume(info.thread) != 0xFFFFFFFF, 'resume isolated app')
        owned['pid'] = int(info.pid)
        backend = until(lambda: call('system.version'), 30, 'backend socket ready')
        assert backend['app_version'] == args.version
        owned['checks'].append({'name': 'backend-ready', 'passed': True, 'app_version': backend['app_version'], 'api': backend['api']})
        def main_window_candidate():
            candidates = []
            snapshots = []
            for hwnd in root_windows(desktop):
                title = ctypes.create_unicode_buffer(512)
                kind = ctypes.create_unicode_buffer(256)
                window_text(hwnd, title, len(title))
                class_name(hwnd, kind, len(kind))
                exact_profile = profile in title.value and 'mycmux' in title.value.lower()
                snapshots.append({'class': kind.value, 'title': scrub(title.value), 'profile_match': exact_profile, 'visible': bool(is_visible(hwnd))})
                if exact_profile:
                    candidates.append(hwnd)
            owned['isolated_window_identity'] = snapshots
            if len(candidates) > 1:
                raise RuntimeError('multiple profile main windows')
            return candidates if len(candidates) == 1 else None
        candidates = until(main_window_candidate, 20, 'isolated profile main window identity')
        station.enter()
        try:
            require(show_window(candidates[0], 4), 'show only noninteractive main window without activation')
        finally:
            station.restore()
        owned['checks'].append({'name': 'isolated-main-show-no-activate', 'passed': True, 'matching_windows': len(candidates)})
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
        if station is not None:
            cleanup.update(station.close())
            cleanup['desktop_closed'] = cleanup.get('private_desktop_closed', True)
            if cleanup.get('private_station_closed') is False:
                owned['status'] = 'failed'
        elif desktop:
            cleanup['desktop_closed'] = bool(close_desktop(desktop))
        if input_desktop:
            close_desktop(input_desktop)
        if cleanup.get('root_exited') is False or cleanup.get('desktop_closed') is False:
            owned['status'] = 'failed'
        owned['cleanup'] = cleanup
        owned['finished_at'] = datetime.now().astimezone().isoformat()
        owned['scope'] = 'distribution executable noninteractive-station startup, PTY output and profile persistence; not I0 transfer or AI-log GUI acceptance'
        (output / 'smoke-receipt.json').write_text(json.dumps(owned, indent=2) + '\n', encoding='utf-8')
        print('HIDDEN_SMOKE', owned['status'], owned.get('error', ''), flush=True)
    return 0 if owned['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
