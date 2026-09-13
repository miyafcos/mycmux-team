"""Fail-closed, redacted privacy scan of an exported directory (stdlib only).

Patterns: one regex per line, optional " # category=name ..." comment.
Full-line # comments are ignored; use \x23 for a literal hash after whitespace.
Reports count occurrences per pattern (overlapping patterns count separately).
Line 0 means a path match; binary payloads are never searched.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import stat
import sys

DEFAULT_PATTERNS = Path(__file__).with_name("public_export") / "patterns.txt"
TEXT_SUFFIXES = {
    ".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt",
    ".html", ".css", ".scss", ".toml", ".yaml", ".yml", ".xml", ".svg",
    ".sh", ".ps1", ".bat", ".cmd", ".csv", ".ini", ".cfg", ".lock",
}
ESCAPES = re.compile(r"\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\x([0-9a-fA-F]{2})")


def rule_lines(path: Path):
    for number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        parts = re.split(r"\s+#", raw, maxsplit=1)
        yield number, parts[0].strip(), parts[1].strip() if len(parts) == 2 else ""


def load_patterns(path: Path):
    patterns = []
    for number, expression, comment in rule_lines(path):
        category = re.search(r"(?:^|\s)category=([a-z_]+)(?:\s|$)", comment)
        try:
            regex = re.compile(expression)
        except re.error:
            raise ValueError(f"invalid regex at policy line {number}") from None
        if regex.search("") is not None:
            raise ValueError(f"empty-match regex at policy line {number}")
        patterns.append((f"P{len(patterns) + 1:03d}",
                         category[1] if category else "uncategorized", number, regex))
    if not patterns:
        raise ValueError("pattern policy is empty")
    return patterns


def expand_escapes(value: str) -> str:
    def convert(match):
        point = int(next(g for g in match.groups() if g is not None), 16)
        return chr(point) if point <= 0x10FFFF else match[0]
    return ESCAPES.sub(convert, value)


def redact(value: str, patterns) -> str:
    # Expand source escapes before collecting spans, so escaped names in paths
    # cannot bypass the redaction used for filenames and report keys.
    value = expand_escapes(value)
    spans = sorted((m.start(), m.end()) for _, _, _, regex in patterns
                   for m in regex.finditer(value) if m.end() > m.start())
    merged = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    for start, end in reversed(merged):
        value = value[:start] + f"<redacted len={end - start}>" + value[end:]
    return value


def is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
        and getattr(info, "st_reparse_tag", 0) & 0x20000000
    )


def read_text(data: bytes, path: Path):
    for bom, encoding in ((b"\xff\xfe\x00\x00", "utf-32"),
                          (b"\x00\x00\xfe\xff", "utf-32"),
                          (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if data.startswith(bom):
            return data.decode(encoding)
    known_text = path.suffix.lower() in TEXT_SUFFIXES
    try:
        value = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        if known_text:
            # Legacy Japanese sources are text too. An undecodable text file
            # is an error, never a silent binary exemption.
            return data.decode("cp932")
        return None
    controls = sum(ord(c) < 32 and c not in "\t\n\r\f" for c in value)
    if not known_text and (b"\0" in data or controls > max(1, len(value) // 100)):
        return None
    return value


def scan_tree(tree: Path, patterns):
    if is_link(tree) or not tree.is_dir():
        raise ValueError("tree must be an ordinary directory")
    findings = []
    files_scanned = text_files = binary_files = 0
    counts = Counter()
    file_counts = Counter()
    categories = Counter()
    file_labels = {}

    def inspect(value, relative, line, kind):
        for pid, category, _, regex in patterns:
            for match in regex.finditer(expand_escapes(value)):
                if not match[0]:
                    raise ValueError("zero-width match is not supported")
                if relative not in file_labels:
                    label = redact(relative, patterns)
                    if label != relative:
                        label += f" [file-{len(file_labels) + 1:06d}]"
                    file_labels[relative] = label
                safe_path = file_labels[relative]
                findings.append({"pattern_id": pid, "category": category,
                                 "file": safe_path, "line": line, "kind": kind,
                                 "match": f"<redacted len={len(match[0])}>"})
                counts[pid] += 1
                file_counts[safe_path] += 1
                categories[category] += 1

    def walk_error(_error):
        raise ValueError("tree traversal failed")

    for directory, dirs, names in os.walk(tree, followlinks=False, onerror=walk_error):
        dirs.sort()
        names.sort()
        for name in dirs:
            if is_link(Path(directory) / name):
                raise ValueError("linked directory in scan tree")
        for name in names:
            path = Path(directory) / name
            if is_link(path) or not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError("non-regular file in scan tree")
            relative = path.relative_to(tree).as_posix()
            inspect(relative, relative, 0, "path")
            files_scanned += 1
            value = read_text(path.read_bytes(), path)
            if value is None:
                binary_files += 1
                continue
            text_files += 1
            # split on LF only: line numbers continue to correspond to source
            # even when strings contain form feeds or Unicode separators.
            for number, line in enumerate(value.split("\n"), 1):
                inspect(line, relative, number, "text")
    return {
        "schema_version": 1, "total_matches": len(findings),
        "files_scanned": files_scanned, "text_files": text_files,
        "binary_files_name_only": binary_files,
        "patterns": [{"id": pid, "category": cat, "policy_line": line,
                      "count": counts[pid]} for pid, cat, line, _ in patterns],
        "category_counts": dict(sorted(categories.items())),
        "file_counts": dict(sorted(file_counts.items(), key=lambda p: (-p[1], p[0]))),
        "findings": findings,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", required=True, type=Path)
    parser.add_argument("--patterns", type=Path, default=DEFAULT_PATTERNS)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--max-show", type=int, default=20)
    args = parser.parse_args(argv)
    try:
        if args.max_show < 0:
            raise ValueError("max-show must be nonnegative")
        tree = args.tree.absolute()
        if args.json:
            target = args.json.resolve()
            if target.is_relative_to(tree.resolve()):
                raise ValueError("JSON output must be outside the scan tree")
            if target == args.patterns.resolve() or target.exists():
                raise ValueError("JSON output must be a new file")
        patterns = load_patterns(args.patterns)
        report = scan_tree(tree, patterns)
        if args.json:
            with args.json.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(report, stream, ensure_ascii=True, indent=2)
                stream.write("\n")
        print(f"matches={report['total_matches']} files={report['files_scanned']} "
              f"binary_name_only={report['binary_files_name_only']}")
        for item in report["patterns"]:
            print(f"{item['id']} category={item['category']} count={item['count']}")
        for file, count in report["file_counts"].items():
            print(f"file={json.dumps(file, ensure_ascii=True)} count={count}")
        for item in report["findings"][:args.max_show]:
            print(f"{json.dumps(item['file'], ensure_ascii=True)}:{item['line']} "
                  f"{item['pattern_id']} {item['match']}")
        return int(report["total_matches"] > 0)
    except (OSError, ValueError, UnicodeError):
        # Exception strings can contain private input paths or regex text.
        print("scan error: invalid policy, tree, encoding or output; no clean verdict",
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
