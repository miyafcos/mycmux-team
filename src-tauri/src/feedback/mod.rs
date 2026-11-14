//! Improvement requests stay in memory; only OS-protected routing and a daily count persist.
pub(crate) mod commands;
mod destination_store;
mod transport;
#[cfg(windows)]
mod capture_windows;
#[cfg(target_os = "macos")]
mod capture_macos;

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

use transport::{validate_upload_url, SlackMethod, SlackResponse, SlackTransport};
#[cfg(test)]
use transport::TransportFuture;

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeedbackError {
    Auth, Destination, RateLimited, Network, Other, DailyLimit,
    NotConfigured, InvalidInput, InvalidDestination, Storage, InvalidImage,
}
impl FeedbackError {
    fn message(self) -> &'static str {
        match self {
            Self::Auth => "送り先の鍵が使えません。設定の『改善の要望の送り先』を確かめてください。",
            Self::Destination => "届け先に送れませんでした。送り先の設定を確かめてください。",
            Self::RateLimited => "混み合っています。少し時間をおいて送ってください。",
            Self::Network => "送れませんでした。ネットにつながっているか確かめてください。",
            Self::Other => "送れませんでした。",
            Self::DailyLimit => "今日はこれ以上送れません。",
            Self::NotConfigured => "送り先が設定されていません。設定 → アプリ情報の『改善の要望の送り先』で設定してください。",
            Self::InvalidInput => "必須項目と文字数を確かめてください。",
            Self::InvalidDestination => "鍵と届け先の形を確かめてください。",
            Self::Storage => "設定を保存・確認できませんでした。もう一度お試しください。",
            Self::InvalidImage => "画像を読み込めませんでした。別の画像を選んでください。",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DestinationStatus { pub configured: bool }

// Deliberately no Debug or public response type for OS-protected values.
#[derive(Deserialize, Serialize)]
struct SecretDestination { token: String, destination: String }
trait SecretStore {
    fn exists(&self) -> Result<bool, FeedbackError>;
    fn read(&self) -> Result<Option<SecretDestination>, FeedbackError>;
    fn write(&self, value: &SecretDestination) -> Result<(), FeedbackError>;
    fn remove(&self) -> Result<(), FeedbackError>;
}
fn valid_destination(token: &str, destination: &str) -> bool {
    token.starts_with("xoxb-") && token.len() > 5 && token.len() <= 512
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && destination.len() >= 2 && destination.len() <= 64
        && matches!(destination.as_bytes()[0], b'C' | b'G' | b'U' | b'W')
        && destination.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
fn destination_status(store: &impl SecretStore) -> Result<DestinationStatus, FeedbackError> {
    Ok(DestinationStatus { configured: store.exists()? })
}
fn save_destination(store: &impl SecretStore, token: &str, destination: &str) -> Result<DestinationStatus, FeedbackError> {
    let token = token.trim();
    let destination = destination.trim();
    if !valid_destination(token, destination) { return Err(FeedbackError::InvalidDestination); }
    store.write(&SecretDestination { token: token.into(), destination: destination.into() })?;
    Ok(DestinationStatus { configured: true })
}
fn remove_destination(store: &impl SecretStore) -> Result<DestinationStatus, FeedbackError> {
    store.remove()?;
    Ok(DestinationStatus { configured: false })
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackImage { pub mime: String, pub data: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackRequest {
    pub category: String,
    pub feature: String,
    pub problem: String,
    pub want: String,
    pub urgency: String,
    pub sender: String,
    pub images: Vec<FeedbackImage>,
}
struct FeedbackMetadata { version: String, os: String, sent_at: String }
struct DecodedImage { bytes: Vec<u8>, mime: String, filename: String }
struct PreparedSubmission {
    routing: SecretDestination, body: String, images: Vec<DecodedImage>, counter: DailyCounter, date: String,
}

const CATEGORIES: &[(&str, &str)] = &[
    ("bug", "不具合"), ("wording", "用語・表示の文言"), ("usability", "使い勝手"), ("feature", "新しい機能"),
];
const FEATURES: &[(&str, &str)] = &[
    ("tabs", "タブ"), ("launcher", "ランチャー"), ("dashboard", "ダッシュボード"),
    ("conversation", "会話の表示"), ("skills", "スキル"), ("accounts", "アカウント"),
    ("settings", "設定"), ("updates", "更新"), ("other", "その他"),
];
const URGENCIES: &[(&str, &str)] = &[("stopped", "仕事が止まっている"), ("soon", "できれば"), ("idea", "思いつき")];
fn label<'a>(options: &'a [(&str, &str)], key: &str) -> Result<&'a str, FeedbackError> {
    options.iter().find(|(value, _)| *value == key).map(|(_, text)| *text).ok_or(FeedbackError::InvalidInput)
}
fn plain_text(text: &str) -> String {
    text.trim().chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect::<String>().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
fn prepare_submission(store: &impl SecretStore, counter: &DailyCounter, date: &str,
    request: &FeedbackRequest, metadata: &FeedbackMetadata) -> Result<PreparedSubmission, FeedbackError>
{
    let category = label(CATEGORIES, &request.category)?;
    let feature = label(FEATURES, &request.feature)?;
    let urgency = label(URGENCIES, &request.urgency)?;
    if request.problem.trim().is_empty() || request.problem.chars().count() > 4000
        || request.want.chars().count() > 2000 || request.sender.trim().is_empty()
        || request.sender.chars().count() > 120 {
        return Err(FeedbackError::InvalidInput);
    }
    if request.images.len() > 3 { return Err(FeedbackError::InvalidImage); }
    let mut images = Vec::with_capacity(request.images.len());
    for (index, image) in request.images.iter().enumerate() {
        let extension = match image.mime.as_str() {
            "image/png" => "png", "image/jpeg" => "jpg", _ => return Err(FeedbackError::InvalidImage),
        };
        if image.data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 { return Err(FeedbackError::InvalidImage); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&image.data).map_err(|_| FeedbackError::InvalidImage)?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES { return Err(FeedbackError::InvalidImage); }
        images.push(DecodedImage { bytes, mime: image.mime.clone(), filename: format!("feedback-{}.{extension}", index + 1) });
    }
    let routing = store.read()?.ok_or(FeedbackError::NotConfigured)?;
    if !valid_destination(&routing.token, &routing.destination) { return Err(FeedbackError::InvalidDestination); }
    let body = format!("mycmux の改善の要望\n種類: {category} ／ 機能: {feature} ／ 急ぎ度: {urgency}\n送った人: {}\n困っていること:\n{}\nこうしてほしい:\n{}\nmycmux v{} ／ {} ／ {}",
        plain_text(&request.sender), plain_text(&request.problem), plain_text(&request.want),
        metadata.version, metadata.os, metadata.sent_at);
    // Reserve before the first request: an uncertain network outcome must not bypass the daily ceiling.
    counter.reserve(date)?;
    Ok(PreparedSubmission { routing, body, images, counter: counter.clone(), date: date.into() })
}
async fn deliver(transport: &impl SlackTransport, submission: PreparedSubmission) -> Result<(), FeedbackError> {
    let PreparedSubmission { routing, body, images, counter, date } = submission;
    if images.is_empty() {
        return checked(transport.call(SlackMethod::PostMessage, &routing.token,
            json!({"channel":routing.destination,"text":body,"mrkdwn":false,"unfurl_links":false,"unfurl_media":false})).await?, &counter, &date).map(|_| ());
    }
    let mut files = Vec::with_capacity(images.len());
    for image in images {
        let reply = checked(transport.call(SlackMethod::GetUpload, &routing.token,
            json!({"filename":image.filename,"length":image.bytes.len()})).await?, &counter, &date)?;
        let url = reply.get("upload_url").and_then(|v| v.as_str()).ok_or(FeedbackError::Other)?;
        validate_upload_url(url)?;
        let id = reply.get("file_id").and_then(|v| v.as_str()).filter(|id| !id.is_empty()).ok_or(FeedbackError::Other)?;
        transport.upload(url, image.bytes, &image.mime).await?;
        files.push(json!({"id":id}));
    }
    let destination_field = if routing.destination.starts_with('U') || routing.destination.starts_with('W') {
        "channels"
    } else { "channel_id" };
    let mut completion = json!({"files":files,"initial_comment":body});
    completion[destination_field] = json!(routing.destination);
    checked(transport.call(SlackMethod::CompleteUpload, &routing.token, completion).await?, &counter, &date).map(|_| ())
}
fn checked(reply: SlackResponse, counter: &DailyCounter, date: &str) -> Result<serde_json::Value, FeedbackError> {
    if reply.status == 429 { return Err(FeedbackError::RateLimited); }
    let ok = reply.body.get("ok").and_then(|value| value.as_bool());
    if ok != Some(true) {
        // Only an explicit rejection proves no request was posted. Unknown outcomes remain counted.
        if ok == Some(false) { counter.refund(date)?; }
        return Err(match reply.body.get("error").and_then(|value| value.as_str()).unwrap_or("") {
            "invalid_auth" | "token_revoked" | "account_inactive" => FeedbackError::Auth,
            "channel_not_found" | "not_in_channel" => FeedbackError::Destination,
            "ratelimited" => FeedbackError::RateLimited,
            _ => FeedbackError::Other,
        });
    }
    if !(200..300).contains(&reply.status) { return Err(FeedbackError::Other); }
    Ok(reply.body)
}

#[derive(Clone)]
struct DailyCounter { path: PathBuf }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Count { date: String, count: u32 }
impl DailyCounter {
    fn new(base: &Path) -> Self { Self { path: base.join("feedback-count.json") } }
    fn read(&self) -> Result<Option<Count>, FeedbackError> {
        match std::fs::read(&self.path) {
            // A damaged count is recoverable; actual filesystem errors still need attention.
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(FeedbackError::Storage),
        }
    }
    fn write(&self, date: &str, count: u32) -> Result<(), FeedbackError> {
        let parent = self.path.parent().ok_or(FeedbackError::Storage)?;
        std::fs::create_dir_all(parent).map_err(|_| FeedbackError::Storage)?;
        let bytes = serde_json::to_vec(&Count { date: date.into(), count }).map_err(|_| FeedbackError::Storage)?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| FeedbackError::Storage)?;
        file.write_all(&bytes).map_err(|_| FeedbackError::Storage)?;
        file.as_file().sync_all().map_err(|_| FeedbackError::Storage)?;
        file.persist(&self.path).map_err(|_| FeedbackError::Storage)?;
        Ok(())
    }
    fn reserve(&self, date: &str) -> Result<(), FeedbackError> {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| FeedbackError::Storage)?;
        let count = self.read()?.filter(|value| value.date == date).map_or(0, |value| value.count);
        if count >= 10 { return Err(FeedbackError::DailyLimit); }
        self.write(date, count + 1)
    }
    fn refund(&self, date: &str) -> Result<(), FeedbackError> {
        if let Some(value) = self.read()?.filter(|value| value.date == date && value.count > 0) {
            self.write(date, value.count - 1)?;
        }
        Ok(())
    }
}

#[cfg(test)]
async fn submit(store: &impl SecretStore, transport: &impl SlackTransport, counter: &DailyCounter,
    date: &str, request: &FeedbackRequest, metadata: &FeedbackMetadata) -> Result<(), FeedbackError>
{
    deliver(transport, prepare_submission(store, counter, date, request, metadata)?).await
}
#[cfg(test)]
mod tests;
