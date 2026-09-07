"""oracmux — oracle-style consults against ChatGPT / Gemini / Grok web, tuned for mycmux.

Package layout (one concern per module, all deterministic and unit-tested):

- paths     : every filesystem / executable location in one place (env-overridable)
- engines   : engines.json loader + contract validation
- brief     : build the handoff brief (prompt + inlined files) with size accounting
- guard     : NDA / confidentiality guard over the brief and attached paths
- ledger    : append-only JSONL ledger under ~/.mycmux/handoff/oracmux/
- run       : run-directory layout, slugs, progress files
- chrome    : OracleChrome (CDP 9222) lifecycle + oracle session busy check
- watcher   : pure answer-completion state machine (no browser dependency)
- cdp       : Playwright-over-CDP driver: consult / collect (browser dependency)
- oracle_cli: steipete/oracle CLI wrapper for the ChatGPT lane
- pane      : mycmux Web pane (web-list / web-push) wrapper
- report    : council markdown + quick_html rendering
"""

__version__ = "0.1.0"
