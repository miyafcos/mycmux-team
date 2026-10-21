"""L16's immutable integration delta and unmasked reader bodies."""
from __future__ import annotations
import hashlib
import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "cc4dae78e832c3439875d7611b72cf0b78452a77"
CANDIDATE = "a9f3492fb1672e5aad56fdb6f5946a5de20aca6f"
LANE = "60fe1b14e71f15aa5115a81ae7fd91e3fa98c50d"
PROTECTED_PATHS = [
    "src-tauri/src/commands/workspace.rs", "src-tauri/src/commands/quit.rs",
    "src-tauri/src/commands/agent_dormancy.rs", "src-tauri/src/commands/session_mapping.rs",
    "src-tauri/src/commands/terminal/agent_restore.rs", "src-tauri/src/commands/terminal/agent_session_guard.rs",
    "src-tauri/src/pty/manager.rs", "src-tauri/src/pty/session.rs", "src-tauri/src/pty/mod.rs",
    "src-tauri/src/pty/monitor.rs", "src-tauri/src/pty/monitor/runner.rs",
    "src-tauri/src/pty/monitor/detection.rs", "src-tauri/src/pty/monitor/transcripts.rs",
    "src-tauri/src/agent_state/hook.rs", "src-tauri/src/agent_state/hook_source.rs",
    "src-tauri/src/agent_state/mod.rs", "src-tauri/src/agent_state/settings.rs",
    "src-tauri/src/db/storage.rs", "src-tauri/src/pty/path_norm.rs",
    "src/App.tsx", "src/components/layout/SocketListener.tsx", "src/lib/liveAgentMetadata.ts",
    "src/stores/workspaceListStore.ts", "src/lib/persistentLayoutProjection.ts", "src/lib/windowFragments.ts",
    "src/hooks/useAgentDormancy.ts", "src/lib/agentDormancy.ts", "src/lib/dormantCompletion.ts",
    "src/stores/settingsMigration.ts", "tests/unit/settingsMigration.test.ts",
    "tests/test_launcher_restore_auto_contract.py", "tests/unit/terminalLaunchParams.test.ts",
    "tests/unit/socketListenerPersistenceContracts.test.ts", "package.json", "package-lock.json",
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json",
]

def base(path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{BASE}:{path}"], cwd=ROOT)

def candidate(path: str) -> bytes:
    # A later accepted integration can change protected files. This oracle
    # continues to prove what L16 changed at its own landing boundary.
    return subprocess.check_output(["git", "show", f"{CANDIDATE}:{path}"], cwd=ROOT)

def function(source: str, name: str) -> str:
    masked = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\'(?:\\.|[^\'\\])\'',
                    lambda match: " " * len(match[0]), source, flags=re.S)
    match = re.search(r"\bfn " + re.escape(name) + r"(?:\b|<)", masked)
    assert match, name
    def closing(start: int, opening: str, close: str) -> int:
        depth = 0
        for index in range(start, len(masked)):
            depth += (masked[index] == opening) - (masked[index] == close)
            if depth == 0:
                return index
        raise AssertionError(name + " unclosed body")
    end = closing(masked.index("(", match.end()), "(", ")")
    start = masked.index("{", end)
    return source[match.start():closing(start, "{", "}") + 1]

# R13-1 authorizes only this new method body. The declaration, placement,
# whitespace outside its braces, and every pre-existing manager byte compare.
RETIRE_DECLARATION = b"    pub(crate) fn retire(&self, session_id: &str) -> Option<PtySession> {"
RETIRE_ANCHOR = b"    pub fn kill(&self, session_id: &str) -> Result<(), String> {"
def manager_retirement_projection(old: bytes, new: bytes) -> tuple[bytes, bytes]:
    assert new.count(RETIRE_DECLARATION) == 1
    body = function(new.decode("utf-8"), "retire").encode("utf-8")
    start = new.index(RETIRE_DECLARATION) + len(RETIRE_DECLARATION)
    end = new.index(body) + len(body) - 1
    approved_scaffold = RETIRE_DECLARATION + b"\n    }\n\n"
    assert old.count(RETIRE_ANCHOR) == 1
    return old.replace(RETIRE_ANCHOR, approved_scaffold + RETIRE_ANCHOR, 1), new[:start] + b"\n    " + new[end:]

def manifest() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    def compare(path: str, label: str, old: bytes, new: bytes) -> None:
        rows.append({"path": path, "scope": label, "base_sha256": hashlib.sha256(old).hexdigest(),
                     "candidate_sha256": hashlib.sha256(new).hexdigest(), "equal": old == new})
    for path in PROTECTED_PATHS:
        old = base(path)
        new = candidate(path)
        if path == "src-tauri/src/pty/manager.rs":
            compare(path, "exact manager bytes except approved retire body; literal scaffold checked", *manager_retirement_projection(old, new))
        else:
            compare(path, "whole file / Git blob", old, new)
    path = "src-tauri/src/commands/terminal.rs"
    old = base(path).decode("utf-8")
    new = candidate(path).decode("utf-8")
    for name in ["get_pty_metadata_snapshot", "get_agent_conversation_owner", "running_conversation_owners",
                 "conversation_owners_for", "owner_commandline_pids", "sanitize_launch_env",
                 "inherit_claude_resume_effort", "normalize_claude_launch_args", "apply_agent_restore_recovery_args_with",
                 "apply_claude_pinned_id_args", "should_trust_claude_workspace", "wrap_restore_notice"]:
        compare(path, name, function(old, name).encode("utf-8"), function(new, name).encode("utf-8"))
    for start, end in [("    let _launch_claim = if reattach", "    if !reattach && !restore_confirmed {"),
                       ("        if let Some(request) = launch_conversation", "    crate::perf_timeline::mark(\"session.create.done\"")]:
        a = old[old.index(start):old.index(end, old.index(start))]
        b = new[new.index(start):new.index(end, new.index(start))]
        # The restore-only observer follows the existing remember call. Compare
        # the exact original caller block, never mask a changed identity call.
        if start.startswith("        if let Some(request)"):
            a = a.split("        }", 1)[0] + "        }"
            b = b.split("        }", 1)[0] + "        }"
        compare(path, start.strip(), a.encode("utf-8"), b.encode("utf-8"))
    marker = "#[cfg(test)]\nmod tests {\n"
    a = old.split(marker, 1)[1]
    b = new.split(marker, 1)[1].split("\n#[cfg(test)]\nmod n3_restore_bindings {", 1)[0]
    compare(path, "entire original test module including imports", a.encode("utf-8"), b.encode("utf-8"))
    path = "src/components/terminal/XTermWrapper.tsx"
    a = base(path).decode("utf-8"); b = candidate(path).decode("utf-8")
    start, end = "    const restartAgent = async", "    const performResumeAction"
    compare(path, "existing recovery identity setter caller", a[a.index(start):a.index(end)].encode("utf-8"), b[b.index(start):b.index(end)].encode("utf-8"))
    fixture = (ROOT / "tests/helpers/narrow_hook_source_base.rs").read_text(encoding="utf-8")
    compare("tests/helpers/narrow_hook_source_base.rs", "actual compiled base classifier",
            function(base("src-tauri/src/agent_state/hook_source.rs").decode("utf-8"), "is_noninteractive_agent").encode("utf-8"),
            function(fixture, "is_noninteractive_agent").encode("utf-8"))
    for path in ["src-tauri/src/launcher.sh", "src-tauri/src/launcher.ps1"]:
        a = base(path).decode("utf-8"); b = candidate(path).decode("utf-8")
        if "# BEGIN CODEX RESTORE HELPERS" in b:
            b = re.sub(r"# BEGIN CODEX RESTORE HELPERS\n.*?# END CODEX RESTORE HELPERS\n\n", "", b, count=1, flags=re.S)
            if path.endswith(".sh"):
                begin = b.index('if [ -n "${MYCMUX_CODEX_RESTORE_REASON:-}" ]; then')
                end = b.index('if [ -n "$MYCMUX_RESUME" ]; then', begin)
                b = b[:begin] + b[end:]
            else:
                b = re.sub(r"  if \(\$env:MYCMUX_CODEX_RESTORE_REASON[^\n]*\) \{\n    Invoke-MycmuxCodexRestore\n    return \$true\n  \}\n", "", b, count=1)
            start = '    codex*)\n' if path.endswith(".sh") else '    "codex*" {\n'
            end = '    grok*)\n' if path.endswith(".sh") else '    "grok*" {\n'
            b = b[:b.index(start)] + a[a.index(start):a.index(end, a.index(start))] + b[b.index(end, b.index(start)):]
        compare(path, "every non-Codex byte (only restore additions removed)", a.encode("utf-8"), b.encode("utf-8"))
    return rows

class RestoreOnlyParityTests(unittest.TestCase):
    def test_save_identity_quit_paths_and_readers_are_exact_base_bytes(self) -> None:
        parents = subprocess.check_output(["git", "show", "-s", "--format=%P", CANDIDATE], cwd=ROOT).decode("ascii").split()
        self.assertEqual(parents, [BASE, LANE])
        subprocess.run(["git", "merge-base", "--is-ancestor", CANDIDATE, "HEAD"], cwd=ROOT, check=True)
        rows = manifest()
        self.assertTrue(all(row["equal"] for row in rows), [row for row in rows if not row["equal"]])
        print(f"protected byte comparisons: {len(rows)}/{len(rows)}; protected files: {len(PROTECTED_PATHS)}; whole protected blobs: {len(PROTECTED_PATHS) - 1}; retire body exception: 1")

    def test_protected_worktree_bytes_match_the_current_committed_source(self) -> None:
        # Independently catch an uncommitted mutation without comparing future
        # stages' legitimate committed changes with the historical L16 tree.
        paths = [*PROTECTED_PATHS, "src-tauri/src/commands/terminal.rs",
                 "src/components/terminal/XTermWrapper.tsx", "src-tauri/src/launcher.sh",
                 "src-tauri/src/launcher.ps1", "tests/helpers/narrow_hook_source_base.rs"]
        changed = [path for path in paths if (ROOT / path).read_bytes().replace(b"\r\n", b"\n")
                   != subprocess.check_output(["git", "show", f"HEAD:{path}"], cwd=ROOT).replace(b"\r\n", b"\n")]
        self.assertEqual(changed, [])

if __name__ == "__main__":
    unittest.main(verbosity=2)
