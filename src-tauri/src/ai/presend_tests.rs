use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn valid_output() -> String {
    format!(
        "{}: read\n{}: assumption\n{}: missing",
        LABELS[0], LABELS[1], LABELS[2]
    )
}

#[test]
fn environment_excludes_billing_keys_and_mycmux_even_with_mixed_case() {
    let names = [
        "ANTHROPIC_API_KEY",
        "anthropic_auth_token",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "codex_api_key",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "MYCMUX_TOKEN",
        "mycmux_tab_id",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "KEEP",
    ];
    let env = child_env(
        names
            .into_iter()
            .map(|name| (name.to_string(), "dummy".to_string())),
    );
    assert_eq!(
        env,
        HashMap::from([("KEEP".to_string(), "dummy".to_string())])
    );
}

#[test]
fn claude_uses_the_warm_non_persistent_tool_free_subscription_route() {
    let args = Provider::Claude.args();
    for arg in [
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
    ] {
        assert!(args.iter().any(|value| value == arg));
    }
    assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--input-format", "stream-json"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--output-format", "stream-json"]));
    // An explicitly empty list excludes settings even in a user-writable cwd.
    assert!(args.iter().any(|value| value == "--setting-sources="));
    assert!(!args.iter().any(|value| value == "--setting-sources"));
    assert!(args.windows(2).any(|pair| pair == ["--effort", "low"]));
    assert!(!args.iter().any(|value| value == "--bare"));
    assert_eq!(Provider::Claude.timeout(), Duration::from_secs(15));
}

#[test]
fn codex_is_ephemeral_and_does_not_change_existing_ai_args() {
    let args = Provider::Codex.args();
    assert!(args.iter().any(|value| value == "--ephemeral"));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--sandbox", "read-only"]));
    assert!(args.iter().any(|value| value == "--skip-git-repo-check"));
    assert!(args.iter().any(|value| value == "--ignore-user-config"));
    assert!(args.iter().any(|value| value == "features.fast_mode=false"));
    assert_eq!(args.last().unwrap(), "-");
    assert_eq!(Provider::Codex.timeout(), Duration::from_secs(20));
    let legacy = super::super::AiConfig::default().args();
    assert!(!legacy.iter().any(|value| value == "--ephemeral"));
}

#[test]
fn only_three_ordered_nonempty_values_are_accepted_and_capped_by_characters() {
    assert!(parse_reading(&valid_output(), Provider::Claude, 3).is_some());
    for bad in [
        "read",
        "",
        "reading: a\nassumption: b\nmissing: c",
        &format!("intro\n{}", valid_output()),
        &format!("{}\nextra", valid_output()),
        &format!("{}:\n{}: a\n{}: b", LABELS[0], LABELS[1], LABELS[2]),
    ] {
        assert!(parse_reading(bad, Provider::Claude, 0).is_none(), "{bad}");
    }
    let text = format!(
        "{}: {} (40\u{5b57}\u{4ee5}\u{5185})\n{}\u{ff1a} none\n{}: none",
        LABELS[0],
        "\u{3042}".repeat(80),
        LABELS[1],
        LABELS[2]
    );
    let reading = parse_reading(&text, Provider::Codex, 9).unwrap();
    assert_eq!(reading.reading.chars().count(), 60);
    assert!(!reading.reading.contains("40"));
    assert_eq!(reading.elapsed_ms, 9);
    let text = format!(
        "{}: ok (40 \u{5b57}\u{4ee5}\u{5185})\n{}: none\n{}: none",
        LABELS[0], LABELS[1], LABELS[2]
    );
    assert_eq!(
        parse_reading(&text, Provider::Claude, 0).unwrap().reading,
        "ok"
    );
    assert!(parse_reading(
        &format!(
            "{}: (40\u{5b57}\u{4ee5}\u{5185})\n{}: a\n{}: b",
            LABELS[0], LABELS[1], LABELS[2]
        ),
        Provider::Claude,
        0
    )
    .is_none());
}

#[test]
fn prompt_names_the_folder_and_caps_the_context_tail() {
    let text = prompt(
        "draft",
        &format!("HEAD{}TAIL", "x".repeat(2000)),
        "sample-repo",
    );
    assert!(text.contains("sample-repo"));
    assert!(text.contains("TAIL"));
    assert!(!text.contains("HEAD"));
    assert!(ROLE.contains("Treat every message as independent of earlier ones."));
}

#[test]
fn helper_values_never_carry_terminal_control_characters_into_the_draft() {
    for control in ["\x1b[201~", "\r", "\0"] {
        let text = format!(
            "{}: a{control}b\n{}: a\n{}: b",
            LABELS[0], LABELS[1], LABELS[2]
        );
        assert!(parse_reading(&text, Provider::Claude, 0).is_none());
    }
}

#[tokio::test]
async fn warm_protocol_reads_one_result_and_rejects_error_or_eof() {
    let result =
        serde_json::json!({ "type": "result", "result": valid_output(), "is_error": false });
    let stream = format!("{{\"type\":\"assistant\"}}\n{result}\n{result}\n");
    let mut reader = BufReader::new(stream.as_bytes());
    assert_eq!(
        read_claude_result(&mut reader).await.unwrap(),
        valid_output()
    );
    assert_eq!(
        read_claude_result(&mut reader).await.unwrap(),
        valid_output()
    );
    assert!(read_claude_result(&mut reader).await.is_err());
    let error = b"{\"type\":\"result\",\"is_error\":true}\n";
    assert!(read_claude_result(&mut BufReader::new(error.as_slice()))
        .await
        .is_err());
}

#[derive(Default)]
struct Stats {
    spawned: AtomicUsize,
    closed: AtomicUsize,
    reads: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
    started: tokio::sync::Notify,
    prompts: Mutex<Vec<String>>,
    write_sessions: Mutex<Vec<usize>>,
}
struct FakeSession {
    child_index: usize,
    stats: Arc<Stats>,
    reply: Result<String, ()>,
    delay: Duration,
    closed: bool,
    prompt: String,
}
struct Active(Arc<Stats>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Session for FakeSession {
    fn write<'a>(&'a mut self, prompt: &'a str) -> Operation<'a, Result<(), ()>> {
        Box::pin(async move {
            self.prompt = prompt.to_string();
            self.stats.prompts.lock().unwrap().push(self.prompt.clone());
            self.stats.write_sessions.lock().unwrap().push(self.child_index);
            Ok(())
        })
    }
    fn read(&mut self) -> Operation<'_, Result<String, ()>> {
        Box::pin(async move {
            self.stats.reads.fetch_add(1, Ordering::SeqCst);
            let active = self.stats.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.stats.max_active.fetch_max(active, Ordering::SeqCst);
            let _active = Active(self.stats.clone());
            self.stats.started.notify_one();
            tokio::time::sleep(self.delay).await;
            self.reply
                .clone()
                .map(|value| value.replace("{request}", &self.prompt))
        })
    }
    fn close(&mut self) -> Operation<'_, ()> {
        Box::pin(async move {
            if !self.closed {
                self.stats.closed.fetch_add(1, Ordering::SeqCst);
                self.closed = true;
            }
        })
    }
}
fn fake(
    reply: Result<String, ()>,
    delay: Duration,
    timeout: Option<Duration>,
) -> (PresendService, Arc<Stats>) {
    let stats = Arc::new(Stats::default());
    let factory_stats = stats.clone();
    let service = PresendService::new(
        Arc::new(move |_| {
            let child_index = factory_stats.spawned.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeSession {
                child_index,
                stats: factory_stats.clone(),
                reply: reply.clone(),
                delay,
                closed: false,
                prompt: String::new(),
            }))
        }),
        Arc::new(OwnedProcesses::default()),
        IDLE_TIMEOUT,
        timeout,
    );
    (service, stats)
}
fn count(value: &AtomicUsize) -> usize {
    value.load(Ordering::SeqCst)
}
fn tab_owner(window: &str, session_id: &str) -> ReadingOwner {
    ReadingOwner {
        window: window.to_owned(),
        session_id: session_id.to_owned(),
        pty_generation: Some(1),
    }
}

async fn read(service: &PresendService, id: &str, provider: Provider) -> Option<Reading> {
    service
        .read(id.to_owned(), provider, tab_owner("main", "tab"), || id.to_owned(), || true, std::future::ready(true))
        .await
}

#[tokio::test]
async fn default_off_never_starts_a_process() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    assert!(read(&service, "off", Provider::Claude).await.is_none());
    assert_eq!(count(&stats.spawned), 0);
}

#[tokio::test]
async fn cancellation_before_async_ipc_registration_prevents_a_late_spawn() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    service.cancel("not-started-yet");
    assert!(read(&service, "not-started-yet", Provider::Claude)
        .await
        .is_none());
    assert_eq!(count(&stats.spawned), 0);
}

#[tokio::test]
async fn claude_context_is_reused_only_by_the_same_tab_in_the_same_window() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;

    async fn read_from(
        service: &PresendService,
        request: &str,
        window: &str,
        session: &str,
        draft: &str,
    ) -> Option<Reading> {
        service
            .read_request(
                true,
                request.into(),
                Provider::Claude,
                tab_owner(window, session),
                draft,
                || "",
                Workdir::Path("example-folder"),
                || true,
                std::future::ready(true),
            )
            .await
    }

    for (request, window, session, draft, spawned, closed) in [
        ("a-1", "window-one", "tab-a", "First owner's first draft", 1, 0),
        ("a-2", "window-one", "tab-a", "First owner's next draft", 1, 0),
        ("b-1", "window-one", "tab-b", "Second owner's draft", 2, 1),
        ("a-3", "window-one", "tab-a", "First owner's return draft", 3, 2),
        ("a-4", "window-two", "tab-a", "Other window's draft", 4, 3),
    ] {
        assert!(read_from(&service, request, window, session, draft).await.is_some());
        assert_eq!(count(&stats.spawned), spawned, "{request}");
        assert_eq!(count(&stats.closed), closed, "{request}");
    }
    let write_sessions = stats.write_sessions.lock().unwrap();
    let prompts = stats.prompts.lock().unwrap();
    assert_eq!(*write_sessions, vec![0, 0, 1, 2, 3]);
    let tab_b_inputs: Vec<_> = write_sessions
        .iter()
        .zip(prompts.iter())
        .filter_map(|(&child, prompt)| (child == 1).then_some(prompt))
        .collect();
    assert_eq!(tab_b_inputs.len(), 1);
    assert!(tab_b_inputs[0].contains("Second owner's draft"));
    assert!(!tab_b_inputs[0].contains("First owner's"));
    for prompt in prompts.iter() {
        assert!(!prompt.contains("window-one"));
        assert!(!prompt.contains("window-two"));
        assert!(!prompt.contains("tab-a"));
        assert!(!prompt.contains("tab-b"));
    }
}

#[tokio::test]
async fn claude_context_follows_pty_generation_and_never_reuses_unknown_owner() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    for (index, (generation, child, closed)) in [
        (Some(91), 0, 0),
        (Some(91), 0, 0),
        (Some(92), 1, 1),
        (Some(92), 1, 1),
        (None, 2, 3),
        (None, 3, 4),
        (Some(92), 4, 4),
    ]
    .into_iter()
    .enumerate()
    {
        let mut owner = tab_owner("main", "same-pty");
        owner.pty_generation = generation;
        assert!(service
            .read_request(
                true,
                format!("request-{index}"),
                Provider::Claude,
                owner,
                &format!("draft-{index}"),
                || "",
                Workdir::Path("example-folder"),
                || true,
                std::future::ready(true),
            )
            .await
            .is_some());
        assert_eq!(stats.write_sessions.lock().unwrap()[index], child, "request-{index}");
        assert_eq!(count(&stats.closed), closed, "request-{index}");
    }
}

#[tokio::test]
async fn changed_pty_generation_is_rejected_before_writing_to_a_warm_child() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "warm", Provider::Claude).await.is_some());

    let result = service
        .read(
            "retired".to_owned(),
            Provider::Claude,
            tab_owner("main", "tab"),
            || "draft from the old PTY".to_owned(),
            || false,
            std::future::ready(true),
        )
        .await;
    assert!(result.is_none());
    assert_eq!(*stats.write_sessions.lock().unwrap(), vec![0]);
    assert_eq!(count(&stats.closed), 1);
}

#[tokio::test]
async fn warm_claude_closes_after_twenty_and_restarts_on_the_next_request() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    for index in 0..20 {
        assert!(read(&service, &index.to_string(), Provider::Claude)
            .await
            .is_some());
    }
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 1);
    assert!(read(&service, "next", Provider::Claude).await.is_some());
    assert_eq!(count(&stats.spawned), 2);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn warm_claude_closes_at_five_idle_minutes_but_not_before() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "first", Provider::Claude).await.is_some());
    let last = service.0.engine.lock().await.last_used.unwrap();
    service
        .expire_idle_at(last + Duration::from_secs(299))
        .await;
    assert_eq!(count(&stats.closed), 0);
    service
        .expire_idle_at(last + Duration::from_secs(300))
        .await;
    assert_eq!(count(&stats.closed), 1);
}

#[tokio::test]
async fn errors_and_invalid_output_close_without_retry() {
    for reply in [Err(()), Ok("wrong shape".to_string())] {
        let (service, stats) = fake(reply, Duration::ZERO, None);
        service.configure(true, Provider::Claude).await;
        assert!(read(&service, "bad", Provider::Claude).await.is_none());
        assert_eq!(count(&stats.closed), 1);
        assert_eq!(count(&stats.reads), 1);
    }
}

#[tokio::test]
async fn timeout_closes_and_does_not_retry() {
    let (service, stats) = fake(
        Ok(valid_output()),
        Duration::from_secs(30),
        Some(Duration::from_millis(5)),
    );
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "timeout", Provider::Claude).await.is_none());
    assert_eq!(count(&stats.closed), 1);
    assert_eq!(count(&stats.reads), 1);
    assert_eq!(count(&stats.active), 0);
}

#[tokio::test]
async fn provider_changes_and_setting_off_close_the_warm_process() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "claude", Provider::Claude).await.is_some());
    service.configure(true, Provider::Codex).await;
    assert_eq!(count(&stats.closed), 1);
    assert!(read(&service, "stale-provider", Provider::Claude)
        .await
        .is_none());
    assert!(read(&service, "codex", Provider::Codex).await.is_some());
    assert_eq!(count(&stats.closed), 2);
    assert!(read(&service, "codex-again", Provider::Codex)
        .await
        .is_some());
    assert_eq!(count(&stats.spawned), 3);
    assert_eq!(count(&stats.closed), 3);
    service.configure(false, Provider::Codex).await;
    assert!(read(&service, "off", Provider::Codex).await.is_none());
}

#[tokio::test]
async fn new_requests_discard_the_running_and_queued_results_and_never_overlap() {
    let (service, stats) = fake(Ok(valid_output()), Duration::from_millis(20), None);
    service.configure(true, Provider::Claude).await;
    let first_service = service.clone();
    let first = tokio::spawn(async move { read(&first_service, "old", Provider::Claude).await });
    stats.started.notified().await;
    let (middle, newest) = tokio::join!(
        read(&service, "middle", Provider::Claude),
        read(&service, "newest", Provider::Claude)
    );
    assert!(first.await.unwrap().is_none());
    assert!(middle.is_none());
    assert!(newest.is_some());
    assert_eq!(count(&stats.max_active), 1);
    assert_eq!(count(&stats.reads), 2);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn request_cancellation_and_exit_drop_running_results() {
    for exit in [false, true] {
        let (service, stats) = fake(Ok(valid_output()), Duration::from_millis(20), None);
        service.configure(true, Provider::Claude).await;
        let active = service.clone();
        let running = tokio::spawn(async move { read(&active, "active", Provider::Claude).await });
        stats.started.notified().await;
        if exit {
            service.shutdown();
        } else {
            service.cancel("active");
        }
        assert!(running.await.unwrap().is_none());
        assert_eq!(count(&stats.closed), usize::from(exit));
        assert_eq!(count(&stats.active), 0);
        if !exit {
            service.configure(false, Provider::Claude).await;
        }
        if exit {
            assert!(service.0.owned.0.lock().unwrap().0);
            assert!(read(&service, "after-exit", Provider::Claude)
                .await
                .is_none());
        }
    }
}

#[tokio::test]
async fn disabling_or_switching_provider_discards_a_running_result() {
    for next_provider in [Provider::Claude, Provider::Codex] {
        let (service, stats) = fake(Ok(valid_output()), Duration::from_secs(30), None);
        service.configure(true, Provider::Claude).await;
        let active = service.clone();
        let running = tokio::spawn(async move { read(&active, "active", Provider::Claude).await });
        stats.started.notified().await;
        service
            .configure(next_provider == Provider::Codex, next_provider)
            .await;
        assert!(running.await.unwrap().is_none());
        assert_eq!(count(&stats.closed), 1);
        assert_eq!(count(&stats.active), 0);
    }
}

#[test]
fn real_command_builder_applies_env_cwd_and_arguments_without_spawn() {
    let removed = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CODEX_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "MYCMUX_TOKEN",
    ];
    for provider in [Provider::Claude, Provider::Codex] {
        let values = removed
            .into_iter()
            .chain(["KEEP"])
            .map(|key| (key.to_string(), "synthetic".to_string()));
        let cmd = command(provider, values).unwrap();
        let keys: Vec<_> = cmd
            .as_std()
            .get_envs()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert_eq!(keys, vec!["KEEP"]);
        assert_eq!(
            cmd.as_std().get_current_dir(),
            Some(
                crate::test_profile::runtime_dir()
                    .unwrap()
                    .join("ai-cwd")
                    .as_path()
            )
        );
        let args = cmd
            .as_std()
            .get_args()
            .map(|v| v.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(args.contains(if provider == Provider::Claude {
            super::super::PRESEND_CLAUDE_MODEL
        } else {
            super::super::PRESEND_CODEX_MODEL
        }));
        assert!(args.contains(if provider == Provider::Claude {
            "--no-session-persistence"
        } else {
            "--ephemeral"
        }));
    }
}

#[test]
fn shared_credential_fixture_covers_five_case_forms_for_every_key() {
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/presend_credentials.json"
    )).unwrap();
    assert_eq!(table["credentialKeys"], serde_json::json!(credentials::CREDENTIAL_KEYS));
    let cases = table["cases"].as_array().unwrap();
    for key in credentials::CREDENTIAL_KEYS {
        let forms = [
            key.to_string(), key.to_ascii_uppercase(),
            format!("{}{}", key[..1].to_ascii_uppercase(), &key[1..]),
            format!("{}{}{}", &key[..1], key[1..2].to_ascii_uppercase(), &key[2..]),
            key.chars().enumerate().map(|(i, c)| {
                if i % 2 == 0 { c.to_ascii_uppercase() } else { c }
            }).collect(),
        ];
        for (i, form) in forms.iter().enumerate() {
            let name = format!("credential-key-case-{key}-{i}");
            let row = cases.iter().find(|row| row["name"] == name).unwrap();
            assert_eq!(row["inputParts"], serde_json::json!([format!("{form}=demo-value")]));
            assert_eq!(row["expectedParts"], serde_json::json!([format!("{form}=[credential omitted]")]));
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialExample {
    name: String,
    input_parts: Vec<String>,
    expected_parts: Vec<String>,
    jev_parts: Vec<String>,
    secret: Option<String>,
}

fn credential_examples() -> Vec<CredentialExample> {
    #[derive(serde::Deserialize)]
    struct Table {
        cases: Vec<CredentialExample>,
    }
    let table: Table = serde_json::from_str(include_str!(
        "../../../tests/fixtures/presend_credentials.json"
    ))
    .unwrap();
    table.cases
}

#[test]
fn renderer_and_backend_share_all_synthetic_credential_examples() {
    let cases = credential_examples();
    assert!(cases.len() >= 50);
    for row in cases {
        let input = row.input_parts.concat();
        let expected = row.expected_parts.concat();
        assert_eq!(credentials::scrub(&input), expected, "{}", row.name);
        assert_eq!(
            credentials::legacy(&input),
            row.jev_parts.concat(),
            "{}",
            row.name
        );
        assert_eq!(credentials::scrub(&expected), expected, "{}", row.name);
    }
}

#[test]
fn redacts_synthetic_authorization_secrets_in_the_fb1363b54_comparison() {
    let mut checked = 0;
    for row in credential_examples() {
        let Some(secret) = row.secret.as_deref() else {
            continue;
        };
        let input = row.input_parts.concat();
        assert!(input.contains(secret), "fixture secret missing: {}", row.name);
        assert!(!credentials::scrub(&input).contains(secret), "{}", row.name);
        checked += 1;
    }
    assert!(checked >= 14);
}

#[test]
fn keeps_every_base_credential_match_in_the_shared_assignment_name_table() {
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/presend_credentials.json"
    ))
    .unwrap();
    let keys = table["credentialKeys"].as_array().unwrap();
    let matches_parts = |name: &str| {
        let lower = name.to_ascii_lowercase();
        let parts: Vec<_> = lower.split(['_', '-']).collect();
        parts.iter().any(|part| keys.iter().any(|key| key == *part))
            || parts.windows(2).any(|pair| {
                let joined = format!("{}_{}", pair[0], pair[1]);
                keys.iter().any(|key| key == joined.as_str())
            })
    };
    let mut names_checked = 0;
    for row in table["cases"].as_array().unwrap() {
        let input: String = row["inputParts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part.as_str().unwrap())
            .collect();
        let Some(name) = input.strip_suffix("=demo-value").filter(|name| {
            !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        }) else {
            continue;
        };
        names_checked += 1;
        let mut base_camel_case = String::new();
        let mut previous = b'_';
        for byte in name.bytes() {
            if byte.is_ascii_uppercase() && (previous.is_ascii_lowercase() || previous.is_ascii_digit()) {
                base_camel_case.push('_');
            }
            base_camel_case.push(char::from(byte));
            previous = byte;
        }
        if matches_parts(name) || matches_parts(&base_camel_case) {
            assert_eq!(credentials::scrub(&input), format!("{name}=[credential omitted]"), "{name}");
        }
    }
    assert!(names_checked > 50);
}

#[test]
fn prompt_uses_the_measured_japanese_keys_and_first_request_sentinel() {
    let text = prompt("draft", "", "example-folder");
    let state: serde_json::Value =
        serde_json::from_str(text.rsplit("\n\n").next().unwrap().trim()).unwrap();
    assert_eq!(state["\u{76f4}\u{524d}\u{306e}\u{3084}\u{308a}\u{3068}\u{308a}"], "(\u{306a}\u{3057}\u{3002}\u{3053}\u{306e}\u{5e2d}\u{306e}\u{6700}\u{521d}\u{306e}\u{4f9d}\u{983c})");
    assert_eq!(
        state["\u{66f8}\u{304d}\u{304b}\u{3051}\u{306e}\u{4f9d}\u{983c}"],
        "draft"
    );
    assert_eq!(
        state["\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}"],
        "example-folder"
    );
    assert!(state.get("previousReply").is_none());
}

#[tokio::test]
async fn global_ai_off_never_spawns_and_also_closes_an_existing_warm_child() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    assert!(service
        .read_request(
            false,
            "disabled".into(),
            Provider::Claude,
            tab_owner("main", "tab"),
            "draft",
            || "",
            Workdir::Path("folder"),
            || true,
            std::future::ready(true),
        )
        .await
        .is_none());
    assert_eq!(count(&stats.spawned), 0);
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "warm", Provider::Claude).await.is_some());
    assert!(service
        .read_request(
            false,
            "disabled-again".into(),
            Provider::Claude,
            tab_owner("main", "tab"),
            "draft",
            || "",
            Workdir::Path("folder"),
            || true,
            std::future::ready(true),
        )
        .await
        .is_none());
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 1);
}

#[tokio::test]
async fn cancellation_drains_old_result_and_reuses_claude_for_the_new_request() {
    let (service, stats) = fake(
        Ok(valid_output().replacen("read", "{request}", 1)),
        Duration::from_millis(20),
        None,
    );
    service.configure(true, Provider::Claude).await;
    let old_service = service.clone();
    let old = tokio::spawn(async move { read(&old_service, "old", Provider::Claude).await });
    stats.started.notified().await;
    service.cancel("old");
    let new = read(&service, "new", Provider::Claude).await.unwrap();
    assert!(old.await.unwrap().is_none());
    assert_eq!(new.reading, "new");
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 0);
    assert_eq!(count(&stats.max_active), 1);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn draining_obeys_the_original_deadline_and_restarts_only_after_timeout() {
    let (service, stats) = fake(
        Ok(valid_output()),
        Duration::from_secs(30),
        Some(Duration::from_millis(5)),
    );
    service.configure(true, Provider::Claude).await;
    let old_service = service.clone();
    let old = tokio::spawn(async move { read(&old_service, "old", Provider::Claude).await });
    stats.started.notified().await;
    service.cancel("old");
    assert!(old.await.unwrap().is_none());
    assert_eq!(count(&stats.closed), 1);
    assert!(read(&service, "next", Provider::Claude).await.is_none());
    assert_eq!(count(&stats.spawned), 2);
}

#[tokio::test]
async fn output_cap_is_per_request_and_non_json_lines_are_skipped() {
    let status = serde_json::json!({"type":"system","data":"x".repeat(100_000)});
    let result = serde_json::json!({"type":"result","result":valid_output()});
    let stream = format!("{status}\n{result}\n").repeat(12);
    assert!(stream.len() > MAX_OUTPUT_BYTES as usize);
    let mut reader = BufReader::new(stream.as_bytes());
    for _ in 0..12 {
        assert_eq!(
            read_claude_result(&mut reader).await.unwrap(),
            valid_output()
        );
    }
    let oversized = format!("{}\n", "x".repeat(MAX_OUTPUT_BYTES as usize + 1));
    assert!(
        read_claude_result(&mut BufReader::new(oversized.as_bytes()))
            .await
            .is_err()
    );
    let with_noise = format!("startup notice\n{{broken}}\n\n42\n{status}\n{result}\n");
    assert_eq!(
        read_claude_result(&mut BufReader::new(with_noise.as_bytes()))
            .await
            .unwrap(),
        valid_output()
    );
    assert!(
        read_claude_result(&mut BufReader::new(b"{broken}\n".as_slice()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn direct_backend_request_scrubs_draft_and_excerpt_before_the_session_reads_them() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let draft = "password=fake-draft-value";
    let token = ["sk-ant-", "fake-reply-token"].concat();
    let excerpt = format!("before {token} after");
    assert!(service
        .read_request(
            true,
            "direct".into(),
            Provider::Claude,
            tab_owner("main", "tab"),
            draft,
            || excerpt.as_str(),
            Workdir::Path("folder"),
            || true,
            std::future::ready(true),
        )
        .await
        .is_some());
    let sent = stats.prompts.lock().unwrap()[0].clone();
    assert!(!sent.contains("fake-draft-value") && !sent.contains(&token));
    let state: serde_json::Value =
        serde_json::from_str(sent.rsplit("\n\n").next().unwrap().trim()).unwrap();
    assert_eq!(
        state["\u{66f8}\u{304d}\u{304b}\u{3051}\u{306e}\u{4f9d}\u{983c}"],
        "password=[credential omitted]"
    );
    assert_eq!(
        state["\u{76f4}\u{524d}\u{306e}\u{3084}\u{308a}\u{3068}\u{308a}"],
        "before [credential omitted] after"
    );
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn read_request_scrubs_nested_assignments_and_renderer_output() {
    assert_scrubbed_read_requests("nested-assignment-").await;
}

#[tokio::test]
async fn read_request_scrubs_url_userinfo_and_renderer_output() {
    assert_scrubbed_read_requests("url-userinfo-").await;
}

async fn assert_scrubbed_read_requests(prefix: &str) {
    let examples: Vec<_> = credential_examples()
        .into_iter()
        .filter(|row| row.name.starts_with(prefix))
        .collect();
    assert!(!examples.is_empty());
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    for row in &examples {
        let input = row.input_parts.concat();
        // The renderer fixture test verifies the exact bytes passed here as its output.
        let renderer_output = row.expected_parts.concat();
        assert!(
            service
                .read_request(
                    true,
                    row.name.clone(),
                    Provider::Claude,
                    tab_owner("main", "tab"),
                    &input,
                    || renderer_output.as_str(),
                    Workdir::Path("toy-folder"),
                    || true,
                    std::future::ready(true),
                )
                .await
                .is_some(),
            "{}",
            row.name
        );
    }
    let prompts = stats.prompts.lock().unwrap();
    assert_eq!(prompts.len(), examples.len());
    for (sent, row) in prompts.iter().zip(&examples) {
        let state: serde_json::Value =
            serde_json::from_str(sent.rsplit("\n\n").next().unwrap().trim()).unwrap();
        let expected = row.expected_parts.concat();
        assert_eq!(
            state["\u{66f8}\u{304d}\u{304b}\u{3051}\u{306e}\u{4f9d}\u{983c}"],
            expected,
            "{}: direct draft",
            row.name
        );
        assert_eq!(
            state["\u{76f4}\u{524d}\u{306e}\u{3084}\u{308a}\u{3068}\u{308a}"],
            expected,
            "{}: renderer output",
            row.name
        );
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresendWireExample {
    generation: u64,
    agent_started_at: u64,
    request: PresendReadingRequest,
    workdir_cases: Vec<WireWorkdirExample>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWorkdirExample {
    workdir_name: String,
}

fn presend_wire_example() -> PresendWireExample {
    serde_json::from_str(include_str!("../../../tests/fixtures/presend_reading_request.json")).unwrap()
}

async fn read_wire_example(
    service: &PresendService,
    example: PresendWireExample,
    observed_generation: u64,
) -> Option<Reading> {
    service
        .read_renderer_request(
            true,
            "toy-window",
            example.request,
            Some(observed_generation),
            || {
                Some(crate::pty::manager::TrustedAgentIdentity {
                    session_epoch: observed_generation,
                    kind: "claude".into(),
                    session_id: "toy-conversation".into(),
                    agent_pid: 1,
                    agent_started_at: example.agent_started_at,
                    from_hook: true,
                })
            },
            || true,
            std::future::ready(None),
        )
        .await
}

async fn renderer_foreground_request(foreground: Option<bool>) -> (bool, usize, usize) {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let request = serde_json::from_value(serde_json::json!({
        "requestId": "toy-request",
        "sessionId": "toy-pty",
        "ptyGeneration": 7,
        "provider": "claude",
        "draft": "synthetic draft for the same PTY",
        "conversationExcerpt": "synthetic prior reply",
        "replySource": {
            "ptyGeneration": 7,
            "agentKind": "codex",
            "agentSessionId": "toy-conversation",
            "occurredAt": 20_000
        },
        "workdirName": "toy-folder",
        "requireForegroundAgent": true
    })).unwrap();
    let result = service.read_renderer_request(
        true,
        "toy-window",
        request,
        Some(7),
        || Some(crate::pty::manager::TrustedAgentIdentity {
            session_epoch: 7,
            kind: "codex".into(),
            session_id: "toy-conversation".into(),
            agent_pid: 42,
            agent_started_at: 10,
            from_hook: false,
        }),
        || true,
        std::future::ready(foreground),
    ).await;
    let writes = stats.write_sessions.lock().unwrap().len();
    (result.is_some(), count(&stats.spawned), writes)
}

#[tokio::test]
async fn renderer_ipc_drops_a_draft_after_codex_exits_before_the_next_observation() {
    assert_eq!(renderer_foreground_request(Some(false)).await, (false, 0, 0));
}

#[tokio::test]
async fn renderer_ipc_drops_a_draft_if_the_foreground_cannot_be_confirmed() {
    assert_eq!(renderer_foreground_request(None).await, (false, 0, 0));
}

#[tokio::test]
async fn renderer_ipc_writes_once_if_the_foreground_agent_is_confirmed() {
    assert_eq!(renderer_foreground_request(Some(true)).await, (true, 1, 1));
}

#[tokio::test]
async fn command_forwards_foreground_requirement_before_spawning_or_writing() {
    for (required, expected) in [(Some(true), (false, 0, 0)), (None, (true, 1, 1))] {
        let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
        let mut request = presend_wire_example().request;
        request.pty_generation = None;
        request.require_foreground_agent = required;
        service.configure(true, request.provider).await;

        // No AppState is available, so the production check cannot confirm an agent.
        let result = read_presend_from_command(&service, || true, "toy-window", request, None).await;
        let writes = stats.write_sessions.lock().unwrap().len();
        assert_eq!(
            (result.is_some(), count(&stats.spawned), writes),
            expected,
            "require_foreground_agent={required:?}"
        );
    }
}

struct FakeForegroundSession {
    observation: Mutex<Option<(u64, Option<u32>)>>,
    running: AtomicBool,
}

impl FakeForegroundSession {
    fn new(observation: Option<(u64, Option<u32>)>) -> Arc<Self> {
        Arc::new(Self {
            observation: Mutex::new(observation),
            running: AtomicBool::new(true),
        })
    }

    fn intervention_observation(&self, _: &str) -> Option<(u64, u64, Option<u32>)> {
        self.observation.lock().unwrap().map(|(epoch, root)| (epoch, 0, root))
    }

    fn session_observation(&self, _: &str) -> Option<(u64, Option<u64>)> {
        self.observation.lock().unwrap().map(|(epoch, _)| (epoch, None))
    }

    fn is_running(&self, _: &str) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

async fn check_fake_foreground(
    session: &Arc<FakeForegroundSession>,
    detect: impl FnOnce(u32) -> Option<bool> + Send + 'static,
    timeout: Duration,
) -> Option<bool> {
    confirm_foreground_agent(
        Some((session, "toy-pty")),
        Some(7),
        FakeForegroundSession::intervention_observation,
        FakeForegroundSession::session_observation,
        FakeForegroundSession::is_running,
        detect,
        timeout,
        crate::diag::log,
    )
    .await
}

#[tokio::test]
async fn foreground_check_skips_probe_on_generation_mismatch_or_missing_pty_pid() {
    for (observation, case) in [
        (Some((8, Some(42))), "generation mismatch"),
        (None, "missing PTY"),
        (Some((7, None)), "missing root PID"),
    ] {
        let session = FakeForegroundSession::new(observation);
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded_calls = Arc::clone(&calls);
        let result = check_fake_foreground(
            &session,
            move |_| {
                recorded_calls.fetch_add(1, Ordering::SeqCst);
                Some(true)
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result, None, "{case}");
        assert_eq!(count(&calls), 0, "{case}");
    }
}

#[tokio::test]
async fn foreground_check_preserves_probe_result_and_passes_root_pid() {
    for expected in [None, Some(false), Some(true)] {
        let session = FakeForegroundSession::new(Some((7, Some(42))));
        let (report_pid, mut reported_pid) = tokio::sync::oneshot::channel();
        let result = check_fake_foreground(
            &session,
            move |pid| {
                let _ = report_pid.send(pid);
                expected
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result, expected);
        assert_eq!(reported_pid.try_recv().unwrap(), 42);
    }
}

#[tokio::test]
async fn foreground_check_rejects_generation_change_or_pty_exit_during_probe() {
    for (observation, running) in [(Some((8, Some(42))), true), (Some((7, Some(42))), false)] {
        let session = FakeForegroundSession::new(Some((7, Some(42))));
        let changed_session = Arc::clone(&session);
        let result = check_fake_foreground(
            &session,
            move |_| {
                *changed_session.observation.lock().unwrap() = observation;
                changed_session.running.store(running, Ordering::SeqCst);
                Some(true)
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result, None);
        assert_eq!(*session.observation.lock().unwrap(), observation);
        assert_eq!(session.is_running("toy-pty"), running);
    }
}

#[tokio::test]
async fn foreground_check_returns_none_when_probe_exceeds_deadline() {
    let session = FakeForegroundSession::new(Some((7, Some(42))));
    let (finish_probe, finish) = tokio::sync::oneshot::channel();
    let (start_probe, started) = tokio::sync::oneshot::channel();
    let (result, started) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            check_fake_foreground(
                &session,
                move |_| {
                    let _ = start_probe.send(());
                    let _ = finish.blocking_recv();
                    Some(true)
                },
                Duration::from_millis(5),
            ),
            started,
        )
    })
    .await
    .expect("the check must return while the probe is blocked");
    started.expect("the probe was called");
    assert_eq!(result, None);
    let _ = finish_probe.send(());
}

#[tokio::test]
async fn foreground_check_returns_while_diagnostic_write_is_blocked() {
    let session = FakeForegroundSession::new(Some((7, Some(42))));
    let (begin_write, line) = tokio::sync::oneshot::channel();
    let (finish_write, released) = tokio::sync::oneshot::channel();
    let (result, line) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            confirm_foreground_agent(
                Some((&session, "toy-pty")),
                Some(7),
                FakeForegroundSession::intervention_observation,
                FakeForegroundSession::session_observation,
                FakeForegroundSession::is_running,
                |_| {
                    std::thread::sleep(Duration::from_millis(160));
                    Some(true)
                },
                Duration::from_secs(5),
                move |line| {
                    let _ = begin_write.send(line.to_owned());
                    let _ = released.blocking_recv();
                },
            ),
            line,
        )
    })
    .await
    .expect("the foreground result must return while the diagnostic write is blocked");
    assert_eq!(result, Some(true));
    assert!(line.unwrap().starts_with("presend_foreground_check result=slow_ok elapsed_ms="));
    finish_write.send(()).unwrap();
}

#[test]
fn foreground_agent_in_pty_reports_no_agent_for_test_process() {
    assert_eq!(foreground_agent_in_pty(std::process::id()), Some(false));
}

#[test]
fn foreground_agent_in_pty_reports_unavailable_for_missing_pid() {
    assert_eq!(foreground_agent_in_pty(u32::MAX), None);
}

#[test]
fn foreground_check_diagnostic_uses_only_fixed_result_and_milliseconds() {
    use ForegroundCheckFailure::*;

    assert_eq!(foreground_check_line(Ok(true), 150.0), None);
    for (result, elapsed_ms, expected) in [
        (Ok(false), 9.0, "no_agent elapsed_ms=9.000"),
        (Err(Unavailable), 2.0, "unavailable elapsed_ms=2.000"),
        (Err(Timeout), 251.0, "timeout elapsed_ms=251.000"),
        (Err(GenerationChanged), 4.0, "generation_changed elapsed_ms=4.000"),
        (Ok(true), 150.125, "slow_ok elapsed_ms=150.125"),
    ] {
        assert_eq!(
            foreground_check_line(result, elapsed_ms),
            Some(format!("presend_foreground_check result={expected}"))
        );
    }
}

fn wire_prompt_fields(prompt: &str) -> serde_json::Value {
    serde_json::from_str(prompt.rsplit("\n\n").next().unwrap().trim()).unwrap()
}

#[tokio::test]
async fn renderer_ipc_keeps_the_current_reply_and_reuses_the_same_pty_child() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let generation = presend_wire_example().generation;
    for index in 0..2 {
        let mut example = presend_wire_example();
        example.request.request_id.push_str(&format!("-{index}"));
        assert!(read_wire_example(&service, example, generation).await.is_some());
    }
    assert_eq!(*stats.write_sessions.lock().unwrap(), vec![0, 0]);
    let prompts = stats.prompts.lock().unwrap();
    let expected = presend_wire_example().request;
    for prompt in prompts.iter() {
        let fields = wire_prompt_fields(prompt);
        assert_eq!(
            fields["\u{66f8}\u{304d}\u{304b}\u{3051}\u{306e}\u{4f9d}\u{983c}"],
            expected.draft
        );
        assert_eq!(
            fields["\u{76f4}\u{524d}\u{306e}\u{3084}\u{308a}\u{3068}\u{308a}"],
            expected.conversation_excerpt
        );
        assert_eq!(fields["\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}"], expected.workdir_name);
    }
}

#[tokio::test]
async fn renderer_ipc_keeps_the_workdir_name_from_typescript() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let cases = presend_wire_example().workdir_cases;
    assert_eq!(cases.len(), 4);
    for (index, case) in cases.iter().enumerate() {
        let mut example = presend_wire_example();
        example.request.request_id.push_str(&format!("-workdir-{index}"));
        // The client test checks these exact wire names against its IPC call.
        example.request.workdir_name.clone_from(&case.workdir_name);
        let generation = example.generation;
        assert!(read_wire_example(&service, example, generation).await.is_some());
    }
    let prompts = stats.prompts.lock().unwrap();
    let actual: Vec<_> = prompts.iter().map(|sent| {
        wire_prompt_fields(sent)["\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}"]
            .as_str().unwrap().to_owned()
    }).collect();
    let expected: Vec<_> = cases.into_iter().map(|case| case.workdir_name).collect();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn renderer_ipc_scrubs_a_token_shaped_workdir_name() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let mut example = presend_wire_example();
    let row = credential_examples().into_iter().find(|row| row.name == "prefix-glpat-20").unwrap();
    example.request.workdir_name = row.input_parts.concat();
    let generation = example.generation;
    assert!(read_wire_example(&service, example, generation).await.is_some());
    let prompts = stats.prompts.lock().unwrap();
    assert_eq!(
        wire_prompt_fields(&prompts[0])["\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}"],
        row.expected_parts.concat()
    );
}

#[tokio::test]
async fn renderer_ipc_drops_a_retired_generation_without_writing_to_the_current_child() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let mut current = presend_wire_example();
    let generation = current.generation + 1;
    current.request.request_id = "toy-warm".into();
    current.request.pty_generation = Some(generation);
    current.request.reply_source.as_mut().unwrap().pty_generation = generation;
    assert!(read_wire_example(&service, current, generation).await.is_some());

    assert!(read_wire_example(&service, presend_wire_example(), generation).await.is_none());
    assert_eq!(*stats.write_sessions.lock().unwrap(), vec![0]);
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 0);
}

#[tokio::test]
async fn renderer_ipc_unknown_generation_is_draft_only_and_uses_a_fresh_child() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let generation = presend_wire_example().generation;
    assert!(read_wire_example(&service, presend_wire_example(), generation).await.is_some());

    let mut unknown = presend_wire_example();
    unknown.request.request_id = "toy-unknown".into();
    unknown.request.pty_generation = None;
    assert!(read_wire_example(&service, unknown, generation).await.is_some());
    assert_eq!(count(&stats.closed), 2);
    assert!(read_wire_example(&service, presend_wire_example(), generation).await.is_some());

    assert_eq!(*stats.write_sessions.lock().unwrap(), vec![0, 1, 2]);
    let prompts = stats.prompts.lock().unwrap();
    let expected = presend_wire_example().request;
    assert_eq!(prompts[1], prompt(&expected.draft, "", &expected.workdir_name));
}

#[test]
fn presend_reply_requires_the_current_pty_conversation_and_process() {
    let mut source = PresendReplySource {
        pty_generation: 7,
        agent_kind: "claude".into(),
        agent_session_id: "resumed-conversation".into(),
        occurred_at: 10_000,
    };
    let mut agent = crate::pty::manager::TrustedAgentIdentity {
        session_epoch: 7,
        kind: "claude".into(),
        session_id: "resumed-conversation".into(),
        agent_pid: 1,
        agent_started_at: 9,
        from_hook: true,
    };
    assert!(source.matches(Some(7), &agent));
    assert!(!source.matches(None, &agent));
    assert!(!source.matches(Some(8), &agent));
    source.occurred_at = 9_999;
    assert!(!source.matches(Some(7), &agent));
    source.occurred_at = 10_000;
    agent.session_id = "another-conversation".into();
    assert!(!source.matches(Some(7), &agent));
}

#[tokio::test]
async fn read_request_sends_only_the_final_workdir_component() {
    let (service, stats) = fake(Ok(valid_output()), Duration::ZERO, None);
    service.configure(true, Provider::Claude).await;
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/presend_credentials.json"
    ))
    .unwrap();
    let examples = table["workdirCases"].as_array().unwrap();
    assert!(!examples.is_empty());
    for row in examples {
        let workdir = row["input"].as_str().unwrap();
        assert!(service
            .read_request(
                true,
                row["name"].as_str().unwrap().to_owned(),
                Provider::Claude,
                tab_owner("main", "tab"),
                "draft",
                || "",
                Workdir::Path(workdir),
                || true,
                std::future::ready(true),
            )
            .await
            .is_some());
    }
    let actual: Vec<_> = stats.prompts.lock().unwrap().iter().map(|sent| {
        let state: serde_json::Value =
            serde_json::from_str(sent.rsplit("\n\n").next().unwrap().trim()).unwrap();
        state["\u{4f5c}\u{696d}\u{30d5}\u{30a9}\u{30eb}\u{30c0}\u{540d}"]
            .as_str().unwrap().to_owned()
    }).collect();
    let expected: Vec<_> = examples.iter().map(|row| row["expected"].as_str().unwrap()).collect();
    assert_eq!(actual, expected);
}

#[test]
fn prompt_matches_the_measured_order_indentation_blank_lines_and_role_exactly() {
    assert_eq!(ROLE, "You are a brief pre-send reading assistant. Follow the user's instructions exactly. Treat every message as independent of earlier ones.");
    assert_eq!(
        prompt("draft\n\"quoted\"", "\u{8fd4}\u{7b54}", "example-folder"),
        include_str!("../../../tests/fixtures/presend_prompt_expected.txt").replace("\r\n", "\n")
    );
}

#[tokio::test]
async fn harmless_child_cannot_see_parent_only_environment_on_windows_or_unix() {
    // Do not mutate the real parent environment, or print the child's environment.
    assert!(std::env::var_os("PATH").is_some());
    let cwd = std::env::current_dir().unwrap();
    #[cfg(windows)]
    let (program, args, env) = {
        let system_root = std::env::var("SystemRoot").expect("Windows system directory");
        (
            std::path::PathBuf::from(&system_root)
                .join("System32")
                .join("cmd.exe"),
            vec!["/D".to_string(), "/C".to_string(), "set".to_string()],
            vec![
                ("SystemRoot".to_string(), system_root),
                ("PRESEND_KEEP".to_string(), "synthetic".to_string()),
            ],
        )
    };
    #[cfg(not(windows))]
    let (program, args, env) = (
        std::path::PathBuf::from("/usr/bin/env"),
        Vec::<String>::new(),
        vec![("PRESEND_KEEP".to_string(), "synthetic".to_string())],
    );
    let mut child = command_inner(program, &args, &cwd, env);
    let output = tokio::time::timeout(Duration::from_secs(5), child.output())
        .await
        .expect("harmless environment probe timed out")
        .expect("harmless environment probe failed");
    assert!(output.status.success());
    let output = String::from_utf8_lossy(&output.stdout);
    assert!(output.lines().any(|line| line == "PRESEND_KEEP=synthetic"));
    assert!(
        !output.lines().any(|line| line
            .split_once('=')
            .is_some_and(|(key, _)| key.eq_ignore_ascii_case("PATH"))),
        "the child must not inherit the parent's PATH"
    );
}

#[tokio::test]
async fn cancellation_inside_spawn_writes_nothing_keeps_child_and_starts_next_immediately() {
    let stats = Arc::new(Stats::default());
    let slot = Arc::new(Mutex::new(None::<std::sync::Weak<Inner>>));
    let factory_slot = slot.clone();
    let factory_stats = stats.clone();
    let service = PresendService::new(
        Arc::new(move |_| {
            factory_stats.spawned.fetch_add(1, Ordering::SeqCst);
            let inner = factory_slot
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap();
            PresendService(inner).cancel("cancel-at-spawn");
            Ok(Box::new(FakeSession {
                child_index: count(&factory_stats.spawned) - 1,
                stats: factory_stats.clone(),
                reply: Ok(valid_output()),
                delay: Duration::ZERO,
                closed: false,
                prompt: String::new(),
            }))
        }),
        Arc::new(OwnedProcesses::default()),
        IDLE_TIMEOUT,
        None,
    );
    *slot.lock().unwrap() = Some(Arc::downgrade(&service.0));
    service.configure(true, Provider::Claude).await;
    assert!(read(&service, "cancel-at-spawn", Provider::Claude)
        .await
        .is_none());
    assert!(stats.prompts.lock().unwrap().is_empty());
    assert_eq!(count(&stats.reads), 0);
    assert_eq!(count(&stats.closed), 0);
    assert!(service.0.engine.lock().await.session.is_some());
    assert_eq!(service.0.engine.lock().await.reads, 0);
    let next = tokio::time::timeout(
        Duration::from_secs(1),
        read(&service, "next-after-spawn", Provider::Claude),
    )
    .await
    .expect("next request must not wait for the unsent draft");
    assert!(next.is_some());
    assert_eq!(*stats.prompts.lock().unwrap(), ["next-after-spawn"]);
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 0);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn off_provider_change_and_exit_interrupt_an_already_canceled_drain_immediately() {
    for action in 0..3 {
        let (service, stats) = fake(Ok(valid_output()), Duration::from_secs(30), None);
        service.configure(true, Provider::Claude).await;
        let old_service = service.clone();
        let old =
            tokio::spawn(async move { read(&old_service, "draining", Provider::Claude).await });
        stats.started.notified().await;
        service.cancel("draining");
        tokio::task::yield_now().await;
        assert_eq!(count(&stats.active), 1);
        assert_eq!(count(&stats.closed), 0);
        match action {
            0 => tokio::time::timeout(
                Duration::from_secs(1),
                service.configure(false, Provider::Claude),
            )
            .await
            .unwrap(),
            1 => tokio::time::timeout(
                Duration::from_secs(1),
                service.configure(true, Provider::Codex),
            )
            .await
            .unwrap(),
            _ => service.shutdown(),
        }
        assert!(tokio::time::timeout(Duration::from_secs(1), old)
            .await
            .unwrap()
            .unwrap()
            .is_none());
        assert_eq!(count(&stats.closed), 1);
        assert_eq!(count(&stats.active), 0);
    }
}

#[derive(Default)]
struct WireStats {
    polls: AtomicUsize,
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
    bytes: Mutex<Vec<String>>,
}
struct GatedWriteSession {
    inner: FakeSession,
    wire: Arc<WireStats>,
    before_poll: Option<Box<dyn FnOnce() + Send>>,
    block_first: bool,
}
impl Session for GatedWriteSession {
    fn write<'a>(&'a mut self, prompt: &'a str) -> Operation<'a, Result<(), ()>> {
        // Construction is deliberately observable; it must not submit bytes.
        if let Some(cancel) = self.before_poll.take() {
            cancel();
        }
        let block = std::mem::take(&mut self.block_first);
        Box::pin(async move {
            self.wire.polls.fetch_add(1, Ordering::SeqCst);
            if block {
                self.wire
                    .bytes
                    .lock()
                    .unwrap()
                    .push(prompt.chars().take(1).collect());
                self.wire.started.notify_one();
                self.wire.release.notified().await;
            }
            self.wire.bytes.lock().unwrap().push(prompt.to_string());
            self.inner.write(prompt).await
        })
    }
    fn read(&mut self) -> Operation<'_, Result<String, ()>> {
        self.inner.read()
    }
    fn close(&mut self) -> Operation<'_, ()> {
        self.inner.close()
    }
}
fn gated_write_service(
    cancel_before_poll: bool,
    cancel_in_factory: bool,
) -> (PresendService, Arc<Stats>, Arc<WireStats>) {
    let stats = Arc::new(Stats::default());
    let wire = Arc::new(WireStats::default());
    let slot = Arc::new(Mutex::new(None::<std::sync::Weak<Inner>>));
    let factory_slot = slot.clone();
    let factory_stats = stats.clone();
    let factory_wire = wire.clone();
    let service = PresendService::new(
        Arc::new(move |_| {
            let first = factory_stats.spawned.fetch_add(1, Ordering::SeqCst) == 0;
            let cancel_slot = factory_slot.clone();
            let cancel = move || {
                let inner = cancel_slot
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap();
                PresendService(inner).cancel("wire-old");
            };
            if first && cancel_in_factory {
                cancel();
            }
            let before_poll: Option<Box<dyn FnOnce() + Send>> = if first && cancel_before_poll {
                Some(Box::new(cancel))
            } else {
                None
            };
            Ok(Box::new(GatedWriteSession {
                inner: FakeSession {
                    child_index: count(&factory_stats.spawned) - 1,
                    stats: factory_stats.clone(),
                    reply: Ok(valid_output()),
                    delay: Duration::ZERO,
                    closed: false,
                    prompt: String::new(),
                },
                wire: factory_wire.clone(),
                before_poll,
                block_first: first,
            }))
        }),
        Arc::new(OwnedProcesses::default()),
        IDLE_TIMEOUT,
        None,
    );
    *slot.lock().unwrap() = Some(Arc::downgrade(&service.0));
    (service, stats, wire)
}

#[tokio::test]
async fn cancellation_before_write_poll_keeps_claude_and_reuses_it_without_submitting_old_bytes() {
    let (service, stats, wire) = gated_write_service(true, false);
    service.configure(true, Provider::Claude).await;
    assert!(tokio::time::timeout(
        Duration::from_secs(1),
        read(&service, "wire-old", Provider::Claude)
    )
    .await
    .expect("an unpolled write must be canceled immediately")
    .is_none());
    assert_eq!(count(&wire.polls), 0);
    assert!(wire.bytes.lock().unwrap().is_empty());
    assert!(stats.prompts.lock().unwrap().is_empty());
    assert_eq!(count(&stats.closed), 0);
    assert!(service.0.engine.lock().await.session.is_some());
    assert!(tokio::time::timeout(
        Duration::from_secs(1),
        read(&service, "wire-new", Provider::Claude)
    )
    .await
    .unwrap()
    .is_some());
    assert_eq!(*wire.bytes.lock().unwrap(), ["wire-new"]);
    assert_eq!(count(&stats.spawned), 1);
    assert_eq!(count(&stats.closed), 0);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn cancellation_during_a_partial_write_closes_claude_before_the_next_child_starts() {
    let (service, stats, wire) = gated_write_service(false, false);
    service.configure(true, Provider::Claude).await;
    let active = service.clone();
    let old = tokio::spawn(async move { read(&active, "wire-old", Provider::Claude).await });
    wire.started.notified().await;
    assert_eq!(*wire.bytes.lock().unwrap(), ["w"]);
    service.cancel("wire-old");
    assert!(tokio::time::timeout(Duration::from_secs(1), old)
        .await
        .expect("cancel must interrupt a blocked partial write")
        .unwrap()
        .is_none());
    assert_eq!(count(&stats.closed), 1);
    assert!(service.0.engine.lock().await.session.is_none());
    assert!(tokio::time::timeout(
        Duration::from_secs(1),
        read(&service, "wire-new", Provider::Claude)
    )
    .await
    .unwrap()
    .is_some());
    assert_eq!(*wire.bytes.lock().unwrap(), ["w", "wire-new"]);
    assert_eq!(*stats.prompts.lock().unwrap(), ["wire-new"]);
    assert_eq!(count(&stats.spawned), 2);
    service.configure(false, Provider::Claude).await;
}

#[tokio::test]
async fn codex_canceled_before_writing_closes_both_at_spawn_and_before_poll() {
    for in_factory in [true, false] {
        let (service, stats, wire) = gated_write_service(!in_factory, in_factory);
        service.configure(true, Provider::Codex).await;
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            read(&service, "wire-old", Provider::Codex)
        )
        .await
        .unwrap()
        .is_none());
        assert!(wire.bytes.lock().unwrap().is_empty());
        assert_eq!(count(&wire.polls), 0);
        assert_eq!(count(&stats.closed), 1);
        assert!(service.0.engine.lock().await.session.is_none());
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            read(&service, "wire-new", Provider::Codex)
        )
        .await
        .unwrap()
        .is_some());
        assert_eq!(count(&stats.spawned), 2);
        assert_eq!(count(&stats.closed), 2);
    }
}

#[tokio::test]
async fn non_utf8_stdout_noise_is_lossy_skipped_and_still_counts_toward_the_output_cap() {
    let result = serde_json::json!({"type":"result","result":valid_output()});
    let mut bytes = b"\xff startup notice\n\xfe not JSON\n".to_vec();
    bytes.extend_from_slice(format!("{result}\n").as_bytes());
    assert_eq!(
        read_claude_result(&mut BufReader::new(bytes.as_slice()))
            .await
            .unwrap(),
        valid_output()
    );
    let mut remaining = 3;
    assert_eq!(
        limited_line(&mut BufReader::new(b"\xff\n".as_slice()), &mut remaining)
            .await
            .unwrap(),
        "\u{fffd}\n"
    );
    assert_eq!(remaining, 1);
    let oversized = vec![0xff; MAX_OUTPUT_BYTES as usize + 1];
    assert!(
        read_claude_result(&mut BufReader::new(oversized.as_slice()))
            .await
            .is_err()
    );
}
