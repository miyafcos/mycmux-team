use super::*;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Default)]
struct TestSecrets(Mutex<Option<SecretDestination>>);
impl SecretStore for TestSecrets {
    fn exists(&self) -> Result<bool, FeedbackError> { Ok(self.0.lock().unwrap().is_some()) }
    fn read(&self) -> Result<Option<SecretDestination>, FeedbackError> {
        Ok(self.0.lock().unwrap().as_ref().map(|value| SecretDestination {
            token: value.token.clone(), destination: value.destination.clone(),
        }))
    }
    fn write(&self, value: &SecretDestination) -> Result<(), FeedbackError> {
        *self.0.lock().unwrap() = Some(SecretDestination {
            token: value.token.clone(), destination: value.destination.clone(),
        });
        Ok(())
    }
    fn remove(&self) -> Result<(), FeedbackError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct TestTransport {
    calls: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<Result<SlackResponse, FeedbackError>>>,
    fail_upload: Option<usize>,
}
impl SlackTransport for TestTransport {
    fn call<'a>(&'a self, method: SlackMethod, token: &'a str, payload: Value)
        -> TransportFuture<'a, SlackResponse>
    {
        assert_eq!(token, "xoxb-test-fake");
        let number = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(json!({"method": method.name(), "payload": payload}));
            calls.len()
        };
        let reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| Ok(SlackResponse {
            status: 200,
            body: if method == SlackMethod::GetUpload {
                json!({"ok":true,"upload_url":format!("https://files.slack.com/upload/fake-{number}"),
                    "file_id":format!("FTEST{number}")})
            } else { json!({"ok":true}) },
        }));
        Box::pin(async move { reply })
    }
    fn upload<'a>(&'a self, url: &'a str, bytes: Vec<u8>, mime: &'a str)
        -> TransportFuture<'a, ()>
    {
        assert!(url.starts_with("https://files.slack.com/upload/fake-"));
        assert_eq!(mime, "image/png");
        assert!(!bytes.is_empty());
        let number = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(json!({"method":"upload", "bytes":bytes.len()}));
            calls.iter().filter(|call| call["method"] == "upload").count()
        };
        Box::pin(async move {
            if self.fail_upload == Some(number) { Err(FeedbackError::Network) } else { Ok(()) }
        })
    }
}
fn configured() -> TestSecrets {
    let store = TestSecrets::default();
    save_destination(&store, "xoxb-test-fake", "C000TEST1").unwrap();
    store
}
fn request(images: usize) -> FeedbackRequest {
    FeedbackRequest {
        category: "bug".into(), feature: "dashboard".into(), urgency: "soon".into(),
        problem: "表示が重なって読めません。".into(), want: "文字を読めるようにしてほしい。".into(),
        sender: "北斗 太郎".into(),
        images: (0..images).map(|_| FeedbackImage {
            mime: "image/png".into(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9GQAAAAASUVORK5CYII=".into(),
        }).collect(),
    }
}
fn metadata() -> FeedbackMetadata {
    FeedbackMetadata { version: "1.2.3".into(), os: "Windows 11".into(), sent_at: "2026-01-02 10:23".into() }
}
async fn send(transport: &TestTransport, images: usize) -> Result<(), FeedbackError> {
    let dir = tempfile::tempdir().unwrap();
    submit(&configured(), transport, &DailyCounter::new(dir.path()), "2026-01-02", &request(images), &metadata()).await
}

#[tokio::test]
async fn text_only_posts_once_with_required_fields_and_metadata() {
    let transport = TestTransport::default();
    send(&transport, 0).await.unwrap();
    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "chat.postMessage");
    assert_eq!(calls[0]["payload"]["channel"], "C000TEST1");
    assert_eq!(calls[0]["payload"]["mrkdwn"], false);
    let text = calls[0]["payload"]["text"].as_str().unwrap();
    for expected in ["mycmux の改善の要望", "種類: 不具合", "機能: ダッシュボード", "急ぎ度: できれば",
        "送った人: 北斗 太郎", "表示が重なって読めません。", "文字を読めるようにしてほしい。",
        "mycmux v1.2.3", "Windows 11", "2026-01-02 10:23"] { assert!(text.contains(expected), "{expected}"); }
}
#[tokio::test]
async fn three_images_upload_in_order_and_complete_once_with_text_and_destination() {
    let transport = TestTransport::default();
    send(&transport, 3).await.unwrap();
    let calls = transport.calls.lock().unwrap();
    let methods: Vec<_> = calls.iter().map(|call| call["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["files.getUploadURLExternal", "upload", "files.getUploadURLExternal", "upload",
        "files.getUploadURLExternal", "upload", "files.completeUploadExternal"]);
    for index in [0, 2, 4] {
        assert!(calls[index]["payload"]["length"].as_u64().unwrap() > 0);
        assert!(calls[index]["payload"]["filename"].as_str().unwrap().ends_with(".png"));
    }
    let complete = &calls[6]["payload"];
    assert_eq!(complete["channel_id"], "C000TEST1");
    assert_eq!(complete["files"], json!([{"id":"FTEST1"},{"id":"FTEST3"},{"id":"FTEST5"}]));
    assert!(complete["initial_comment"].as_str().unwrap().contains("困っていること:"));
    assert!(complete.get("text").is_none());
}
#[tokio::test]
async fn a_failed_middle_upload_never_completes_or_posts() {
    let transport = TestTransport { fail_upload: Some(2), ..Default::default() };
    assert_eq!(send(&transport, 3).await, Err(FeedbackError::Network));
    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(!calls.iter().any(|call| call["method"] == "files.completeUploadExternal" || call["method"] == "chat.postMessage"));
}
#[tokio::test]
async fn slack_errors_http_429_and_network_failures_are_safe_user_messages() {
    for (code, expected, message) in [
        ("invalid_auth", FeedbackError::Auth, "送り先の鍵が使えません。設定の『改善の要望の送り先』を確かめてください。"),
        ("token_revoked", FeedbackError::Auth, "送り先の鍵が使えません。設定の『改善の要望の送り先』を確かめてください。"),
        ("account_inactive", FeedbackError::Auth, "送り先の鍵が使えません。設定の『改善の要望の送り先』を確かめてください。"),
        ("channel_not_found", FeedbackError::Destination, "届け先に送れませんでした。送り先の設定を確かめてください。"),
        ("not_in_channel", FeedbackError::Destination, "届け先に送れませんでした。送り先の設定を確かめてください。"),
        ("ratelimited", FeedbackError::RateLimited, "混み合っています。少し時間をおいて送ってください。"),
        ("private_server_detail", FeedbackError::Other, "送れませんでした。"),
    ] {
        let transport = TestTransport::default();
        transport.replies.lock().unwrap().push_back(Ok(SlackResponse { status:200, body:json!({"ok":false,"error":code}) }));
        let error = send(&transport, 0).await.unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(error.message(), message);
    }
    for (reply, expected, message) in [
        (Ok(SlackResponse { status:429, body:Value::Null }), FeedbackError::RateLimited,
            "混み合っています。少し時間をおいて送ってください。"),
        (Err(FeedbackError::Network), FeedbackError::Network, "送れませんでした。ネットにつながっているか確かめてください。"),
    ] {
        let transport = TestTransport::default();
        transport.replies.lock().unwrap().push_back(reply);
        let error = send(&transport, 0).await.unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(error.message(), message);
    }
}
#[tokio::test]
async fn get_or_complete_errors_are_checked_and_never_followed_by_a_post() {
    for fail_complete in [false, true] {
        let transport = TestTransport::default();
        if fail_complete {
            transport.replies.lock().unwrap().push_back(Ok(SlackResponse {
                status:200, body:json!({"ok":true,"upload_url":"https://files.slack.com/upload/fake-1","file_id":"FTEST1"}),
            }));
        }
        transport.replies.lock().unwrap().push_back(Ok(SlackResponse {
            status:200, body:json!({"ok":false,"error":"not_in_channel"}),
        }));
        assert_eq!(send(&transport, 1).await, Err(FeedbackError::Destination));
        assert!(!transport.calls.lock().unwrap().iter().any(|call| call["method"] == "chat.postMessage"));
    }
}
#[tokio::test]
async fn daily_ten_limit_persists_counts_only_and_resets_on_local_date_change() {
    let dir = tempfile::tempdir().unwrap();
    let counter = DailyCounter::new(dir.path());
    let transport = TestTransport::default();
    for _ in 0..10 { submit(&configured(), &transport, &counter, "2026-01-02", &request(0), &metadata()).await.unwrap(); }
    assert_eq!(submit(&configured(), &transport, &DailyCounter::new(dir.path()), "2026-01-02", &request(0), &metadata()).await,
        Err(FeedbackError::DailyLimit));
    assert_eq!(transport.calls.lock().unwrap().len(), 10);
    assert_eq!(FeedbackError::DailyLimit.message(), "今日はこれ以上送れません。");
    let state: Value = serde_json::from_slice(&std::fs::read(dir.path().join("feedback-count.json")).unwrap()).unwrap();
    assert_eq!(state, json!({"date":"2026-01-02","count":10}));
    submit(&configured(), &transport, &counter, "2026-01-03", &request(0), &metadata()).await.unwrap();
    assert_eq!(transport.calls.lock().unwrap().len(), 11);
    let state: Value = serde_json::from_slice(&std::fs::read(dir.path().join("feedback-count.json")).unwrap()).unwrap();
    assert_eq!(state, json!({"date":"2026-01-03","count":1}));
}
#[tokio::test]
async fn unset_destination_and_invalid_inputs_never_call_transport() {
    let dir = tempfile::tempdir().unwrap();
    let counter = DailyCounter::new(dir.path());
    let transport = TestTransport::default();
    assert_eq!(submit(&TestSecrets::default(), &transport, &counter, "2026-01-02", &request(0), &metadata()).await,
        Err(FeedbackError::NotConfigured));
    for field in ["category", "feature", "urgency", "problem", "sender"] {
        let mut value = request(0);
        match field { "category" => value.category.clear(), "feature" => value.feature.clear(),
            "urgency" => value.urgency.clear(), "problem" => value.problem = "  ".into(), _ => value.sender.clear() }
        assert_eq!(submit(&configured(), &transport, &counter, "2026-01-02", &value, &metadata()).await, Err(FeedbackError::InvalidInput));
    }
    assert!(transport.calls.lock().unwrap().is_empty());
    assert!(!dir.path().join("feedback-count.json").exists());
}
#[test]
fn secret_store_roundtrips_replaces_and_removes_without_public_secret_fields() {
    let store = TestSecrets::default();
    assert_eq!(serde_json::to_value(destination_status(&store).unwrap()).unwrap(), json!({"configured":false}));
    save_destination(&store, "xoxb-test-fake", "C000TEST1").unwrap();
    let public = serde_json::to_value(destination_status(&store).unwrap()).unwrap();
    assert_eq!(public, json!({"configured":true}));
    assert_eq!(store.read().unwrap().unwrap().token, "xoxb-test-fake");
    save_destination(&store, "xoxb-test-replacement", "U000TEST2").unwrap();
    assert_eq!(store.read().unwrap().unwrap().destination, "U000TEST2");
    remove_destination(&store).unwrap();
    remove_destination(&store).unwrap();
    assert!(!destination_status(&store).unwrap().configured);
}
#[test]
fn validates_token_and_destination_shapes_without_network() {
    let store = TestSecrets::default();
    for token in ["", "xoxp-test-wrong", "xoxb-", "xoxb-test- space", "xoxb-test-\nfake"] {
        assert_eq!(save_destination(&store, token, "C000TEST1"), Err(FeedbackError::InvalidDestination));
    }
    for id in ["", "C", "c000TEST1", "D000TEST1", "C00-test", "C000 TEST", "U000\nTEST1"] {
        assert_eq!(save_destination(&store, "xoxb-test-fake", id), Err(FeedbackError::InvalidDestination));
    }
    for id in ["C000TEST1", "G000TEST1", "U000TEST1", "W000TEST1"] {
        save_destination(&store, "xoxb-test-fake", id).unwrap();
    }
}
#[tokio::test]
async fn rejects_too_many_large_or_malformed_images_and_overlong_text_before_network() {
    let dir = tempfile::tempdir().unwrap();
    let transport = TestTransport::default();
    let counter = DailyCounter::new(dir.path());
    let mut values = vec![request(4)];
    let mut large = request(1);
    large.images[0].data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, vec![0u8; 2*1024*1024+1]);
    values.push(large);
    let mut bad = request(1); bad.images[0].data = "not-base64".into(); values.push(bad);
    let mut problem = request(0); problem.problem = "あ".repeat(4001); values.push(problem);
    let mut want = request(0); want.want = "あ".repeat(2001); values.push(want);
    for value in values {
        assert!(submit(&configured(), &transport, &counter, "2026-01-02", &value, &metadata()).await.is_err());
    }
    assert!(transport.calls.lock().unwrap().is_empty());
}
#[test]
fn only_allows_https_slack_upload_urls_without_credentials_or_redirects() {
    for url in ["http://files.slack.com/upload/fake", "https://example.test/fake",
        "https://files.slack.com.example.test/fake",
        "https://files.slack.com:444/fake"] {
        assert!(validate_upload_url(url).is_err(), "{url}");
    }
    let mut credentialed = reqwest::Url::parse("https://files.slack.com/fake").unwrap();
    credentialed.set_username("test-user").unwrap();
    credentialed.set_password(Some("test-password")).unwrap();
    assert!(validate_upload_url(credentialed.as_str()).is_err());
    assert!(validate_upload_url("https://files.slack.com/upload/fake").is_ok());
}

fn persisted_count(counter: &DailyCounter) -> Value {
    serde_json::from_slice(&std::fs::read(&counter.path).unwrap()).unwrap()
}

#[tokio::test]
async fn explicit_slack_rejections_refund_each_stage_and_allow_ten_successes() {
    for (images, successful_gets) in [(0, 0), (3, 0), (3, 1), (3, 3)] {
        for code in ["invalid_auth", "not_in_channel", "ratelimited", "unknown_rejection"] {
            let dir = tempfile::tempdir().unwrap();
            let counter = DailyCounter::new(dir.path());
            let transport = TestTransport::default();
            for _ in 0..successful_gets {
                transport.replies.lock().unwrap().push_back(Ok(SlackResponse { status:200,
                    body:json!({"ok":true,"upload_url":"https://files.slack.com/upload/fake-1","file_id":"FTEST1"}) }));
            }
            transport.replies.lock().unwrap().push_back(Ok(SlackResponse {
                status:200, body:json!({"ok":false,"error":code}) }));
            assert!(submit(&configured(), &transport, &counter, "2026-01-02", &request(images), &metadata()).await.is_err());
            assert_eq!(persisted_count(&counter), json!({"date":"2026-01-02","count":0}));
            for _ in 0..10 {
                submit(&configured(), &transport, &counter, "2026-01-02", &request(0), &metadata()).await.unwrap();
            }
            assert_eq!(persisted_count(&counter)["count"], 10);
            assert_eq!(submit(&configured(), &transport, &counter, "2026-01-02", &request(0), &metadata()).await,
                Err(FeedbackError::DailyLimit));
        }
    }
}

#[tokio::test]
async fn uncertain_network_timeout_http_429_and_malformed_replies_keep_the_reservation() {
    for (reply, expected) in [
        (Err(FeedbackError::Network), FeedbackError::Network),
        (Ok(SlackResponse { status:429, body:json!({"ok":false,"error":"ratelimited"}) }), FeedbackError::RateLimited),
        (Ok(SlackResponse { status:500, body:json!({"ok":true}) }), FeedbackError::Other),
        (Ok(SlackResponse { status:200, body:json!({"error":"missing_ok"}) }), FeedbackError::Other),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let counter = DailyCounter::new(dir.path());
        let transport = TestTransport::default();
        transport.replies.lock().unwrap().push_back(reply);
        assert_eq!(submit(&configured(), &transport, &counter, "2026-01-02", &request(0), &metadata()).await, Err(expected));
        assert_eq!(persisted_count(&counter), json!({"date":"2026-01-02","count":1}));
    }
    let dir = tempfile::tempdir().unwrap();
    let counter = DailyCounter::new(dir.path());
    let transport = TestTransport { fail_upload:Some(2), ..Default::default() };
    assert_eq!(submit(&configured(), &transport, &counter, "2026-01-02", &request(3), &metadata()).await,
        Err(FeedbackError::Network));
    assert_eq!(persisted_count(&counter)["count"], 1);
}

#[tokio::test]
async fn corrupt_daily_count_is_replaced_on_the_same_or_next_day() {
    for bytes in [b"{".as_slice(), b"", br#"{"date":"2026-01-02","count":"broken"}"#] {
        for date in ["2026-01-02", "2026-01-03"] {
            let dir = tempfile::tempdir().unwrap();
            let counter = DailyCounter::new(dir.path());
            std::fs::write(&counter.path, bytes).unwrap();
            submit(&configured(), &TestTransport::default(), &counter, date, &request(0), &metadata()).await.unwrap();
            assert_eq!(persisted_count(&counter), json!({"date":date,"count":1}));
        }
    }
}

struct UnreadableSecrets;
impl SecretStore for UnreadableSecrets {
    fn exists(&self) -> Result<bool, FeedbackError> { Ok(true) }
    fn read(&self) -> Result<Option<SecretDestination>, FeedbackError> { Err(FeedbackError::Storage) }
    fn write(&self, _value: &SecretDestination) -> Result<(), FeedbackError> { Ok(()) }
    fn remove(&self) -> Result<(), FeedbackError> { Ok(()) }
}
#[test]
fn destination_status_does_not_read_or_decrypt_an_existing_secret() {
    assert_eq!(destination_status(&UnreadableSecrets), Ok(DestinationStatus { configured:true }));
}

#[tokio::test]
async fn image_completion_uses_channels_for_users_and_channel_id_for_channels() {
    for id in ["C000TEST1", "G000TEST1", "U000TEST1", "W000TEST1"] {
        let dir = tempfile::tempdir().unwrap();
        let store = TestSecrets::default();
        save_destination(&store, "xoxb-test-fake", id).unwrap();
        let transport = TestTransport::default();
        submit(&store, &transport, &DailyCounter::new(dir.path()), "2026-01-02", &request(3), &metadata()).await.unwrap();
        let calls = transport.calls.lock().unwrap();
        let complete = &calls[6]["payload"];
        let (field, absent) = if id.starts_with('U') || id.starts_with('W') { ("channels", "channel_id") }
            else { ("channel_id", "channels") };
        assert_eq!(complete[field], id);
        assert!(complete.get(absent).is_none());
        assert_eq!(complete["files"], json!([{"id":"FTEST1"},{"id":"FTEST3"},{"id":"FTEST5"}]));
        assert!(complete["initial_comment"].as_str().unwrap().contains(&request(0).problem));
    }
}

#[test]
fn destination_save_trims_surrounding_whitespace_before_validation_and_storage() {
    let store = TestSecrets::default();
    save_destination(&store, " \txoxb-test-fake\r\n", "\n U000TEST1 \r\n").unwrap();
    let saved = store.read().unwrap().unwrap();
    assert_eq!(saved.token, "xoxb-test-fake");
    assert_eq!(saved.destination, "U000TEST1");
}

#[tokio::test]
async fn malformed_get_upload_reply_never_uploads_or_completes() {
    for body in [json!({"ok":true}), json!({"ok":true,"upload_url":"http://files.slack.com/fake","file_id":"FTEST"})] {
        let transport = TestTransport::default();
        transport.replies.lock().unwrap().push_back(Ok(SlackResponse{status:200,body}));
        assert!(send(&transport, 1).await.is_err());
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
    }
}
