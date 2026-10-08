from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from scripts import stack  # noqa: E402


IDENTITY = "0123456789abcdef"


def options(root: Path) -> argparse.Namespace:
    return argparse.Namespace(
        state_dir=str(root), key_file=None, profile_dir=None, tunnel_client=None,
        profile="mycmux-control", timeout=0.1,
    )


def prepared(root: Path) -> argparse.Namespace:
    ns = options(root)
    p = stack.paths(ns)
    p["root"].mkdir(parents=True, exist_ok=True)
    p["key"].write_text("offline-test-marker", encoding="utf-8")
    p["profiles"].mkdir()
    (p["profiles"] / "mycmux-control.yaml").write_text("# offline test profile\n", encoding="utf-8")
    p["client"].parent.mkdir(parents=True)
    p["client"].write_text("not an executable; spawn is mocked", encoding="utf-8")
    return ns


def runtime(root: Path) -> tuple[argparse.Namespace, dict[str, Path], dict]:
    ns = options(root)
    p = stack.paths(ns)
    p["runtime"].mkdir(parents=True)
    state = {
        "pid": 123, "identity": IDENTITY, "profile": "mycmux-control",
        "healthUrlFile": "health-url-" + "a" * 32 + ".txt",
        "state": "ready",
    }
    stack.save_runtime(p, state)
    return ns, p, state


class StackTests(unittest.TestCase):
    def test_missing_key_fails_before_reads_writes_or_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "isolated"
            with mock.patch.object(stack, "spawn") as spawn, mock.patch.object(Path, "read_text") as read:
                with self.assertRaisesRegex(stack.StackFailure, "Runtime key file missing"):
                    stack.cmd_start(options(root))
            spawn.assert_not_called()
            read.assert_not_called()
            self.assertFalse(root.exists())

    def test_missing_key_cli_prints_guidance_without_using_environment_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            sentinel = os.urandom(20).hex()
            env = os.environ.copy()
            env["CONTROL_PLANE_API_KEY"] = sentinel
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            root = Path(temporary) / "isolated"
            result = subprocess.run(
                [sys.executable, str(PLUGIN_ROOT / "scripts" / "stack.py"), "start", "--state-dir", str(root)],
                capture_output=True, text=True, encoding="utf-8", timeout=10, env=env, check=False,
            )
            self.assertEqual(2, result.returncode)
            self.assertEqual("", result.stdout)
            self.assertIn("Runtime key file missing", result.stderr)
            self.assertIn("owner-only permissions", result.stderr)
            self.assertNotIn(sentinel, result.stdout + result.stderr)
            self.assertFalse(root.exists())

    def test_preflight_stops_for_missing_profile_or_client(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "control-plane.key").write_text("offline", encoding="utf-8")
            ns = options(root)
            with mock.patch.object(stack, "spawn") as spawn:
                with self.assertRaisesRegex(stack.StackFailure, "Profile missing"):
                    stack.cmd_start(ns)
                (root / "profiles").mkdir()
                (root / "profiles" / "mycmux-control.yaml").write_text("# test", encoding="utf-8")
                with self.assertRaisesRegex(stack.StackFailure, "Tunnel client missing"):
                    stack.cmd_start(ns)
            spawn.assert_not_called()
            self.assertFalse((root / "runtime").exists())

    @unittest.skipUnless(os.name == "nt", "Detached process launcher is Windows-specific")
    def test_spawn_is_detached_hidden_and_strips_secret_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fake_process = mock.Mock(pid=123)
            with mock.patch.dict(os.environ, {"CONTROL_PLANE_API_KEY": "test-control", "OPENAI_API_KEY": "test-openai"}):
                with mock.patch.object(stack.subprocess, "Popen", return_value=fake_process) as popen:
                    self.assertEqual(123, stack.spawn(["fake-client", "run"], Path(temporary) / "stdout.log"))
            args, kwargs = popen.call_args
            self.assertEqual(["fake-client", "run"], args[0])
            self.assertEqual(
                stack.CREATE_NO_WINDOW | stack.DETACHED_PROCESS | stack.CREATE_NEW_PROCESS_GROUP,
                kwargs["creationflags"],
            )
            self.assertTrue(kwargs["close_fds"])
            self.assertEqual(subprocess.DEVNULL, kwargs["stdin"])
            self.assertNotIn("CONTROL_PLANE_API_KEY", kwargs["env"])
            self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
            self.assertEqual("1", kwargs["env"]["PYTHONDONTWRITEBYTECODE"])

    @unittest.skipUnless(os.name == "nt", "Process identity is Windows-specific")
    def test_windows_process_identity_is_available_for_current_process(self) -> None:
        self.assertRegex(stack.process_identity(os.getpid()), r"^[0-9a-f]{16}$")
        self.assertIsNone(stack.process_identity(0))

    @unittest.skipUnless(os.name == "nt", "Detached process launcher is Windows-specific")
    def test_start_records_pid_identity_and_unique_health_file_without_key_value(self) -> None:
        with tempfile.TemporaryDirectory(prefix="stack space ") as temporary:
            root = Path(temporary)
            ns = prepared(root)
            with mock.patch.object(stack, "spawn", return_value=123) as spawn, \
                 mock.patch.object(stack, "process_identity", return_value=IDENTITY), \
                 mock.patch.object(stack, "status_info", return_value={"pid": 123, "alive": True, "healthz": 200, "readyz": 200}), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(0, stack.cmd_start(ns))
            p = stack.paths(ns)
            state = stack.load_runtime(p)
            argv = spawn.call_args.args[0]
            self.assertEqual(123, state["pid"])
            self.assertEqual(IDENTITY, state["identity"])
            self.assertEqual("ready", state["state"])
            self.assertEqual("file:" + str(p["key"]), argv[argv.index("--control-plane.api-key") + 1])
            self.assertEqual(str(p["runtime"] / state["healthUrlFile"]), argv[argv.index("--health.url-file") + 1])
            self.assertEqual("127.0.0.1:0", argv[argv.index("--health.listen-addr") + 1])
            self.assertEqual("1", argv[argv.index("--mcp.max-concurrent-requests") + 1])
            self.assertIn("--allow-remote-ui=false", argv)
            self.assertIn("--log.http-raw-unsafe=false", argv)
            self.assertNotIn("offline-test-marker", output.getvalue() + p["state"].read_text(encoding="utf-8") + json.dumps(argv))

    @unittest.skipUnless(os.name == "nt", "Detached process launcher is Windows-specific")
    def test_repeated_start_reuses_only_the_owned_live_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ns = prepared(root)
            _, p, state = runtime(root)
            with mock.patch.object(stack, "process_identity", return_value=IDENTITY), \
                 mock.patch.object(stack, "status_info", return_value={"readyz": 200, "alive": True}), \
                 mock.patch.object(stack, "spawn") as spawn, contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(0, stack.cmd_start(ns))
            spawn.assert_not_called()
            self.assertTrue(json.loads(output.getvalue())["alreadyRunning"])
            self.assertEqual(state, stack.load_runtime(p))

    def test_status_uses_owned_loopback_health_metadata_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _, p, state = runtime(Path(temporary))
            (p["runtime"] / state["healthUrlFile"]).write_text("http://127.0.0.1:45678", encoding="utf-8")
            with mock.patch.object(stack, "process_identity", return_value=IDENTITY), \
                 mock.patch.object(stack, "http_status", return_value=200) as http:
                info = stack.status_info(p)
            self.assertTrue(info["alive"])
            self.assertEqual(200, info["healthz"])
            self.assertEqual(200, info["readyz"])
            self.assertEqual(
                [mock.call("http://127.0.0.1:45678", "healthz"), mock.call("http://127.0.0.1:45678", "readyz")],
                http.call_args_list,
            )

    def test_reused_pid_is_not_probed_or_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ns, p, _ = runtime(Path(temporary))
            with mock.patch.object(stack, "process_identity", return_value="fedcba9876543210"), \
                 mock.patch.object(stack, "http_status") as http, \
                 mock.patch.object(stack.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(stack.status_info(p)["alive"])
                self.assertEqual(0, stack.cmd_stop(ns))
            http.assert_not_called()
            run.assert_not_called()
            self.assertTrue(p["state"].is_file())

    def test_health_origin_rejects_remote_urls_and_credentials_before_http(self) -> None:
        for value in ("https://example.test", "http://127.0.0.1:9@other.test", "http://127.0.0.1:9/private", "http://127.0.0.1:9?token=test"):
            with self.subTest(value=value):
                with self.assertRaises(stack.StackFailure):
                    stack.health_base(value)
        self.assertEqual("http://127.0.0.1:9", stack.health_base("http://127.0.0.1:9/"))

    def test_stop_targets_owned_process_tree_and_preserves_runtime_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ns, p, state = runtime(Path(temporary))
            health_file = p["runtime"] / state["healthUrlFile"]
            health_file.write_text("http://127.0.0.1:45678", encoding="utf-8")
            with mock.patch.object(stack, "process_identity", side_effect=[IDENTITY, None]), \
                 mock.patch.object(stack.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, stack.cmd_stop(ns))
            self.assertEqual(["taskkill", "/PID", "123", "/T", "/F"], run.call_args.args[0])
            self.assertEqual("stopped", stack.load_runtime(p)["state"])
            self.assertTrue(health_file.is_file())
            self.assertTrue(p["state"].is_file())

    def test_runtime_cannot_point_health_reads_at_an_unrelated_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _, p, state = runtime(Path(temporary))
            state["healthUrlFile"] = "../control-plane.key"
            stack.save_runtime(p, state)
            with self.assertRaisesRegex(stack.StackFailure, "Runtime state is invalid"):
                stack.load_runtime(p)


if __name__ == "__main__":
    unittest.main()
