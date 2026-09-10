"""Every read of Claude's credentials has to go through the store resolver.

macOS keeps them in the login keychain and never writes
``~/.claude/.credentials.json``. Code that reads ``paths.credentials`` with
``fs::read_to_string`` therefore works on Windows and silently returns nothing
on a Mac -- which is how the account meter came to show an em dash on a machine
that was signed in. ``claude::read_credentials`` picks the store, so it is the
only sanctioned reader outside the module that owns both.
"""

from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_SRC = REPO_ROOT / "src-tauri" / "src"
OWNER = RUST_SRC / "cli_accounts" / "claude.rs"

# The reads inside claude.rs are the implementation of the store itself, and
# the test module writes fixture files on purpose.
EXEMPT = {OWNER, RUST_SRC / "cli_accounts" / "tests.rs", RUST_SRC / "cli_accounts" / "live_sync.rs"}

DIRECT_READ = re.compile(r"read_to_string\(\s*&?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?credentials\b")


def rust_sources() -> list[Path]:
    return sorted(path for path in RUST_SRC.rglob("*.rs") if path not in EXEMPT)


def test_no_direct_read_of_claude_credentials_file() -> None:
    offenders: list[str] = []
    for path in rust_sources():
        text = path.read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), start=1):
            if DIRECT_READ.search(line):
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{number}: {line.strip()}")
    assert not offenders, (
        "read Claude's credentials through claude::read_credentials instead:\n"
        + "\n".join(offenders)
    )


def test_store_resolver_still_exists() -> None:
    # A guard that names a function has to fail loudly if the function is
    # renamed away, rather than passing because nothing matches any more.
    owner = OWNER.read_text(encoding="utf-8")
    assert "pub fn read_credentials(paths: &ClaudePaths) -> Option<String>" in owner
    assert "enum CredentialStore" in owner
    assert "Keychain" in owner


def test_usage_reads_through_the_resolver() -> None:
    usage = (RUST_SRC / "commands" / "usage.rs").read_text(encoding="utf-8")
    assert usage.count("claude::read_credentials(&paths)") == 2, (
        "usage.rs sources Claude credentials for both the active row and the "
        "unregistered row; both have to use the resolver"
    )
