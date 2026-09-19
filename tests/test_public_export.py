"""Synthetic-only integration checks for private-to-public export tooling."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
EXPORT = ROOT / "scripts" / "public_export.py"
GATE = ROOT / "scripts" / "public_scrub_gate.py"
spec = importlib.util.spec_from_file_location("export_gate_under_test", GATE)
gate_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate_module)


def run(*args, cwd=None):
    return subprocess.run([str(a) for a in args], cwd=cwd,
                          capture_output=True, text=True, encoding="utf-8",
                          env={**os.environ, "PYTHONIOENCODING": "utf-8",
                               "PYTHONDONTWRITEBYTECODE": "1"})


def git(repo, *args):
    result = run("git", "-c", "core.hooksPath=/dev/null",
                 "-c", "commit.gpgSign=false", *args, cwd=repo)
    assert result.returncode == 0, result.stderr
    return result.stdout


def put(repo, name, data):
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))


@pytest.fixture
def repository(tmp_path):
    repo = tmp_path / "source"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Synthetic Tester")
    git(repo, "config", "user.email", "tester@example.invalid")
    git(repo, "config", "core.autocrlf", "false")
    put(repo, "scripts/public_export.py", EXPORT.read_bytes())
    put(repo, "scripts/public_scrub_gate.py", GATE.read_bytes())
    put(repo, "scripts/public_export/denylist.txt", (
        "# synthetic policy\n"
        "docs/plans/** # synthetic internal documents\n"
        "docs\\history\\** # separator normalization\n"
        "docs/mail-*.md # one component only\n"
        "package-source-*.txt # root pattern\n"
        "scripts/public_export/denylist.txt # private policy\n"
        "scripts/public_export/patterns.txt # private policy\n"
    ))
    put(repo, "scripts/public_export/patterns.txt",
        "SYNTHETIC_PRIVATE # category=person audit_rows=1 targeted_rows=1\n")
    put(repo, "docs/plans/private.md", "SYNTHETIC_PRIVATE")
    put(repo, "docs/plans/nested/deep.md", "SYNTHETIC_PRIVATE")
    put(repo, "docs/history/log.md", "SYNTHETIC_PRIVATE")
    put(repo, "docs/mail-team.md", "private")
    put(repo, "docs/deeper/mail-team.md", "public nested doc")
    put(repo, "package-source-demo.txt", "private")
    put(repo, "README.md", b"Public\r\n")
    put(repo, "LICENSE", b"Example license\n")
    put(repo, "CaseDir/Keep.TXT", b"Case retained\x00\xff")
    put(repo, "space dir/caf\u00e9.txt", "UTF-8: \u96ea\n")
    put(repo, "run.sh", b"#!/bin/sh\necho ok\n")
    put(repo, "blob.bin", bytes(range(256)))
    git(repo, "add", ".")
    git(repo, "update-index", "--chmod=+x", "run.sh")
    git(repo, "commit", "-qm", "Synthetic base")
    return repo


def export(repo, *args):
    return run(sys.executable, repo / "scripts/public_export.py", *args, cwd=repo)


def state(repo):
    return (git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
            git(repo, "rev-parse", "HEAD"), git(repo, "show-ref"),
            hashlib.sha256((repo / ".git/index").read_bytes()).hexdigest())


def test_export_excludes_private_policies_and_preserves_exact_blobs(repository, tmp_path):
    before = state(repository)
    out = tmp_path / "export"
    result = export(repository, "--out", out)
    assert result.returncode == 0, result.stderr
    assert "retained=9 excluded=7" in result.stdout
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert not (out / ".git").exists()
    for path in ["docs/plans/private.md", "docs/plans/nested/deep.md",
                 "docs/history/log.md", "docs/mail-team.md",
                 "scripts/public_export/denylist.txt", "scripts/public_export/patterns.txt"]:
        assert not (out / path).exists()
    for path in ["README.md", "LICENSE", "CaseDir/Keep.TXT", "blob.bin",
                 "space dir/caf\u00e9.txt", "docs/deeper/mail-team.md", "run.sh"]:
        expected = subprocess.check_output(["git", "show", "HEAD:" + path], cwd=repository)
        assert (out / path).read_bytes() == expected
    if os.name != "nt":
        assert (out / "run.sh").stat().st_mode & 0o111
    assert state(repository) == before


def test_revision_is_committed_snapshot_and_dirty_state_is_preserved(repository, tmp_path):
    original = git(repository, "rev-parse", "HEAD").strip()
    put(repository, "README.md", "new committed version")
    git(repository, "add", "README.md")
    git(repository, "commit", "-qm", "Synthetic next")
    put(repository, "README.md", "uncommitted staged version")
    git(repository, "add", "README.md")
    put(repository, "README.md", "unstaged version")
    put(repository, "untracked.txt", "untracked version")
    before = state(repository)
    out = tmp_path / "snapshot"
    result = export(repository, "--rev", original, "--out", out, "--list")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "retained=9 excluded=7"
    assert (out / "README.md").read_bytes() == b"Public\r\n"
    assert not (out / "untracked.txt").exists()
    assert state(repository) == before


def test_list_without_out_is_read_only(repository):
    before = state(repository)
    result = export(repository, "--list")
    assert result.returncode == 0
    assert result.stdout.strip() == "retained=9 excluded=7"
    assert state(repository) == before


@pytest.mark.parametrize("kind", ["nonempty", "file", "source", "metadata", "invalid_rev"])
def test_export_refuses_unsafe_destinations_and_revisions(repository, tmp_path, kind):
    out = tmp_path / "destination"
    args = []
    if kind == "nonempty":
        out.mkdir()
        (out / "sentinel").write_bytes(b"do not overwrite")
    elif kind == "file":
        out.write_bytes(b"do not overwrite")
    elif kind == "source":
        out = repository / "new-output"
    elif kind == "metadata":
        out = repository / ".git" / "new-output"
    elif kind == "invalid_rev":
        args = ["--rev", "--not-a-revision"]
    before = state(repository)
    result = export(repository, "--out", out, *args)
    assert result.returncode == 2
    if kind == "nonempty":
        assert (out / "sentinel").read_bytes() == b"do not overwrite"
    elif kind == "file":
        assert out.read_bytes() == b"do not overwrite"
    else:
        assert not out.exists()
    assert state(repository) == before


def test_export_can_use_existing_empty_directory(repository, tmp_path):
    out = tmp_path / "empty"
    out.mkdir()
    assert export(repository, "--out", out).returncode == 0


def test_export_private_policy_exclusion_is_mandatory(repository, tmp_path):
    put(repository, "scripts/public_export/denylist.txt", "docs/plans/**\n")
    out = tmp_path / "no-policy-leak"
    assert export(repository, "--out", out).returncode == 0
    assert not (out / "scripts/public_export/denylist.txt").exists()
    assert not (out / "scripts/public_export/patterns.txt").exists()


def test_export_excluded_paths_are_redacted(repository, tmp_path):
    put(repository, "docs/plans/SYNTHETIC_PRIVATE.md", "private")
    git(repository, "add", ".")
    git(repository, "commit", "-qm", "Synthetic named path")
    result = export(repository, "--out", tmp_path / "redacted")
    assert result.returncode == 0
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert "<redacted len=17>" in result.stdout


def test_export_rejects_symlink_blob_without_following_it(repository, tmp_path):
    oid = git(repository, "rev-parse", "HEAD:README.md").strip()
    git(repository, "update-index", "--add", "--cacheinfo", f"120000,{oid},link")
    git(repository, "commit", "-qm", "Synthetic link mode")
    result = export(repository, "--out", tmp_path / "unsupported")
    assert result.returncode == 2
    assert not (tmp_path / "unsupported").exists()


def make_scan(tmp_path, expression="SYNTHETIC_PRIVATE"):
    tree = tmp_path / "tree"
    tree.mkdir()
    patterns = tmp_path / "policy.txt"
    patterns.write_text(expression + " # category=person\n", encoding="utf-8")
    return tree, patterns, tmp_path / "result.json"


def scan(tree, patterns, output, *extra):
    return run(sys.executable, GATE, "--tree", tree, "--patterns", patterns,
               "--json", output, *extra)


def test_gate_detects_text_names_binary_names_and_redacts_all_outputs(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    put(tree, "text.txt", "safe\nSYNTHETIC_PRIVATE and SYNTHETIC_PRIVATE\n")
    put(tree, "SYNTHETIC_PRIVATE.bin", b"\x00\xffSYNTHETIC_PRIVATE")
    result = scan(tree, patterns, output, "--max-show", "1")
    assert result.returncode == 1, result.stderr
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["total_matches"] == 3
    assert report["binary_files_name_only"] == 1
    assert report["patterns"][0]["count"] == 3
    assert report["category_counts"] == {"person": 3}
    assert sum(report["file_counts"].values()) == 3
    assert {item["line"] for item in report["findings"]} == {0, 2}
    assert all(item["match"] == "<redacted len=17>" for item in report["findings"])
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr + output.read_text()
    assert result.stdout.count(" P001 <redacted") == 1


def test_gate_clean_tree_and_binary_payload_exit_zero(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    put(tree, "clean.txt", "public")
    put(tree, "binary.bin", b"\0\xffSYNTHETIC_PRIVATE")
    result = scan(tree, patterns, output, "--max-show", "0")
    assert result.returncode == 0
    assert json.loads(output.read_text())["total_matches"] == 0


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16", "utf-32", "cp932"])
def test_gate_scans_text_encodings_with_original_lines(tmp_path, encoding):
    tree, patterns, output = make_scan(tmp_path)
    put(tree, "encoded.txt", "header\n\u96ea SYNTHETIC_PRIVATE\n".encode(encoding))
    assert scan(tree, patterns, output).returncode == 1
    assert json.loads(output.read_text())["findings"][0]["line"] == 2


def test_gate_scans_nul_in_source_and_unicode_escapes(tmp_path):
    tree, patterns, output = make_scan(tmp_path, "SYNTHETIC_PRIVATE|\u96ea")
    put(tree, "nul.ts", b'const value = "\0SYNTHETIC_PRIVATE";\n')
    put(tree, "escaped.json", '{"name": "\\u96ea"}\n')
    result = scan(tree, patterns, output)
    assert result.returncode == 1
    report = json.loads(output.read_text())
    assert report["total_matches"] == 2
    assert report["binary_files_name_only"] == 0
    assert "\u96ea" not in output.read_text()


@pytest.mark.parametrize("expression", ["", "# no rules", "(", ".*", "(?=X)"])
def test_gate_invalid_or_empty_policies_fail_closed_without_leaking(tmp_path, expression):
    tree, patterns, output = make_scan(tmp_path, expression)
    put(tree, "data.txt", "X")
    result = scan(tree, patterns, output)
    assert result.returncode == 2
    assert not output.exists()


def test_gate_missing_tree_fails_closed(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    result = scan(tree / "missing", patterns, output)
    assert result.returncode == 2
    assert not output.exists()


def test_gate_refuses_report_in_tree_or_existing_file(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    assert scan(tree, patterns, tree / "result.json").returncode == 2
    assert not (tree / "result.json").exists()
    output.write_text("sentinel", encoding="utf-8")
    assert scan(tree, patterns, output).returncode == 2
    assert output.read_text() == "sentinel"


def test_gate_does_not_follow_directory_links(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tree / "external"
    if os.name == "nt":
        made = run("cmd", "/c", "mklink", "/J", link, outside)
        assert made.returncode == 0, made.stderr
    else:
        link.symlink_to(outside, target_is_directory=True)
    result = scan(tree, patterns, output)
    assert result.returncode == 2
    assert not output.exists()


def test_rule_comments_and_literal_hash(tmp_path):
    tree, patterns, output = make_scan(tmp_path, r"MARK\x23VALUE")
    put(tree, "data.txt", "MARK#VALUE")
    assert scan(tree, patterns, output).returncode == 1
    assert "MARK#VALUE" not in output.read_text()


def test_invalid_text_encoding_cannot_pass_as_binary(tmp_path):
    tree, patterns, output = make_scan(tmp_path)
    put(tree, "broken.txt", b"\x81")
    assert scan(tree, patterns, output).returncode == 2


def test_globs_are_case_sensitive_and_component_scoped(repository, tmp_path):
    put(repository, "docs/Plans/keep.md", "public")
    put(repository, "nested/package-source-keep.txt", "public")
    git(repository, "add", ".")
    git(repository, "commit", "-qm", "Synthetic glob cases")
    out = tmp_path / "glob-result"
    # On Windows the directory spelling can collapse with docs/plans; validate
    # case semantics directly using the tool loaded without bytecode writes.
    source = EXPORT.read_text(encoding="utf-8")
    namespace = {"__name__": "export_test", "__file__": str(EXPORT)}
    old_bytecode = sys.dont_write_bytecode
    old = sys.modules.get("public_scrub_gate")
    sys.modules["public_scrub_gate"] = gate_module
    try:
        exec(compile(source, str(EXPORT), "exec"), namespace)
        match = namespace["matches"]
        assert not match("docs/Plans/keep.md", "docs/plans/**")
        assert not match("nested/package-source-keep.txt", "package-source-*.txt")
        assert match("docs/plans/a/b.md", "docs\\plans\\**")
        assert match("a/b.txt", "**/b.txt")
        assert match("b.txt", "**/b.txt")
    finally:
        sys.dont_write_bytecode = old_bytecode
        if old is None:
            sys.modules.pop("public_scrub_gate", None)
        else:
            sys.modules["public_scrub_gate"] = old
    assert export(repository, "--out", out).returncode == 0
    assert (out / "nested/package-source-keep.txt").exists()


def test_redacted_filenames_do_not_merge_distinct_file_counts(tmp_path):
    tree, patterns, output = make_scan(tmp_path, "PRIVATE_[AB]")
    put(tree, "PRIVATE_A.txt", "PRIVATE_A")
    put(tree, "PRIVATE_B.txt", "PRIVATE_B")
    assert scan(tree, patterns, output).returncode == 1
    report = json.loads(output.read_text())
    assert report["total_matches"] == 4
    assert len(report["file_counts"]) == 2
    assert sorted(report["file_counts"].values()) == [2, 2]
    assert "PRIVATE_A" not in output.read_text()
    assert "PRIVATE_B" not in output.read_text()


def test_export_refuses_linked_destination_ancestor(repository, tmp_path):
    outside = tmp_path / "other"
    outside.mkdir()
    link = tmp_path / "linked"
    if os.name == "nt":
        result = run("cmd", "/c", "mklink", "/J", link, outside)
        assert result.returncode == 0, result.stderr
    else:
        link.symlink_to(outside, target_is_directory=True)
    before = state(repository)
    assert export(repository, "--out", link / "child").returncode == 2
    assert not (outside / "child").exists()
    assert state(repository) == before


@pytest.mark.skipif(os.name != "nt", reason="Windows filesystem collision")
def test_export_rejects_case_collision_before_writing(repository, tmp_path):
    oid = git(repository, "rev-parse", "HEAD:README.md").strip()
    git(repository, "update-index", "--add", "--cacheinfo", f"100644,{oid},case/file.txt")
    git(repository, "update-index", "--add", "--cacheinfo", f"100644,{oid},CASE/other.txt")
    git(repository, "commit", "-qm", "Synthetic case collision")
    out = tmp_path / "collision"
    assert export(repository, "--out", out).returncode == 2
    assert not out.exists()


@pytest.fixture
def exporter_module(monkeypatch):
    module_spec = importlib.util.spec_from_file_location("public_export_under_test", EXPORT)
    module = importlib.util.module_from_spec(module_spec)
    monkeypatch.setitem(sys.modules, "public_scrub_gate", gate_module)
    old_bytecode = sys.dont_write_bytecode
    try:
        module_spec.loader.exec_module(module)
        yield module
    finally:
        sys.dont_write_bytecode = old_bytecode


def tree_entries(repo, rev):
    raw = subprocess.check_output(
        ["git", "ls-tree", "-rz", "--full-tree", rev], cwd=repo
    )
    return {record.split(b"\t", 1)[1].decode("utf-8"):
            tuple(record.split(b"\t", 1)[0].decode("ascii").split())
            for record in raw.split(b"\0") if record}


def test_tree_object_preserves_every_blob_and_mode_with_dirty_index(
    repository, tmp_path, monkeypatch
):
    put(repository, ".gitattributes", "* text=auto\n*.bin -text\n*.txt eol=crlf\n")
    git(repository, "add", ".gitattributes")
    git(repository, "commit", "-qm", "Synthetic attributes")
    source_rev = git(repository, "rev-parse", "HEAD").strip()
    source = tree_entries(repository, source_rev)
    git(repository, "config", "core.autocrlf", "true")
    put(repository, "README.md", "staged version\r\n")
    git(repository, "add", "README.md")
    put(repository, "README.md", "unstaged version\r\n")
    put(repository, "untracked.txt", "not committed")
    temporary = tmp_path / "temporary"
    temporary.mkdir()
    monkeypatch.setenv("TEMP", str(temporary))
    monkeypatch.setenv("TMP", str(temporary))
    before = state(repository)
    result = export(repository, "--rev", source_rev, "--tree-object")
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert len(result.stdout.splitlines()) == 1
    tree = result.stdout.strip()
    assert len(tree) in (40, 64) and all(c in "0123456789abcdef" for c in tree)
    assert git(repository, "cat-file", "-t", tree).strip() == "tree"
    filtered = tree_entries(repository, tree)
    excluded = {
        "docs/plans/private.md", "docs/plans/nested/deep.md", "docs/history/log.md",
        "docs/mail-team.md", "package-source-demo.txt",
        "scripts/public_export/denylist.txt", "scripts/public_export/patterns.txt",
    }
    assert set(source) - set(filtered) == excluded
    assert filtered == {p: value for p, value in source.items() if p not in excluded}
    assert filtered["run.sh"][0] == "100755"
    assert state(repository) == before
    assert (repository / "README.md").read_bytes() == b"unstaged version\r\n"
    assert not list(temporary.iterdir())
    # A second call must not introduce state or yield a different tree.
    assert export(repository, "--rev", source_rev, "--tree-object").stdout == result.stdout
    assert not list(temporary.iterdir())


def test_tree_object_empty_tree_is_valid_and_private_policies_never_escape(
    repository, tmp_path, monkeypatch
):
    put(repository, "scripts/public_export/denylist.txt", "** # empty export\n")
    temporary = tmp_path / "temporary"
    temporary.mkdir()
    monkeypatch.setenv("TEMP", str(temporary))
    monkeypatch.setenv("TMP", str(temporary))
    before = state(repository)
    result = export(repository, "--tree-object")
    assert result.returncode == 0, result.stderr
    assert tree_entries(repository, result.stdout.strip()) == {}
    assert state(repository) == before
    assert not list(temporary.iterdir())


@pytest.mark.parametrize("stage", ["update-index", "write-tree"])
def test_tree_object_failure_removes_its_index_without_touching_normal_index(
    repository, tmp_path, monkeypatch, exporter_module, stage
):
    monkeypatch.chdir(repository)
    monkeypatch.setattr(exporter_module.tempfile, "tempdir", str(tmp_path))
    real_git = exporter_module.git
    touched = []
    before = state(repository)

    def injected_git(*args, **kwargs):
        if stage in args:
            index = Path(kwargs["env"]["GIT_INDEX_FILE"])
            touched.append(index)
            # Model a native failure leaving either the temporary index or lock.
            index.write_bytes(b"synthetic partial index")
            index.with_name("index.lock").write_bytes(b"synthetic lock")
            raise OSError("synthetic native failure")
        return real_git(*args, **kwargs)

    monkeypatch.setattr(exporter_module, "git", injected_git)
    with pytest.raises(OSError, match="synthetic native failure"):
        exporter_module.write_tree_object([])
    assert touched and all(not p.parent.exists() for p in touched)
    assert state(repository) == before


@pytest.mark.parametrize("other", [["--list"], ["--out", "unused-output"]])
def test_tree_object_refuses_ambiguous_output_modes(repository, other):
    result = export(repository, "--tree-object", *other)
    assert result.returncode == 2
    assert result.stdout == ""
    assert "ValueError" in result.stderr and "cannot be combined" in result.stderr
    assert not (repository / "unused-output").exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows path limit")
def test_longest_output_path_is_reported_before_any_output_is_created(repository, tmp_path):
    out = tmp_path / ("a" * 90) / ("b" * 90)
    kept = [
        "scripts/public_export.py", "scripts/public_scrub_gate.py",
        "README.md", "LICENSE", "CaseDir/Keep.TXT", "blob.bin",
        "space dir/caf\u00e9.txt", "docs/deeper/mail-team.md", "run.sh",
    ]
    longest = max(len(str(out / p).encode("utf-16-le")) // 2 for p in kept)
    assert longest > 260
    before = state(repository)
    result = export(repository, "--out", out)
    assert result.returncode == 2
    assert result.stdout == ""
    assert f"ValueError: longest output path is {longest} characters" in result.stderr
    assert "exceeds Windows limit 260" in result.stderr
    assert not out.parent.exists()
    assert state(repository) == before


def test_export_error_keeps_exception_class_and_redacts_only_private_spans(
    repository, tmp_path, monkeypatch, exporter_module, capsys
):
    monkeypatch.chdir(repository)
    monkeypatch.setattr(exporter_module, "POLICY_DIR", repository / "scripts/public_export")

    def failed_write(*_):
        raise PermissionError("cannot write SYNTHETIC_PRIVATE/output.txt: access denied")

    monkeypatch.setattr(exporter_module, "write_blobs", failed_write)
    assert exporter_module.main(["--out", str(tmp_path / "destination")]) == 2
    captured = capsys.readouterr()
    assert not captured.out
    assert "export error: PermissionError: cannot write <redacted len=17>/output.txt: access denied" in captured.err
    assert "SYNTHETIC_PRIVATE" not in captured.err


def test_export_git_error_contains_native_reason(repository):
    result = export(repository, "--rev", "does-not-exist", "--tree-object")
    assert result.returncode == 2
    assert "export error: ValueError: git plumbing exited" in result.stderr
    assert "fatal:" in result.stderr
    assert result.stdout == ""


def test_release_mirror_uses_filtered_tree_and_capture_throws_on_failure():
    release = (ROOT / "scripts/release-local.ps1").read_text(encoding="utf-8")
    block = release[release.index('  $mirrorRemote = "public"'):
                    release.index('    Write-Host "公開ミラー: PASS')]
    assert '$localTree = Invoke-NativeCapture -FilePath "python"' in block
    # The tag, not the branch. Two sessions share one local `master`, so reading
    # it can export a tree that was never released -- on 2026-09-19 the main
    # tree carried an unreleased v0.77.0 while v0.76.1 shipped from a detached
    # worktree. tests/test_release_script_contract.py holds the same line.
    assert '"public_export.py"), "--rev", $tag, "--tree-object")' in block
    assert '"--rev", "master"' not in block
    assert 'if ($mirrorTree -eq $localTree)' in block
    assert '@("commit-tree", $localTree, "-p", $mirrorHead, "-m", "sync: mycmux $tag (public export)")' in block
    assert "master^{tree}" not in block
    helper = release[release.index("function Invoke-NativeCapture {"):
                     release.index("function Test-NativeSuccess {")]
    assert 'if ($exitCode -ne 0)' in helper
    assert 'throw ' in helper
