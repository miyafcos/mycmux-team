"""Export committed blobs without checkout, index updates, filters or history.

Rules are rooted, case-sensitive globs. * and ? match within one component;
** matches zero or more components. Backslashes in rules mean separators;
literal backslashes in Git filenames are rejected instead of being rewritten.
--list alone counts only; --out with --list also writes, suppressing path output.
--tree-object writes only Git tree objects via a disposable index and prints its SHA.
Policy is read from the private tool directory, independently of --rev.
"""
from __future__ import annotations

import argparse
import fnmatch
from functools import lru_cache
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from public_scrub_gate import is_link, load_patterns, redact, rule_lines

POLICY_DIR = Path(__file__).with_name("public_export")
PRIVATE_FILES = {"scripts/public_export/denylist.txt", "scripts/public_export/patterns.txt"}


def git(*args, input=None, env=None):
    result = subprocess.run(
        ["git", "--no-optional-locks", *args], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, input=input,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", **(env or {})},
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"git plumbing exited {result.returncode}: {detail}")
    return result.stdout


def matches(path: str, rule: str) -> bool:
    parts, pattern = path.split("/"), rule.replace("\\", "/").split("/")

    @lru_cache(None)
    def match(i, j):
        if j == len(pattern):
            return i == len(parts)
        if pattern[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], pattern[j]) and match(i + 1, j + 1)
    return match(0, 0)


def entries(rev, rules):
    # Resolve exactly once so a concurrently moving branch cannot mix trees.
    commit = git("rev-parse", "--verify", "--end-of-options", rev + "^{commit}").decode().strip()
    kept, excluded = [], []
    for record in git("ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = raw_path.decode("utf-8")
        if path in PRIVATE_FILES or any(matches(path, rule) for rule in rules):
            excluded.append(path)
        else:
            if kind != "blob" or mode not in {"100644", "100755"}:
                raise ValueError("unsupported Git mode; symlinks and submodules need explicit handling")
            kept.append((path, oid, mode))
    return commit, kept, excluded


def validate_paths(kept):
    seen = {}
    for path, _, _ in kept:
        parts = path.split("/")
        if "\\" in path or any(p in {"", ".", ".."} or p.lower() == ".git" for p in parts):
            raise ValueError("unsafe Git path")
        for i, part in enumerate(parts):
            if os.name == "nt" and (
                any(c in part for c in '<>:"|?*') or part[-1] in " ."
                or any(ord(c) < 32 for c in part)
                or part.split(".")[0].upper() in {
                    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
                    *("COM" + str(n) for n in range(1, 10)),
                    *("LPT" + str(n) for n in range(1, 10)),
                }
            ):
                raise ValueError("unrepresentable Windows path")
            prefix = "/".join(parts[:i + 1])
            key = prefix.casefold() if os.name == "nt" else prefix
            if key in seen and seen[key] != prefix:
                raise ValueError("case collision on destination filesystem")
            seen[key] = prefix


def validate_destination(out: Path, root: Path):
    absolute = out.absolute()
    for path in (absolute, *absolute.parents):
        if path.is_symlink() or (path.exists() and is_link(path)):
            raise ValueError("linked output path")
    resolved = absolute.resolve()
    if resolved.is_relative_to(root) or root.is_relative_to(resolved):
        raise ValueError("output overlaps source worktree")
    # A linked worktree's administrative area is outside its working directory.
    for arg in ("--absolute-git-dir", "--git-common-dir"):
        admin = Path(git("rev-parse", arg).decode().strip()).resolve()
        if resolved.is_relative_to(admin) or admin.is_relative_to(resolved):
            raise ValueError("output overlaps Git metadata")
    if absolute.exists() and (not absolute.is_dir() or any(absolute.iterdir())):
        raise ValueError("output must be empty")
    return absolute


def write_tree_object(kept):
    # Never initialize from the ordinary index: staged/unstaged files, filters
    # and autocrlf must have no influence on the committed blob identifiers.
    directory = Path(tempfile.mkdtemp(prefix="public-export-index-"))
    index = directory / "index"
    env = {"GIT_INDEX_FILE": str(index)}
    try:
        records = b"".join(
            f"{mode} {oid}\t{path}\0".encode("utf-8") for path, oid, mode in kept
        )
        git("-c", "core.splitIndex=false", "-c", "core.untrackedCache=false",
            "update-index", "-z", "--index-info", input=records, env=env)
        return git("write-tree", env=env).decode("ascii").strip()
    finally:
        # Only our two disposable files can be removed; no recursive cleanup.
        for path in (index.with_name("index.lock"), index):
            path.unlink(missing_ok=True)
        directory.rmdir()


def validate_output_length(out, kept):
    if os.name != "nt":
        return
    # Win32 counts UTF-16 code units, including each directory separator.
    longest = max((len(str(out.absolute().joinpath(*path.split("/")))
                       .encode("utf-16-le")) // 2 for path, _, _ in kept),
                  default=len(str(out.absolute()).encode("utf-16-le")) // 2)
    if longest > 260:
        raise ValueError(
            f"longest output path is {longest} characters; exceeds Windows limit 260"
        )


def write_blobs(out, kept):
    out.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        ["git", "--no-optional-locks", "cat-file", "--batch"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    try:
        for path, oid, mode in kept:
            process.stdin.write((oid + "\n").encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3 or header[0].decode() != oid or header[1] != b"blob":
                raise ValueError("invalid blob response")
            remaining = int(header[2])
            target = out.joinpath(*path.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                while remaining:
                    chunk = process.stdout.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("incomplete blob")
                    stream.write(chunk)
                    remaining -= len(chunk)
            if process.stdout.read(1) != b"\n":
                raise ValueError("invalid blob terminator")
            if os.name != "nt":
                target.chmod(0o755 if mode == "100755" else 0o644)
        process.stdin.close()
        if process.wait() != 0:
            raise ValueError("blob reader failed")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rev", default="HEAD")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--tree-object", action="store_true")
    args = parser.parse_args(argv)
    patterns = []
    try:
        patterns = load_patterns(POLICY_DIR / "patterns.txt")
        if args.tree_object and (args.out is not None or args.list):
            raise ValueError("--tree-object cannot be combined with --out or --list")
        if args.out is None and not args.list and not args.tree_object:
            raise ValueError("out, list or tree-object is required")
        rules = [rule for _, rule, _ in rule_lines(POLICY_DIR / "denylist.txt")]
        if not rules:
            raise ValueError("denylist is empty")
        root = Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve()
        _, kept, excluded = entries(args.rev, rules)
        if args.tree_object:
            print(write_tree_object(kept))
            return 0
        validate_paths(kept)
        if args.out is not None:
            validate_output_length(args.out, kept)
            out = validate_destination(args.out, root)
            write_blobs(out, kept)
        print(f"retained={len(kept)} excluded={len(excluded)}")
        if not args.list:
            for path in excluded:
                print("excluded " + json.dumps(redact(path, patterns), ensure_ascii=True))
        return 0
    except (OSError, ValueError, UnicodeError) as error:
        # If the policy itself cannot be loaded, no unfiltered detail is safe.
        message = redact(str(error), patterns) if patterns else (
            f"<redacted len={len(str(error))}> (private policy unavailable)"
        )
        # Keep diagnostics on one line, even for multiline native stderr.
        message = message.replace("\r", r"\r").replace("\n", r"\n")
        print(f"export error: {type(error).__name__}: {message}; "
              "partial output, if any, is not reusable", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
