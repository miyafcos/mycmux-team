"""Catalog additions must include file-only, asynchronous CLI detection."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def test_catalog_targets_all_have_detection_rules():
    catalog = (ROOT / "src/lib/agentCatalog.ts").read_text(encoding="utf-8")
    entries = re.findall(r'\{\s*target:\s*"([^"]+)"[\s\S]*?kind:\s*"([^"]+)"', catalog)
    targets = {target for target, kind in entries if kind == "agent"}
    detector = (ROOT / "src-tauri/src/agent_services.rs").read_text(encoding="utf-8")
    table = detector.split("const SERVICE_RULES:", 1)[1].split("];", 1)[0]
    rules = set(re.findall(r'\("([^"]+)",', table))
    assert targets == rules


def test_detector_is_registered_async_and_never_starts_shells():
    detector = (ROOT / "src-tauri/src/agent_services.rs").read_text(encoding="utf-8")
    assert re.search(r"#\[tauri::command\]\s*pub async fn detect_agent_services", detector)
    assert "agent_services::detect_agent_services," in (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    assert not re.search(r"Command::new|login_shell_path\(\)", detector.replace("cached_login_shell_path()", ""))
