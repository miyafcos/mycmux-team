"""The local integration check must detect a missed commit without calling it release acceptance."""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location("next_update_check", Path(__file__).resolve().parents[1] / "scripts/check_next_update_inclusion.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@pytest.fixture
def history(tmp_path):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], encoding="utf-8", stderr=subprocess.DEVNULL).strip()
    git("init")
    git("-c", "user.name=Inclusion test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")
    base = git("rev-parse", "HEAD")
    git("-c", "user.name=Inclusion test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "feature")
    feature = git("rev-parse", "HEAD")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "requiredCommits": [{"id": "feature", "commit": feature}],
                                    "releaseConditions": ["Native acceptance required"]}), encoding="utf-8")
    return tmp_path, manifest, base, feature


def test_integrated_head_preserves_unperformed_acceptance(history):
    repo, manifest, _, feature = history
    result = MODULE.check(repo, manifest, "HEAD")
    assert result["allIncluded"] and result["head"] == feature
    assert result["releaseAcceptanceCertified"] is False
    assert result["remainingConditions"] == ["Native acceptance required"]


def test_older_branch_detects_an_omitted_feature(history):
    repo, manifest, base, _ = history
    result = MODULE.check(repo, manifest, base)
    assert not result["allIncluded"]
    assert result["commits"][0]["gitExitCode"] == 1


def test_empty_or_malformed_commit_manifest_cannot_pass(history):
    repo, manifest, _, _ = history
    for commits in [[], [{"id": "unsafe", "commit": "--help"}]]:
        manifest.write_text(json.dumps({"schemaVersion": 1, "requiredCommits": commits}), encoding="utf-8")
        with pytest.raises(ValueError):
            MODULE.check(repo, manifest, "HEAD")


def test_missing_commit_is_not_treated_as_included(history):
    repo, manifest, _, _ = history
    manifest.write_text(json.dumps({"schemaVersion": 1, "requiredCommits": [{"id": "missing", "commit": "f" * 40}]}), encoding="utf-8")
    result = MODULE.check(repo, manifest, "HEAD")
    assert not result["allIncluded"]
    assert result["commits"][0]["gitExitCode"] > 1
