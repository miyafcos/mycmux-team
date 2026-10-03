use super::*;
use protocol::{MAX_EVENTS, MAX_REPLY_BYTES};
use tokio::io::{split, DuplexStream, ReadHalf, WriteHalf};

fn core() -> ProtocolState {
    let mut core = ProtocolState::default();
    core.opened_thread(
        thread_start_params("/trial"),
        &json!({"thread":{"id":"thread-a"},
        "model":"observed-model","reasoningEffort":"max","cwd":"/trial","serviceTier":null}),
    )
    .unwrap();
    core.reserve_send("operation-a", "probe text", 1).unwrap();
    core
}

fn turn_event(status: &str) -> Value {
    json!({"threadId":"thread-a","turn":{"id":"turn-a","status":status}})
}

#[test]
fn version_is_exact_and_cannot_match_the_client_version_or_a_newer_patch() {
    assert!(pinned_user_agent(
        "mycmux_openai_probe/0.160.0 (Windows; 0.1.0)"
    ));
    for value in [
        "probe/0.160.01",
        "probe/0.161.0",
        "probe/0.160.0-beta",
        "probe/0.1.0",
        "",
    ] {
        assert!(!pinned_user_agent(value), "{value}");
    }
}

#[test]
fn requested_and_effective_values_are_never_conflated() {
    let core = core();
    assert_eq!(
        core.snapshot.configuration.requested,
        json!({"cwd":"/trial","ephemeral":true})
    );
    assert!(core.snapshot.configuration.requested.get("model").is_none());
    assert_eq!(
        core.snapshot.configuration.effective["model"],
        "observed-model"
    );
    assert_eq!(core.snapshot.configuration.effective["effort"], "max");
    assert!(core.snapshot.configuration.effective["serviceTier"].is_null());
    assert!(core.snapshot.configuration.observed);
    for prohibited in [
        "model",
        "effort",
        "serviceTier",
        "approvalPolicy",
        "sandbox",
        "permissions",
        "config",
    ] {
        assert!(
            thread_start_params("/trial").get(prohibited).is_none(),
            "{prohibited}"
        );
        assert!(turn_start_params("thread-a", "hello", "operation-a")
            .get(prohibited)
            .is_none());
    }
}

#[test]
fn a_logical_send_is_not_reissued_after_a_duplicate_or_unknown_outcome() {
    let mut core = core();
    assert!(!core.reserve_send("operation-a", "probe text", 2).unwrap());
    assert!(core.reserve_send("operation-a", "changed text", 2).is_err());
    assert!(core
        .reserve_send("operation-b", "probe text", 2)
        .unwrap_err()
        .starts_with("unsupported:"));
    core.connection_lost("EOF", 3);
    assert_eq!(core.snapshot.delivery.as_ref().unwrap().status, "unknown");
    assert!(!core.reserve_send("operation-a", "probe text", 4).unwrap());
    assert_eq!(
        core.snapshot
            .events
            .iter()
            .filter(|e| e.method == "turn/start:submitted")
            .count(),
        1
    );
}

#[test]
fn acceptance_is_not_inferred_as_turn_start_or_completion() {
    let mut core = core();
    core.accept_send(&json!({"turn":{"id":"turn-a","status":"inProgress"}}), 2)
        .unwrap();
    let delivery = core.snapshot.delivery.as_ref().unwrap();
    assert_eq!(delivery.status, "accepted");
    assert!(delivery.started_at_ms.is_none() && delivery.completed_at_ms.is_none());
    core.receive_notification("turn/started", &turn_event("inProgress"), 3);
    assert_eq!(core.snapshot.delivery.as_ref().unwrap().status, "started");
    core.receive_notification("turn/completed", &turn_event("completed"), 4);
    assert_eq!(core.snapshot.delivery.as_ref().unwrap().status, "completed");
}

#[test]
fn explicit_rejection_remains_known_after_transport_loss() {
    let mut core = core();
    core.snapshot.delivery.as_mut().unwrap().status = "rejected".into();
    core.connection_lost("EOF after a rejected request", 2);
    assert_eq!(core.snapshot.delivery.as_ref().unwrap().status, "rejected");
    assert!(core
        .snapshot
        .delivery
        .as_ref()
        .unwrap()
        .accepted_at_ms
        .is_none());
    assert!(!core.reserve_send("operation-a", "probe text", 3).unwrap());
}

#[test]
fn completion_before_the_response_never_regresses_to_accepted() {
    let mut core = core();
    core.receive_notification("turn/started", &turn_event("inProgress"), 2);
    core.receive_notification("turn/completed", &turn_event("completed"), 3);
    core.accept_send(&json!({"turn":{"id":"turn-a"}}), 4)
        .unwrap();
    let delivery = core.snapshot.delivery.as_ref().unwrap();
    assert_eq!(delivery.status, "completed");
    assert_eq!(delivery.started_at_ms, Some(2));
    assert_eq!(delivery.completed_at_ms, Some(3));
    assert_eq!(delivery.accepted_at_ms, Some(4));
}

#[test]
fn wrong_thread_or_turn_and_duplicate_completion_do_not_mutate_delivery() {
    let mut core = core();
    core.receive_notification(
        "turn/started",
        &json!({"threadId":"other","turn":{"id":"other"}}),
        2,
    );
    assert!(core.snapshot.delivery.as_ref().unwrap().turn_id.is_none());
    core.accept_send(&json!({"turn":{"id":"turn-a"}}), 3)
        .unwrap();
    core.receive_notification(
        "turn/completed",
        &json!({"threadId":"thread-a","turn":{"id":"other","status":"completed"}}),
        4,
    );
    assert!(core
        .snapshot
        .delivery
        .as_ref()
        .unwrap()
        .completed_at_ms
        .is_none());
    core.receive_notification("turn/completed", &turn_event("interrupted"), 5);
    core.receive_notification("turn/completed", &turn_event("completed"), 6);
    assert_eq!(
        core.snapshot.delivery.as_ref().unwrap().status,
        "interrupted"
    );
    assert_eq!(
        core.snapshot.delivery.as_ref().unwrap().completed_at_ms,
        Some(5)
    );
    assert!(core.active_turn("turn-a").is_err());
}

#[test]
fn a_response_with_another_turn_id_fails_closed() {
    let mut core = core();
    core.receive_notification("turn/started", &turn_event("inProgress"), 2);
    assert!(core
        .accept_send(&json!({"turn":{"id":"other"}}), 3)
        .is_err());
    assert!(core
        .snapshot
        .delivery
        .as_ref()
        .unwrap()
        .accepted_at_ms
        .is_none());
}

#[test]
fn unknown_status_remains_unknown_and_usage_does_not_become_a_price() {
    let mut core = core();
    core.receive_notification(
        "thread/status/changed",
        &json!({"threadId":"thread-a","status":{"type":"newState"}}),
        2,
    );
    assert_eq!(core.snapshot.agent_state, "unknown");
    core.accept_send(&json!({"turn":{"id":"turn-a"}}), 3)
        .unwrap();
    core.receive_notification(
        "thread/tokenUsage/updated",
        &json!({"threadId":"thread-a","turnId":"turn-a",
        "tokenUsage":{"total":{"totalTokens":55}}}),
        4,
    );
    core.receive_notification(
        "account/rateLimits/updated",
        &json!({"rateLimits":{"primary":{"usedPercent":20}}}),
        5,
    );
    assert_eq!(
        core.snapshot.usage.token_usage.as_ref().unwrap()["total"]["totalTokens"],
        55
    );
    assert_eq!(
        core.snapshot.usage.chatgpt_allowance.as_ref().unwrap()["primary"]["usedPercent"],
        20
    );
    assert!(
        core.snapshot.usage.api_standard_estimate_usd.is_none()
            && core.snapshot.usage.extra_cost_usd.is_none()
    );
}

#[test]
fn reply_and_event_limits_preserve_utf8_and_visible_truncation() {
    let mut core = core();
    core.accept_send(&json!({"turn":{"id":"turn-a"}}), 2)
        .unwrap();
    let delta = "\u{3042}".repeat(MAX_REPLY_BYTES);
    core.receive_notification(
        "item/agentMessage/delta",
        &json!({"threadId":"thread-a","turnId":"turn-a","delta":delta}),
        3,
    );
    assert!(core.snapshot.reply.len() <= MAX_REPLY_BYTES);
    assert!(core.snapshot.reply_truncated);
    assert!(!core.snapshot.reply.contains('\u{fffd}'));
    for _ in 0..MAX_EVENTS * 2 {
        core.record("test", "adapter", None, 4);
    }
    assert_eq!(core.snapshot.events.len(), MAX_EVENTS);
    assert!(core
        .snapshot
        .events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    assert!(validate_text(&"x".repeat(protocol::MAX_INPUT_BYTES + 1)).is_err());
    assert!(validate_text(" \n ").is_err());
    assert!(validate_id("invalid id").is_err());
}

#[test]
fn replay_the_recorded_windows_roundtrip_using_its_real_ids_and_timestamps() {
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/codex-app-server/0.160.0-roundtrip.json"
    ))
    .unwrap();
    assert_eq!(evidence["success"], true);
    assert_eq!(evidence["toolItems"], json!([]));
    let thread = evidence["threadId"].as_str().unwrap();
    let turn = evidence["turnId"].as_str().unwrap();
    let operation = evidence["operationId"].as_str().unwrap();
    let mut core = ProtocolState::default();
    core.opened_thread(
        evidence["configuration"]["requested"].clone(),
        &json!({"thread":{"id":thread},
        "model":evidence["configuration"]["effective"]["model"],"reasoningEffort":"max"}),
    )
    .unwrap();
    core.reserve_send(operation, "probe", 0).unwrap();
    for event in evidence["events"].as_array().unwrap() {
        let at = chrono::DateTime::parse_from_rfc3339(event["at"].as_str().unwrap())
            .unwrap()
            .timestamp_millis();
        if event["direction"] != "receive" {
            continue;
        }
        if event["id"] == evidence["requestId"] && event["accepted"] == true {
            core.accept_send(&json!({"turn":{"id":turn}}), at).unwrap();
        } else if event["threadId"] == thread && event["turnId"] == turn {
            let method = event["method"].as_str().unwrap_or("");
            core.receive_notification(
                method,
                &json!({"threadId":thread,"turnId":turn,
                "turn":{"id":turn,"status":event["status"]}}),
                at,
            );
        }
    }
    let delivery = core.snapshot.delivery.unwrap();
    assert_eq!(delivery.status, "completed");
    assert!(
        delivery.accepted_at_ms.is_some()
            && delivery.started_at_ms.is_some()
            && delivery.completed_at_ms.is_some()
    );
}

fn duplex_client() -> (
    Arc<Client>,
    BufReader<ReadHalf<DuplexStream>>,
    WriteHalf<DuplexStream>,
) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = split(client);
    let (server_reader, server_writer) = split(server);
    (
        Client::with_io(writer, reader, None),
        BufReader::new(server_reader),
        server_writer,
    )
}

async fn write_frame(writer: &mut WriteHalf<DuplexStream>, frame: Value) {
    let mut bytes = serde_json::to_vec(&frame).unwrap();
    bytes.push(b'\n');
    writer.write_all(&bytes).await.unwrap();
    writer.flush().await.unwrap();
}

async fn read(reader: &mut BufReader<ReadHalf<DuplexStream>>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), read_frame(reader))
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn handshake(
    reader: &mut BufReader<ReadHalf<DuplexStream>>,
    writer: &mut WriteHalf<DuplexStream>,
    version: &str,
) {
    let init = read(reader).await;
    assert_eq!(init["method"], "initialize");
    assert_eq!(init["params"], initialize_params());
    assert!(init.get("jsonrpc").is_none());
    write_frame(
        writer,
        json!({"id":init["id"],"result":{"userAgent":format!("probe/{version} (0.1.0)")}}),
    )
    .await;
    if version != PINNED_VERSION {
        return;
    }
    assert_eq!(read(reader).await["method"], "initialized");
    let start = read(reader).await;
    assert_eq!(start["method"], "thread/start");
    assert_eq!(start["params"], thread_start_params("/trial"));
    write_frame(writer, json!({"id":start["id"],"result":{"thread":{"id":"thread-a"},"model":"fixture-model","reasoningEffort":"max"}})).await;
}

async fn wait_for_status(client: &Client, status: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .core
                .lock()
                .await
                .snapshot
                .delivery
                .as_ref()
                .is_some_and(|d| d.status == status)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn transport_initializes_and_keeps_events_that_arrive_before_the_send_receipt() {
    let (client, mut reader, mut writer) = duplex_client();
    let (finished, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        handshake(&mut reader, &mut writer, PINNED_VERSION).await;
        let send = read(&mut reader).await;
        assert_eq!(
            send["params"],
            turn_start_params("thread-a", "probe", "operation-a")
        );
        write_frame(
            &mut writer,
            json!({"method":"turn/started","params":turn_event("inProgress")}),
        )
        .await;
        write_frame(
            &mut writer,
            json!({"method":"turn/completed","params":turn_event("completed")}),
        )
        .await;
        write_frame(
            &mut writer,
            json!({"id":send["id"],"result":{"turn":{"id":"turn-a"}}}),
        )
        .await;
        let _ = done.await;
    });
    client.initialize("/trial").await.unwrap();
    let response = client.send("operation-a", "probe").await.unwrap();
    assert_eq!(response["delivery"]["status"], "completed");
    assert!(response["delivery"]["acceptedAtMs"].is_number());
    assert!(response["delivery"]["startedAtMs"].is_number());
    assert_eq!(
        client.send("operation-a", "probe").await.unwrap()["duplicate"],
        true
    );
    assert!(client.pending.lock().await.is_empty());
    let _ = finished.send(());
    server.await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn transport_enforces_expected_turn_for_steer_and_waits_for_interrupt_completion() {
    let (client, mut reader, mut writer) = duplex_client();
    let (complete, wait_complete) = oneshot::channel();
    let (finished, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        handshake(&mut reader, &mut writer, PINNED_VERSION).await;
        let send = read(&mut reader).await;
        write_frame(
            &mut writer,
            json!({"id":send["id"],"result":{"turn":{"id":"turn-a"}}}),
        )
        .await;
        write_frame(
            &mut writer,
            json!({"method":"turn/started","params":turn_event("inProgress")}),
        )
        .await;
        let steer = read(&mut reader).await;
        assert_eq!(
            steer["params"],
            steer_params("thread-a", "turn-a", "additional input", "steer-a")
        );
        write_frame(
            &mut writer,
            json!({"id":steer["id"],"result":{"turnId":"turn-a"}}),
        )
        .await;
        let interrupt = read(&mut reader).await;
        assert_eq!(interrupt["params"], interrupt_params("thread-a", "turn-a"));
        write_frame(&mut writer, json!({"id":interrupt["id"],"result":{}})).await;
        let _ = wait_complete.await;
        write_frame(
            &mut writer,
            json!({"method":"turn/completed","params":turn_event("interrupted")}),
        )
        .await;
        let _ = done.await;
    });
    client.initialize("/trial").await.unwrap();
    client.send("operation-a", "probe").await.unwrap();
    wait_for_status(&client, "started").await;
    assert!(client
        .control("steer", "wrong", "stale", Some("input"))
        .await
        .is_err());
    let receipt = client
        .control("steer", "steer-a", "turn-a", Some("additional input"))
        .await
        .unwrap();
    assert_eq!(receipt["control"]["accepted"], true);
    assert_eq!(receipt["control"]["observed"], false);
    assert_eq!(
        client
            .control("steer", "steer-a", "turn-a", Some("additional input"))
            .await
            .unwrap()["duplicate"],
        true
    );
    assert!(client
        .control("steer", "steer-a", "turn-a", Some("changed"))
        .await
        .is_err());
    client
        .control("interrupt", "interrupt-a", "turn-a", None)
        .await
        .unwrap();
    assert_eq!(
        client
            .core
            .lock()
            .await
            .snapshot
            .delivery
            .as_ref()
            .unwrap()
            .status,
        "started"
    );
    let _ = complete.send(());
    wait_for_status(&client, "interrupted").await;
    assert!(client
        .control("interrupt", "another", "turn-a", None)
        .await
        .is_err());
    let _ = finished.send(());
    server.await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn unsupported_server_requests_are_rejected_and_never_approved() {
    let (client, mut reader, mut writer) = duplex_client();
    write_frame(&mut writer, json!({"id":77,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-a"}})).await;
    let response = read(&mut reader).await;
    assert_eq!(response["id"], 77);
    assert_eq!(response["error"]["code"], -32601);
    assert!(response.get("result").is_none());
    client.close().await;
}

#[tokio::test]
async fn rejected_methods_return_unsupported_without_any_fallback() {
    let (client, mut reader, mut writer) = duplex_client();
    client.core.lock().await.snapshot.thread_id = Some("thread-a".into());
    let server = tokio::spawn(async move {
        let request = read(&mut reader).await;
        assert_eq!(request["method"], "turn/start");
        write_frame(
            &mut writer,
            json!({"id":request["id"],"error":{"code":-32601,"message":"not supported"}}),
        )
        .await;
    });
    let receipt = client.send("operation-a", "probe").await.unwrap();
    assert_eq!(receipt["delivery"]["status"], "rejected");
    assert!(receipt["error"]
        .as_str()
        .unwrap()
        .starts_with("unsupported:"));
    server.await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn a_timeout_leaves_no_pending_sender_and_does_not_retry() {
    let (client, mut reader, _writer) = duplex_client();
    let request =
        client.request_with_timeout("test", "unsupported", json!({}), Duration::from_millis(10));
    let (response, frame) = tokio::join!(request, read(&mut reader));
    assert_eq!(frame["id"], "test");
    assert!(matches!(response, Err(RpcFailure::Unknown(_))));
    assert!(client.pending.lock().await.is_empty());
    client.close().await;
}

#[tokio::test]
async fn eof_marks_the_unfinished_send_unknown_without_repeating_it() {
    let (client, mut reader, writer) = duplex_client();
    client.core.lock().await.snapshot.thread_id = Some("thread-a".into());
    let server = tokio::spawn(async move {
        let _ = read(&mut reader).await;
        drop(writer);
    });
    let receipt = client.send("operation-a", "probe").await.unwrap();
    assert_eq!(receipt["delivery"]["status"], "unknown");
    assert_eq!(
        client.send("operation-a", "probe").await.unwrap()["duplicate"],
        true
    );
    assert!(client.pending.lock().await.is_empty());
    server.await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn request_deadline_includes_backpressure_while_writing_stdin() {
    let (pipe, _nonreading_server) = tokio::io::duplex(1);
    let (reader, writer) = split(pipe);
    let client = Client::with_io(writer, reader, None);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        client.request_with_timeout(
            "blocked",
            "turn/start",
            json!({"input":"cannot fit into the pipe"}),
            Duration::from_millis(10),
        ),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(RpcFailure::Unknown(_))));
    assert!(client.pending.lock().await.is_empty());
    assert!(client.closed.load(Ordering::Acquire));
    assert_eq!(
        client.core.lock().await.snapshot.process_state,
        "disconnected"
    );
    client.close().await;
}

#[tokio::test]
async fn initialize_rejects_a_different_cli_version_before_thread_start() {
    let (client, mut reader, mut writer) = duplex_client();
    let (finished, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        handshake(&mut reader, &mut writer, "0.161.0").await;
        let _ = done.await;
    });
    assert!(client
        .initialize("/trial")
        .await
        .unwrap_err()
        .starts_with("unsupported:"));
    assert!(client.core.lock().await.snapshot.thread_id.is_none());
    let _ = finished.send(());
    server.await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn disabled_state_is_readable_but_cannot_resolve_or_launch_a_process() {
    let state = CodexAppServerState::default();
    assert!(!state.snapshot().await.enabled);
    assert_eq!(state.snapshot().await.process_state, "notStarted");
    assert!(state
        .start("/does-not-exist", Some("/not-a-binary"))
        .await
        .unwrap_err()
        .contains("disabled"));
    assert!(state
        .command(ExperimentCommand {
            operation: "resume".into(),
            operation_id: "r".into(),
            expected_turn_id: None,
            text: None
        })
        .await
        .unwrap_err()
        .starts_with("unsupported:"));
    state.set_enabled(true).await;
    assert_eq!(state.snapshot().await.process_state, "notStarted");
    state.set_enabled(false).await;
    assert!(!state.snapshot().await.enabled);
}

#[tokio::test]
async fn frame_reader_rejects_truncation_invalid_json_and_oversized_frames() {
    for input in [
        b"{".to_vec(),
        b"not-json\n".to_vec(),
        vec![b'x'; MAX_FRAME_BYTES + 1],
    ] {
        let mut reader = BufReader::new(std::io::Cursor::new(input));
        assert!(read_frame(&mut reader).await.is_err());
    }
    let mut reader = BufReader::new(std::io::Cursor::new(b"{\"id\":\"ok\"}\r\n"));
    assert_eq!(read_frame(&mut reader).await.unwrap().unwrap()["id"], "ok");
    assert!(read_frame(&mut reader).await.unwrap().is_none());
}

#[test]
fn transcript_normalization_keeps_the_product_capability_identity() {
    let adapter = crate::livebrief::AgentAdapter::new("claude-codex").unwrap();
    assert_eq!(adapter.capabilities().agent, "claude-codex");
}

#[test]
fn resolution_rejects_shell_or_node_shims_before_any_process_is_launched() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    });
    std::fs::write(&path, b"#!/usr/bin/env node\nlaunch_an_unowned_child()\n").unwrap();
    assert!(!is_native_executable(&path));
    assert!(resolve_codex(Some(path.to_str().unwrap()))
        .unwrap_err()
        .starts_with("unsupported:"));
    let native_header = if cfg!(target_os = "windows") {
        [b'M', b'Z', 0, 0]
    } else if cfg!(target_os = "macos") {
        [0xcf, 0xfa, 0xed, 0xfe]
    } else {
        *b"\x7fELF"
    };
    std::fs::write(&path, native_header).unwrap();
    assert!(is_native_executable(&path));
    assert_eq!(resolve_codex(Some(path.to_str().unwrap())).unwrap(), path);
    std::fs::write(&path, b"MZ").unwrap();
    assert!(!is_native_executable(&path));
}
