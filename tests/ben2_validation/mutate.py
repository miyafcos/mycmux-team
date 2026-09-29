"""Run bounded, reversible production mutations for the stage-1 contract replacements."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
LISTENER = "src/components/layout/SocketListener.tsx"
COMMANDS = "src/components/layout/socketCommands.ts"
GUARD = """          if (!isLeader.current || !isPersistenceWriteAllowed()) {
            return request ? null : false;
          }
"""
CASES = [
    ("r1_table_only", COMMANDS, [("export const SOCKET_COMMAND_NAMES = [", 'export const SOCKET_COMMAND_NAMES = [\n  "ben2.extra",')], "socketCommandNames.test.ts", ""),
    ("r1_case_only", COMMANDS, [('case "pane.move":', 'case "pane.move_extra":')], "socketCommandNames.test.ts", ""),
    ("r1_foreground", COMMANDS, [('  const workspaceState = useWorkspaceListStore.getState();', '  useUiStore.setState({ activePaneId: "BEN2" });\n  const workspaceState = useWorkspaceListStore.getState();')], "socketForegroundContract.test.ts", ""),
    ("r2_startup_guard", LISTENER, [('if (!envelope.supported || !envelope.data) {', 'if (false) {')], "socketSchemaOrdering.test.tsx", "quarantines unsupported startup"),
    ("r2_early_support", LISTENER, [('    await hydrate();\n    markPersistentSchemaSupported(schemaVersion);', '    markPersistentSchemaSupported(schemaVersion);\n    await hydrate();')], "socketSchemaOrdering.test.tsx", "publishes support after"),
    ("r2_startup_hold", LISTENER, [('startupAutosaveHoldUntil.current = startupRestoreTargetPaneCount > 0', 'startupAutosaveHoldUntil.current = false')], "socketSchemaOrdering.test.tsx", "publishes support after"),
    ("r2_child_guard", LISTENER, [('            reportUnsupportedPersistentSchema(unsupportedSchema);', '            void unsupportedSchema;')], "socketSchemaOrdering.test.tsx", "quarantines a child"),
    ("r2_hydration_guard", LISTENER, [('    reportPersistentHydrationFailure();', '    // Mutation: hydration quarantine removed.')], "socketSchemaOrdering.test.tsx", "quarantines failed hydration"),
    ("r2_save_guard", LISTENER, [('if (unsupportedSchema !== null) {', 'if (false) {'), ('if (terminalError !== null) {', 'if (false) {')], "socketSchemaOrdering.test.tsx", "save rejection"),
    ("r2_strings", "src/lib/persistenceStrings.ts", [], "persistenceStrings.test.ts", ""),
    ("r3_ast_role_guard", LISTENER, [(GUARD, "")], "persistenceRoleGuardAst.test.ts", "guards every data write"),
    ("r3_ast_await", LISTENER, [(GUARD, GUARD + '          await Promise.resolve();\n')], "persistenceRoleGuardAst.test.ts", "allows no await"),
    ("r3_ast_mapping", LISTENER, [('cachedAgentMappings = await readAgentSessionMappings(mappingSessionIds);', 'cachedAgentMappings = {};'), (GUARD, GUARD + '          await readAgentSessionMappings(mappingSessionIds);\n')], "persistenceRoleGuardAst.test.ts", "completes mapping preflight"),
    ("r3_ast_fragments", LISTENER, [('windowFragments = await getWindowFragments();', 'windowFragments = [];'), (GUARD, GUARD + '          await getWindowFragments();\n')], "persistenceRoleGuardAst.test.ts", "completes fragment preflight"),
    ("r3_socket_role", LISTENER, [('      if (!isLeader.current) return;\n      const { id, cmd, args } = event.payload;', '      const { id, cmd, args } = event.payload;')], "peerWindowClose.test.tsx", "dispatches socket success"),
    ("r3_fragment_publish", LISTENER, [('await publishWindowFragment(buildWindowFragment());', 'void buildWindowFragment();')], "peerWindowClose.test.tsx", "workspace changes regardless"),
    ("r3_incoming_close", LISTENER, [('const pending = await takePendingAdoption(windowLabel());', 'const pending: WorkspaceConfig[] = [];')], "peerWindowClose.test.tsx", "closes already committed"),
    ("r3_tearout", "src/lib/workspaceTearOut.ts", [('evictTerminalCache(sessionId);', 'void sessionId;')], "browserTabTransfer.test.ts", "hands off before evicting"),
    ("r3_close_save", LISTENER, [('const saved = await sync(true);', 'const saved = true;')], "peerWindowClose.test.tsx", "closing main confirms"),
]


def main():
    records = []
    for name, relative, replacements, test, pattern in CASES:
        path = ROOT / relative
        original = path.read_bytes()
        original_hash = hashlib.sha256(original).hexdigest()
        newline = "\r\n" if b"\r\n" in original else "\n"
        text = original.decode("utf-8").replace("\r\n", "\n")
        for old, new in replacements:
            assert old in text, (name, old)
            text = text.replace(old, new)
        if name == "r2_strings":
            text = "\n".join(line[:-1] + ' + "BEN2",' if line.startswith("  ") and line.endswith(",") else line for line in text.split("\n"))
        command = ["node", "node_modules/vitest/vitest.mjs", "run", "tests/unit/" + test,
                   "--reporter=json", "--outputFile=" + str(OUT / (name + ".json"))]
        if pattern:
            command += ["-t", pattern]
        try:
            path.write_bytes(text.replace("\n", newline).encode("utf-8"))
            result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=180)
            (OUT / (name + ".log")).write_bytes(result.stdout + result.stderr)
            output = json.loads((OUT / (name + ".json")).read_text(encoding="utf-8"))
            failed = [assertion["fullName"] for suite in output["testResults"]
                      for assertion in suite.get("assertionResults", []) if assertion["status"] == "failed"]
            record = {"mutation": name, "path": relative, "command": command,
                      "exit": result.returncode, "failed_tests": failed, "before_sha256": original_hash}
        finally:
            path.write_bytes(original)
            assert hashlib.sha256(path.read_bytes()).hexdigest() == original_hash
        record["restored_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        records.append(record)
        with (OUT / "mutations.json").open("w", encoding="utf-8") as handle:
            json.dump(records, handle, ensure_ascii=False, indent=2)
        assert "\ufffd" not in (OUT / "mutations.json").read_text(encoding="utf-8")
        print(name, "exit", result.returncode, "failed", len(failed), "restored", flush=True)
        assert result.returncode != 0 and failed, (name, "mutation survived or failed before any test ran")


if __name__ == "__main__":
    main()
