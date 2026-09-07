from __future__ import annotations

import copy
import json

import pytest

from oracmux_lib import engines, paths


def test_shipped_engines_json_satisfies_contract():
    data = engines.load(paths.engines_json())
    assert set(engines.ENGINE_IDS) <= set(data)
    for engine_id in engines.ENGINE_IDS:
        site = engines.engine(data, engine_id)
        assert site["default_mode"] in site["modes"]
        assert site["pane_preset"] in engines.KNOWN_PANE_PRESETS
        assert "current" in site["modes"], "every engine keeps a no-op mode"
    assert engines.cdp_endpoint(data) == "http://127.0.0.1:9222"


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: d["gemini"].pop("composer"), "composer"),
        (lambda d: d["grok"].update(default_mode="nope"), "default_mode"),
        (lambda d: d["chatgpt"]["timeouts"].update(stable_sec=0), "stable_sec"),
        (lambda d: d["chatgpt"]["modes"]["deep-research"].update(steps=["not-a-list"]), "steps"),
        (lambda d: d["gemini"].update(pane_preset="bing"), "pane_preset"),
        (lambda d: d.pop("cdp"), "cdp"),
    ],
)
def test_contract_rejects_broken_files(tmp_path, mutate, message):
    data = json.loads(paths.engines_json().read_text(encoding="utf-8-sig"))
    broken = copy.deepcopy(data)
    mutate(broken)
    target = tmp_path / "engines.json"
    target.write_text(json.dumps(broken), encoding="utf-8")
    with pytest.raises(engines.EngineContractError) as info:
        engines.load(target)
    assert message in str(info.value)


def test_unknown_engine_is_rejected():
    data = engines.load(paths.engines_json())
    with pytest.raises(engines.EngineContractError):
        engines.engine(data, "claude")
