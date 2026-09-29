"""Keep the JSON export and the shipped bash directory reader compatible."""

from __future__ import annotations

import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
STRINGS = ROOT / "src-tauri" / "src" / "launcher_dirs" / "strings.rs"
LAUNCHER = ROOT / "src-tauri" / "src" / "launcher.sh"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def shell_function(name: str) -> str:
    match = re.search(rf"(?m)^{re.escape(name)}\(\) \{{[\s\S]*?^\}}", read(LAUNCHER))
    assert match is not None, f"missing bash function: {name}"
    return match.group(0)


def run_shell(script: str) -> list[str]:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    result = subprocess.run(
        [bash, "-s"], input=script, capture_output=True, text=True,
        encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()


def test_anken_prefix_and_field_separator_match_the_bash_reader() -> None:
    strings = read(STRINGS)
    prefix = re.search(r'pub const ANKEN_PREFIX: &str = "([^"]+)";', strings)
    assert prefix is not None
    assert prefix.group(1) == "\u6848\u4ef6: "
    assert "pub const FIELD_SEPARATOR: char = '|';" in strings
    reader = shell_function("__load_roots_section")
    # Only the colon form routes to anken; a dev label such as "\u6848\u4ef6tool"
    # stays in dev, exactly like the Rust importer (strip_prefix on "\u6848\u4ef6:").
    assert "'\u6848\u4ef6:'*)" in reader
    assert "\u6848\u4ef6*)" not in reader
    assert "IFS='|'" in reader


def test_short_root_key_is_shared_between_rust_and_bash() -> None:
    key = re.search(r'pub const SHORT_ROOT_KEY: &str = "([^"]+)";', read(STRINGS))
    assert key is not None
    assert key.group(1) == "# short-root:"
    assert key.group(1) in shell_function("__load_short_roots")
    assert "__load_short_roots" in shell_function("__short_path_into")


def test_bash_has_no_private_refresh_script_or_private_path_component() -> None:
    source = read(LAUNCHER)
    assert "update_launch_anken" not in source
    assert "__refresh_anken_roots_bg" not in source
    assert "\u4e8b\u52d9\u95a2\u4fc2" not in source


def test_retired_directory_api_is_absent_from_both_source_trees() -> None:
    retired = (b"launcher_list_dirs", b"listLauncherDirs")
    offenders = []
    for tree in (ROOT / "src", ROOT / "src-tauri" / "src"):
        for path in tree.rglob("*"):
            if path.is_file() and any(name in path.read_bytes() for name in retired):
                offenders.append(str(path.relative_to(ROOT)))
    assert not offenders, offenders


def test_recording_mru_does_not_broadcast_a_ledger_change() -> None:
    commands = read(ROOT / "src-tauri" / "src" / "commands" / "launcher.rs")
    mru = re.search(
        r"pub async fn launcher_record_dir_mru\([^)]*\)[\s\S]*?^\}",
        commands, re.MULTILINE,
    )
    assert mru is not None
    assert "store::record_dir_mru(" in mru.group(0)
    assert "launcher-dirs://changed" not in mru.group(0)
    assert ".emit(" not in mru.group(0)
    assert "change(" not in mru.group(0)


def test_short_paths_use_configured_roots_boundaries_and_home_fallback(tmp_path: Path) -> None:
    roots = tmp_path / "launch-roots.txt"
    roots.write_text(
        "# ignored comment\n# short-root:  C:\\Work Root\\  \n"
        "# short-root: /tmp/clients\n# short-root:   \n"
        "# short-root: /final/root", encoding="utf-8",
    )
    functions = "\n".join(shell_function(name) for name in ("__load_short_roots", "__short_path_into"))
    script = f"__ROOTS_FILE={shlex.quote(roots.as_posix())}\n{functions}\n" + r'''
__load_short_roots
for path in 'C:\Work Root\repo\nested' '/tmp/clients/Example A' '/final/root/repo' 'C:/Work Roots/sibling' '/unknown/path'; do
  __short_path_into "$path"
  printf '%s\n' "$__SHORT_RESULT"
done
__short_path_into "$HOME"
printf '%s\n' "$__SHORT_RESULT"
__short_path_into "$HOME/inside/repo"
printf '%s\n' "$__SHORT_RESULT"
# Replacing the test catalog cannot invalidate the per-process cached roots.
printf '%s\n' '# short-root: /different' > "$__ROOTS_FILE"
__short_path_into '/tmp/clients/still-cached'
printf '%s\n' "$__SHORT_RESULT"
'''
    assert run_shell(script) == [
        "\u2026/repo/nested", "\u2026/Example A", "\u2026/repo",
        "C:/Work Roots/sibling", "/unknown/path", "~", "~/inside/repo",
        "\u2026/still-cached",
    ]


def test_empty_profile_has_the_same_home_shortening(tmp_path: Path) -> None:
    script = (
        f"__ROOTS_FILE={shlex.quote((tmp_path / 'missing.txt').as_posix())}\n"
        + shell_function("__load_short_roots") + "\n"
        + shell_function("__short_path_into") + "\n"
        + '__short_path_into "$HOME/repo"\nprintf "%s\\n" "$__SHORT_RESULT"\n'
    )
    assert run_shell(script) == ["~/repo"]


def test_dev_and_anken_keys_still_read_the_exported_row_format(tmp_path: Path) -> None:
    roots = tmp_path / "launch-roots.txt"
    roots.write_text(
        "# generated header\n# short-root: C:/work\n"
        "# === AUTO-DEV BEGIN ===\n"
        "Repo|C:/work/repo\n"
        "# === AUTO-DEV END ===\n"
        "# === AUTO-ANKEN BEGIN ===\n"
        "\u6848\u4ef6: Client (\u25cf09/05)|C:/work/client with spaces\n"
        "# === AUTO-ANKEN END ===\n",
        encoding="utf-8",
    )
    script = (
        f"__ROOTS_FILE={shlex.quote(roots.as_posix())}\n"
        + shell_function("__load_roots_section") + "\n"
        + r'''
for mode in dev anken; do
  __load_roots_section "$mode"
  printf '%s|%s|%s\n' "$mode" "${__PICK_LABELS[0]}" "${__PICK_PATHS[0]}"
done
'''
    )
    assert run_shell(script) == [
        "dev|Repo|C:/work/repo",
        "anken|Client (\u25cf09/05)|C:/work/client with spaces",
    ]


def test_rule_roots_are_exported_as_short_root_comments() -> None:
    exporter = read(ROOT / "src-tauri" / "src" / "launcher_dirs" / "export.rs")
    loop = re.search(r"for root in doc([\s\S]*?)    for section", exporter)
    assert loop is not None
    source = loop.group(1)
    assert ".rules" in source
    assert 'rule.get("root")' in source
    assert "normalize_path(root)" in source
    assert "strings::SHORT_ROOT_KEY" in source
    assert '{root}\\n' in source
    key = re.search(r'pub const SHORT_ROOT_KEY: &str = "([^"]+)";', read(STRINGS))
    assert key is not None
    assert key.group(1) in shell_function("__load_short_roots")


def run_shell_bytes(script: str) -> bytes:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    result = subprocess.run(
        [bash, "--noprofile", "--norc", "-s"],
        input=script.encode("utf-8"),
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    return result.stdout


def test_bash_roots_reader_tolerates_crlf_and_missing_final_newline(tmp_path: Path) -> None:
    roots = tmp_path / "launch-roots.txt"
    # CRLF rows, last row has CR but no LF. Paths are ASCII so ${#path} is bytes.
    repo, client = "C:/work/repo", "C:/work/client"
    roots.write_bytes(
        f"Repo|{repo}\r\n".encode("ascii")
        + f"\u6848\u4ef6: Client|{client}\r".encode("utf-8"),
    )
    script = (
        f"__ROOTS_FILE={shlex.quote(roots.as_posix())}\n"
        + shell_function("__load_roots_section") + "\n"
        + r'''
__load_roots_section dev
printf '%s|%s|%s\n' "${__PICK_LABELS[0]}" "${__PICK_PATHS[0]}" "${#__PICK_PATHS[0]}"
__load_roots_section anken
printf '%s|%s|%s\n' "${__PICK_LABELS[0]}" "${__PICK_PATHS[0]}" "${#__PICK_PATHS[0]}"
'''
    )
    raw = run_shell_bytes(script)
    assert b"\r" not in raw
    assert raw.decode("utf-8").split("\n") == [
        f"Repo|{repo}|{len(repo)}",
        f"Client|{client}|{len(client)}",
        "",
    ]


def test_anken_routing_uses_colon_form_only(tmp_path: Path) -> None:
    roots = tmp_path / "launch-roots.txt"
    roots.write_text(
        "\u6848\u4ef6tool|C:/d\n"
        "\u6848\u4ef6: Client|C:/c\n"
        "\u6848\u4ef6\uff1atool|C:/t\n",
        encoding="utf-8",
    )
    script = (
        f"__ROOTS_FILE={shlex.quote(roots.as_posix())}\n"
        + shell_function("__load_roots_section") + "\n"
        + r'''
__load_roots_section dev
printf 'dev-count=%s\n' "${#__PICK_LABELS[@]}"
printf 'dev0|%s|%s\n' "${__PICK_LABELS[0]}" "${__PICK_PATHS[0]}"
printf 'dev1|%s|%s\n' "${__PICK_LABELS[1]}" "${__PICK_PATHS[1]}"
__load_roots_section anken
printf 'anken-count=%s\n' "${#__PICK_LABELS[@]}"
printf 'anken0|%s|%s\n' "${__PICK_LABELS[0]}" "${__PICK_PATHS[0]}"
'''
    )
    assert run_shell(script) == [
        "dev-count=2",
        "dev0|\u6848\u4ef6tool|C:/d",
        "dev1|\u6848\u4ef6\uff1atool|C:/t",
        "anken-count=1",
        "anken0|Client|C:/c",
    ]


def test_record_dir_mru_uses_per_process_temp_and_leaves_no_tmp(tmp_path: Path) -> None:
    mru = tmp_path / "launch-dirs-mru.txt"
    p1 = (tmp_path / "one").as_posix()
    p2 = (tmp_path / "two").as_posix()
    p3 = (tmp_path / "three").as_posix()
    script = (
        f"__DIR_MRU_FILE={shlex.quote(mru.as_posix())}\n"
        + shell_function("__record_dir_mru") + "\n"
        + f"__record_dir_mru {shlex.quote(p1)}\n"
        + f"__record_dir_mru {shlex.quote(p2)}\n"
        + f"__record_dir_mru {shlex.quote(p3)}\n"
        + f"__record_dir_mru {shlex.quote(p2)}\n"
        + "printf '%s\\n' \"$(cat \"$__DIR_MRU_FILE\")\"\n"
    )
    assert run_shell(script) == [p2, p3, p1]
    assert mru.read_text(encoding="utf-8").splitlines() == [p2, p3, p1]
    assert list(tmp_path.glob("launch-dirs-mru.txt.tmp*")) == []


def test_mru_reader_tolerates_crlf_and_missing_final_newline(tmp_path: Path) -> None:
    target = tmp_path / "\u65e5\u672c" / "repo"
    target.mkdir(parents=True)
    path = target.as_posix()
    mru = tmp_path / "launch-dirs-mru.txt"
    mru.write_bytes(f"{path}\r".encode("utf-8"))
    # The C locale exists everywhere (macOS has no C.UTF-8), and under it Bash's
    # ${#var} counts bytes, so the length is compared against the UTF-8 byte count.
    script = (
        "export LC_ALL=C\n"
        f"__DIR_MRU_FILE={shlex.quote(mru.as_posix())}\n"
        f"__ROOTS_FILE={shlex.quote((tmp_path / 'missing.txt').as_posix())}\n"
        + "\n".join(shell_function(name) for name in (
            "__load_short_roots", "__short_path_into", "__short_path", "__select_launch_root",
        )) + "\n"
        + r'''
__pick_list() {
  printf '%s|%s\n' "${__PICK_PATHS[0]}" "${#__PICK_PATHS[0]}"
  return 1
}
__select_launch_root mru || true
'''
    )
    raw = run_shell_bytes(script)
    assert b"\r" not in raw
    decoded = raw.decode("utf-8")
    assert decoded.split("\n") == [f"{path}|{len(path.encode('utf-8'))}", ""]
    assert decoded.startswith(path)
    reader = shell_function("__select_launch_root")
    assert "while IFS= read -r line || [ -n \"$line\" ]; do" in reader
    assert "line=\"${line%$'\\r'}\"" in reader
