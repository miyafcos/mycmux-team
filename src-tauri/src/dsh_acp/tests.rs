use super::*;
use tokio::io::duplex;

fn run(generation: u64) -> DshRunRef {
    DshRunRef { run_id: format!("run-{generation}"), generation, conv_id: Some("opaque/session:one".into()), cwd: "/trial".into() }
}

fn core() -> Core {
    let mut core = Core::default();
    core.state.enabled = true;
    core.state.run = Some(run(1));
    core.state.process = "running".into();
    core.state.activity = "quiescent".into();
    core
}

fn initialize() -> Value {
    json!({"protocolVersion":1,"agentInfo":{"version":"0.0.1"},"agentCapabilities":{
        "sessionCapabilities":{"resume":{},"list":{},"close":{}}}})
}

#[test]
fn initialize_checks_capabilities_and_keeps_executable_version_separate() {
    let mut state = core();
    state.state.executable_version = Some(PINNED_VERSION.into());
    state.initialized(&initialize()).unwrap();
    assert_eq!(state.state.agent_info_version.as_deref(), Some("0.0.1"));
    assert_eq!(state.state.executable_version.as_deref(), Some(PINNED_VERSION));
    let mut bad = initialize(); bad["protocolVersion"] = json!(2);
    assert!(state.initialized(&bad).is_err());
    assert!(state.initialized(&json!({"protocolVersion":1,"agentCapabilities":{}})).is_err());
}

#[test]
fn new_and_resume_reject_id_and_cwd_disagreement() {
    let mut state = core();
    assert!(state.opened(&json!({"sessionId":"other"}), Some("saved")).is_err());
    assert!(state.opened(&json!({"sessionId":"saved","cwd":"/other"}), Some("saved")).is_err());
    assert!(state.opened(&json!({}), None).is_err());
    state.opened(&json!({"configOptions":[]}), Some("saved")).unwrap();
    assert_eq!(state.state.run.unwrap().conv_id.as_deref(), Some("saved"));
}

#[test]
fn prompt_is_one_inflight_and_never_invents_acceptance() {
    let mut state = core();
    let (_, receipt) = state.reserve(&run(1), "op", "hello", "rpc1").unwrap();
    assert!(receipt.accepted_at_ms.is_none());
    assert!(receipt.settled_at_ms.is_none());
    assert_eq!(receipt.status, "submitted");
    assert!(!state.reserve(&run(1), "op", "hello", "rpc2").unwrap().0);
    assert!(state.reserve(&run(1), "op", "changed", "rpc3").is_err());
    assert!(state.reserve(&run(1), "other", "hello", "rpc4").is_err());
    state.settle("op", Ok(json!({"stopReason":"end_turn"})));
    assert_eq!(state.state.delivery.as_ref().unwrap().status, "settled");
    assert!(state.reserve(&run(1), "next", "hello", "rpc5").unwrap().0);
}

#[test]
fn expected_run_validates_generation_conversation_and_cwd() {
    for expected in [run(2), DshRunRef { cwd: "/other".into(), ..run(1) }, DshRunRef { conv_id: Some("other".into()), ..run(1) }] {
        assert!(core().reserve(&expected, "op", "hello", "rpc1").is_err());
    }
}

#[test]
fn updates_interleave_and_other_session_cannot_change_receipt() {
    let mut state = core();
    state.reserve(&run(1), "op", "hello", "rpc1").unwrap();
    state.update(&json!({"sessionId":"other","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"wrong"}}}));
    assert!(state.state.delivery.as_ref().unwrap().observed_at_ms.is_none());
    state.update(&json!({"sessionId":run(1).conv_id,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}));
    assert!(state.state.delivery.as_ref().unwrap().observed_at_ms.is_some());
    assert!(state.state.delivery.as_ref().unwrap().accepted_at_ms.is_none());
    let read = state.read(0).unwrap();
    assert_eq!(read.updates.len(), 1);
    assert!(!read.history_available);
    assert_eq!(read.source, "acpUpdates");
}

#[test]
fn update_buffer_has_cursor_gap_utf8_bound_and_secret_projection() {
    let mut state = core();
    for _ in 0..150 { state.update(&json!({"sessionId":run(1).conv_id,"update":{"sessionUpdate":"tool_call","rawInput":"sk-private"}})); }
    let read = state.read(0).unwrap();
    assert_eq!(read.updates.len(), protocol::MAX_UPDATES);
    assert!(read.gap && read.truncated);
    assert!(!serde_json::to_string(&read).unwrap().contains("sk-private"));
    state.update(&json!({"sessionId":run(1).conv_id,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"あ".repeat(40000)}}}));
    let read = state.read(0).unwrap();
    assert!(read.updates.iter().filter_map(|u| u.text.as_ref()).map(String::len).sum::<usize>() <= protocol::MAX_TEXT_BYTES);
    assert!(protocol::display_text("token sk-private API_KEY=private").contains("redacted"));
}

#[test]
fn cancel_requested_is_separate_from_correlated_cancelled_settlement() {
    let mut state = core();
    state.reserve(&run(1), "op", "hello", "rpc").unwrap();
    state.cancel_requested();
    assert!(state.inflight.is_some());
    assert_eq!(state.state.delivery.as_ref().unwrap().status, "submitted");
    state.settle("other", Ok(json!({"stopReason":"cancelled"})));
    assert!(state.inflight.is_some());
    state.settle("op", Ok(json!({"stopReason":"cancelled"})));
    assert_eq!(state.state.delivery.unwrap().status, "cancelled");
    assert!(state.inflight.is_none());
}

#[test]
fn lost_reply_is_unknown_and_late_settlement_cannot_restore_it() {
    let mut state = core();
    state.reserve(&run(1), "op", "hello", "rpc").unwrap();
    state.lost("fixture loss");
    state.settle("op", Ok(json!({"stopReason":"end_turn"})));
    assert_eq!(state.state.delivery.as_ref().unwrap().status, "unknown");
    assert!(state.reserve(&run(1), "op", "hello", "rpc2").is_err());
}

#[tokio::test]
async fn frame_reader_rejects_stdout_pollution_invalid_json_oversize_and_torn_eof() {
    for bytes in [b"startup log\n".to_vec(), b"{broken}\n".to_vec(), vec![b'x'; MAX_FRAME_BYTES + 1], b"{\"jsonrpc\":\"2.0\"}".to_vec(), b"{}\n".to_vec()] {
        assert!(read_frame(&mut BufReader::new(bytes.as_slice())).await.is_err());
    }
    assert!(read_frame(&mut BufReader::new(&b""[..])).await.unwrap().is_none());
}

#[tokio::test]
async fn disabled_state_refuses_start_and_all_session_mutations_without_spawn() {
    let state = DshAcpState::default();
    assert!(!state.snapshot().await.enabled);
    assert!(state.start(DshStartRequest { executable: "/does-not-exist".into(), cwd: "/trial".into(), dsh_home: None, resume: None }).await.unwrap_err().contains("disabled"));
    assert!(state.prompt(DshPromptRequest { expected_run: run(1), operation_id: "op".into(), text: "hello".into() }).await.is_err());
    assert!(state.cancel(&run(1)).await.is_err());
    assert!(state.close_session(&run(1)).await.is_err());
    assert!(state.read(&run(1), 0).await.is_err());
    assert!(state.permission(DshPermissionAnswer { expected_run: run(1), permission_id: "p".into(), choice: "allow".into() }).await.is_err());
    assert!(state.client.lock().await.is_none());
}

#[tokio::test]
async fn request_ids_are_not_reused_across_process_generations() {
    let (a, _) = duplex(8192); let (ar, aw) = tokio::io::split(a);
    let (b, _) = duplex(8192); let (br, bw) = tokio::io::split(b);
    let first = Client::from_io(ar, aw, None, run(1));
    let second = Client::from_io(br, bw, None, run(2));
    assert_ne!(first.next_id().unwrap(), second.next_id().unwrap());
}

struct Wire {
    reader: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
}
impl Wire {
    async fn receive(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.reader)).await.unwrap().unwrap().unwrap()
    }
    async fn send(&mut self, frame: Value) {
        let mut bytes = serde_json::to_vec(&frame).unwrap(); bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
    }
    async fn reply(&mut self, id: Value, result: Value) { self.send(json!({"jsonrpc":"2.0","id":id,"result":result})).await; }
}
fn wire() -> (Arc<Client>, Wire) {
    let (local, remote) = duplex(65536);
    let (reader, writer) = tokio::io::split(local);
    let client = Client::from_io(reader, writer, None, run(1));
    let (reader, writer) = tokio::io::split(remote);
    (client, Wire { reader: BufReader::new(reader), writer })
}
async fn ready(client: &Client) { client.core.lock().await.state = core().state; }
async fn until(client: &Client, predicate: impl Fn(&DshState) -> bool) -> DshState {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = client.snapshot().await;
            if predicate(&snapshot) { return snapshot; }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await.expect("fixture state did not arrive")
}
fn prompt_request(id: &str, text: &str) -> DshPromptRequest {
    DshPromptRequest { expected_run: run(1), operation_id: id.into(), text: text.into() }
}

#[tokio::test]
async fn wire_handshake_and_new_use_acp_fields_without_codex_turn_rules() {
    let (client, mut wire) = wire();
    let opened = tokio::spawn({ let client = client.clone(); async move { client.open(PINNED_VERSION, None).await } });
    let init = wire.receive().await;
    assert_eq!(init["method"], "initialize");
    assert_eq!(init["params"]["protocolVersion"], 1);
    wire.reply(init["id"].clone(), initialize()).await;
    let new = wire.receive().await;
    assert_eq!(new["method"], "session/new");
    assert_eq!(new["params"], json!({"cwd":"/trial","mcpServers":[]}));
    wire.reply(new["id"].clone(), json!({"sessionId":"opaque/session:one"})).await;
    opened.await.unwrap().unwrap();
    assert_eq!(client.snapshot().await.activity, "quiescent");
}

#[tokio::test]
async fn wire_prompt_interleaving_duplicate_reply_and_operation_deduplication() {
    let (client, mut wire) = wire(); ready(&client).await;
    let submitted = client.prompt(prompt_request("op", "hello")).await.unwrap();
    let frame = wire.receive().await;
    assert_eq!(frame["method"], "session/prompt");
    assert_eq!(frame["params"], json!({"sessionId":"opaque/session:one","prompt":[{"type":"text","text":"hello"}]}));
    wire.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"opaque/session:one",
        "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"reply"}}}})).await;
    until(&client, |s| s.delivery.as_ref().is_some_and(|d| d.observed_at_ms.is_some())).await;
    wire.reply(frame["id"].clone(), json!({"stopReason":"end_turn"})).await;
    until(&client, |s| s.activity == "quiescent").await;
    wire.reply(frame["id"].clone(), json!({"stopReason":"cancelled"})).await;
    let duplicate = client.prompt(prompt_request("op", "hello")).await.unwrap();
    assert_eq!(duplicate.request_id, submitted.request_id);
    assert_eq!(duplicate.status, "settled");
    assert!(tokio::time::timeout(Duration::from_millis(30), read_frame(&mut wire.reader)).await.is_err());
    assert!(client.prompt(prompt_request("op", "different")).await.is_err());
    let next = client.prompt(prompt_request("next", "next text")).await.unwrap();
    assert_ne!(submitted.request_id, next.request_id);
    assert_eq!(wire.receive().await["method"], "session/prompt");
}

#[tokio::test]
async fn wire_unknown_request_is_explicitly_unsupported_and_not_accepted() {
    let (client, mut wire) = wire(); ready(&client).await;
    wire.send(json!({"jsonrpc":"2.0","id":44,"method":"terminal/create","params":{"command":"sk-private"}})).await;
    let response = wire.receive().await;
    assert_eq!(response["error"]["code"], -32601);
    assert!(response.get("result").is_none());
    assert!(!serde_json::to_string(&client.snapshot().await).unwrap().contains("sk-private"));
}

#[tokio::test]
async fn wire_unknown_reply_and_eof_cannot_prove_process_exit_or_task_success() {
    for eof in [false, true] {
        let (client, mut wire) = wire(); ready(&client).await;
        client.prompt(prompt_request("op", "hello")).await.unwrap(); wire.receive().await;
        if eof { drop(wire); } else { wire.reply(json!("foreign-generation:42"), json!({"stopReason":"end_turn"})).await; }
        let snapshot = until(&client, |s| s.activity == "unknown").await;
        assert_eq!(snapshot.process, "running"); // A broken pipe is not an exit observation.
        assert_eq!(snapshot.delivery.unwrap().status, "unknown");
        assert!(client.prompt(prompt_request("retry", "hello")).await.is_err());
    }
}

#[tokio::test]
async fn wire_timeout_and_late_reply_are_unknown_without_automatic_resend() {
    let (client, mut wire) = wire(); ready(&client).await;
    let id = client.next_id().unwrap();
    client.core.lock().await.reserve(&run(1), "op", "hello", &id).unwrap();
    let pending = tokio::spawn({ let client = client.clone(); let id = id.clone(); async move {
        client.request(id, "session/prompt", json!({"sessionId":"opaque/session:one"}), Some("op".into()), Duration::from_millis(20)).await
    } });
    wire.receive().await;
    assert!(matches!(pending.await.unwrap(), Err(RpcFailure::Unknown)));
    wire.reply(json!(id), json!({"stopReason":"end_turn"})).await;
    assert_eq!(client.snapshot().await.delivery.unwrap().status, "unknown");
    assert!(tokio::time::timeout(Duration::from_millis(30), read_frame(&mut wire.reader)).await.is_err());
}

#[tokio::test]
async fn wire_cancel_noop_sends_nothing_and_immediate_cancel_follows_prompt() {
    let (client, mut wire) = wire(); ready(&client).await;
    client.cancel(&run(1)).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(20), read_frame(&mut wire.reader)).await.is_err());
    let delivery = client.prompt(prompt_request("op", "hello")).await.unwrap();
    let requested = client.cancel(&run(1)).await.unwrap();
    assert_eq!(requested.delivery.unwrap().status, "submitted");
    assert_eq!(wire.receive().await["method"], "session/prompt");
    let cancel = wire.receive().await;
    assert_eq!(cancel["method"], "session/cancel"); assert!(cancel.get("id").is_none());
    wire.reply(json!(delivery.request_id), json!({"stopReason":"cancelled"})).await;
    let settled = until(&client, |s| s.activity == "quiescent").await;
    assert_eq!(settled.delivery.unwrap().status, "cancelled");
}

#[tokio::test]
async fn wire_permissions_are_scoped_one_shot_and_remote_secrets_are_not_exposed() {
    for choice in ["allow", "reject"] {
        let (client, mut wire) = wire(); ready(&client).await;
        client.prompt(prompt_request("op", "hello")).await.unwrap(); wire.receive().await;
        let params = json!({"sessionId":"opaque/session:one","toolCall":{"rawInput":"sk-private"},"options":[
            {"kind":"allow_once","optionId":"allow-id","name":"sk-private"},
            {"kind":"reject_once","optionId":"reject-id","name":"sk-private"},
            {"kind":"allow_always","optionId":"permanent"}]});
        wire.send(json!({"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":params})).await;
        let snapshot = until(&client, |s| !s.permissions.is_empty()).await;
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("sk-private"));
        let permission_id = snapshot.permissions[0].permission_id.clone();
        client.answer(DshPermissionAnswer { expected_run: run(1), permission_id: permission_id.clone(), choice: choice.into() }).await.unwrap();
        let response = wire.receive().await;
        assert_eq!(response["result"]["outcome"]["optionId"], format!("{choice}-id"));
        assert!(client.answer(DshPermissionAnswer { expected_run: run(1), permission_id, choice: choice.into() }).await.is_err());
        wire.send(json!({"jsonrpc":"2.0","id":78,"method":"session/request_permission",
            "params":{"sessionId":"other","options":[{"kind":"allow_once","optionId":"allow-id"}]}})).await;
        assert_eq!(wire.receive().await["result"]["outcome"]["outcome"], "cancelled");
    }
}

#[tokio::test]
async fn wire_ambiguous_and_durable_permission_choices_are_cancelled() {
    let (client, mut wire) = wire(); ready(&client).await;
    client.prompt(prompt_request("op", "hello")).await.unwrap(); wire.receive().await;
    for options in [json!([{"kind":"allow_always","optionId":"always"}]),
        json!([{"kind":"allow_once","optionId":"same"},{"kind":"reject_once","optionId":"same"}])] {
        wire.send(json!({"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"opaque/session:one","options":options}})).await;
        assert_eq!(wire.receive().await["result"]["outcome"]["outcome"], "cancelled");
    }
    assert!(client.snapshot().await.permissions.is_empty());
}

#[tokio::test]
async fn wire_resume_checks_list_and_never_falls_back_to_new() {
    for mismatch in [false, true] {
        let (client, mut wire) = wire();
        let resumed = tokio::spawn({ let client = client.clone(); async move { client.open(PINNED_VERSION, Some(&run(1))).await } });
        let init = wire.receive().await; wire.reply(init["id"].clone(), initialize()).await;
        let listed = wire.receive().await; assert_eq!(listed["method"], "session/list");
        wire.reply(listed["id"].clone(), json!({"sessions":[{"sessionId":"opaque/session:one","cwd":if mismatch {"/wrong"} else {"/trial"}}]})).await;
        if mismatch { assert!(resumed.await.unwrap().is_err()); }
        else {
            let resume = wire.receive().await; assert_eq!(resume["method"], "session/resume");
            wire.reply(resume["id"].clone(), json!({"configOptions":[]})).await;
            resumed.await.unwrap().unwrap();
            assert!(!client.snapshot().await.read.unwrap().history_available);
        }
        assert!(tokio::time::timeout(Duration::from_millis(30), read_frame(&mut wire.reader)).await.is_err());
    }
}

#[tokio::test]
async fn wire_close_waits_for_reply_preserves_saved_id_and_keeps_process_separate() {
    let (client, mut wire) = wire(); ready(&client).await;
    let close = tokio::spawn({ let client = client.clone(); async move { client.close_session(&run(1)).await } });
    let frame = wire.receive().await;
    assert_eq!(frame["params"]["sessionId"], "opaque/session:one");
    assert!(!client.snapshot().await.session_closed);
    wire.reply(frame["id"].clone(), json!({})).await;
    let closed = close.await.unwrap().unwrap();
    assert!(closed.session_closed); assert_eq!(closed.process, "running");
    assert_eq!(closed.run.unwrap().conv_id, run(1).conv_id);
    assert!(client.prompt(prompt_request("after", "hello")).await.is_err());
}

#[tokio::test]
async fn disabled_feature_stops_the_owned_connection_and_retains_the_conversation() {
    let state = Arc::new(DshAcpState::default()); state.set_enabled(true).await;
    let (client, mut wire) = wire(); ready(&client).await;
    *state.client.lock().await = Some(client);
    let disabled = tokio::spawn({ let state = state.clone(); async move { state.set_enabled(false).await } });
    let close = wire.receive().await; assert_eq!(close["method"], "session/close");
    wire.reply(close["id"].clone(), json!({})).await;
    let snapshot = disabled.await.unwrap();
    assert!(!snapshot.enabled); assert_eq!(snapshot.process, "exited");
    assert!(snapshot.session_closed); assert_eq!(snapshot.run, Some(run(1)));
    assert!(state.client.lock().await.is_none());
}

#[cfg(unix)]
fn fixture(version: &str) -> (tempfile::TempDir, DshStartRequest) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().join("日本語 space"); std::fs::create_dir(&cwd).unwrap();
    let executable = directory.path().join("fake dsh");
    let source = include_str!("../../../tests/fixtures/dsh-acp/fake_dsh.py").replace(PINNED_VERSION, version);
    std::fs::write(&executable, source).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, DshStartRequest { executable: executable.to_string_lossy().into(), cwd: cwd.to_string_lossy().into(), dsh_home: None, resume: None })
}
async fn state_until(state: &DshAcpState, predicate: impl Fn(&DshState) -> bool) -> DshState {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = state.snapshot().await;
            if predicate(&snapshot) { return snapshot; }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }).await.expect("fake child state did not arrive")
}

#[cfg(unix)]
#[tokio::test]
async fn fake_child_version_mismatch_is_rejected_before_acp_start() {
    let (_directory, request) = fixture("0.2.1-alpha.1");
    let state = DshAcpState::default(); state.set_enabled(true).await;
    assert!(state.start(request).await.unwrap_err().contains("version"));
    assert!(state.client.lock().await.is_none());
    assert!(state.snapshot().await.run.is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn fake_child_text_close_stop_and_resume_keep_the_saved_conversation() {
    let (directory, request) = fixture(PINNED_VERSION);
    let marker = directory.path().join("saved-session"); std::fs::write(&marker, "retained").unwrap();
    let state = DshAcpState::default(); state.set_enabled(true).await;
    let initial = state.start(request.clone()).await.unwrap();
    let first = initial.run.unwrap();
    assert_eq!(initial.executable_version.as_deref(), Some(PINNED_VERSION));
    assert_eq!(initial.agent_info_version.as_deref(), Some("0.0.1"));
    assert!(state.start(request.clone()).await.is_err());
    state.prompt(DshPromptRequest { expected_run: first.clone(), operation_id: "one".into(), text: "hello".into() }).await.unwrap();
    let settled = state_until(&state, |s| s.delivery.as_ref().is_some_and(|d| d.status == "settled")).await;
    assert_eq!(settled.read.unwrap().updates[0].text.as_deref(), Some("fixture reply"));
    let closed = state.close_session(&first).await.unwrap();
    assert_eq!(closed.process, "running"); assert!(closed.session_closed);
    state.stop_owned(Some(&first)).await.unwrap();
    let resumed = state.start(DshStartRequest { resume: Some(first.clone()), ..request }).await.unwrap();
    let second = resumed.run.unwrap();
    assert_eq!(second.conv_id, first.conv_id); assert_ne!(second.run_id, first.run_id);
    assert!(second.generation > first.generation);
    assert!(!resumed.read.unwrap().history_available);
    assert!(state.prompt(DshPromptRequest { expected_run: first.clone(), operation_id: "stale".into(), text: "hello".into() }).await.is_err());
    assert!(state.stop_owned(Some(&first)).await.is_err());
    state.stop_owned(Some(&second)).await.unwrap();
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "retained");
}

#[cfg(unix)]
#[tokio::test]
async fn fake_child_permission_and_cancel_have_correlated_settlements() {
    let (_directory, request) = fixture(PINNED_VERSION);
    let state = DshAcpState::default(); state.set_enabled(true).await;
    let run = state.start(request).await.unwrap().run.unwrap();
    for (index, choice) in ["allow", "reject"].iter().enumerate() {
        state.prompt(DshPromptRequest { expected_run: run.clone(), operation_id: format!("permission-{index}"), text: "permission".into() }).await.unwrap();
        let permission = state_until(&state, |s| !s.permissions.is_empty()).await.permissions.remove(0);
        state.permission(DshPermissionAnswer { expected_run: run.clone(), permission_id: permission.permission_id, choice: choice.to_string() }).await.unwrap();
        state_until(&state, |s| s.activity == "quiescent").await;
    }
    state.prompt(DshPromptRequest { expected_run: run.clone(), operation_id: "cancel".into(), text: "cancel".into() }).await.unwrap();
    state.cancel(&run).await.unwrap();
    let cancelled = state_until(&state, |s| s.delivery.as_ref().is_some_and(|d| d.status == "cancelled")).await;
    assert!(cancelled.delivery.unwrap().cancel_requested);
    state.stop_owned(Some(&run)).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn fake_child_eof_becomes_unknown_without_a_retry_or_replacement() {
    let (_directory, request) = fixture(PINNED_VERSION);
    let state = DshAcpState::default(); state.set_enabled(true).await;
    let run = state.start(request).await.unwrap().run.unwrap();
    state.prompt(DshPromptRequest { expected_run: run.clone(), operation_id: "eof".into(), text: "eof".into() }).await.unwrap();
    let lost = state_until(&state, |s| s.activity == "unknown").await;
    assert_eq!(lost.delivery.unwrap().status, "unknown");
    assert!(state.prompt(DshPromptRequest { expected_run: run.clone(), operation_id: "retry".into(), text: "hello".into() }).await.is_err());
    state.stop_owned(Some(&run)).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn fake_child_environment_contains_no_pane_identity_or_ambient_credentials() {
    let (_directory, request) = fixture(PINNED_VERSION);
    let state = DshAcpState::default(); state.set_enabled(true).await;
    let run = state.start(request).await.unwrap().run.unwrap();
    state.prompt(DshPromptRequest { expected_run: run.clone(), operation_id: "environment".into(), text: "environment".into() }).await.unwrap();
    let settled = state_until(&state, |s| s.delivery.as_ref().is_some_and(|d| d.status == "settled")).await;
    assert_eq!(settled.read.unwrap().updates[0].text.as_deref(), Some("isolation clean"));
    state.stop_owned(Some(&run)).await.unwrap();
}

#[test]
fn dsh_codex_child_ancestry_is_not_a_registered_codex_pane() {
    use sysinfo::Pid;
    // app -> PTY -> ordinary Codex; app -> dsh -> Codex app-server -> hook.
    let rows = [(1, None, 10), (11, Some(1), 20), (12, Some(11), 30),
        (21, Some(1), 20), (22, Some(21), 30), (23, Some(22), 40)];
    let lookup = |pid: Pid| rows.iter().find(|(id, _, _)| *id == pid.as_u32())
        .map(|(_, parent, started)| (parent.map(Pid::from_u32), *started));
    assert!(crate::livebrief::intervene::is_descendant_with(Pid::from_u32(12), Pid::from_u32(11), lookup));
    assert!(!crate::livebrief::intervene::is_descendant_with(Pid::from_u32(23), Pid::from_u32(11), lookup));
    for key in ["MYCMUX_SESSION_ID", "MYCMUX_HOOK_CAP", "__CMUX_ATTACH", "CODEX_HOME", "CODEX_THREAD_ID", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] {
        assert!(remove_child_env(key), "{key}");
    }
    assert!(!remove_child_env("DSH_HOME")); assert!(!remove_child_env("HOME"));
}

#[tokio::test]
async fn dsh_child_hook_without_a_pane_capability_is_rejected() {
    let service = crate::agent_state::HookService::new();
    let response = service.handle_hook(1, "".into(), "hook.observe".into(), json!({"provider":"codex","sender_pid":23})).await;
    assert!(!response.ok);
    assert_eq!(service.metrics().accepted, 0);
}

#[test]
fn session_open_cannot_restore_a_connection_already_marked_unknown() {
    let mut state = core();
    state.state.run.as_mut().unwrap().conv_id = None;
    state.lost("ACP stdout EOF");
    assert!(state.opened(&json!({"sessionId":"opaque/session:one"}), None).is_err());
    assert_eq!(state.state.activity, "unknown");
    assert!(state.state.run.unwrap().conv_id.is_none());
}

#[tokio::test]
async fn concurrent_lifecycle_start_is_rejected_without_waiting_or_spawning() {
    let state = DshAcpState::default();
    state.set_enabled(true).await;
    let _busy = state.lifecycle.lock().await;
    let result = tokio::time::timeout(Duration::from_millis(50), state.start(DshStartRequest {
        executable: "/does-not-exist".into(), cwd: "/trial".into(), dsh_home: None, resume: None,
    })).await.unwrap();
    assert!(result.unwrap_err().contains("already in progress"));
    assert!(state.client.lock().await.is_none());
}

#[tokio::test]
async fn wire_close_drain_requires_the_pending_prompts_own_settlement() {
    for settled in [false, true] {
        let (client, mut wire) = wire(); ready(&client).await;
        let prompt = client.prompt(prompt_request("op", "hello")).await.unwrap();
        wire.receive().await;
        let close = tokio::spawn({ let client = client.clone(); async move { client.close_session(&run(1)).await } });
        let frame = wire.receive().await;
        if settled { wire.reply(json!(prompt.request_id), json!({"stopReason":"cancelled"})).await; }
        wire.reply(frame["id"].clone(), json!({})).await;
        let snapshot = close.await.unwrap().unwrap();
        assert!(snapshot.session_closed);
        assert_eq!(snapshot.process, "running");
        let receipt = snapshot.delivery.unwrap();
        assert_eq!(receipt.status, if settled { "cancelled" } else { "unknown" });
        assert_eq!(receipt.settled_at_ms.is_some(), settled);
        assert!(receipt.accepted_at_ms.is_none());
    }
}

#[tokio::test]
async fn wire_invalid_settlement_is_unknown_and_remote_error_details_are_withheld() {
    for malformed in [false, true] {
        let (client, mut wire) = wire(); ready(&client).await;
        client.prompt(prompt_request("op", "hello")).await.unwrap();
        let frame = wire.receive().await;
        if malformed { wire.reply(frame["id"].clone(), json!({"stopReason":"sk-private"})).await; }
        else { wire.send(json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32603,"message":"sk-private","data":{"API_KEY":"private"}}})).await; }
        let snapshot = until(&client, |s| s.delivery.as_ref().is_some_and(|d| d.status == if malformed { "unknown" } else { "rejected" })).await;
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("sk-private"));
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("API_KEY"));
    }
}
