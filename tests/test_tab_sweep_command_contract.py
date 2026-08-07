from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_tab_sweep_command_is_wired_end_to_end() -> None:
    assert "pub mod tab_sweep;" in read("src-tauri/src/commands/mod.rs")
    assert "commands::tab_sweep::run_tab_sweep_judge" in read("src-tauri/src/lib.rs")
    assert "pub async fn run_tab_sweep_judge" in read("src-tauri/src/commands/tab_sweep.rs")
    assert 'invoke<string>("run_tab_sweep_judge"' in read(
        "src/components/layout/TabSweepPanel.tsx"
    )


def test_judge_action_never_applies_or_closes_tabs_implicitly() -> None:
    panel = read("src/components/layout/TabSweepPanel.tsx")
    match = re.search(
        r"const runJudge = async \(\) => \{(?P<body>.*?)\n  \};\n\n  const applyAndRefresh",
        panel,
        re.DOTALL,
    )
    assert match is not None
    body = match.group("body")
    assert "applySweep" not in body
    assert "applyAndRefresh" not in body
    assert "closeCandidateTabIds" not in body
    assert "pane.close_tab" not in body
    assert 'setVerdicts(parseJudgeOutput("", ids))' in body


def test_judge_process_uses_stdin_pipes_and_a_clean_environment() -> None:
    source = read("src-tauri/src/commands/tab_sweep.rs")
    assert ".env_clear()" in source
    assert ".stdin(Stdio::piped())" in source
    assert ".stdout(Stdio::piped())" in source
    assert ".stderr(Stdio::piped())" in source
    assert "stdin.write_all(prompt.as_bytes())" in source
    assert ".arg(prompt)" not in source
