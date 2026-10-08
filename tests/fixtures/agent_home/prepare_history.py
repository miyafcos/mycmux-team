"""Public synthetic Git history. Never point this helper at a real home."""
from pathlib import Path
import json
import subprocess
import sys

SECRET = "CANARY_SECRET_7F3A"
MEMORY = "CANARY_MEMORY_4D8E"
home = Path(sys.argv[1]).resolve()
action = sys.argv[2]

def put(name, value):
    path = home / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value.encode("utf-8") if isinstance(value, str) else value)

def git(*args):
    return subprocess.check_output(["git", "-C", str(home), *args], stderr=subprocess.DEVNULL).decode("utf-8").strip()

def commit(subject):
    git("add", "--", ".claude", ".codex")
    if (home / "CLAUDE.md").exists():
        git("add", "--", "CLAUDE.md")
    git("-c", "user.name=Fixture Writer", "-c", "user.email=writer@example.test", "commit", "-qm", subject)

def settings(model):
    return json.dumps({"model": model, "effortLevel": "high", "env": {"FIXTURE_KEY": SECRET},
        "permissions": {"defaultMode": "default", "allow": ["Read(fixture)"]},
        "hooks": {"Stop": [{"hooks": [{"command": "python fixture_hook.py --token " + SECRET}]}]},
        "mcpServers": {"fixture": {"url": "https://fixture.example.test", "headers": {"Authorization": SECRET}}}}, indent=2)

if action == "initial":
    assert not home.exists() or not any(home.iterdir()), "only an empty synthetic home is allowed"
    home.mkdir(parents=True, exist_ok=True)
    git("init", "-q")
    put("CLAUDE.md", "# Fixture instructions\nKeep the scope explicit.\n")
    put(".claude/rules/review.md", "# Review\nKeep useful checks.\nRead the current spec.\nPreserve existing work.\n")
    put(".claude/settings.json", settings("fixture-small"))
    put(".codex/config.toml", 'model = "fixture-small"\nmodel_reasoning_effort = "high"\n[mcp_servers.fixture]\nenabled = false\nsecret = "' + SECRET + '"\n')
    put(".codex/memories/MEMORY.md", MEMORY + "\n")
    put(".codex/memories/private-note.md", MEMORY + "\n")
    put(".codex/rules/default.rules", b"\x00binary fixture\xff\n")
    for name in [".env", "credentials.json", "auth.json", "token.txt", "fixture.key", "fixture.pem", "tokens/fixture.txt"]:
        put(".claude/" + name, SECRET)
    commit("Initial fixture design")
elif action == "update":
    assert (home / ".git").is_dir() and (home / ".claude/rules/review.md").is_file()
    put(".claude/settings.json", settings("fixture-large"))
    put(".claude/rules/review.md", (home / ".claude/rules/review.md").read_text(encoding="utf-8") + "Check the changed lines.\n")
    put(".codex/memories/MEMORY.md", MEMORY + "\nAdditional private memory.\n")
    put(".codex/memories/private-note.md", MEMORY + "\nAdditional private note.\n")
    commit("Tune fixture model and review")
    git("mv", "--", ".claude/rules/review.md", ".claude/rules/renamed.md")
    commit("Rename fixture review")
    put(".claude/rules/new.md", "# Added rule\nUse a bounded diff.\n")
    git("rm", "--", "CLAUDE.md")
    commit("Add rule and remove instructions")
else:
    raise SystemExit("unsupported synthetic action")
print(home)
