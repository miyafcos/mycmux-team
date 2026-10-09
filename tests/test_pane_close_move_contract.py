"""CLI and documentation contract; also collected by pytest on Windows."""
import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("close_move_cli", ROOT / "scripts/mycmux_agent_cli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class PaneCloseContract(unittest.TestCase):
    def test_close_tab_default_force_is_false_and_keeps_the_existing_request(self):
        args = cli.build_parser().parse_args(["close-tab", "--session", "session"])
        self.assertFalse(args.force)
        self.assertEqual(cli.request_for(args), ("pane.close_tab", {"sessionId": "session"}))

    def test_close_tab_force_is_explicit(self):
        args = cli.build_parser().parse_args(["close-tab", "--session", "session", "--force"])
        self.assertEqual(cli.request_for(args), ("pane.close_tab", {"sessionId": "session", "force": True}))

    def test_cli_help_and_both_api_documents_share_the_same_result_example(self):
        parser = cli.build_parser()
        subcommands = next(action for action in parser._actions if isinstance(action, cli.argparse._SubParsersAction))
        help_text = subcommands.choices["close-tab"].format_help()
        texts = [help_text] + [(ROOT / path).read_text(encoding="utf-8") for path in (
            "docs/agent-integration.md", "docs/adr/0014-agent-neutral-workspace-and-handoff-contracts.md",
        )]
        examples = [next(json.loads(line) for line in re.findall(r'^\{"workspaceId".*\}$', text, re.M)
                         if '"needs_confirmation"' in line) for text in texts]
        self.assertEqual(examples[0], examples[1])
        self.assertEqual(examples[1], examples[2])
        self.assertEqual(examples[0]["effect"], "needs_confirmation")
        self.assertFalse(examples[0]["closed"])
        self.assertEqual(set(examples[0]), {"workspaceId", "paneId", "tabId", "kind", "hasPty", "persistent",
                                          "transferable", "closeEffect", "sendable", "closed", "effect", "reason"})


if __name__ == "__main__":
    unittest.main()
