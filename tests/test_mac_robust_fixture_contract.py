"""The robustness fixture creates actual preference and painted-buffer state."""
from pathlib import Path
import ast

ROOT=Path(__file__).resolve().parents[1]

def functions():
    source=(ROOT/'scripts/e2e/mac_robust.py').read_text(encoding='utf-8')
    return source,{node.name:ast.get_source_segment(source,node) for node in ast.parse(source).body if isinstance(node,ast.FunctionDef)}

def test_robust_uses_the_explicit_mac_preference_and_proves_spare_ownership():
    source,fn=functions()
    assert "choices=['off','on'],default='off'" in source
    setting=fn['configure_tearout']
    assert 'setNativePaneTearoutEnabled' in setting
    assert 'macNativePaneTearoutEnabled === ' in setting
    assert "OFF releases the spare" in setting
    assert 'window.__MYCMUX_TEAROUT_WINDOW__ === true' in setting
    assert 'assert len(spares)==int(enabled)' in setting
    assert fn['run_case'].index('configure_tearout')<fn['run_case'].index('fixture(app')

def test_background_fixture_requires_real_parsed_output_and_restores_the_tab():
    _,fn=functions()
    prepare=fn['prepare_background_read']
    assert 'terminals.live.get(' in prepare and 't.buffer.active' in prepare
    assert 'mounted clock has parsed live output' in prepare
    assert prepare.index("mounted=app.call('pane.read'") < prepare.index('original tab restored') < prepare.index('normal background clock read')
    case=fn['run_case']
    assert case.index('prepare_background_read')<case.index('before=clocks')<case.index("read=app.call('pane.read'")
    assert "assert 'M2CLOCK' in json.dumps(read)" in case
    assert 'assert labels==[label]' in case and "label='web-pane-'+opened['tabId']" in case
    assert case.index('exact native browser webview created') < case.index('assert labels==[label]')
    assert "if candidate.startswith('web-pane-')]==[label]" in case
    assert "assert diag(app).count('[watchdog] renderer silent')==1" in case
