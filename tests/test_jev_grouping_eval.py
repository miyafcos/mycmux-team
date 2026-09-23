import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("jev_grouping_eval", ROOT / "scripts/jev_grouping_eval.py")
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


def state():
    return {"tabs": [{"id":f"t{i}","label":f"Task {i}","cwd":"C:/work", "workspaceId":"w", "origin":{}}
                     for i in range(4)],"workspaces":[{"id":"w","name":"Workspace"}],"lineageClusters":[]}


def response(body):
    answers = {}
    for key, question in body["questions"].items():
        if question["type"] == "noul":
            answers[key] = {"type":"noul","noul":0.0}
            continue
        choice = "different" if key.startswith("pair") else "normal" if key.startswith("health") else "worker"
        answers[key] = {"type":"choice","choice":choice,"confidence":1,
                        "probabilities":{x:float(x==choice) for x in question["criteria"]}}
    return {"model":trial.MODEL,"answers":answers,"usage":{"input_tokens":100,"output_tokens":100,"cost":.001}}


def select(answers, key, choice):
    answers[key]["choice"] = choice
    answers[key]["probabilities"] = {x:float(x==choice) for x in answers[key]["probabilities"]}


def test_all_independent_questions_use_one_request_without_expected_labels():
    s = state(); s["expected"] = {"secret_expected":"answer"}; s["baseline"] = "must not be sent"
    body = trial.build_request(s)
    assert len(body["questions"]) == 20
    assert "secret_expected" not in json.dumps(body)
    assert "must not be sent" not in json.dumps(body)
    assert "panes.pane_a" in body["questions"]["pair_0_1"]["instructions"]
    assert "panes.pane_b" in body["questions"]["pair_0_1"]["instructions"]


def test_duplicate_tabs_and_credential_like_input_are_rejected():
    s = state(); s["tabs"][1]["id"] = "t0"
    with pytest.raises(ValueError): trial.build_request(s)
    s = state(); s["tabs"][0]["tail"] = ["sk-or-" + "x" * 24]
    with pytest.raises(ValueError): trial.build_request(s)


@pytest.mark.parametrize("mutation", ["missing", "extra", "confidence", "probability", "model", "usage"])
def test_malformed_responses_fail_closed(mutation):
    body = trial.build_request(state()); out = response(body)
    if mutation == "missing": out["answers"].pop("role_0")
    if mutation == "extra": out["answers"]["unexpected"] = out["answers"]["role_0"]
    if mutation == "confidence": out["answers"]["role_0"]["confidence"] = float("nan")
    if mutation == "probability": out["answers"]["role_0"]["probabilities"]["worker"] = .1
    if mutation == "model": out["model"] = "other"
    if mutation == "usage": out["usage"]["input_tokens"] = -1
    with pytest.raises(ValueError): trial.validate_response(body, out)


def test_bridge_cannot_join_unrelated_projects():
    s = state(); answers = trial.effective_answers(s,response(trial.build_request(s))["answers"])
    select(answers,"pair_0_1","same"); select(answers,"pair_1_2","same")
    clusters = trial.project_clusters(s, answers)
    assert not any(0 in c and 2 in c for c in clusters)


def test_composer_keeps_three_strategies_and_all_ids():
    s = state(); s["tabs"][1]["origin"] = {"parentTabId":"t0"}
    answers = trial.effective_answers(s,response(trial.build_request(s))["answers"])
    select(answers,"pair_0_1","same")
    plans = trial.compose(s, answers)
    assert [p["strategy"] for p in plans["plans"]] == ["project","role","minimal_move"]
    for audit in trial.audit(s, plans):
        assert audit["hard_errors"] == []
        assert not any(i["code"] == "split_lineage" for i in audit["quality_issues"])


def test_expectation_report_retains_all_failures():
    answers = response(trial.build_request(state()))["answers"]
    report = trial.check_expectations(answers, {"role_0":["mother"],"health_0":["normal"]})
    assert report["total"] == 2 and report["passed"] == 1
    assert len(report["checks"]) == 2


def test_explicit_family_role_is_preserved_and_binary_answers_are_validated():
    s = state(); s["tabs"][1]["origin"] = {"parentTabId":"t0"}
    body = trial.build_request(s); raw = response(body)
    assert body["state"]["panes"]["pane_a"]["childIds"] == ["t1"]
    assert body["state"]["panes"]["pane_a"]["projectDirectory"] is None
    assert trial.effective_answers(s,raw["answers"])["role_0"]["choice"] == "mother"
    raw["answers"]["pair_0_1"]["noul"] = 1.01
    with pytest.raises(ValueError): trial.validate_response(body,raw)


def test_workspace_title_uses_labels_not_cli_status_decorations():
    s = state()
    for t in s["tabs"]:
        t["tail"] = ["sid sess dev agents Ask Codex"]
        t["label"] = "Maple release"
    assert trial.bucket_title(s,[0,1,2],[]) == "Maple"
    assert trial.safe_title("Payroll review", "Fallback") == "Payroll"
    assert trial.safe_title("review+Invoice", "Fallback") == "Invoice"


def test_constrained_planner_avoids_unrelated_rows_and_small_workspaces():
    s = state()
    s["tabs"] += [{**s["tabs"][0],"id":f"t{i}"} for i in range(4,12)]
    answers=trial.effective_answers(s,response(trial.build_request(s))["answers"])
    plans=trial.compose(s,answers)
    for item in trial.audit(s,plans):
        assert item["hard_errors"] == []
        assert item["quality_issues"] == []


def test_family_units_preserve_grandchildren_and_cycles_without_duplicate_ids():
    s = state()
    s["tabs"][1]["origin"]={"parentTabId":"t0"}
    s["tabs"][2]["origin"]={"parentTabId":"t1"}
    assert trial.family_units(s,[0,1,2,3]) == [[0,1,2],[3]]
    s["tabs"][0]["origin"]={"parentTabId":"t2"}
    assert sorted(sum(trial.family_units(s,[0,1,2,3]),[])) == [0,1,2,3]


def test_focused_recheck_selects_ambiguous_or_unknown_pairs_without_expected_labels():
    s = state(); s["expected"] = {"hidden_expected": "answer"}
    s["tabs"][0]["tail"] = ["Current task evidence must be preserved"]
    answers = trial.effective_answers(s, response(trial.build_request(s))["answers"])
    answers["pair_0_1"]["probabilities"]["same"] = .5
    select(answers, "health_3", "unknown")
    requests = trial.build_focused_requests(s, answers)
    assert {r["question"] for r in requests} == {"pair_0_1", "pair_0_3", "pair_1_3", "pair_2_3"}
    assert requests[0]["body"]["state"]["left_pane"]["tail"] == s["tabs"][0]["tail"]
    assert "hidden_expected" not in json.dumps(requests)
    assert set(requests[0]["body"]["state"]) == {"left_pane", "right_pane"}


def test_failed_focused_recheck_never_returns_partial_answers(monkeypatch):
    monkeypatch.setattr(trial, "call", lambda body, key: {"status": "error", "error_code": "network_or_timeout"})
    result = trial.call_focused([{"question": "pair_0_1", "body": {}}], "unused-test-value")
    assert result["status"] == "error"
    assert result["answers"] == {}
    assert result["request_count"] == 1
    assert "unused-test-value" not in json.dumps(result)


def test_focused_merge_preserves_roles_and_original_answers():
    s = state(); answers = trial.effective_answers(s, response(trial.build_request(s))["answers"])
    refined = {"pair_0_1": {"type": "choice", "choice": "related", "confidence": .9,
        "probabilities": {"same": .1, "related": .9, "different": 0, "unknown": 0}}}
    merged = trial.merge_focused_answers(answers, refined)
    assert merged["role_0"] == answers["role_0"]
    assert merged["pair_0_1"]["choice"] == "related"
    assert merged["compat_0_1"]["noul"] == 1
    assert answers["pair_0_1"]["choice"] == "different"
    with pytest.raises(ValueError):
        trial.merge_focused_answers(answers, {"pair_1_9": refined["pair_0_1"]})
