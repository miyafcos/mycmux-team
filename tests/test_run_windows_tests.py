"""Windows Rust runner accounting with fixed libtest process output."""

from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from scripts import run_windows_tests as runner


EMPTY = """running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
"""
PASSING = """running 1 test
test sample ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
"""
FAILING = """running 1 test
test sample ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
"""
LIB = "mycmux_lib-deadbeef.exe"
BIN = "mycmux-deadbeef.exe"


@pytest.mark.parametrize(
    ("outputs", "status", "message"),
    [
        pytest.param({LIB: (EMPTY, 0), BIN: (EMPTY, 0)}, 1, "no Rust tests ran", id="zero-tests"),
        pytest.param({LIB: ("no summary\n", 0), BIN: (PASSING, 0)}, 1, "missing mycmux_lib", id="missing-lib-summary"),
        pytest.param({BIN: (PASSING, 0)}, 1, "missing mycmux_lib", id="missing-lib-binary"),
        pytest.param({LIB: (PASSING, 0), BIN: (EMPTY, 0)}, 0, "1 Rust tests ran", id="empty-companion"),
        pytest.param({LIB: (EMPTY, 0), BIN: (PASSING, 0)}, 0, "1 Rust tests ran", id="count-across-binaries"),
        pytest.param({LIB: (FAILING, 101)}, 1, "exit 101", id="failed-test"),
        pytest.param({LIB: (FAILING, 0)}, 1, "summary reports 1 failed", id="failed-summary-zero-exit"),
        pytest.param(
            {LIB: (FAILING + PASSING, 0)}, 1, "summary reports 1 failed",
            id="earlier-failed-summary-zero-exit",
        ),
    ],
)
def test_windows_rust_harness_requires_executed_tests_and_a_lib_summary(
    monkeypatch, tmp_path, capsys, outputs, status, message
):
    exes = [tmp_path / name for name in outputs]
    for exe in exes:
        exe.touch()
    monkeypatch.setattr(runner, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(runner, "MANIFEST", Path(__file__))
    monkeypatch.setattr(runner, "build_test_binaries", lambda _: exes)
    monkeypatch.setattr(runner, "find_mt_exe", lambda: tmp_path / "mt.exe")
    monkeypatch.setattr(runner, "embed_manifest", lambda *_: None)
    monkeypatch.setattr(sys, "argv", ["run_windows_tests.py"])

    def fake_executable(argv):
        stdout, code = outputs[Path(argv[0]).name]
        program = "import sys; print(sys.argv[1], end=''); sys.exit(int(sys.argv[2]))"
        return [sys.executable, "-c", program, stdout, str(code)]

    monkeypatch.setattr(runner, "subprocess", SimpleNamespace(
        PIPE=subprocess.PIPE,
        run=lambda argv, **kwargs: subprocess.run(fake_executable(argv), **kwargs),
        Popen=lambda argv, **kwargs: subprocess.Popen(fake_executable(argv), **kwargs),
    ))

    assert runner.main() == status
    captured = capsys.readouterr()
    assert message in captured.out + captured.err
