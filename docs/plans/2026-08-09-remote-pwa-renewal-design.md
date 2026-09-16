# iPhone Remote PWA Renewal — Design (2026-08-09)

Companion to `2026-08-09-v1-roadmap.md` Phase 4. Line numbers refer to v0.21.29 (`5cbfc11`). Re-verify before each phase.

## Findings that shaped the plan

- **A. The whole desktop command surface is already reachable in-process.** `socket.rs:329-463` bridges JSON commands to the frontend via `app.emit("socket-request")` + `socket_response`, 30s bounded wait (`socket.rs:425-456`). `socketCommands.ts:1027-1154` implements `pane.list_all/spawn_tab/close_tab/rename_tab/activate_tab/send_text/read/move`. Extract `dispatch_to_frontend(app, cmd, args, timeout)` and call it from a remote route (~80 lines) → the phone gets the entire PC command surface. Also deletes (not patches) the `+New` singleton-shell bug.
- **B. Staleness guard is a reusable pure function.** `socket.rs:132-171 stale_send_text_result(&SessionStateStore, &SendTextExpectations)` returns the `{sent:false, reason, current}` shape. `pub(crate)` is all that's needed.
- **C. Resume-from-offset is nearly free.** `get_scrollback_snapshot()` (`pty/session.rs:908-926`) returns absolute offsets; the reader computes them pre-broadcast (`:740-748`, broadcast `:781-784`) but `broadcast::Sender<Vec<u8>>` (`:409`) drops them. Change payload to `{data, start, end}` (consumers: `ws_handler.rs:61,109,144` + `remote/session.rs` which gets deleted).
- **D. Testability blocker = `RemoteState`'s AppHandle coupling** at `mod.rs:438` (db load) and `status_ws.rs:78-82` (state hop). Inject `status_feed`, `session_state_store`, workspace-name provider → whole router buildable in `#[tokio::test]`.
- **E. Status feed carries state but no identity** (`status_feed.rs:48-70`). Keep the feed contract untouched; add a separate identity endpoint.
- **F. Attention quality differs by agent.** Codex attention is backend-derived from rollout JSONL (`pty/monitor/codex_rollout.rs:704-723`). Claude attention comes from a frontend screen scan **only for mounted terminals** (`XTermWrapper.tsx:1057-1147`). An unmounted Claude tab never shows `waiting` on the phone — pre-existing desktop limitation; caps approve-from-phone coverage; document or add headless scanning later.
- **G. `Router::fallback(get(serve_static))` (`mod.rs:209`)** makes every unknown `/api/*` return index.html with 200. Nest `/api` with JSON 404.

## Target architecture

```
iPhone PWA (Preact+htm, vendored ESM, no bundler, rust_embed)
├─ /ws/status      subprotocol auth  → live state (existing feed, contract unchanged)
├─ /api/sessions   Bearer            → identity + tail lines
├─ /api/session/{id}/respond Bearer  → structured approve/deny (socket.rs guards)
├─ /api/attention/ack Bearer         → per-device seen; feeds push dedup
├─ /api/cmd        Bearer            → allowlisted bridge to socketCommands.ts
├─ /ws?session=&mode=view|control&since=  subprotocol auth → terminal
└─ /api/pair       (one-time code)   → per-device token
Rust: remote/{mod,router,auth→devices,extract,api,ws_handler,status_ws,notify,tail}.rs
```

Kills: the 3s poll, the client-side status regex (`app.js:80-110`), blind `y\n`/`n\n` senders (`app.js:823-843`), `remote/session.rs` singleton shell (`:161-177` + wiring `lib.rs:199,231,327-330,367-372`).

## Key API shapes

`GET /api/sessions` (built from `iter_pids()` + metadata_store like `mod.rs:426-562`, plus new `PtySession::scrollback_tail(n)` to avoid 256KB copies):
```json
{ "server_epoch": "…", "generated_at": 0, "sessions": [{
  "session_id": "pty-…", "workspace_id": "…", "workspace_name": "…",
  "label": "…", "agent_kind": "claude", "cwd": "…", "git_branch": "…",
  "process_name": "…", "alive": true, "last_output_at": 0, "tail": ["…"] }]}
```

`POST /api/session/{id}/respond`:
```json
{ "action": "approve|deny|keys|text", "keys": "\r", "text": "…", "enter": true,
  "expected_session_epoch": 7, "expected_attention_id": "…", "expected_session_revision": 41 }
```
→ success `{sent:true,bytes:n}` / stale = socket.rs's exact `{sent:false, reason, current}` shape. Server-side key allowlist: `\r`, `\x1b`, `y`, `n`, `1`-`3`, `\x1b[A`, `\x1b[B`.

**Key-mapping risk (verify on device in Phase 4a before enabling buttons):** current `"y\n"` is a guess; Claude/Codex approval prompts are highlighted option lists → `approve`=`\r`, `deny`=`\x1b`, numeric row + arrows. Keep the terminal visible under the card so the operator sees what happened.

## Push (staged)

- **Phase 4b — ntfy relay first**: `remote/notify.rs` with its own `StatusFeed::subscribe()` (like `status_ws.rs:83`). Trigger: `ui_state==waiting && attention.kind ∈ {input,approval,error} && attention_id ∉ notified_lru && no remote client attached && confidence ≥ 0.7`, debounce `state_since` <1.5s, hard per-minute cap. POST via reqwest (already a dep, rustls). Payload verbosity configurable (default title only — session titles leave the machine otherwise). `/api/attention/ack` inserts into the same LRU. Deep link `#/s/{session_id}`.
- **Phase 4c — HTTPS via `tailscale serve`** (never funnel): unlocks service worker/offline/installability and the iOS Web Push prerequisites (16.4+, HTTPS, homescreen, user-gesture permission). Behind the proxy every `peer_addr` becomes 127.0.0.1 → RemoteTab client list must key on device name.
- **Self-hosted Web Push (optional, L, after 4c)**: `/api/push/subscribe`, VAPID ES256, aes128gcm.

## Security (MUST in Phase 4a)

- Per-device tokens: `~/.mycmux/remote-devices.json` `[{id,name,token_sha256,created_at,last_seen_at,last_ip,revoked_at}]`, sha2 digest + constant-time compare; legacy `remote-token` auto-migrates as device "Legacy".
- Token out of URLs: HTTP `Authorization: Bearer`; WS via subprotocol `["mycmux.token."+t]` validated server-side and echoed (`WebSocketUpgrade::protocols`). Removes `?token=` from `/ws` (`ws_handler.rs:16-19`) and `/ws/status` (`status_ws.rs:16-19`).
- QR carries a **120s single-use pairing code** (`https://host/#pair=<code>` → `POST /api/pair` → device token) instead of the live token (`qr.rs:74-76`).
- Server off-switch + bind change without restart: supervised `axum::serve(..).with_graceful_shutdown(rx)`; `AppSettings.remote_enabled` (consider default **off** for fresh installs — today it starts unconditionally at `lib.rs:337`).
- `/api` JSON 404, `Cache-Control: no-store`, per-IP failed-auth token bucket, one-line audit for pair/revoke/respond.
- NICE later: per-device read-only flag, audit log in Settings, idle expiry.

## View mode vs resize

- Default `mode=view` never resizes (delete the resize path — today `ws_handler.rs:227-233` rewrites the real PC PTY on every phone viewport change).
- Add `PtySession::size()` (wrapper over `MasterPty::get_size()`, near `:872-885`); send `cols/rows/session_epoch` in the `connected` frame (`ws_handler.rs:115-119`); client creates xterm at PC geometry and CSS-scales to fit.
- Phase 4d: `take_control` → `control_owner: DashMap<session_id, client_id>`, store pre-takeover PtySize, honor resize only from owner, restore on release/disconnect.

## Reconnect (Phase 4d)

`OutputChunk {data,start,end}` broadcast → client persists `lastEnd` per session → `?since=`: if within snapshot range, send only the delta with `resync:false`; else full snapshot + `resync:true` (client `term.reset()`). Drop/trim overlapping chunks (`trim_overlap` pure fn). Frame each binary message with 8-byte LE `end` offset (mirrors MCX1/MCS1 convention, `pty/session.rs:106-140`).

## Client tech

Preact + htm as vendored ES modules (~12KB), no bundler, keep rust_embed (`mod.rs:174-176`). Rejected: staying vanilla (string-concat HTML frays at this app size), sharing desktop React (couples mobile to store refactors, heavy payload).

```
remote/client/ index.html  app/{main,api,status,attach,router,store}.js
  app/views/{SessionList,SessionDetail,Pair,Settings}.js
  app/lib/{ansi,format,keys}.js   ← pure, vitest-importable
  vendor/{preact.mjs,htm.mjs,xterm.js,addon-fit.js,xterm.css}
  icons/…  sw.js  manifest.json  style.css
```

Cache busting: SHA-256 of embedded client bytes computed at server start, substituted into `__ASSET_VERSION__` in index.html at serve time (replaces hand-edited `?v=` literals at `index.html:13,93`). Fix immediately: manifest has no `icons`, `apple-touch-icon` is `data:,` — copy from `src-tauri/icons/`.

## Test strategy

Prerequisite: RemoteState decoupling (finding D) + `pub fn router(state) -> Router` extraction. Dev-deps: `tower` (util), `http-body-util`, `tokio-tungstenite`.

1. `src-tauri/tests/remote_http.rs` (oneshot): 401 matrix (no auth/malformed/unknown/revoked/query-token), pair lifecycle (once→200, reuse→410, expired→410, rate limit), `/api/sessions` shape+ordering, respond staleness matrix (feed `Evidence` into real `SessionStateStore` mirroring `socket.rs:536-555`), `/api/cmd` allowlist, JSON 404.
2. `src-tauri/tests/remote_ws.rs` (real TcpListener + tungstenite): subprotocol handshake, view ignores resize / control honors + restores, `since=` zero-duplicate resume, status snapshot→delta→overflow→resync (mirrors `status_feed.rs:654-700`).
3. In-module pure units: device store round-trip, ANSI tail, key allowlist, trim_overlap, pairing lifetime.
4. `tests/test_remote_api_contract.py` freezing JSON field names.
5. `tests/unit/remoteClient.test.ts` importing `remote/client/app/lib/*.js` directly (plain ESM): status reducer, ordering, key mapping.

All Rust integration tests under `src-tauri/tests/` are picked up by `scripts/run_windows_tests.py` automatically.

## Phase map (roadmap 4a-4d)

- **4a Mission control (M)**: router split + DI + devices + extract + api; ws subprotocol auth + view-mode no-resize + connected geometry; delete remote/session.rs; Preact client (SessionList/SessionDetail/Pair); RemoteTab device management; `/api/cmd` bridge pulled forward (~80 lines, highest value-per-line); icons/manifest; full test suite. New Tauri commands (`list_remote_devices`/`revoke_remote_device`/`start_remote_pairing`/`set_remote_enabled`) — check `test_command_sync_contract.py` allowlist.
- **4b Notifications (S/M)**: notify.rs + ntfy + settings UI.
- **4c HTTPS + real PWA (S)**: `remote_public_origin` setting, tailscale serve docs, sw.js versioned cache, standalone polish.
- **4d Resume/control/tab lifecycle (M)**: OutputChunk + since + framing; take-control; phone spawn/close via `/api/cmd`.

DoD per phase: 4 verification commands green + `docs/features/implemented/remote-pwa.md` (Phase 4a creates it — the feature currently has no implemented-doc).

## Cross-cutting risks

1. Approval key sequences unverified against real agent TUIs (verify first, on device).
2. Unmounted-Claude-tab attention gap (finding F) silences push for background tabs — decide accept vs headless scan.
3. Deleting remote/session.rs removes phone shell until 4a's `/api/cmd` lands — sequence tightly (both in 4a).
4. RemoteState refactor touches boot path (`lib.rs:337-344`) — isolated commit.
5. Windows Rust tests: always `scripts/run_windows_tests.py`, never raw `cargo test --release`.
