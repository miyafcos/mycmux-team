use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::Value;
use super::FeedbackError;

pub(super) type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, FeedbackError>> + Send + 'a>>;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SlackMethod { PostMessage, GetUpload, CompleteUpload }
impl SlackMethod {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::PostMessage => "chat.postMessage",
            Self::GetUpload => "files.getUploadURLExternal",
            Self::CompleteUpload => "files.completeUploadExternal",
        }
    }
}
pub(super) struct SlackResponse { pub status: u16, pub body: Value }
pub(super) trait SlackTransport {
    fn call<'a>(&'a self, method: SlackMethod, token: &'a str, payload: Value) -> TransportFuture<'a, SlackResponse>;
    fn upload<'a>(&'a self, url: &'a str, bytes: Vec<u8>, mime: &'a str) -> TransportFuture<'a, ()>;
}

pub(super) fn validate_upload_url(value: &str) -> Result<(), FeedbackError> {
    let url = reqwest::Url::parse(value).map_err(|_| FeedbackError::Other)?;
    let host = url.host_str().ok_or(FeedbackError::Other)?;
    if url.scheme() != "https" || !(host == "files.slack.com" || host.ends_with(".slack.com"))
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || url.port_or_known_default() != Some(443) {
        return Err(FeedbackError::Other);
    }
    Ok(())
}

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

// Building requests is pure: tests can inspect the exact HTTP contract without opening a socket.
fn api_request(client: &reqwest::Client, method: SlackMethod, token: &str, payload: Value)
    -> Result<reqwest::Request, FeedbackError>
{
    let request = client.post(format!("https://slack.com/api/{}", method.name())).bearer_auth(token);
    let request = if method == SlackMethod::GetUpload {
        request.form(&[
            ("filename", payload["filename"].as_str().ok_or(FeedbackError::Other)?.to_string()),
            ("length", payload["length"].as_u64().ok_or(FeedbackError::Other)?.to_string()),
        ])
    } else { request.json(&payload) };
    request.build().map_err(|_| FeedbackError::Other)
}

fn upload_request(client: &reqwest::Client, url: &str, bytes: Vec<u8>, mime: &str)
    -> Result<reqwest::Request, FeedbackError>
{
    validate_upload_url(url)?;
    // The presigned upload URL gets image bytes only, never a bearer token.
    client.post(url).header(reqwest::header::CONTENT_TYPE, mime).body(bytes)
        .build().map_err(|_| FeedbackError::Other)
}

fn append_response_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), FeedbackError> {
    if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) { return Err(FeedbackError::Other); }
    bytes.extend_from_slice(chunk);
    Ok(())
}

async fn read_response(mut response: reqwest::Response) -> Result<SlackResponse, FeedbackError> {
    let status = response.status().as_u16();
    if status == 429 { return Ok(SlackResponse { status, body: Value::Null }); }
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) { return Err(FeedbackError::Other); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FeedbackError::Network)? {
        append_response_chunk(&mut bytes, &chunk)?;
    }
    let body = serde_json::from_slice(&bytes).map_err(|_| FeedbackError::Other)?;
    Ok(SlackResponse { status, body })
}

pub(super) struct HttpSlackTransport { client: reqwest::Client }
impl HttpSlackTransport {
    pub(super) fn new() -> Result<Self, FeedbackError> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build().map_err(|_| FeedbackError::Network)?;
        Ok(Self { client })
    }
}
impl SlackTransport for HttpSlackTransport {
    fn call<'a>(&'a self, method: SlackMethod, token: &'a str, payload: Value) -> TransportFuture<'a, SlackResponse> {
        Box::pin(async move {
            let request = api_request(&self.client, method, token, payload)?;
            let response = self.client.execute(request).await.map_err(|_| FeedbackError::Network)?;
            read_response(response).await
        })
    }
    fn upload<'a>(&'a self, url: &'a str, bytes: Vec<u8>, mime: &'a str) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let request = upload_request(&self.client, url, bytes, mime)?;
            let response = self.client.execute(request).await.map_err(|_| FeedbackError::Network)?;
            if response.status().as_u16() == 429 { return Err(FeedbackError::RateLimited); }
            if response.status().is_success() { Ok(()) } else { Err(FeedbackError::Other) }
        })
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_requests_use_form_for_get_upload_and_json_for_post_and_complete() {
        let client = reqwest::Client::new();
        let payload = json!({"filename":"screen space.png","length":420});
        let request = api_request(&client, SlackMethod::GetUpload, "xoxb-test-fake", payload).unwrap();
        assert_eq!(request.method().as_str(), "POST");
        assert_eq!(request.url().as_str(), "https://slack.com/api/files.getUploadURLExternal");
        assert_eq!(request.headers()[reqwest::header::AUTHORIZATION], "Bearer xoxb-test-fake");
        assert_eq!(request.headers()[reqwest::header::CONTENT_TYPE], "application/x-www-form-urlencoded");
        let form = std::str::from_utf8(request.body().unwrap().as_bytes().unwrap()).unwrap();
        let decoded = reqwest::Url::parse(&format!("https://example.test/?{form}")).unwrap();
        let values: Vec<_> = decoded.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
        assert_eq!(values, [("filename".into(), "screen space.png".into()), ("length".into(), "420".into())]);
        for (method, payload) in [
            (SlackMethod::PostMessage, json!({"channel":"C000TEST1","text":"sample body"})),
            (SlackMethod::CompleteUpload, json!({"channels":"U000TEST1","files":[{"id":"FTEST1"}],"initial_comment":"sample body"})),
        ] {
            let request = api_request(&client, method, "xoxb-test-fake", payload.clone()).unwrap();
            assert_eq!(request.method().as_str(), "POST");
            assert_eq!(request.url().as_str(), format!("https://slack.com/api/{}", method.name()));
            assert_eq!(request.headers()[reqwest::header::AUTHORIZATION], "Bearer xoxb-test-fake");
            assert_eq!(request.headers()[reqwest::header::CONTENT_TYPE], "application/json");
            assert_eq!(serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(), payload);
        }
        assert!(api_request(&client, SlackMethod::GetUpload, "xoxb-test-fake", json!({"filename":"sample.png"})).is_err());
    }

    #[test]
    fn image_upload_request_has_only_image_bytes_and_no_bearer_token() {
        let client = reqwest::Client::new();
        let url = "https://files.slack.com/upload/fake";
        let request = upload_request(&client, url, vec![1, 2, 3], "image/png").unwrap();
        assert_eq!(request.method().as_str(), "POST");
        assert_eq!(request.url().as_str(), url);
        assert_eq!(request.headers()[reqwest::header::CONTENT_TYPE], "image/png");
        assert!(!request.headers().contains_key(reqwest::header::AUTHORIZATION));
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), &[1, 2, 3]);
        assert!(upload_request(&client, "http://files.slack.com/fake", vec![1], "image/png").is_err());
        assert!(upload_request(&client, "https://example.test/fake", vec![1], "image/png").is_err());
    }

    #[test]
    fn streaming_response_bound_accepts_exactly_one_mebibyte_without_appending_overflow() {
        let mut bytes = vec![0; MAX_RESPONSE_BYTES - 3];
        append_response_chunk(&mut bytes, &[1, 2, 3]).unwrap();
        assert_eq!(bytes.len(), MAX_RESPONSE_BYTES);
        assert_eq!(append_response_chunk(&mut bytes, &[4]), Err(FeedbackError::Other));
        assert_eq!(bytes.len(), MAX_RESPONSE_BYTES);
        assert_eq!(&bytes[bytes.len() - 3..], &[1, 2, 3]);
        let mut empty = Vec::new();
        assert_eq!(append_response_chunk(&mut empty, &vec![0; MAX_RESPONSE_BYTES + 1]), Err(FeedbackError::Other));
        assert!(empty.is_empty());
    }

    fn response(status: u16, bytes: Vec<u8>) -> reqwest::Response {
        tauri::http::Response::builder().status(status).body(bytes).unwrap().into()
    }

    #[tokio::test]
    async fn response_reader_accepts_large_japanese_echo_beyond_the_old_64k_limit() {
        let text = "\u{3042}".repeat(30000);
        let bytes = serde_json::to_vec(&json!({"ok":true,"text":text})).unwrap();
        assert!(bytes.len() > 64 * 1024 && bytes.len() < MAX_RESPONSE_BYTES);
        let reply = read_response(response(200, bytes)).await.unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["text"], text);
    }

    #[tokio::test]
    async fn response_reader_rejects_oversized_or_invalid_json_and_preserves_http_429() {
        assert!(matches!(read_response(response(200, vec![b' '; MAX_RESPONSE_BYTES + 1])).await, Err(FeedbackError::Other)));
        assert!(matches!(read_response(response(200, b"invalid-json".to_vec())).await, Err(FeedbackError::Other)));
        let reply = read_response(response(429, b"not-json".to_vec())).await.unwrap();
        assert_eq!(reply.status, 429);
        assert_eq!(reply.body, Value::Null);
    }
}
