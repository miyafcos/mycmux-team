import json
from pathlib import Path
import pytest
from dispatch_preflight import prepare_project, preflight, normalized_cwd, required_routes

def make_home(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text("{}", encoding="utf-8")
    config = tmp_path / ".claude.json"
    config.write_text(json.dumps({"other": {"keep": 1}, "projects": {
        "C:/Users/alice": {"hasTrustDialogAccepted": True, "enabledMcpjsonServers": ["custom"]},
        "C:/old": {"keep": "value"}}}), encoding="utf-8")
    return config

def test_merge_backup_and_atomic_roundtrip(tmp_path):
    config = make_home(tmp_path)
    original = config.read_bytes()
    result = prepare_project(config, "C:\\new\\path")
    assert result["key"] == "C:/new/path"
    after = json.loads(config.read_text(encoding="utf-8"))
    assert after["projects"]["C:/Users/alice"]["enabledMcpjsonServers"] == ["custom"]
    assert after["other"] == {"keep": 1}
    assert config.with_name(".claude.json.bak-guard").read_bytes() == original
    assert after["projects"][result["key"]] == {
        "hasTrustDialogAccepted": True, "enabledMcpjsonServers": ["oracle", "deepwiki"]}
    assert prepare_project(config, "C:/new/path")["changed"] is False

def test_concurrent_write_is_reread_and_preserved(tmp_path):
    config = make_home(tmp_path)
    def race():
        value = json.loads(config.read_text(encoding="utf-8"))
        value["concurrent"] = 42
        value["projects"]["C:/new"] = {"custom": 7, "enabledMcpjsonServers": ["user"]}
        config.write_text(json.dumps(value), encoding="utf-8")
    prepare_project(config, "C:/new", before_reload=race)
    value = json.loads(config.read_text(encoding="utf-8"))
    assert value["concurrent"] == 42
    assert value["projects"]["C:/new"]["custom"] == 7
    assert value["projects"]["C:/new"]["enabledMcpjsonServers"] == ["user", "oracle", "deepwiki"]

def test_mixed_case_existing_key_reused():
    assert normalized_cwd("c:\\USERS\\alice", {"C:/Users/alice": {}}) == "C:/Users/alice"

@pytest.mark.parametrize("keyword,route", [("Gmail", "google_gws"), ("gws", "google_gws"),
                                         ("Slack", "slack"), ("OAuth", "local_mcp_tokens"),
                                         ("mcp__claude_ai", "local_mcp_tokens")])
def test_dead_required_routes_block_spawn(tmp_path, keyword, route):
    make_home(tmp_path)
    spec = tmp_path / "spec.md"
    spec.write_text(keyword, encoding="utf-8")
    result = preflight("C:/new", home=tmp_path, spec=spec,
        doctor_fn=lambda: (0, route + " dead 1 unavailable"),
        ensure_fn=lambda: {"alive": True})
    assert result["exit_code"] == 3 and route in result["blocked_routes"]

def test_settings_warnings_read_only_and_optional_dead_route(tmp_path):
    config = make_home(tmp_path)
    settings = tmp_path / ".claude" / "settings.json"
    original = settings.read_bytes()
    result = preflight("C:/new", home=tmp_path, doctor_fn=lambda: (1, "slack dead 1 down"),
                       ensure_fn=lambda: {"alive": True})
    assert result["ok"] and result["warnings"]
    assert settings.read_bytes() == original

def test_invalid_config_warns_and_guard_still_ensured(tmp_path):
    config = make_home(tmp_path)
    config.write_text("{broken", encoding="utf-8")
    calls = []
    result = preflight("C:/new", home=tmp_path, doctor_fn=lambda: (0, ""),
                       ensure_fn=lambda: calls.append(1) or {"alive": True})
    assert result["ok"] and calls == [1]
    assert config.read_text(encoding="utf-8") == "{broken"
