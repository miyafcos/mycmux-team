"""Add the Stage B canaries to a freshly prepared synthetic Stage A home."""
import json
import runpy
import sys
from pathlib import Path

script = Path(__file__).with_name("prepare_home.py")
sys.argv += ["--variant", "both"]
runpy.run_path(str(script), run_name="__main__")
home = Path(sys.argv[1]).resolve()
extra = {
    ".claude/projects/synthetic/memory/export-extra.md": "CANARY_MEMORY_4D8E\n",
    ".claude/rules/export-public.md": "# Public rule\nUse a repeatable check.\n",
    ".claude/rules/export-name.md": "# Contact\nFICTIONAL_PERSON\n",
    ".mycmux/agent_design/export-names.txt": "fictional_person\n",
}
for relative, content in extra.items():
    path = home / relative
    assert not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode("utf-8"))
    assert path.read_bytes().decode("utf-8") == content and "\ufffd" not in content
print(json.dumps({"exportFixtureFiles": len(extra)}))
