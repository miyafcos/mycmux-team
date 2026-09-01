# Phase 1b agent hook wire contract

Status: fixed for protocol 1.0 on 2026-08-30.

This document fixes the Phase 1b fields that section 4.4 intentionally left to
the implementation gate. The normative identity, acceptance order, limits, and
projection rules remain in `2026-08-30-agent-hook-contract.md` section 4.4.

## Broad-token launch command

`launch.issue_hook_cap` belongs to the existing broad-token realm. It accepts:

```json
{
  "token": "<broad socket token>",
  "cmd": "launch.issue_hook_cap",
  "args": {
    "terminal_session_id": "<live PTY session_id>",
    "provider": "claude | codex | grok"
  }
}
```

`claude-codex` is normalized to provider `claude` because it uses the Claude
process and hook protocol. The terminal session must still be live. Success
returns `result.hook_cap`, `result.protocol_major`, and `result.protocol_minor`.
Only `hook_cap` is placed in the child environment.

## Hook realm envelope

The request and response envelopes are the ones in section 4.4. `id` is an
unsigned 64-bit request correlation value. The only commands in protocol 1.0
are `hook.health` and `hook.observe`. `hook.prompt.*` is unknown in Phase 1b.

`hook.health` accepts an empty object body and returns:

```json
{"protocol_major": 1, "protocol_minor": 0}
```

`hook.observe` requires this body:

```json
{
  "event_kind": "turn_active | attention_required | turn_ended | process_exited | session_terminated | failed | cancelled | rate_limited",
  "provider_session_id": "<non-empty provider session ID>",
  "provider_turn_id": "<non-empty provider turn ID>",
  "source_event_id": "<non-empty provider event ID>",
  "terminal_session_id": "<optional agreement check>",
  "provider": "<optional agreement check>",
  "launch_id": "<optional agreement check>",
  "pane_id": "<optional display-metadata agreement check>",
  "payload": "<optional provider data; unknown fields are ignored>"
}
```

The server obtains terminal session, provider, launch, generation, and optional
pane metadata from the capability. Optional identity fields in the body are
agreement checks only. They never route or authenticate the request.

## Rejections

All rejections use `ok=false`, a machine-readable `reason`, and `retryable`.

| Condition | reason | retryable |
|---|---|---|
| Unknown capability, wrong app instance, or revoked capability | `unauthorized` | false |
| Capability no longer current, or non-terminal event while draining | `stale_launch` | false |
| Body provider disagrees with the capability | `wrong_provider` | false |
| Queue or rate limit is full | `queue_dropped` | true |
| Frame, capability, command, string, or depth limit exceeded | `too_large` | false |
| Invalid UTF-8, malformed JSON, missing/wrong body field, identity mismatch, unknown command, or both credentials present | `malformed` | false |

Malformed JSON and invalid UTF-8 have `id=0`. A frame larger than 1 MiB also
has `id=0` and `reason=too_large`. No rejected request changes the reconciler,
ledger projection, card, unread state, or notification state.

## terminal_session_id lifetime (gate P1B-02)

Verified from code on 2026-08-30, since the capability binds to this value.

| Question | Finding | How it was checked |
|---|---|---|
| Who generates it | The frontend, per tab | `PaneTab.sessionId` in `src/types/workspace.ts:35-37` |
| Does it change while the tab lives | **No path rewrites it.** A grep for assignments to an existing tab's `sessionId` across the stores and layout returns nothing | `\.sessionId = ` / `sessionId: newSessionId` over `src/stores/*.ts`, `src/components/layout/*.tsx` |
| Is it stable across pane moves | Yes, by construction: it belongs to the tab, and `Pane.sessionId` is only a compatibility mirror of the active tab | `src/types/workspace.ts:88-95` |
| Does a restarted agent reuse it | No — a restart means a new tab, therefore a new value |  |
| Is uniqueness enforced by the backend | **No.** `create_session` does not reject a duplicate id | `src-tauri/src/commands/terminal.rs` |

The last row is the honest gap. Nothing in the backend stops a caller from
presenting an id it has already used, so uniqueness currently rests on the
frontend generating fresh ones. That is acceptable while the only caller is
mycmux itself, and `app_instance_id` still separates ids across app restarts,
but it is a real assumption rather than an enforced invariant — worth closing
if the launch path ever gains another caller.
