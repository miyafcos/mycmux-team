"""Build detailed, load-separated audit tables from retained Mac evidence."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import runpy

helpers = runpy.run_path(str(Path(__file__).with_name("summarize-mac.py")))
stats = helpers["stats"]
METRICS = {
    "S1": ["visibleMarkMs", "firstFrameMs", "visibleObservedMs", "restoredObservedMs", "restoredPtyCount"],
    "S2": ["rafHz", "maxRafGapMs", "mycmuxCpuMs", "WebContentCpuMs", "GPUCpuMs", "NetworkingCpuMs",
           "mycmuxRssMiB", "WebContentRssMiB", "GPURssMiB", "NetworkingRssMiB"],
    "S3": ["ms"], "S4": ["ms"],
    "S5": ["settledMs", "sentinelObservedMs", "maxRafGapMs", "droppedFrames", "keysStartedBeforeSentinel", "keysStartedDuringOutput"],
    "S6": ["builtMs", "visibleMs", "firstFrameMs", "inputObservedMs", "closedMs"],
    "S7": ["createdMs", "loadedMs", "shownMs", "loadedObservedMs", "frameObservedMs"],
    "S8": ["rssMiB", "ms", "builtMs", "visibleMs", "firstFrameMs", "closedMs", "loadedObservedMs", "exitMs", "ptyCount"],
}


def all_windows(row):
    result = []
    if isinstance(row, dict):
        for key, value in row.items():
            if key in ("windows", "windowsBefore", "windowsAfter") and isinstance(value, list):
                result.extend(value)
            elif key == "childFrame" and isinstance(value, dict):
                result.append(value)
            elif isinstance(value, (dict, list)):
                result.extend(all_windows(value))
    elif isinstance(row, list):
        for value in row:
            result.extend(all_windows(value))
    return result


def stopped(row):
    candidates = [row] + [row.get(k) or {} for k in ("frame", "mainFrame", "outbound", "inbound")]
    return any(r.get("outcome") == "raf-stopped" or ("start" in r and r.get("frames", 0) < 2) for r in candidates)


def interval_errors(row):
    samples = row.get("loadIntervalSamples", [])
    if len(samples) < 2:
        return ["missing interval samples"]
    duration = samples[-1]["epoch"] - samples[0]["epoch"]
    mean = sum((b["epoch"] - a["epoch"]) * (a["load1"] + b["load1"]) / 2
               for a, b in zip(samples, samples[1:])) / duration if duration else samples[-1]["load1"]
    errors = []
    if abs(mean - row.get("loadMean", -1)) > 1e-8:
        errors.append("interval mean mismatch")
    if row.get("loadStart") != samples[0]["load1"] or row.get("loadEnd") != samples[-1]["load1"]:
        errors.append("interval endpoint mismatch")
    if row.get("highLoad") != (mean > 20):
        errors.append("threshold mismatch")
    return errors


def leaf_profile(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    marker = "Sort by top of stack, same collapsed (when >= 5):"
    if marker not in text:
        return {"missingLeafTable": True}
    table = text.split(marker, 1)[1].split("Binary Images:", 1)[0]
    leaves = []
    for line in table.splitlines():
        match = re.match(r"\s*(.+?)\s+(\d+)\s*$", line)
        if not match:
            continue
        symbol, count = match.group(1), int(match.group(2))
        lower = symbol.lower()
        if any(word in lower for word in ("wait", "mach_msg", "kevent", "workq_kernreturn", "semaphore", "read  (in libsystem")):
            kind = "waiting-or-system-blocked"
        elif any(word in lower for word in ("layout", "style::", "styleresolver")):
            kind = "layout-style"
        elif any(word in lower for word in ("composit", "ca::", "metal", "layer")):
            kind = "compositing"
        elif any(word in lower for word in ("paint", "raster", "draw")):
            kind = "paint"
        elif any(word in lower for word in ("jsc::", "llint", "javascriptcore")):
            kind = "javascriptcore-including-runtime"
        else:
            kind = "other-unresolved"
        leaves.append({"symbol": symbol, "count": count, "category": kind})
    total = sum(r["count"] for r in leaves)
    categories = {kind: sum(r["count"] for r in leaves if r["category"] == kind) for kind in sorted({r["category"] for r in leaves})}
    return {"top15": leaves[:15], "classifiedLeafSamples": total, "categories": categories,
            "categoryPercent": {k: v / total * 100 for k, v in categories.items()} if total else {},
            "interpretation": "symbol heuristic of collapsed leaf samples >=5; includes waiting threads, not CPU-time shares"}


def external_summary(root):
    rows = [json.loads(line) for line in (root / "observations.jsonl").read_text(encoding="utf-8").splitlines()]
    intervals = []
    for before, after in zip(rows, rows[1:]):
        mean = (before["load"][0] + after["load"][0]) / 2
        intervals.append({"start": before["epoch"], "end": after["epoch"], "loadStart": before["load"][0],
                          "loadEnd": after["load"][0], "loadMeanApprox": mean, "highLoad": mean > 20,
                          "processes": after["processes"]})
    report = {"rows": len(rows), "spanS": rows[-1]["epoch"] - rows[0]["epoch"],
              "method": "Retained 10-second observations; interval load approximated by two endpoints. Not the 1-second recorder used for S1-S8.",
              "load": stats([r["load"][0] for r in rows]), "groups": {}, "intervals": intervals,
              "profiles": {p.name: leaf_profile(p) for p in root.glob("sample-*.txt")}}
    for high in (False, True):
        chosen = [r for r in intervals if r["highLoad"] is high]
        group = {"n": len(chosen), "load": stats([r["loadMeanApprox"] for r in chosen]), "processes": {}}
        for kind in ("mycmux", "WebContent", "GPU", "Networking"):
            group["processes"][kind] = {
                "cpuMsPerInterval": stats([sum(p["cpu_delta_ms"] or 0 for p in r["processes"] if p["kind"] == kind) for r in chosen]),
                "rssMiB": stats([sum(p["rss_kib"] for p in r["processes"] if p["kind"] == kind) / 1024 for r in chosen])}
        report["groups"]["high" if high else "normal"] = group
    path = root / "summary-load20.json"
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return str(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--external-dir", type=Path)
    args = parser.parse_args()
    if args.external_dir:
        print(json.dumps({"externalSummary": external_summary(args.external_dir)}))
    root = args.run_dir
    state = json.loads((root / "state.json").read_text(encoding="utf-8"))
    audit = {"phases": {}, "groups": {}, "profiles": [], "loadErrors": [], "attempts": [], "tableRows": []}
    selected = {Path(row["out"]).name for row in state.get("phases", {}).values()}
    for file in sorted(root.glob("*/results.json")):
        data = json.loads(file.read_text(encoding="utf-8"))
        audit["attempts"].append({"directory": file.parent.name, "selected": file.parent.name in selected,
                                  "complete": data.get("complete"), "errors": data.get("errors"),
                                  "sampleCount": sum(len(g["samples"]) for g in data.get("measurements", {}).values())})
    for phase, record in state.get("phases", {}).items():
        directory = root / Path(record["out"]).name
        file = directory / "results.json"
        if not file.exists():
            continue
        data = json.loads(file.read_text(encoding="utf-8"))
        windows = all_windows(data.get("measurements", {}))
        audit["phases"][phase] = {"complete": data.get("complete"), "missing": data.get("missing"), "errors": data.get("errors"),
                                  "windows": {"observations": len(windows), "hidden": sum(not w.get("visible") for w in windows),
                                              "occluded": sum(bool(w.get("occluded")) for w in windows),
                                              "applicationActive": sum(bool(w.get("applicationActive")) for w in windows)},
                                  "launchMethods": sorted({r["method"] for r in data.get("launches", [])}),
                                  "priorityReceipts": [r.get("priority") for r in data.get("launches", [])],
                                  "diagErrors": data.get("diag_errors"), "appearance": data.get("appearance"),
                                  "liveInitial": data.get("live_initial"), "liveFinal": data.get("live_final"),
                                  "testFinal": data.get("test_final")}
        for name, item in data.get("measurements", {}).items():
            rows = item["samples"]
            for index, row in enumerate(rows):
                for error in interval_errors(row):
                    audit["loadErrors"].append({"group": name, "index": index, "error": error})
            entry = {"n": len(rows), "rafStopped": sum(stopped(r) for r in rows),
                     "renderTimeouts": sum(r.get("rendered") is False for r in rows),
                     "idsMismatch": sum(r.get("idsMatch") is False for r in rows),
                     "geometryMismatch": sum(r.get("geometryMatches") is False for r in rows),
                     "restorationTimeouts": sum(bool(r.get("restorationError")) for r in rows),
                     "failedVerdicts": sum(r.get("passed") is False for r in rows)}
            for high in (False, True):
                category = "high" if high else "normal"
                chosen = [r for r in rows if r.get("highLoad") is high]
                complete = [r for r in chosen if not stopped(r) and r.get("rendered") is not False]
                metrics = {key: stats([r.get(key) for r in complete]) for key in METRICS.get("S8" if phase == "S8_tail" else phase, []) if any(key in r for r in rows)}
                entry[category] = {"n": len(chosen), "completedN": len(complete), "load": stats([r.get("loadMean") for r in chosen]), "metrics": metrics}
                for metric, values in metrics.items():
                    audit["tableRows"].append({"group": name, "load": category, "metric": metric, **values})
                if phase == "S1":
                    values = {k: [] for k in ("launchToFrontendMs", "frontendToFirstFrameMs", "visibleToFrameMs")}
                    for row in chosen:
                        marks = {m["name"]: m["atMs"] for m in row["marks"]["front"]}
                        difference = marks["workspace.first.frame"] - marks["frontend.start"]
                        values["launchToFrontendMs"].append(row["firstFrameMs"] - difference)
                        values["frontendToFirstFrameMs"].append(difference)
                        values["visibleToFrameMs"].append(marks["workspace.first.frame"] - marks["window.visible"])
                    entry[category]["startupBreakdown"] = {k: stats(v) for k, v in values.items()}
                    entry[category]["emptyRustStartupMarks"] = sum(not r["marks"]["rust"] for r in chosen)
                    for metric, samples in values.items():
                        audit["tableRows"].append({"group": name, "load": category, "metric": metric, **stats(samples)})
                if phase == "S5":
                    keys = [key for row in chosen for key in row.get("inputs", [])]
                    entry[category]["inputLatency"] = stats([k.get("ms") for k in keys if k.get("rendered")])
                    entry[category]["inputTimeouts"] = sum(k.get("rendered") is False for k in keys)
                    entry[category]["fullFiftyKeyOverlap"] = sum(r.get("keysStartedDuringOutput") == 50 for r in chosen)
                if name == "S8_continuous":
                    entry[category]["resources"] = []
                    for row in chosen:
                        details = {d["pid"]: d for d in row["details"]}
                        groups = {}
                        for process in row["processes"]:
                            detail = details[process["pid"]]
                            target = groups.setdefault(process["kind"], {"rssMiB": 0, "threads": 0, "lsofRows": 0})
                            target["rssMiB"] += process["rss_kib"] / 1024
                            # macOS ps -M prints a header despite pid=; retain raw evidence.
                            lines = detail["threadPs"]["stdout"].splitlines()
                            target["threads"] += len(lines) - int(bool(lines) and lines[0].lstrip().startswith("USER"))
                            target["lsofRows"] += detail["fdCount"]
                        entry[category]["resources"].append({"index": row["index"], "loadMean": row["loadMean"], "groups": groups})
                if phase == "S2":
                    timers = {}
                    for row in chosen:
                        for key, value in row["probe"]["timers"].items():
                            target = timers.setdefault(key, {"fired": 0, "registered": 0, "totalMs": 0})
                            for field in target:
                                target[field] += value[field]
                    entry[category]["timers"] = sorted(({"site": k, **v} for k, v in timers.items()), key=lambda r: -r["totalMs"])
                    entry[category]["longtaskSupported"] = [r["probe"]["longtaskSupported"] for r in chosen]
                    entry[category]["longtasks"] = [t for r in chosen for t in r["probe"]["longtasks"]]
                    entry[category]["contexts"] = [r["probe"]["contexts"] for r in chosen]
            audit["groups"][name] = entry
        for profile in data.get("profiles", []):
            path = directory / Path(profile["file"]).name
            audit["profiles"].append({"stage": profile["stage"], "file": str(path),
                                      "loadMean": profile.get("loadMean"), "highLoad": profile.get("highLoad"),
                                      **leaf_profile(path)})
    (root / "evidence-audit.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    lines = ["| Group | Load | Metric | n | Median | p90 | p99 | Max |", "|---|---|---|---:|---:|---:|---:|---:|"]
    def number(value):
        return "NA" if value is None else f"{value:.3f}"
    for row in audit["tableRows"]:
        lines.append(f"| {row['group']} | {row['load']} | {row['metric']} | {row['n']} | {number(row['median'])} | {number(row['p90'])} | {number(row['p99'])} | {number(row['max'])} |")
    (root / "measurement-tables.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"phases": list(audit["phases"]), "groups": len(audit["groups"]), "loadErrors": len(audit["loadErrors"]), "profiles": len(audit["profiles"])}))


if __name__ == "__main__":
    main()
