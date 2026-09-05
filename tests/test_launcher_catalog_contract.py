"""The GUI agent catalog and the two launchers must describe the same menu.

`src/lib/agentCatalog.ts` is what the New Workspace dialog offers; the launchers
are what actually starts a process. They drifted before this catalog existed --
the old BUILT_IN_AGENTS list still offered a Gemini CLI that was sunset in June
2026 and never offered claude-codex, agy, or any web tab -- so every row is
walked against both launchers here.

The model / effort translation is checked twice: once statically (every CLI in
the catalog has an arm in both launchers) and once by execution (bash and
PowerShell are handed the same input and must produce the same command line).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "src" / "lib" / "agentCatalog.ts"
LAUNCHER_PS1 = ROOT / "src-tauri" / "src" / "launcher.ps1"
LAUNCHER_SH = ROOT / "src-tauri" / "src" / "launcher.sh"

# Rows a new workspace has no use for: resuming needs a session that does not
# exist yet, "Custom..." prompts for a command, and "shell" skips the launcher.
LAUNCHER_ONLY_TARGETS = {
    "claude-resume",
    "codex-resume",
    "claude-codex-resume",
    "grok-resume",
    "custom",
    "shell",
    "aider",
}

# Aliases the launchers keep for older callers; the catalog names one of each.
TARGET_ALIASES = {
    "fcc": "claude-codex-open",
    "fcc-claude": "claude-codex-open",
    "gemini": "agy",
    "antigravity": "agy",
    "chatgpt": "web-chatgpt",
    "gemini-web": "web-gemini",
    "grok-web": "web-grok",
    "claude-web": "web-claude",
    "claude-ai": "web-claude",
    "notebooklm": "web-notebooklm",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def catalog_entries() -> list[dict[str, str]]:
    """Pulls target/label/kind/cli out of the AGENT_CATALOG literal."""
    source = read(CATALOG)
    body = source.split("export const AGENT_CATALOG", 1)[1]
    body = body.split("\n];", 1)[0]
    entries: list[dict[str, str]] = []
    for block in re.findall(r"\{(.*?)\}", body, re.S):
        fields = dict(re.findall(r'(\w+):\s*"([^"]*)"', block))
        if "target" not in fields or "label" not in fields:
            continue
        # models / efforts point at a shared const rather than an inline list.
        for field in ("models", "efforts"):
            reference = re.search(rf"{field}:\s*([A-Z_]+)", block)
            if reference:
                fields[f"{field}_ref"] = reference.group(1)
        entries.append(fields)
    assert entries, "AGENT_CATALOG entries could not be parsed"
    return entries


@lru_cache(maxsize=1)
def catalog_choice_lists() -> dict[str, tuple[str, ...]]:
    """The shared model / effort consts, as the values they put on a command line."""
    source = read(CATALOG)
    lists: dict[str, tuple[str, ...]] = {"NO_CHOICES": (), "NO_EFFORTS": ()}
    for name, block in re.findall(
        r"const (\w+): readonly ModelChoice\[\] = \[(.*?)\n\];", source, re.S
    ):
        lists[name] = tuple(re.findall(r'value: "([^"]+)"', block))
    for name, block in re.findall(r"const (\w+) = \[(.*?)\] as const;", source, re.S):
        lists[name] = tuple(re.findall(r'"([^"]+)"', block))
    assert len(lists) > 4, f"AGENT_CATALOG choice lists parsed thin: {sorted(lists)}"
    return lists


def catalog_choices_by_target() -> dict[str, dict[str, tuple[str, ...]]]:
    lists = catalog_choice_lists()
    out: dict[str, dict[str, tuple[str, ...]]] = {}
    for entry in catalog_entries():
        if entry.get("kind") != "agent":
            continue
        out[entry["target"]] = {
            "models": lists[entry["models_ref"]],
            "efforts": lists[entry["efforts_ref"]],
        }
    assert out, "no agent rows carried model/effort lists"
    return out


def powershell_launch_targets() -> set[str]:
    match = re.search(r"\$LaunchTargets\s*=\s*@\{(?P<body>.*?)\n\}", read(LAUNCHER_PS1), re.S)
    assert match is not None, "launcher.ps1 $LaunchTargets table is missing"
    keys = set(re.findall(r'"([^"]+)"\s*=\s*\$Options', match.group("body")))
    assert keys, "launcher.ps1 $LaunchTargets table parsed empty"
    return keys


def powershell_menu_labels() -> list[str]:
    labels = re.findall(r'New-MycmuxOption\s+"([^"]+)"', read(LAUNCHER_PS1))
    assert labels, "launcher.ps1 menu labels parsed empty"
    return labels


def shell_launch_targets() -> set[str]:
    source = read(LAUNCHER_SH)
    match = re.search(
        r'if \[ -n "\$MYCMUX_LAUNCH_TARGET" \]; then.*?case "\$MYCMUX_LAUNCH_TARGET" in'
        r"(?P<body>.*?)\n  esac",
        source,
        re.S,
    )
    assert match is not None, "launcher.sh MYCMUX_LAUNCH_TARGET case is missing"
    targets: set[str] = set()
    for line in match.group("body").splitlines():
        pattern = re.match(r"\s{4}([A-Za-z0-9|_-]+)\)\s*$", line)
        if pattern:
            targets.update(pattern.group(1).split("|"))
    assert targets, "launcher.sh MYCMUX_LAUNCH_TARGET case parsed empty"
    return targets


def canonical(target: str) -> str:
    return TARGET_ALIASES.get(target, target)


def test_every_catalog_target_is_dispatchable_by_both_launchers() -> None:
    ps1_targets = powershell_launch_targets()
    sh_targets = shell_launch_targets()
    for entry in catalog_entries():
        target = entry["target"]
        assert target in ps1_targets, f"launcher.ps1 cannot dispatch {target}"
        assert target in sh_targets, f"launcher.sh cannot dispatch {target}"


def test_every_launcher_target_is_offered_by_the_catalog() -> None:
    """The reverse direction: a launcher row the dialog never shows."""
    known = {entry["target"] for entry in catalog_entries()}
    for target in powershell_launch_targets() | shell_launch_targets():
        if target in LAUNCHER_ONLY_TARGETS:
            continue
        assert canonical(target) in known, (
            f"{target} can be launched but is missing from AGENT_CATALOG"
        )


def test_catalog_labels_match_the_launcher_menu() -> None:
    labels = set(powershell_menu_labels())
    for entry in catalog_entries():
        assert entry["label"] in labels, (
            f'catalog label "{entry["label"]}" is not a launcher menu row'
        )


def test_every_catalog_cli_has_a_translation_arm_in_both_launchers() -> None:
    """A new agent without an arm would silently ignore its model and effort."""
    ps1 = read(LAUNCHER_PS1)
    ps1_arm = ps1.split("function Add-MycmuxLaunchSpecToCommandArray", 1)[1].split("\nfunction ", 1)[0]
    sh_arm = read(LAUNCHER_SH).split("__add_launch_spec_to_cmd() {", 1)[1].split("\n}", 1)[0]

    for entry in catalog_entries():
        cli = entry.get("cli")
        if not cli:
            continue
        assert f'"{cli}"' in ps1_arm, f"launcher.ps1 has no model/effort arm for {cli}"
        assert re.search(rf"(^|\||\s){re.escape(cli)}(\||\))", sh_arm, re.M), (
            f"launcher.sh has no model/effort arm for {cli}"
        )


def test_both_launchers_read_the_launch_spec_environment() -> None:
    for path in (LAUNCHER_PS1, LAUNCHER_SH):
        source = read(path)
        for key in ("MYCMUX_LAUNCH_MODEL", "MYCMUX_LAUNCH_EFFORT"):
            assert key in source, f"{path.name} never reads {key}"


# --- The launcher's own model / effort menu -----------------------------------


@lru_cache(maxsize=1)
def powershell_spec_catalog() -> dict[str, dict[str, list[str]]]:
    """Evaluates only the catalog assignments out of launcher.ps1.

    Reading them with a regex would mean re-implementing PowerShell's array
    syntax; running the file itself would open the menu.
    """
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is not available")
    harness = r"""
$src = Get-Content -LiteralPath $env:MYCMUX_LAUNCHER_PS1 -Raw -Encoding utf8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$fn = $ast.FindAll({
  param($n)
  $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "New-MycmuxModelChoice"
}, $true)
if ($fn.Count -ne 1) { throw "New-MycmuxModelChoice not found" }
Invoke-Expression $fn[0].Extent.Text
$want = @(
  "ClaudeModels","CodexModels","AgyModels",
  "ClaudeEfforts","CodexEfforts","ShortEfforts","LaunchSpecCatalog"
)
foreach ($a in $ast.FindAll({
  param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst]
}, $true)) {
  $name = $a.Left.VariablePath.UserPath
  if ($want -contains $name) { Invoke-Expression $a.Extent.Text }
}
$out = @{}
foreach ($key in $LaunchSpecCatalog.Keys) {
  $out[$key] = @{
    models = @($LaunchSpecCatalog[$key].Models | ForEach-Object { $_.Value })
    efforts = @($LaunchSpecCatalog[$key].Efforts)
  }
}
$out | ConvertTo-Json -Depth 5 -Compress
"""
    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        env={
            "MYCMUX_LAUNCHER_PS1": str(LAUNCHER_PS1),
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
        },
    )
    assert result.returncode == 0, f"powershell failed: {result.stderr}"
    return json.loads(result.stdout)


@lru_cache(maxsize=1)
def shell_spec_catalog() -> dict[str, dict[str, list[str]]]:
    """Runs launcher.sh's own lookup functions rather than reading their case arms."""
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    functions = extract_named_sh_functions(["__spec_models_for", "__spec_efforts_for"])
    targets = sorted(catalog_choices_by_target())
    script = [functions]
    for target in targets:
        script.append(
            f'echo "== {target} models"\n'
            f"__spec_models_for {shlex.quote(target)}\n"
            f'echo "== {target} efforts"\n'
            f"__spec_efforts_for {shlex.quote(target)}\n"
        )
    result = subprocess.run(
        [bash, "-s"], input="\n".join(script), capture_output=True, text=True, encoding="utf-8", timeout=60
    )
    assert result.returncode == 0, f"bash failed: {result.stderr}"

    out: dict[str, dict[str, list[str]]] = {t: {"models": [], "efforts": []} for t in targets}
    current: list[str] | None = None
    for line in result.stdout.splitlines():
        header = re.match(r"== (\S+) (models|efforts)$", line)
        if header:
            current = out[header.group(1)][header.group(2)]
            continue
        if current is None or not line.strip():
            continue
        # Model rows are "label|value"; effort rows are the value itself.
        current.append(line.split("|", 1)[1] if "|" in line else line)
    return out


def extract_named_sh_functions(names: list[str]) -> str:
    source = read(LAUNCHER_SH)
    chunks = []
    for name in names:
        match = re.search(rf"^{re.escape(name)}\(\) \{{.*?^\}}", source, re.S | re.M)
        assert match is not None, f"launcher.sh {name} not found"
        chunks.append(match.group(0))
    return "\n\n".join(chunks)


def test_the_menu_offers_the_same_models_and_efforts_as_the_dialog() -> None:
    """Three copies of the list is what caused the drift; this pins them together."""
    expected = catalog_choices_by_target()
    ps1 = powershell_spec_catalog()
    sh = shell_spec_catalog()

    assert sorted(ps1) == sorted(expected), "launcher.ps1 covers a different set of targets"
    assert sorted(sh) == sorted(expected), "launcher.sh covers a different set of targets"

    for target, choices in expected.items():
        for field in ("models", "efforts"):
            assert list(ps1[target][field]) == list(choices[field]), (
                f"launcher.ps1 {target} {field} differs from AGENT_CATALOG"
            )
            assert list(sh[target][field]) == list(choices[field]), (
                f"launcher.sh {target} {field} differs from AGENT_CATALOG"
            )


def test_the_spec_menu_is_reachable_without_changing_the_existing_keys() -> None:
    """Enter and the number keys must still launch at the CLI's own default."""
    ps1 = read(LAUNCHER_PS1)
    sh = read(LAUNCHER_SH)

    # Right / m is the new door, in both launchers.
    assert "[ConsoleKey]::RightArrow -or $key.Key -eq [ConsoleKey]::M" in ps1
    assert "'[C'|'OC') __MENU_EVENT=right" in sh
    assert "m|M) __MENU_EVENT=right" in sh

    # Enter and digits keep their old arms.
    assert "if ($key.Key -eq [ConsoleKey]::Enter) {\n    break\n  }" in ps1
    assert "enter)\n        __try_selected_menu_command" in sh

    # Every list starts on the default, so backing out costs nothing.
    assert '"(default)"' in ps1
    assert '__SPEC_LABELS=("(default)")' in sh

    # And the main menu says the door is there.
    assert "-> model" in ps1
    assert "->/m: model" in sh


# --- Behavioural parity ------------------------------------------------------
# Identical input, identical command line. Static reading cannot catch a flag
# spelled `--reasoning_effort` on one side and `--reasoning-effort` on the other.

CLAUDE_CMD = "claude --allow-dangerously-skip-permissions"

# (id, command, model, effort)
PARITY_CASES = [
    ("claude", CLAUDE_CMD, "opus", "high"),
    ("codex", "codex --no-alt-screen", "gpt-5.6-terra", "xhigh"),
    ("codex-positional", "codex resume --no-alt-screen --last", "gpt-5.6-sol", "max"),
    ("grok", "grok --no-alt-screen --permission-mode auto", "grok-4", "high"),
    ("agy", "agy", "gemini-3.1-pro-high", "high"),
    ("claude-codex", "claude-codex --backend gpt", "gpt-5.6-sol", "max"),
    # No spec, an unknown executable, and values that must be refused because
    # they could be read as a flag or as shell syntax.
    ("no-spec", CLAUDE_CMD, "", ""),
    ("unknown-cli", "aider", "opus", "high"),
    ("reject-flag", CLAUDE_CMD, "--evil-flag", "high"),
    ("reject-semicolon", CLAUDE_CMD, "a; echo pwned", "high"),
    ("reject-substitution", CLAUDE_CMD, "$(echo sub)", "high"),
    # Surrounding whitespace is trimmed, not treated as a bad value.
    ("trim", CLAUDE_CMD, "  opus  ", " high "),
    # Whitespace only is the same as saying nothing.
    ("blank", CLAUDE_CMD, "   ", ""),
]

CASE_IDS = [case[0] for case in PARITY_CASES]


def extract_sh_functions() -> str:
    source = read(LAUNCHER_SH)
    start = source.index("__launch_spec_value() {")
    end = source.index("__read_launch_spec_from_env\n", start)
    return source[start:end]


@lru_cache(maxsize=1)
def run_shell_translation() -> tuple[str, ...]:
    """Drives the real path: values arrive in the environment, get validated,
    and the environment is cleared before the command is assembled."""
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    script = [extract_sh_functions()]
    for _case_id, command, model, effort in PARITY_CASES:
        script.append(
            f"export MYCMUX_LAUNCH_MODEL={shlex.quote(model)}\n"
            f"export MYCMUX_LAUNCH_EFFORT={shlex.quote(effort)}\n"
            "__read_launch_spec_from_env\n"
            f"__add_launch_spec_to_cmd {shlex.quote(command)}\n"
            'printf "\\n"\n'
            # Reading must consume them, or a later launch would inherit the
            # first pick.
            'if [ -n "${MYCMUX_LAUNCH_MODEL:-}${MYCMUX_LAUNCH_EFFORT:-}" ]; then\n'
            '  echo "LEAKED" >&2; exit 3\n'
            "fi\n"
        )
    result = subprocess.run(
        [bash, "-s"],
        input="\n".join(script),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert result.returncode == 0, f"bash failed: {result.stderr}"
    return tuple(line for line in result.stdout.splitlines() if line.strip())


def shell_translation_by_id() -> dict[str, str]:
    lines = run_shell_translation()
    assert len(lines) == len(PARITY_CASES), f"expected one line per case, got {lines}"
    return dict(zip(CASE_IDS, lines))


PS_HARNESS = r"""
# -Encoding utf8 is required: PS 5.1 reads as ANSI by default and would mangle
# any non-ASCII in the launcher before the parser ever sees it.
$src = Get-Content -LiteralPath $env:MYCMUX_LAUNCHER_PS1 -Raw -Encoding utf8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$want = @(
  "Get-MycmuxCommandLeaf",
  "Get-MycmuxLaunchSpecValue",
  "Read-MycmuxLaunchSpecFromEnv",
  "Add-MycmuxLaunchSpecToCommandArray"
)
$fns = $ast.FindAll({
  param($n)
  $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $n.Name
}, $true)
if ($fns.Count -ne $want.Count) { throw "expected $($want.Count) functions, found $($fns.Count)" }
foreach ($f in $fns) { Invoke-Expression $f.Extent.Text }
$script:MycmuxLaunchModel = ""
$script:MycmuxLaunchEffort = ""
$cases = ConvertFrom-Json $env:MYCMUX_PARITY_CASES
foreach ($case in $cases) {
  $env:MYCMUX_LAUNCH_MODEL = $case[2]
  $env:MYCMUX_LAUNCH_EFFORT = $case[3]
  Read-MycmuxLaunchSpecFromEnv
  if ($env:MYCMUX_LAUNCH_MODEL -or $env:MYCMUX_LAUNCH_EFFORT) { throw "launch spec leaked" }
  $out = Add-MycmuxLaunchSpecToCommandArray ($case[1] -split " ")
  Write-Output ($out -join " ")
}
"""


def run_powershell_translation() -> list[str]:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is not available")
    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_HARNESS],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        env={
            "MYCMUX_LAUNCHER_PS1": str(LAUNCHER_PS1),
            "MYCMUX_PARITY_CASES": json.dumps([list(case) for case in PARITY_CASES]),
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
        },
    )
    assert result.returncode == 0, f"powershell failed: {result.stderr}"
    return [line for line in result.stdout.splitlines() if line.strip()]


def test_the_two_launchers_translate_a_launch_spec_identically() -> None:
    sh_lines = list(run_shell_translation())
    ps_lines = run_powershell_translation()
    assert len(sh_lines) == len(PARITY_CASES), sh_lines
    assert sh_lines == ps_lines, (
        "launcher.sh and launcher.ps1 disagree:\n"
        + "\n".join(
            f"  {case_id}\n    sh: {s}\n    ps: {p}"
            for case_id, s, p in zip(CASE_IDS, sh_lines, ps_lines)
            if s != p
        )
    )


def test_a_launch_spec_translates_to_the_flags_each_cli_documents() -> None:
    """Pins the actual flags, so parity alone cannot make both sides wrong."""
    by_id = shell_translation_by_id()

    assert by_id["claude"].startswith("claude --model opus --effort high ")
    assert by_id["codex"] == (
        "codex --model gpt-5.6-terra -c model_reasoning_effort=xhigh --no-alt-screen"
    )
    # A positional argument must survive: flags go after the executable, not at
    # the end where `codex resume <id>` would lose its id.
    assert by_id["codex-positional"].endswith("resume --no-alt-screen --last")
    assert "--reasoning-effort high" in by_id["grok"]
    assert by_id["agy"] == "agy --model gemini-3.1-pro-high --effort high"
    assert by_id["claude-codex"].startswith("claude-codex --model gpt-5.6-sol --effort max ")
    # No spec: untouched. Unknown executable: untouched rather than handed flags
    # it may reject.
    assert by_id["no-spec"] == CLAUDE_CMD
    assert by_id["unknown-cli"] == "aider"
    # Whitespace is trimmed off a good value, and is nothing on its own.
    assert by_id["trim"].startswith("claude --model opus --effort high ")
    assert by_id["blank"] == CLAUDE_CMD


@pytest.mark.parametrize("case_id", ["reject-flag", "reject-semicolon", "reject-substitution"])
def test_a_model_that_could_be_read_as_a_flag_is_dropped(case_id: str) -> None:
    rejected = next(case[2] for case in PARITY_CASES if case[0] == case_id)
    line = shell_translation_by_id()[case_id]
    assert "--model" not in line, f"a rejected model still produced a flag: {line}"
    assert rejected not in line, f"rejected model leaked into the command: {line}"
    # The effort next to it is well-formed and must still apply.
    assert "--effort high" in line


# --- The model menu, driven ---------------------------------------------------
# Both launchers get the same scripted keystrokes and must record the same
# choice. Reading the two implementations side by side would not catch a row
# that is off by one on one side, which is exactly what a menu gets wrong.

# (id, target, POSIX key bytes, PowerShell key names, typed lines, expected)
# Codex rows since GPT-6 Astra (2026-09-05): 1 default, 2 astra, 3 sol, 4 terra,
# 5 luna, 6 type-in. Effort rows: 1 default, 2 none, 3 low, 4 medium, 5 high,
# 6 xhigh, 7 max, 8 ultra.
MENU_CASES = [
    ("digits", "codex", "45", ["4", "5"], [], "gpt-5.6-terra|high"),
    (
        "arrows",
        "codex",
        "\\x1b[B\\x1b[B\\x1b[B\\n\\x1b[B\\n",
        ["down", "down", "down", "enter", "down", "enter"],
        [],
        "gpt-5.6-terra|none",
    ),
    # The flagship row sits right under the default; the last effort row is ultra.
    ("astra-ultra", "codex", "28", ["2", "8"], [], "gpt-6-astra|ultra"),
    # Enter twice is the launch that happened before this menu existed.
    ("defaults", "claude", "\\n\\n", ["enter", "enter"], [], "|"),
    ("escape", "claude", "\\x1b", ["esc"], [], "CANCELLED"),
    ("typed", "codex", "6gpt-5.6-custom\\n1", ["6", "1"], ["gpt-5.6-custom"], "gpt-5.6-custom|"),
    # grok publishes no model list, so its type-in row is row 2.
    ("typed-grok", "grok", "2grok-4-fast\\n4", ["2", "4"], ["grok-4-fast"], "grok-4-fast|high"),
    (
        "typed-trim",
        "codex",
        "6  gpt-5.6-luna  \\n1",
        ["6", "1"],
        ["  gpt-5.6-luna  "],
        "gpt-5.6-luna|",
    ),
    # Typing nothing takes the default rather than stranding the user there.
    ("typed-blank", "codex", "6\\n1", ["6", "1"], [""], "|"),
    # A typed value that could pass as a flag is refused and the menu stays put,
    # so the scripted keys run out and it backs out instead of launching.
    ("typed-refused", "codex", "6--evil\\n", ["6"], ["--evil"], "CANCELLED"),
    # Web and directory rows carry no target; the key does nothing.
    ("no-target", "", "\\n\\n", ["enter", "enter"], [], "CANCELLED"),
]

SPEC_MENU_SH_FUNCTIONS = [
    "__mycmux_read_key_with_timeout",
    "__open_menu_fd",
    "__read_menu_event",
    "__launch_spec_value",
    "__spec_models_for",
    "__spec_efforts_for",
    "__spec_has_target",
    "__spec_menu",
    "__launch_spec_menu",
]

# Only the two input primitives are swapped out; the menu logic under test is
# the shipped code, pulled straight out of launcher.ps1 by its AST.
PS_MENU_HARNESS = r"""
$ErrorActionPreference = "Stop"
$src = Get-Content -LiteralPath $env:MYCMUX_LAUNCHER_PS1 -Raw -Encoding utf8
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)

$script:TestKeys = @(); $script:TestKeyIndex = 0
$script:TestLines = @(); $script:TestLineIndex = 0

function Get-MycmuxTestKey {
  if ($script:TestKeyIndex -ge $script:TestKeys.Count) {
    return [System.ConsoleKeyInfo]::new([char]27, [ConsoleKey]::Escape, $false, $false, $false)
  }
  $spec = $script:TestKeys[$script:TestKeyIndex]
  $script:TestKeyIndex++
  switch ($spec) {
    "down"  { return [System.ConsoleKeyInfo]::new([char]0, [ConsoleKey]::DownArrow, $false, $false, $false) }
    "up"    { return [System.ConsoleKeyInfo]::new([char]0, [ConsoleKey]::UpArrow, $false, $false, $false) }
    "enter" { return [System.ConsoleKeyInfo]::new([char]13, [ConsoleKey]::Enter, $false, $false, $false) }
    "esc"   { return [System.ConsoleKeyInfo]::new([char]27, [ConsoleKey]::Escape, $false, $false, $false) }
    default { return [System.ConsoleKeyInfo]::new([char]$spec, [ConsoleKey]::NoName, $false, $false, $false) }
  }
}

function Get-MycmuxTestLine {
  if ($script:TestLineIndex -ge $script:TestLines.Count) { return "" }
  $line = $script:TestLines[$script:TestLineIndex]
  $script:TestLineIndex++
  return $line
}

$wantFunctions = @(
  "New-MycmuxModelChoice", "Get-MycmuxCommandLeaf", "Get-MycmuxLaunchSpecValue",
  "Read-MycmuxTypedSpecValue", "Show-MycmuxSpecMenu", "Invoke-MycmuxLaunchSpecMenu"
)
$found = 0
foreach ($f in $ast.FindAll({
  param($n)
  $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wantFunctions -contains $n.Name
}, $true)) {
  $text = $f.Extent.Text
  $text = $text -replace '\[Console\]::ReadKey\(\$true\)', '(Get-MycmuxTestKey)'
  $text = $text -replace 'Read-Host "  >"', '(Get-MycmuxTestLine)'
  $text = $text -replace 'Clear-Host', '$null = $null'
  $text = $text -replace 'Write-Host', 'Write-Verbose'
  $text = $text -replace 'Start-Sleep -Milliseconds 1200', '$null = $null'
  Invoke-Expression $text
  $found++
}
if ($found -ne $wantFunctions.Count) { throw "expected $($wantFunctions.Count) functions, ran $found" }

$wantVars = @("ClaudeModels","CodexModels","AgyModels","ClaudeEfforts","CodexEfforts","ShortEfforts","LaunchSpecCatalog")
foreach ($a in $ast.FindAll({
  param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst]
}, $true)) {
  if ($wantVars -contains $a.Left.VariablePath.UserPath) { Invoke-Expression $a.Extent.Text }
}
$MYCMUX_SPEC_DEFAULT = "__default__"
$MYCMUX_SPEC_TYPE_IN = "__type__"

foreach ($case in (ConvertFrom-Json $env:MYCMUX_MENU_CASES)) {
  $script:TestKeys = @($case.keys); $script:TestKeyIndex = 0
  $script:TestLines = @($case.lines); $script:TestLineIndex = 0
  $script:MycmuxLaunchModel = ""; $script:MycmuxLaunchEffort = ""
  $option = [pscustomobject]@{ Label = "probe"; Target = $case.target }
  if (Invoke-MycmuxLaunchSpecMenu $option) {
    Write-Output ("{0}|{1}" -f $script:MycmuxLaunchModel, $script:MycmuxLaunchEffort)
  } else {
    Write-Output "CANCELLED"
  }
}
"""


@lru_cache(maxsize=1)
def run_shell_menu() -> tuple[str, ...]:
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash is not available")
    script = [extract_named_sh_functions(SPEC_MENU_SH_FUNCTIONS), 'K="$(mktemp)"']
    for _case_id, target, keys, _ps_keys, _lines, _expected in MENU_CASES:
        script.append(
            "__MYCMUX_LAUNCH_MODEL=''; __MYCMUX_LAUNCH_EFFORT=''\n"
            f"printf '%b' {shlex.quote(keys)} > \"$K\"\n"
            'exec 9< "$K"\n'
            "__CMUX_MENU_FD=9\n"
            f"if __launch_spec_menu {shlex.quote(target)} probe 2>/dev/null; then\n"
            '  printf "%s|%s\\n" "$__MYCMUX_LAUNCH_MODEL" "$__MYCMUX_LAUNCH_EFFORT"\n'
            "else\n"
            '  printf "CANCELLED\\n"\n'
            "fi\n"
            "exec 9<&-\n"
        )
    result = subprocess.run(
        [bash, "-s"],
        input="\n".join(script),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert result.returncode == 0, f"bash failed: {result.stderr}"
    return tuple(line for line in result.stdout.splitlines() if line.strip())


@lru_cache(maxsize=1)
def run_powershell_menu() -> tuple[str, ...]:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is not available")
    cases = [
        {"target": target, "keys": ps_keys, "lines": lines}
        for _case_id, target, _keys, ps_keys, lines, _expected in MENU_CASES
    ]
    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_MENU_HARNESS],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        env={
            "MYCMUX_LAUNCHER_PS1": str(LAUNCHER_PS1),
            "MYCMUX_MENU_CASES": json.dumps(cases),
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
        },
    )
    assert result.returncode == 0, f"powershell failed: {result.stderr}"
    return tuple(line for line in result.stdout.splitlines() if line.strip())


def test_the_two_launchers_run_their_model_menu_identically() -> None:
    sh_lines = list(run_shell_menu())
    ps_lines = list(run_powershell_menu())
    assert len(sh_lines) == len(MENU_CASES), sh_lines
    assert len(ps_lines) == len(MENU_CASES), ps_lines
    assert sh_lines == ps_lines, (
        "the two model menus disagree:\n"
        + "\n".join(
            f"  {case[0]}\n    sh: {s}\n    ps: {p}"
            for case, s, p in zip(MENU_CASES, sh_lines, ps_lines)
            if s != p
        )
    )


@pytest.mark.parametrize("index", range(len(MENU_CASES)))
def test_the_model_menu_records_what_was_picked(index: int) -> None:
    case_id, _target, keys, _ps_keys, _lines, expected = MENU_CASES[index]
    assert run_shell_menu()[index] == expected, f"{case_id} [{keys}] in launcher.sh"
