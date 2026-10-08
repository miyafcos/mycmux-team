"""Public synthetic home, also used by the Python/Rust parity oracle."""
from pathlib import Path
import json
import os
import subprocess
import time


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(text)
    assert path.read_text(encoding='utf-8') == text and '\ufffd' not in text


def dump(path, value):
    write(path, json.dumps(value, ensure_ascii=True, indent=2) + '\n')


def skill(home, place, name, description, body, extra=''):
    path = home / place / 'SKILL.md'
    text = '---\nname: ' + name + '\ndescription: ' + json.dumps(description, ensure_ascii=True) + '\n' + extra + '---\n' + body
    write(path, text)
    return path


def prepare(home):
    home = Path(home).resolve()
    assert not home.exists(), 'fixture must have its own new temporary directory'
    home.mkdir(parents=True)
    review = skill(home, '.claude/skills/sample-review', 'sample-review', 'Review the fictional sample.',
                   '# Sample review\n\n## Steps\n\nRead, compare, and report.\n\n| Check | Result |\n|---|---|\n| Syntax | OK |\n',
                   'metadata:\n  triggers: [review, verify]\n  exclusions:\n    - publish\n  pocket:\n    label: Author label\n    category: gate\n    symbol: checkmark.shield\nallowed-tools: [Read, Bash]\n')
    skill(home, '.codex/skills/sample-review', 'sample-review', 'Old wrapper description.',
          '# Compatibility wrapper\n\nRead `' + str(review) + '` first.\n')
    skill(home, '.agents/skills/sample-review', 'sample-review', 'An old copy.', '# Old copied steps\nRead then report.\n')
    write(home / '.codex/skills/sample-review/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n')
    skill(home, '.codex/skills/old-name', 'old-name', 'Alias description.', '# Alias\n')
    skill(home, '.hermes/skills/synthetic-home', 'synthetic-home', 'Only Hermes.', '# Hermes\n')
    skill(home, '.codex/skills/.system/sample-system', 'sample-system', 'A built-in tool.', '# Built-in\n')
    skill(home, '.claude/skills/body-hit', 'body-hit', 'No name match.', '# Body\n\nThe special text is blueberry.\n',
          'metadata:\n  triggers: [special-trigger]\n')
    skill(home, '.claude/skills/hidden-demo', 'hidden-demo', 'Hidden.', '# Hidden\n')
    skill(home, '.claude/skills/synced/group/sample-sync', 'sample-sync', 'Synced sample.', '# Synced\n')
    install = home / 'plugin-sources/demo'
    skill(install, 'skills/plugin-review', 'plugin-review', 'Plugin review.', '# Plugin\n')
    dump(home / '.claude/plugins/installed_plugins.json', {'plugins': {'sample@example-market': [{'scope': 'user', 'installPath': str(install)}]}})
    dump(home / '.claude/settings.json', {'enabledPlugins': {'sample@example-market': True}})
    skill(home, '.codex/plugins/cache/example-market/demo/1/skills/demo-tool', 'demo-tool', 'A code test tool.', '# Demo tool\n')
    write(home / '.codex/config.toml', '[plugins."demo@example-market"]\nenabled = true\n')
    write(home / '.claude/commands/sample-report.md', '---\ndescription: A sample command.\n---\n# Command\n')
    (home / '.claude/commands/folder-command').mkdir(parents=True)
    listing = {'sample-review': 'Current review.', 'builtin-check': 'A built-in check.', 'sample:plugin-review': 'Plugin listing.', 'anthropic-skills:sample-sync': 'Synced listing.'}
    import re
    project = re.sub('[^A-Za-z0-9]', '-', str(home))
    dump_text = json.dumps({'type': 'attachment', 'attachment': {'type': 'skill_listing', 'names': list(listing), 'content': '\n'.join('- ' + k + ': ' + v for k, v in listing.items())}}, ensure_ascii=True) + '\n'
    write(home / '.claude/projects' / project / 'session.jsonl', dump_text)
    dump(home / '.claude.json', {'skillUsage': {'sample-review': {'usageCount': 4, 'lastUsedAt': time.time() * 1000}, 'old-name': {'usageCount': 2}}})
    shared = home / '.mycmux/skills'
    categories = [{'id': 'gate', 'name': 'Reviews', 'color': '#2FB36B', 'symbol': 'checkmark.shield'}, {'id': 'code', 'name': 'Code', 'color': '#64748B', 'symbol': 'curlybraces'}]
    dump(shared / 'shelf.json', {'categories': categories, 'skills': {'sample-review': {'label': 'Manual review', 'category': 'gate', 'symbol': 'checkmark.shield', 'line': 'Read and report'}}, 'aliases': {'old-name': 'sample-review'}, 'hidden': ['hidden-demo']})
    dump(shared / 'shelf_auto.json', {'skills': {'sample-review': {'label': 'AI review', 'category': 'code'}, 'body-hit': {'category': 'code'}}})
    dump(shared / 'usage_codex.json', {'sample-session': {'skills': ['sample-review'], 'mtimeNs': time.time_ns(), 'last': time.time() * 1000}})
    defaults = {'categories': categories, 'skills': {'sample-review': {'label': 'Shipped review', 'category': 'code', 'glyph': 'R'}}, 'aliases': {}, 'hidden': []}
    dump(home / 'defaults.json', defaults)
    root = review.parent
    for relative, text in {'scripts/check.py': 'print("OK")\n', 'reference/notes.md': '# Notes\n', 'assets/example.txt': 'sample\n', 'reports/result.txt': 'generated\n', 'logs/run.log': 'record\n', 'data/sample.csv': 'a,b\n', 'config/config.json': '{}\n', 'backup/old.md': '# Old\n', '__pycache__/cached.pyc': 'cache\n', '.env': 'not-a-real-key\n', 'private.env': 'not-a-real-key\n', 'example-token.txt': 'not-a-real-key\n'}.items():
        write(root / relative, text)
    with (root / 'large.txt').open('wb') as stream:
        stream.truncate(5 * 1024 * 1024 + 1)
    link = home / '.codex/skills/broken-demo'
    target = home / 'absent-junction-target'
    if os.name == 'nt':
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
        dump(home / 'junction-result.json', {'created': result.returncode == 0})
    else:
        link.symlink_to(target, target_is_directory=True)
        dump(home / 'junction-result.json', {'created': True})
    return home


def oracle(home, pocket_source):
    import sys
    sys.path.insert(0, str(pocket_source))
    import skill_shelf
    import skill_files
    import fnmatch
    home = Path(home)
    snapshot = skill_shelf.collect_skills(home, home / 'state', defaults_path=home / 'defaults.json', persist_listing=False)
    # Matches the server's filename policy, plus the SPEC's *.env requirement.
    denied = ('.env*', '*.env*', '*credentials*', '*token*', '*secret*', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.pem', '*.key', '*.ppk', '*.p12', '*.pfx', '.ssh', '.gnupg', '_state', '.git', 'auth.json', 'cookies*')
    def resolve(path):
        p = Path(path).resolve()
        if not p.is_relative_to(home) or any(any(fnmatch.fnmatchcase(part.lower(), pattern) for pattern in denied) for part in p.parts):
            raise PermissionError(path)
        return p
    def kind(path):
        return 'md' if path.suffix == '.md' else 'text'
    policy = skill_files.FilePolicy(resolve, lambda path: False, kind, lambda handle: Path(handle.name).resolve(), denied)
    plan = skill_files.build_plan(snapshot, 'sample-review', policy)
    dump(home / 'python-expected.json', {'catalog': snapshot, 'files': sorted([{'path': f.path, 'reason': f.reason} for f in plan.files], key=lambda f: f['path'].lower()), 'selected': sorted((f.path for f in skill_files.select_files(plan, {})), key=lambda path: (path.casefold(), path))})


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--home', required=True)
    p.add_argument('--pocket', required=True)
    a = p.parse_args()
    home = prepare(Path(a.home))
    oracle(home, Path(a.pocket))
    print('synthetic home and Python oracle prepared')
