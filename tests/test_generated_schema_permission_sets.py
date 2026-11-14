"""Generated platform permission identifiers must agree with the ACL manifest."""
from pathlib import Path
import json

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
