"""Build four fully synthetic agent homes; no live home is read."""
from __future__ import annotations
import argparse
import json
from pathlib import Path

SECRET = "CANARY_SECRET_7F3A"
BODY = "CANARY_BODY_9C1D"
VARIANTS = ("claude_only", "codex_only", "both", "empty")

def write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as output:
        output.write(text)
    assert path.read_text(encoding="utf-8") == text and "\ufffd" not in text

def record(root: Path, relative: str, rows: list[dict]) -> None:
    write(root, relative, "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows))

def prepare(root: Path, variant: str) -> Path:
    if variant not in VARIANTS:
        raise ValueError("unsupported fixture")
    root.mkdir(parents=True, exist_ok=True)
    cwd = str(root.resolve())
    project_key = "".join(c if c.isascii() and c.isalnum() else "-" for c in cwd)
    if variant in ("claude_only", "both"):
        settings = {
            "model": "synthetic-model", "effortLevel": "high",
            "permissions": {"defaultMode": "default", "allow": ["Read", "Bash(example)"]},
            "env": {SECRET + "_KEY": SECRET, "EXAMPLE_KEY": SECRET},
            "hooks": {
                "SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "python hook.py --auth " + SECRET}]}],
                "Stop": [{"matcher": ".*", "hooks": [{"type": "command", "command": "python dispatcher.py --auth " + SECRET}]}],
            },
            "enabledPlugins": {"sample-plugin@fixture": True},
            "unsupported_setting": SECRET,
        }
        write(root, ".claude/settings.json", json.dumps(settings, indent=2))
        write(root, ".claude/settings.local.json", json.dumps({"permissions": {"allow": ["Read"]}, "env": {"SECRET_ENV": SECRET}}))
        write(root, ".claude/CLAUDE.md", "# Instructions\nRead declared references only. \u65e5\u672c\u8a9e\n")
        write(root, "CLAUDE.md", "# Project\nUse synthetic material.\n")
        write(root, ".claude/rules/always.md", "# Rules\nRead references/guide.md and scripts/hook.py in that order.\n")
        write(root, ".claude/rules/conditional.md", '---\npaths:\n  - "src/**/*.tsx"\n  - "skills/**"\n---\n# Conditional\nCheck a component.\n')
        write(root, ".claude/references/guide.md", "# Guide\nSynthetic guide.\n")
        write(root, ".claude/scripts/hook.py", "# Synthetic script; never executed.\n")
        write(root, ".claude/scripts/dispatcher.py", "# Synthetic dispatcher; never executed.\n")
        memory = ("memory line " + "x" * 112 + "\n") * 210
        write(root, ".claude/projects/" + project_key + "/memory/MEMORY.md", memory)
        write(root, ".claude/projects/" + project_key + "/memory/body.md", "Synthetic memory body, counted without reading. " + SECRET + "\n")
        for name in ("reviewer", "unused"):
            write(root, ".claude/skills/" + name + "/SKILL.md", "---\nname: " + name + "\ndescription: Synthetic " + name + "\n---\n# " + name + "\nUse sample@example.test.\n")
        write(root, ".claude/skills/synced/catalog/remote/SKILL.md", "---\nname: remote\ndescription: Synthetic sync\n---\n# Remote\n")
        write(root, ".claude/commands/sample-command/SKILL.md", "---\nname: sample-command\ndescription: A synthetic command\n---\n# Command\n")
        write(root, ".claude/agents/helper.md", "---\nname: helper\n---\nSynthetic helper.\n")
        write(root, ".claude/plugins/installed_plugins.json", '{"plugins":{"sample-plugin@fixture":[]}}')
        write(root, ".claude/tokens/private-file.dat", SECRET)
        write(root, ".claude/tokens/secret-name.txt", SECRET)
        write(root, ".claude/auth.json", SECRET)
        write(root, ".claude/.env", SECRET)
        state = {"skillUsage": {"reviewer": {"usageCount": 2}},
                 "mcpServers": {SECRET + "_MCP": {"env": {"AUTH": SECRET}}},
                 "projects": {cwd.replace("\\", "/"): {"mcpServers": {"example": {"args": [SECRET]}}}}}
        write(root, ".claude.json", json.dumps(state))
        listing = "- reviewer: Synthetic review\n- unused: Synthetic rarely used procedure\n- remote: Synchronized procedure\n- sample-command: Synthetic command\n- help: Product helper\n"
        rows = [
            {"type": "attachment", "attachment": {"type": "skill_listing", "isInitial": True, "skillCount": 5, "names": ["reviewer", "unused", "remote", "sample-command", "help"], "content": listing}},
            {"type": "attachment", "attachment": {"type": "hook_success", "hookEvent": "SessionStart", "command": "python hook.py --auth " + SECRET, "content": SECRET}},
            {"type": "assistant", "message": {"content": BODY}},
            {"type": "user", "message": {"content": BODY}},
        ]
        record(root, ".claude/projects/" + project_key + "/initial.jsonl", rows)
    if variant in ("codex_only", "both"):
        write(root, ".codex/config.toml", 'model = "synthetic-model"\nmodel_reasoning_effort = "max"\napproval_policy = "never"\nsandbox_mode = "read-only"\npersonality = "pragmatic"\nunknown_option = "' + SECRET + '"\n# [mcp_servers.legacy]\n[mcp_servers.tools]\nenabled = false\nargs = ["' + SECRET + '"]\n[plugins."sample-plugin@fixture"]\nenabled = false\n[plugins."active-plugin@fixture"]\nenabled = true\n[projects."/synthetic"]\ntrust_level = "trusted"\n')
        write(root, ".codex/hooks.json", json.dumps({"hooks": {"Stop": [{"hooks": [{"command": "python notify.py --secret " + SECRET}]}]}}))
        write(root, ".codex/AGENTS.md", "# Global instructions\nSynthetic instructions.\n")
        write(root, "AGENTS.md", "# Generated\nSynthetic instructions shadowed by override.\n")
        write(root, "AGENTS.override.md", "# Override\nIntentional synthetic override.\n")
        write(root, ".codex/memories/memory_summary.md", "Synthetic memory summary.\n")
        write(root, ".codex/memories/MEMORY.md", "Synthetic memory index.\n")
        write(root, ".codex/memories/note.md", "A synthetic memory body, counted without reading. " + SECRET + "\n")
        write(root, ".codex/rules/default.rules", SECRET * 4)
        write(root, ".codex/agents/helper.toml", 'name = "helper"\n')
        write(root, ".codex/references/guide.md", "# Guide\nSynthetic Codex guide.\n")
        write(root, ".codex/scripts/notify.py", "# Synthetic script; never executed.\n")
        for location, name in ((".codex/skills", "reviewer"), (".codex/skills", "duplicate"), (".agents/skills", "duplicate")):
            body = "# Compatibility wrapper\nRead the source at " + chr(96) + "~/.claude/skills/reviewer/SKILL.md" + chr(96) + ".\n" if name == "reviewer" else "# Synthetic duplicate\n"
            write(root, location + "/" + name + "/SKILL.md", "---\nname: " + name + "\ndescription: Synthetic " + name + "\n---\n" + body)
            write(root, location + "/" + name + "/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n")
        write(root, ".codex/skills/visible/SKILL.md", "---\nname: visible\ndescription: Visible skill\n---\n# Visible\n")
        write(root, ".codex/skills/.system/system-sample/SKILL.md", "---\nname: system-sample\ndescription: Synthetic bundled skill\n---\n# System\n")
        write(root, ".codex/auth.json", SECRET)
        write(root, ".codex/credentials-example", SECRET)
        write(root, ".codex/private.env", SECRET)
        skill_text = "<skills_instructions>\n## Skills\n### Skill roots\n"
        skill_text += "- " + chr(96) + "r0" + chr(96) + " = " + chr(96) + cwd.replace("\\", "/") + "/.codex/skills" + chr(96) + "\n"
        skill_text += "- " + chr(96) + "r1" + chr(96) + " = " + chr(96) + cwd.replace("\\", "/") + "/.codex/skills/.system" + chr(96) + "\n"
        skill_text += "- " + chr(96) + "r2" + chr(96) + " = " + chr(96) + cwd.replace("\\", "/") + "/.codex/plugins/cache/fixture/sample-plugin" + chr(96) + "\n"
        skill_text += "### Available skills\n- visible: Synthetic visible skill (file: r0/visible/SKILL.md)\n- system-sample: Synthetic system skill (file: r1/system-sample/SKILL.md)\n- sample-plugin:scan: Synthetic scanning (file: r2/scan/SKILL.md)\n- sample-plugin:write: Synthetic writing (file: r2/write/SKILL.md)\n</skills_instructions>\n"
        rows = [
            {"type": "session_meta", "payload": {"cwd": cwd, "base_instructions": "Synthetic product source"}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "## Memory\nSynthetic memory section.\n"}, {"type": "input_text", "text": skill_text}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "<permissions instructions>\nSynthetic permissions.\n"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions\n<INSTRUCTIONS>Synthetic override</INSTRUCTIONS>\n"}, {"type": "input_text", "text": "<environment_context>Synthetic environment</environment_context>"}]}},
            {"type": "world_state", "payload": {"body": BODY}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": BODY}]}},
        ]
        record(root, ".codex/sessions/2026/01/02/rollout-synthetic.jsonl", rows)
    if variant == "both":
        write(root, ".mycmux/agent_design/links.json", json.dumps({"links": [{"id": "synthetic-sync", "event": "Stop", "via": "dispatcher.py", "script": "sync.py", "writePath": "~/AGENTS.md", "targetService": "codex"}]}))
    return root

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--variant", choices=VARIANTS)
    args = parser.parse_args()
    if args.variant:
        prepare(args.output, args.variant)
    else:
        for variant in VARIANTS:
            prepare(args.output / variant, variant)
    print("synthetic homes prepared")

if __name__ == "__main__":
    main()
