from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"


def test_macos_associations_are_alternate_and_windows_common_config_has_none():
    common = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    mac = json.loads((TAURI / "tauri.macos.conf.json").read_text(encoding="utf-8"))
    assert "fileAssociations" not in common["bundle"]
    associations = mac["bundle"]["fileAssociations"]
    assert {ext for item in associations for ext in item["ext"]} == {
        "md", "markdown", "html", "htm"
    }
    assert all(item["rank"] == "Alternate" and item["role"] == "Viewer" for item in associations)
    assert {item["contentTypes"][0] for item in associations} == {
        "net.daringfireball.markdown", "public.html"
    }


def test_nsis_uninstall_removes_only_the_values_and_keys_we_register():
    common = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    hook_path = TAURI / common["bundle"]["windows"]["nsis"]["installerHooks"]
    hook = hook_path.read_text(encoding="utf-8")
    source = (TAURI / "src/open_with_windows.rs").read_text(encoding="utf-8")
    types = re.findall(r'\("(\.[a-z]+)", "(mycmux\.[a-z]+)",', source)
    assert types == [
        (".md", "mycmux.markdown"),
        (".markdown", "mycmux.markdown"),
        (".html", "mycmux.html"),
        (".htm", "mycmux.html"),
    ]
    removed_values = set(re.findall(r'DeleteRegValue HKCU "([^"]+)" "([^"]+)"', hook))
    assert removed_values == {
        (rf"Software\Classes\{ext}\OpenWithProgids", prog_id)
        for ext, prog_id in types
    }
    removed_keys = set(re.findall(r'DeleteRegKey HKCU "([^"]+)"', hook))
    assert removed_keys == {
        r"Software\Classes\mycmux.markdown",
        r"Software\Classes\mycmux.html",
        r"Software\Classes\Applications\mycmux.exe",
    }
    empty_only = set(re.findall(r'DeleteRegKey /ifempty HKCU "([^"]+)"', hook))
    assert empty_only == {rf"Software\Classes\{ext}\OpenWithProgids" for ext, _ in types}
    assert "UserChoice" not in hook


def test_open_commands_stay_behind_socket_auth_and_out_of_frontend_broadcast():
    socket = (TAURI / "src/socket.rs").read_text(encoding="utf-8")
    assert socket.index("if !auth.authorize") < socket.index('if cmd == "app.open_paths"')
    assert socket.index('if cmd == "app.open_paths"') < socket.index('app.emit("socket-request"')
    assert socket.index('if cmd == "app.activate"') < socket.index('app.emit("socket-request"')
    open_with = (TAURI / "src/open_with.rs").read_text(encoding="utf-8")
    assert 'app.emit_to("main", OPEN_PATHS_EVENT' in open_with
