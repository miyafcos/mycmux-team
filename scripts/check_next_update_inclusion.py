"""Read-only local inclusion check. It neither publishes nor certifies release acceptance."""
import argparse
import json
import subprocess
from pathlib import Path


def check(repo: Path, manifest: Path, ref: str) -> dict:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or not isinstance(data.get("requiredCommits"), list) or not data["requiredCommits"]:
        raise ValueError("A version-1, nonempty inclusion manifest is required")
    head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--verify", ref + "^{commit}"], encoding="utf-8").strip()
    rows = []
    for entry in data["requiredCommits"]:
        commit = entry["commit"]
        if not isinstance(commit, str) or len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
            raise ValueError("Required commits must be full lowercase SHA-1 IDs")
        run = subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", commit, head], capture_output=True, text=True)
        rows.append({"id": entry["id"], "commit": commit, "included": run.returncode == 0,
                     "gitExitCode": run.returncode})
    return {"ref": ref, "head": head, "allIncluded": all(row["included"] for row in rows), "commits": rows,
            "releaseAcceptanceCertified": False, "remainingConditions": data.get("releaseConditions", [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--ref", default="HEAD")
    args = parser.parse_args()
    manifest = args.manifest or args.repo / "docs/plans/2026-10-05-next-update-inclusion.json"
    try:
        result = check(args.repo, manifest, args.ref)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(json.dumps({"allIncluded": False, "error": str(error)}, ensure_ascii=True))
        return 2
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["allIncluded"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
