"""Summarize retained Mac phase results without hiding failed observations."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import statistics


def stats(values):
    values = sorted(v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool))
    if not values:
        return {"n": 0, "median": None, "p90": None, "p99": None, "max": None}
    def quantile(p):
        rank = (len(values) - 1) * p
        lo = int(rank)
        return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (rank - lo)
    return {"n": len(values), "median": statistics.median(values), "p90": quantile(.9), "p99": quantile(.99), "max": values[-1]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    state = json.loads((args.run_dir / "state.json").read_text())
    summary = {"state": state, "phases": {}, "groups": {}, "findings": [], "loadThreshold": 20,
               "highLoadSamples": 0, "normalLoadSamples": 0, "missingLoadSamples": 0}
    for phase, phase_state in state.get("phases", {}).items():
        directory = args.run_dir / Path(phase_state["out"]).name
        path = directory / "results.json"
        if not path.exists():
            summary["phases"][phase] = {"missingResults": True}
            continue
        result = json.loads(path.read_text())
        summary["phases"][phase] = {key: result.get(key) for key in
            ("head", "started", "ended", "complete", "missing", "errors", "launches", "fake_agents", "diag_errors", "profiles", "appearance")}
        for name, group in result.get("measurements", {}).items():
            rows = group["samples"]
            low = [r for r in rows if r.get("loadMean") is not None and r["loadMean"] <= 20]
            high = [r for r in rows if r.get("loadMean") is not None and r["loadMean"] > 20]
            summary["highLoadSamples"] += len(high)
            summary["normalLoadSamples"] += len(low)
            summary["missingLoadSamples"] += len(rows) - len(low) - len(high)
            windows = [w for r in rows for w in r.get("windows", [])]
            entry = {"n": len(rows), "normalLoadN": len(low), "highLoadN": len(high),
                     "loadMean": stats([r.get("loadMean") for r in rows]),
                     "occludedWindowObservations": sum(bool(w.get("occluded")) for w in windows),
                     "hiddenWindowObservations": sum(not w.get("visible") for w in windows),
                     "activeWindowObservations": sum(bool(w.get("applicationActive")) for w in windows),
                     "normalLoadStats": {key: stats([r.get(key) for r in low]) for key in group["stats"]},
                     "highLoadStats": {key: stats([r.get(key) for r in high]) for key in group["stats"]}}
            if name.startswith("S2_"):
                for category, selected in (("normalLoadCpuPercent", low), ("highLoadCpuPercent", high)):
                    entry[category] = {kind: stats([r["cpu"][kind]["cpuDeltaMs"] / (r["elapsedS"] * 10) for r in selected])
                                       for kind in ("mycmux", "WebContent", "GPU", "Networking")}
                entry["noFrameSamples"] = sum(r["probe"]["noFrames"] for r in rows)
                entry["contexts"] = [r["probe"]["contexts"] for r in rows]
            def raf_stopped(row):
                observations = [row] + [row.get(key) or {} for key in ("frame", "mainFrame", "outbound", "inbound")]
                return any(value.get("outcome") == "raf-stopped"
                           or ("start" in value and value.get("frames", 0) < 2)
                           for value in observations)
            completed = [r for r in rows if not raf_stopped(r) and r.get("rendered") is not False]
            entry["rafStopped"] = sum(raf_stopped(r) for r in rows)
            entry["renderTimeouts"] = sum(r.get("rendered") is False for r in rows)
            for category, selected in (("normalLoadCompletedStats", low), ("highLoadCompletedStats", high)):
                entry[category] = {key: stats([r.get(key) for r in selected if r in completed]) for key in group["stats"]}
            for index, row in enumerate(rows):
                for field in ("restorationError", "windows_error"):
                    if row.get(field):
                        summary["findings"].append({"group": name, "index": index, "field": field, "value": row[field]})
                for field in ("geometryMatches", "idsMatch", "passed"):
                    if row.get(field) is False:
                        summary["findings"].append({"group": name, "index": index, "field": field, "value": False})
            summary["groups"][name] = entry
    out = args.run_dir / "summary.json"
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(out), "phases": list(summary["phases"]), "groups": len(summary["groups"]), "findings": len(summary["findings"])}))


if __name__ == "__main__":
    main()
