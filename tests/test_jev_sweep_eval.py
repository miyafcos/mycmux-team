"""Offline behavioral checks for the Jev sweep experiment, never live API tests."""
import importlib.util
import io
import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("jev_sweep_eval", ROOT / "scripts/jev_sweep_eval.py")
trial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trial)


def response(verdict="done_waiting", confidence=.98):
    probabilities = {name: .01 for name in trial.VERDICTS}
    probabilities[verdict] = .97
    return {
        "model": trial.MODEL,
        "answers": {"pane_status": {
            "type": "choice", "choice": verdict,
            "probabilities": probabilities, "confidence": confidence,
        }},
        "usage": {"input_tokens": 1000, "output_tokens": 30},
    }


def result(case_id, verdict, confidence=.98):
    row = trial.validate_response(response(verdict, confidence))
    row.update(id=case_id, status="ok", latency_ms=100)
    row["gated_verdict"] = trial.gated_verdict(row, .9, .9)
    return row


@pytest.fixture
def pack(tmp_path):
    path = tmp_path / "prepared"
    trial.prepare(trial.DEFAULT_CASES, path)
    return path


def test_prepare_keeps_reference_labels_out_of_request_and_preserves_source(pack):
    cases, requests, manifest = trial.load_pack(pack)
    assert len(cases) == 32
    assert manifest["network_requests_made"] == 0
    assert not any(case["human_reviewed"] for case in cases)
    for case, row in zip(cases, requests):
        assert set(row["body"]["state"]) == {"id", "label", "cwd", "tail"}
        assert row["body"]["state"]["tail"] == case["state"]["tail"]
        assert "expected" not in row["body"]
        assert row["body"]["questions"]["pane_status"]["type"] == "choice"
    baseline = trial.read_jsonl(pack / "baseline_prompts.jsonl")
    prefix, _ = trial.legacy_prefix()
    assert baseline[0]["legacy_prompt"].startswith("\n".join(prefix))
    assert json.loads(baseline[0]["legacy_prompt"].splitlines()[-1])[0] == requests[0]["body"]["state"]


def test_changed_pack_is_rejected_before_running(pack):
    rows = trial.read_jsonl(pack / "requests.jsonl")
    rows[0]["body"]["state"]["tail"] = ["tampered"]
    (pack / "requests.jsonl").write_text(trial.jsonl(rows), encoding="utf-8")
    with pytest.raises(trial.TrialError, match="changed"):
        trial.load_pack(pack)


def test_existing_output_is_not_overwritten(pack):
    before = (pack / "manifest.json").read_bytes()
    with pytest.raises(FileExistsError):
        trial.prepare(trial.DEFAULT_CASES, pack)
    assert (pack / "manifest.json").read_bytes() == before


@pytest.mark.parametrize("mutation", [
    lambda p: p.update(model="jev-future"),
    lambda p: p["answers"]["pane_status"].update(choice="close_everything"),
    lambda p: p["answers"]["pane_status"].update(confidence=float("nan")),
    lambda p: p["answers"]["pane_status"].update(confidence=True),
    lambda p: p["answers"]["pane_status"]["probabilities"].update(working=.9),
    lambda p: p["answers"]["pane_status"]["probabilities"].update(working=-.1),
    lambda p: p["answers"]["pane_status"].update(choice="working"),
    lambda p: p["usage"].update(input_tokens=True),
    lambda p: p["usage"].update(output_tokens=-1),
    lambda p: p.update(answers={}),
])
def test_malformed_typed_answers_fail_closed(mutation):
    payload = response()
    mutation(payload)
    with pytest.raises(trial.TrialError):
        trial.validate_response(payload)


def test_weak_confidence_and_api_failures_are_unknown():
    weak = result("case-001", "done_waiting", .6)
    assert weak["gated_verdict"] == "unknown"
    weak_probability = result("case-001", "done_waiting")
    weak_probability["selected_probability"] = .7
    assert trial.gated_verdict(weak_probability, .9, .9) == "unknown"
    assert trial.gated_verdict({"status": "error"}, .9, .9) == "unknown"


def test_summary_separates_provisional_labels_errors_and_false_completion():
    cases = trial.load_cases(trial.DEFAULT_CASES)[:4]
    # Human review is absent: no result may be presented as human accuracy.
    rows = [
        result("case-001", "done_waiting"),
        result("case-002", "done_waiting", .6),
        result("case-003", "done_waiting"),
        {"id": "case-004", "status": "error", "error_code": "http_429",
         "gated_verdict": "unknown", "latency_ms": 700},
    ]
    summary = trial.summarize(cases, rows)
    assert summary["human_label_accuracy"] is None
    assert summary["production_acceptance"] is False
    assert summary["agreement_with_reference_labels"] == pytest.approx(1 / 3)
    assert summary["raw_false_done_ids"] == ["case-002", "case-003"]
    assert summary["gated_false_done_ids"] == ["case-003"]
    assert summary["accepted_fraction_of_tested"] == .5
    assert summary["latency_p95_ms"] == 700
    assert summary["unmetered_calls"] == 1
    assert summary["estimated_reported_cost_usd"] == .000126


def test_run_without_live_flag_never_starts_network(pack, tmp_path, monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "dummy-unit-test-key")
    out = tmp_path / "run"
    assert trial.main(["run", "--prepared", str(pack), "--out", str(out)]) == 2
    assert not out.exists()


def test_missing_key_never_creates_run(pack, tmp_path, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    out = tmp_path / "run"
    assert trial.main(["run", "--live", "--prepared", str(pack), "--out", str(out)]) == 2
    assert not out.exists()


@pytest.mark.parametrize("error_code", ["http_401", "http_402"])
def test_trial_stops_on_auth_or_credit_error_and_does_not_persist_key(pack, tmp_path, capsys, error_code):
    calls = []
    def fake(body, key, timeout):
        calls.append(body)
        return {"status": "error", "error_code": error_code, "latency_ms": 110}
    out = tmp_path / "run"
    summary = trial.run_trial(pack, out, "secret-unit-test-value", transport=fake)
    assert len(calls) == 1
    assert summary["not_attempted_cases"] == 3
    assert summary["errors"] == 1
    assert len(trial.read_jsonl(out / "results.jsonl")) == 1
    saved = "".join(p.read_text(encoding="utf-8") for p in out.iterdir())
    assert "secret-unit-test-value" not in saved + capsys.readouterr().out


def test_successful_mock_run_writes_reanalyzable_results(pack, tmp_path):
    calls = []
    def fake(body, key, timeout):
        calls.append(body)
        # Canned transport response, not an oracle and not a model measurement.
        row = trial.validate_response(response("unknown"))
        return {**row, "status": "ok", "latency_ms": 123}
    out = tmp_path / "mock-run"
    summary = trial.run_trial(pack, out, "dummy-unit-test-key", transport=fake)
    assert len(calls) == 4
    assert summary["valid_responses"] == 4
    assert summary["accepted_count"] == 0
    path = tmp_path / "reanalyzed.json"
    assert trial.main(["analyze", "--run", str(out), "--out", str(path)]) == 0
    assert json.loads(path.read_text(encoding="utf-8"))["tested_cases"] == 4


def test_baseline_requires_same_state_and_reports_only_overlap(pack, tmp_path):
    cases, _, _ = trial.load_pack(pack)
    baseline = trial.read_jsonl(pack / "baseline_template.jsonl")[:2]
    baseline[0].update(verdict="done_waiting", provider="operator-recorded",
                       model="existing-model", prompt_kind="matched")
    baseline[1].update(verdict="done_waiting", provider="operator-recorded",
                       model="existing-model", prompt_kind="matched")
    path = tmp_path / "baseline.jsonl"
    trial.write_text(path, trial.jsonl(baseline))
    rows = [result("case-001", "done_waiting"), result("case-002", "queued_input")]
    comparison = trial.compare_baseline(cases, rows, path)
    assert comparison["overlap_valid_cases"] == 2
    assert comparison["agreement"] == .5
    assert comparison["baseline_false_done_ids_on_overlap"] == ["case-002"]
    assert comparison["jev_label_agreement_on_overlap"] == 1
    baseline[0]["state_sha256"] = "wrong-state"
    path.write_text(trial.jsonl(baseline), encoding="utf-8")
    with pytest.raises(trial.TrialError, match="different input"):
        trial.compare_baseline(cases, rows, path)


def test_provider_error_body_and_auth_header_are_not_logged(monkeypatch):
    class FakeOpener:
        def open(self, req, timeout):
            assert req.get_header("Authorization") == "Bearer secret-unit-test-value"
            raise HTTPError(trial.ENDPOINT, 401, "bad", {},
                            io.BytesIO(b"secret-unit-test-value provider diagnostics"))
    monkeypatch.setattr(trial.request, "build_opener", lambda *args: FakeOpener())
    row = trial.call_jev({}, "secret-unit-test-value", 2)
    assert row["error_code"] == "http_401"
    assert "secret-unit-test-value" not in trial.encode(row)
    assert trial.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test") is None


def test_trace_cases_need_explicit_data_flag(tmp_path):
    cases = trial.load_cases(trial.DEFAULT_CASES)[:1]
    cases[0]["origin"] = "redacted_trace"
    path = tmp_path / "cases.jsonl"
    trial.write_text(path, trial.jsonl(cases))
    prepared = tmp_path / "prepared"
    trial.prepare(path, prepared)
    with pytest.raises(trial.TrialError, match="allow-local-data"):
        trial.run_trial(prepared, tmp_path / "run", "dummy-unit-test-key")
    assert not (tmp_path / "run").exists()


def test_fixture_rejects_duplicate_ids_and_overlong_tail(tmp_path):
    cases = trial.load_cases(trial.DEFAULT_CASES)[:2]
    cases[1]["id"] = cases[0]["id"]
    path = tmp_path / "duplicate.jsonl"
    trial.write_text(path, trial.jsonl(cases))
    with pytest.raises(trial.TrialError, match="Duplicate"):
        trial.load_cases(path)
    cases = trial.load_cases(trial.DEFAULT_CASES)[:1]
    cases[0]["state"]["tail"] = ["line"] * 9
    path = tmp_path / "overlong.jsonl"
    trial.write_text(path, trial.jsonl(cases))
    with pytest.raises(trial.TrialError, match="eight"):
        trial.load_cases(path)


@pytest.fixture
def openrouter_pack(tmp_path):
    path = tmp_path / "prepared_openrouter"
    trial.prepare(trial.DEFAULT_CASES, path, "openrouter")
    return path


def openrouter_response():
    payload = response()
    payload["model"] = "typesafe/jev-1.13-20260917"
    payload["usage"]["cost"] = .000042
    return payload


def test_openrouter_pack_selects_own_route_and_rejects_endpoint_changes(openrouter_pack):
    cases, rows, manifest = trial.load_pack(openrouter_pack)
    assert manifest["provider"] == "openrouter"
    assert rows[0]["body"]["model"] == "typesafe/jev-1.13"
    assert rows[0]["body"]["state"] == trial.make_request(cases[0])["state"]
    manifest["endpoint"] = "https://other.test/api/alpha/decisions"
    (openrouter_pack / "manifest.json").write_text(trial.encode(manifest), encoding="utf-8")
    with pytest.raises(trial.TrialError, match="changed"):
        trial.load_pack(openrouter_pack)


def test_old_direct_packs_remain_readable(pack):
    manifest = json.loads((pack / "manifest.json").read_text(encoding="utf-8"))
    del manifest["provider"]
    (pack / "manifest.json").write_text(trial.encode(manifest), encoding="utf-8")
    assert trial.load_pack(pack)[1][0]["body"]["model"] == trial.MODEL


def test_openrouter_response_preserves_billed_cost_and_rounded_distribution():
    payload = openrouter_response()
    payload["answers"]["pane_status"]["probabilities"]["working"] = 0
    row = trial.validate_response(payload, "openrouter")
    assert sum(row["probabilities"].values()) == pytest.approx(.99)
    assert row["model"] == "typesafe/jev-1.13-20260917"
    assert row["provider_reported_cost_usd"] == .000042
    row.update(id="case-001", status="ok", latency_ms=100)
    row["gated_verdict"] = trial.gated_verdict(row, .9, .9)
    summary = trial.summarize(trial.load_cases(trial.DEFAULT_CASES)[:1], [row])
    assert summary["provider_reported_cost_usd"] == .000042
    assert summary["calls_with_reported_cost"] == 1


@pytest.mark.parametrize("field", ["confidence", "probabilities"])
def test_openrouter_missing_optional_certainty_is_kept_but_gated_unknown(field):
    payload = openrouter_response()
    del payload["answers"]["pane_status"][field]
    row = trial.validate_response(payload, "openrouter")
    row["status"] = "ok"
    assert row["raw_verdict"] == "done_waiting"
    assert row[field] is None
    assert trial.gated_verdict(row, .9, .9) == "unknown"


@pytest.mark.parametrize("mutation", [
    lambda p: p.update(model="typesafe/jev-1.14-20260917"),
    lambda p: p["usage"].update(cost=float("nan")),
    lambda p: p["usage"].update(cost=-.1),
    lambda p: p["usage"].update(cost=True),
    lambda p: p["answers"]["pane_status"]["probabilities"].update(working=.3),
])
def test_openrouter_invalid_values_are_not_accepted(mutation):
    payload = openrouter_response()
    mutation(payload)
    with pytest.raises(trial.TrialError):
        trial.validate_response(payload, "openrouter")


def test_openrouter_transport_routes_body_and_key_without_persisting_key(openrouter_pack, tmp_path, monkeypatch):
    calls = []
    class FakeOpener:
        def open(self, req, timeout):
            calls.append(req.full_url)
            assert req.full_url == "https://openrouter.ai/api/alpha/decisions"
            assert req.get_header("Authorization") == "Bearer openrouter-unit-test-value"
            assert json.loads(req.data)["model"] == "typesafe/jev-1.13"
            return io.BytesIO(trial.encode(openrouter_response()).encode("utf-8"))
    monkeypatch.setattr(trial.request, "build_opener", lambda *args: FakeOpener())
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-unit-test-value")
    monkeypatch.setenv("TYPESAFE_API_KEY", "must-not-be-used")
    out = tmp_path / "openrouter_run"
    assert trial.main(["run", "--prepared", str(openrouter_pack), "--out", str(out), "--live"]) == 0
    assert len(calls) == 4
    run = json.loads((out / "run.json").read_text(encoding="utf-8"))
    assert run["provider"] == "openrouter"
    saved = "".join(p.read_text(encoding="utf-8") for p in out.iterdir())
    assert "openrouter-unit-test-value" not in saved
    assert "must-not-be-used" not in saved


def test_openrouter_does_not_fall_back_to_typesafe_key(openrouter_pack, tmp_path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "must-not-be-used")
    out = tmp_path / "run"
    assert trial.main(["run", "--prepared", str(openrouter_pack), "--out", str(out), "--live"]) == 2
    assert not out.exists()


@pytest.mark.parametrize("line", [
    "OPENROUTER_API_KEY=sk-or-v1-unit-test-only",
    'export OPENROUTER_API_KEY="sk-or-v1-unit-test-only" # note',
    "OPENROUTER_API_KEY='sk-or-v1-unit-test-only'",
])
def test_existing_fcc_key_is_read_without_modifying_configuration(tmp_path, line):
    path = tmp_path / "fake-fcc-config.txt"
    original = ("OTHER_SETTING=unchanged\n" + line + "\n").encode("utf-8")
    path.write_bytes(original)
    assert trial.read_fcc_openrouter_key(path) == "sk-or-v1-unit-test-only"
    assert path.read_bytes() == original


@pytest.mark.parametrize("content", [
    "OTHER_SETTING=unchanged\n",
    "OPENROUTER_API_KEY=unsupported-unit-test-value\n",
    "OPENROUTER_API_KEY=sk-or-v1-unit-test-only\nOPENROUTER_API_KEY=sk-or-v1-unit-test-only\n",
])
def test_existing_fcc_invalid_or_ambiguous_key_is_not_logged(tmp_path, content):
    path = tmp_path / "fake-fcc-config.txt"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(trial.TrialError) as error:
        trial.read_fcc_openrouter_key(path)
    assert "unit-test" not in str(error.value)


def test_existing_fcc_key_cli_reuses_key_without_prompt_or_persistence(openrouter_pack, tmp_path, monkeypatch):
    path = tmp_path / "fake-fcc-config.txt"
    original = b"OPENROUTER_API_KEY=sk-or-v1-unit-test-only\n"
    path.write_bytes(original)
    read_key = trial.read_fcc_openrouter_key
    monkeypatch.setattr(trial, "read_fcc_openrouter_key", lambda: read_key(path))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    calls = []
    def fake(body, key, timeout, provider):
        assert key == "sk-or-v1-unit-test-only"
        assert provider == "openrouter"
        calls.append(body)
        return {**trial.validate_response(openrouter_response(), provider),
                "status": "ok", "latency_ms": 100}
    monkeypatch.setattr(trial, "call_jev", fake)
    out = tmp_path / "run"
    assert trial.main(["run", "--prepared", str(openrouter_pack), "--out", str(out),
                       "--live", "--key-from-fcc"]) == 0
    assert len(calls) == 4
    assert path.read_bytes() == original
    assert "sk-or-v1-unit-test-only" not in "".join(
        p.read_text(encoding="utf-8") for p in out.iterdir())


def test_fcc_key_cannot_be_sent_to_direct_typesafe_route(pack, tmp_path, monkeypatch):
    def forbidden_read():
        pytest.fail("The OpenRouter credential must not be read for TypeSafe.")
    monkeypatch.setattr(trial, "read_fcc_openrouter_key", forbidden_read)
    out = tmp_path / "run"
    assert trial.main(["run", "--prepared", str(pack), "--out", str(out),
                       "--live", "--key-from-fcc"]) == 2
    assert not out.exists()
