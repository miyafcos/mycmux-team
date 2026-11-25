"""Generated platform permission identifiers must agree with the ACL manifest."""
from pathlib import Path
import json
import re

import pytest

SCHEMAS = Path(__file__).resolve().parents[1] / "src-tauri/gen/schemas"


def schema_permission_identifiers(filename):
    document = json.loads((SCHEMAS / filename).read_text(encoding="utf-8"))
    return {entry["const"] for entry in document["definitions"]["Identifier"]["oneOf"]}


@pytest.mark.parametrize("filename", ["linux-schema.json", "macOS-schema.json", "windows-schema.json"])
def test_platform_permission_identifiers_match_desktop(filename):
    expected = schema_permission_identifiers("desktop-schema.json")
    actual = schema_permission_identifiers(filename)
    assert actual == expected, {"missing": sorted(expected - actual), "extra": sorted(actual - expected)}


def test_acl_manifest_permission_identifiers_match_desktop():
    manifests = json.loads((SCHEMAS / "acl-manifests.json").read_text(encoding="utf-8"))
    actual = set()
    for namespace, manifest in manifests.items():
        prefix = "" if namespace == "__app-acl__" else namespace + ":"
        for section in ("permissions", "permission_sets"):
            actual.update(prefix + identifier for identifier in manifest.get(section, {}))
        if manifest.get("default_permission") is not None:
            actual.add(prefix + "default")
    expected = schema_permission_identifiers("desktop-schema.json")
    assert actual == expected, {"missing": sorted(expected - actual), "extra": sorted(actual - expected)}


def test_windows_schema_is_byte_identical_to_desktop():
    assert (SCHEMAS / "windows-schema.json").read_bytes() == (SCHEMAS / "desktop-schema.json").read_bytes()


def test_linux_app_local_permission_description_matches_desktop():
    def permission(filename):
        document = json.loads((SCHEMAS / filename).read_text(encoding="utf-8"))
        return next(item for item in document["definitions"]["Identifier"]["oneOf"] if item["const"] == "app-local")


    source = (SCHEMAS.parents[1] / "permissions/app-local.toml").read_text(encoding="utf-8")
    array = re.search(r"(?ms)^permissions = \[(.*?)^\]", source)
    assert array is not None
    allowed = set(re.findall(r'^\s*"([^"]+)",?\s*$', array.group(1), re.MULTILINE))
    assert allowed
    desktop = permission("desktop-schema.json")
    linux = permission("linux-schema.json")
    assert linux == desktop
    for field in ("description", "markdownDescription"):
        listed = re.findall(r"^- `([^`]+)`$", linux[field], re.MULTILINE)
        assert sorted(listed) == sorted(allowed)

def test_app_local_rejects_a_permission_omitted_in_both_schema_descriptions(monkeypatch):
    read_text = Path.read_text

    def read_with_omission(path, *args, **kwargs):
        raw = read_text(path, *args, **kwargs)
        if path.parent != SCHEMAS or path.name not in {"desktop-schema.json", "linux-schema.json"}:
            return raw
        document = json.loads(raw)
        entry = next(row for row in document["definitions"]["Identifier"]["oneOf"] if row["const"] == "app-local")
        for field in ("description", "markdownDescription"):
            assert "- `allow-abort-next-action-judge`\n" in entry[field]
            entry[field] = entry[field].replace("- `allow-abort-next-action-judge`\n", "", 1)
        return json.dumps(document)

    monkeypatch.setattr(Path, "read_text", read_with_omission)
    with pytest.raises(AssertionError, match="allow-abort-next-action-judge"):
        test_linux_app_local_permission_description_matches_desktop()
