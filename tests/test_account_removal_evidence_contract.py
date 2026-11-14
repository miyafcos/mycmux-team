"""Removal completion always invalidates tab evidence, including join errors."""
from pathlib import Path
import re
import pytest

ROOT = Path(__file__).resolve().parents[1]


def assert_removal_invalidation(source):
    start = source.index("pub async fn remove_cli_account(")
    body = source[start:source.index("\n}", start) + 2]
    assert "let removed_profile_id = profile_id.clone();" in body
    assert "let result = tauri::async_runtime::spawn_blocking(move || {" in body
    assert body.count("app.emit(") == 1
    # Retain the nested result until after the unconditional invalidation. Using
    # ? on the await would lose the event on a task join failure.
    joined = body.index("}).await.map_err(")
    event = body.index('app.emit("tab-account-evidence-updated"')
    assert joined < event
    assert body[joined:event].strip() == (
        '}).await.map_err(|_| cli_accounts::ERR_REMOVE_FAILED.to_string());\n    let _ ='
    )
    tail = body[event:]
    assert re.fullmatch(
        r'app\.emit\("tab-account-evidence-updated", serde_json::json!\(\{ "profile_id": removed_profile_id \}\)\);\s*result\?\s*\}',
        tail,
    )
    assert re.findall(r'serde_json::json!\(\{([^}]+)\}\)', body) == [' "profile_id": removed_profile_id ']
    # Provider lookup, partial unregister failure and successful removal all
    # stay inside the blocking task and pass through the same completion tail.
    task = body[body.index("spawn_blocking("):joined]
    assert "registered_profile_provider(&base, &profile_id)?" in task
    assert "return cli_accounts::remove_resolved(&base, &profile_id);" in task
    assert "cli_accounts::account_homes::unregister_and(" in task
    assert "|| cli_accounts::remove_resolved(&base, &profile_id)" in task


def test_account_removal_invalidates_once_after_success_failure_and_join_error():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    assert_removal_invalidation(source)


def test_removal_contract_rejects_missing_emit_in_memory():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    assert_removal_invalidation(source)
    start = source.index("pub async fn remove_cli_account(")
    end = source.index("\n}", start) + 2
    mutated = source[start:end].replace('app.emit(', 'app.removed_emit(', 1)
    with pytest.raises(AssertionError):
        assert_removal_invalidation(source[:start] + mutated + source[end:])


def test_removal_contract_rejects_early_join_error_propagation_in_memory():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    assert_removal_invalidation(source)
    start = source.index("pub async fn remove_cli_account(")
    end = source.index("\n}", start) + 2
    mutated = source[start:end].replace('ERR_REMOVE_FAILED.to_string());', 'ERR_REMOVE_FAILED.to_string())?;', 1)
    with pytest.raises(AssertionError):
        assert_removal_invalidation(source[:start] + mutated + source[end:])
