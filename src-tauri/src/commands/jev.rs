use std::{collections::HashSet, fs, io::Write, path::PathBuf, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Manager;
use super::tab_sweep::{JudgeRegistration, TabSweepJudgeError};

#[path = "jev_secrets.rs"]
mod secrets;
const MODEL: &str = "typesafe/jev-1.13";
const ENDPOINT: &str = "https://openrouter.ai/api/alpha/decisions";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    enabled: bool,
    model: String,
    key_saved: bool,
    revision: String,
}
impl Default for Config {
    fn default() -> Self {
        Self { enabled: false, model: MODEL.into(), key_saved: false, revision: "initial".into() }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevSettings {
    enabled: bool,
    model: String,
    has_api_key: bool,
    revision: String,
}
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(crate::test_profile::app_data_dir_from).map_err(|_| "settings_storage".into())
}
fn secret_target() -> String {
    format!("mycmux.jev.openrouter.{}", crate::test_profile::name().unwrap_or("production"))
}
fn load_config(dir: &std::path::Path) -> Result<Config, String> {
    match fs::read(dir.join("jev.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "settings_storage".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(_) => Err("settings_storage".into()),
    }
}
fn public(config: Config) -> JevSettings {
    JevSettings { enabled: config.enabled, model: config.model, has_api_key: config.key_saved, revision: config.revision }
}
fn validate_model(model: &str) -> Result<(), String> {
    if model.len() > 100 || !model.starts_with("typesafe/jev-") ||
        !model.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._/".contains(&c)) {
        return Err("invalid_model".into());
    }
    Ok(())
}
fn validate_key(key: &str) -> Result<(), String> {
    if key.len() < 12 || key.len() > 4096 || key.bytes().any(|c| c.is_ascii_whitespace() || c.is_ascii_control()) {
        return Err("invalid_key".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn get_jev_settings(app: tauri::AppHandle) -> Result<JevSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock().lock().map_err(|_| "settings_storage")?;
        load_config(&directory(&app)?).map(public)
    }).await.map_err(|_| "settings_storage".to_string())?
}
#[tauri::command]
pub async fn save_jev_settings(app: tauri::AppHandle, enabled: bool, model: String, api_key: Option<String>) -> Result<JevSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_model(&model)?;
        let _guard = lock().lock().map_err(|_| "settings_storage")?;
        let dir = directory(&app)?;
        let mut config = load_config(&dir)?;
        if let Some(key) = api_key.as_deref().filter(|key| !key.is_empty()) {
            validate_key(key)?;
            secrets::write(&dir, &secret_target(), key)?;
            config.key_saved = true;
        }
        if enabled && !config.key_saved { return Err("missing_key".into()); }
        config.enabled = enabled;
        config.model = model;
        config.revision = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(&dir).map_err(|_| "settings_storage")?;
        let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "settings_storage")?;
        file.write_all(&serde_json::to_vec(&config).map_err(|_| "settings_storage")?).map_err(|_| "settings_storage")?;
        file.as_file().sync_all().map_err(|_| "settings_storage")?;
        file.persist(dir.join("jev.json")).map_err(|_| "settings_storage")?;
        Ok(public(config))
    }).await.map_err(|_| "settings_storage".to_string())?
}
#[derive(Clone, Deserialize, Serialize)]
pub struct DecisionRequest {
    state: Value,
    questions: Map<String, Value>,
}
fn validate_requests(requests: &[DecisionRequest]) -> Result<(), String> {
    if requests.is_empty() || requests.len() > 256 { return Err("invalid_request".into()); }
    let mut keys = HashSet::new();
    for request in requests {
        if !request.state.is_object() || request.questions.is_empty() || request.questions.len() > 48 {
            return Err("invalid_request".into());
        }
        for (key, question) in &request.questions {
            if !keys.insert(key) || !matches!(question["type"].as_str(), Some("choice" | "noul")) ||
                !question["criteria"].is_object() || !question["instructions"].is_string() {
                return Err("invalid_request".into());
            }
        }
    }
    Ok(())
}
fn probability(value: &Value) -> Option<f64> {
    value.as_f64().filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
}
fn validate_answers(request: &DecisionRequest, payload: &Value) -> Result<Map<String, Value>, String> {
    let answers = payload["answers"].as_object().ok_or("invalid_response")?;
    if answers.len() != request.questions.len() || answers.keys().any(|key| !request.questions.contains_key(key)) {
        return Err("invalid_response".into());
    }
    for (key, question) in &request.questions {
        let answer = &answers[key];
        if answer["type"] != question["type"] { return Err("invalid_response".into()); }
        if question["type"] == "noul" {
            probability(&answer["noul"]).ok_or("invalid_response")?;
        } else {
            let criteria = question["criteria"].as_object().ok_or("invalid_response")?;
            let probabilities = answer["probabilities"].as_object().ok_or("invalid_response")?;
            let choice = answer["choice"].as_str().ok_or("invalid_response")?;
            if !criteria.contains_key(choice) || probabilities.len() != criteria.len() ||
                !criteria.keys().all(|name| probabilities.contains_key(name)) {
                return Err("invalid_response".into());
            }
            let scores: Vec<f64> = probabilities.values().map(probability).collect::<Option<_>>().ok_or("invalid_response")?;
            if (scores.iter().sum::<f64>() - 1.0).abs() > criteria.len() as f64 * 0.005 + 0.0001 {
                return Err("invalid_response".into());
            }
            let selected = probability(&probabilities[choice]).ok_or("invalid_response")?;
            if scores.iter().any(|p| *p > selected + 0.0001) { return Err("invalid_response".into()); }
            probability(&answer["confidence"]).ok_or("invalid_response")?;
        }
    }
    Ok(answers.clone())
}
fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() { return Ok(client.clone()); }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(12))
        .build().map_err(|_| "network")?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}
struct DecisionFailure {
    code: &'static str,
    retry_after: Option<Duration>,
}
impl DecisionFailure {
    fn stable(code: &'static str) -> Self { Self { code, retry_after: None } }
    fn transport(error: reqwest::Error) -> Self {
        Self {
            code: if error.is_timeout() { "timeout" } else { "network" },
            retry_after: (error.is_timeout() || error.is_connect()).then_some(Duration::from_millis(250)),
        }
    }
}
fn retry_delay(status: u16, retry_after: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
    if !matches!(status, 408 | 429 | 500 | 502 | 503 | 504 | 529) { return None; }
    // Never retry earlier than Retry-After. Long or unparseable delays are left
    // to a later user attempt instead of extending the 25-second command budget.
    match retry_after {
        Some(value) => value.to_str().ok()?.parse::<u64>().ok()
            .filter(|seconds| *seconds <= 2).map(Duration::from_secs),
        None => Some(Duration::from_millis(250)),
    }
}
async fn decide_once(client: &reqwest::Client, endpoint: &str, model: &str, key: &str, request: &DecisionRequest) -> Result<Map<String, Value>, DecisionFailure> {
    let mut response = client.post(endpoint).bearer_auth(key)
        .json(&json!({"model":model,"state":request.state,"questions":request.questions}))
        .send().await.map_err(DecisionFailure::transport)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(DecisionFailure {
            code: match status { 401 | 403 => "authentication", 402 => "credits", 429 => "rate_limit", _ => "provider_error" },
            retry_after: retry_delay(status, response.headers().get(reqwest::header::RETRY_AFTER)),
        });
    }
    let invalid = || DecisionFailure::stable("invalid_response");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(DecisionFailure::transport)? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err(invalid()); }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let returned_model = body["model"].as_str().ok_or_else(invalid)?;
    if returned_model != model && !returned_model.starts_with(&format!("{model}-")) { return Err(invalid()); }
    validate_answers(request, &body).map_err(|_| invalid())
}
async fn decide_at(client: reqwest::Client, endpoint: &str, model: &str, key: &str, request: DecisionRequest) -> Result<(Map<String, Value>, usize), String> {
    // Retry only the failed HTTP request, once. execute's JoinSet and the
    // command deadline still cancel both an in-flight attempt and this backoff.
    match decide_once(&client, endpoint, model, key, &request).await {
        Ok(answers) => Ok((answers, 0)),
        Err(error) => {
            let Some(delay) = error.retry_after else { return Err(error.code.into()); };
            tokio::time::sleep(delay).await;
            decide_once(&client, endpoint, model, key, &request).await
                .map(|answers| (answers, 1)).map_err(|error| error.code.into())
        }
    }
}
async fn execute(requests: Vec<DecisionRequest>, model: String, key: String) -> Result<Value, String> {
    validate_requests(&requests)?;
    let started = Instant::now();
    let count = requests.len();
    let client = client()?;
    let mut pending = requests.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut answers = Map::new();
    let mut retry_count = 0;
    loop {
        while tasks.len() < 4 {
            let Some(request) = pending.next() else { break };
            let client = client.clone(); let model = model.clone(); let key = key.clone();
            tasks.spawn(async move { decide_at(client, ENDPOINT, &model, &key, request).await });
        }
        let Some(result) = tasks.join_next().await else { break };
        let (batch, retries) = result.map_err(|_| "network")??;
        answers.extend(batch);
        retry_count += retries;
    }
    Ok(json!({"answers":answers,"requestCount":count,"retryCount":retry_count,"httpMs":started.elapsed().as_secs_f64()*1000.0}))
}
#[tauri::command]
pub async fn test_jev_connection(app: tauri::AppHandle, model: String, api_key: Option<String>) -> Result<Value, String> {
    validate_model(&model)?;
    let dir = directory(&app)?;
    let key = match api_key.filter(|key| !key.is_empty()) {
        Some(key) => key,
        None => tauri::async_runtime::spawn_blocking(move || secrets::read(&dir, &secret_target())).await
            .map_err(|_| "key_storage")??.ok_or("missing_key")?,
    };
    validate_key(&key)?;
    let request: DecisionRequest = serde_json::from_value(json!({
        "state":{"connection_test":true},
        "questions":{"connected":{"type":"noul","instructions":"Is connection_test true?","criteria":{"true":"The value is true.","false":"The value is false."}}}
    })).map_err(|_| "invalid_request")?;
    let result = execute(vec![request], model, key).await?;
    if result["answers"]["connected"]["noul"].as_f64().unwrap_or(0.0) < 0.5 { return Err("invalid_response".into()); }
    Ok(json!({"ok":true,"elapsedMs":result["httpMs"]}))
}
#[tauri::command]
pub async fn run_jev_grouping_judge(app: tauri::AppHandle, prompt: String, request_id: String) -> Result<String, TabSweepJudgeError> {
    let fail = |code: &str| TabSweepJudgeError::new("jev_error", code);
    if !crate::ai::resolve(&app).enabled { return Err(TabSweepJudgeError::new("ai_disabled", "ai_disabled")); }
    if prompt.len() > 4_000_000 { return Err(fail("invalid_request")); }
    #[derive(Deserialize)] struct Input { requests: Vec<DecisionRequest> }
    let input: Input = serde_json::from_str(&prompt).map_err(|_| fail("invalid_request"))?;
    validate_requests(&input.requests).map_err(|code| fail(&code))?;
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    let _registration = JudgeRegistration::register(request_id, sender)?;
    let dir = directory(&app).map_err(|code| fail(&code))?;
    let (config, key) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock().lock().map_err(|_| "settings_storage")?;
        let config = load_config(&dir)?;
        if !config.enabled { return Err("jev_disabled".to_string()); }
        let key = secrets::read(&dir, &secret_target())?.ok_or("missing_key")?;
        Ok((config, key))
    }).await.map_err(|_| fail("key_storage"))?.map_err(|code| fail(&code))?;
    let work = execute(input.requests, config.model, key);
    let result = tokio::select! {
        _ = &mut receiver => return Err(TabSweepJudgeError::new("cancelled", "cancelled")),
        result = tokio::time::timeout(Duration::from_secs(25), work) => result.map_err(|_| fail("timeout"))?.map_err(|code| fail(&code))?,
    };
    serde_json::to_string(&result).map_err(|_| fail("invalid_response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> DecisionRequest {
        serde_json::from_value(json!({"state":{},"questions":{"r":{"type":"choice","instructions":"role","criteria":{"a":"A","b":"B"}}}})).unwrap()
    }
    #[test]
    fn settings_response_never_contains_key_material() {
        let value = serde_json::to_value(public(Config { key_saved:true, ..Config::default() })).unwrap();
        assert_eq!(value["hasApiKey"], true);
        assert_eq!(value.as_object().unwrap().len(),4);
        assert!(value.get("apiKey").is_none());
    }
    #[test]
    fn responses_reject_missing_extra_and_invalid_probabilities() {
        let r = request();
        let good = json!({"answers":{"r":{"type":"choice","choice":"a","confidence":0.8,"probabilities":{"a":0.9,"b":0.1}}}});
        assert!(validate_answers(&r,&good).is_ok());
        for bad in [
            json!({"answers":{}}),
            json!({"answers":{"r":{"type":"choice","choice":"b","confidence":0.8,"probabilities":{"a":0.9,"b":0.1}}}}),
            json!({"answers":{"r":{"type":"choice","choice":"a","confidence":0.8,"probabilities":{"a":2,"b":-1}}}}),
            json!({"answers":{"r":{"type":"choice","choice":"a","confidence":0.8,"probabilities":{"a":0.9,"c":0.1}}}}),
        ] { assert!(validate_answers(&r,&bad).is_err()); }
    }
    #[test]
    fn request_and_settings_validation() {
        assert!(validate_requests(&[request()]).is_ok());
        assert!(validate_requests(&[request(),request()]).is_err());
        assert!(validate_requests(&[]).is_err());
        assert!(validate_model(MODEL).is_ok());
        assert!(validate_model("other/model").is_err());
        assert!(validate_key("line\ninjected-key").is_err());
        let temp=tempfile::tempdir().unwrap();
        assert!(!load_config(temp.path()).unwrap().enabled);
    }
    #[test]
    fn transient_retry_respects_status_and_retry_after() {
        use reqwest::header::HeaderValue;
        for status in [401, 402, 403, 404, 422] { assert!(retry_delay(status, None).is_none()); }
        for status in [408, 429, 500, 502, 503, 504, 529] {
            assert_eq!(retry_delay(status, None), Some(Duration::from_millis(250)));
        }
        assert_eq!(retry_delay(429, Some(&HeaderValue::from_static("2"))), Some(Duration::from_secs(2)));
        for header in ["30", "unknown", "Mon, 21 Sep 2026 12:00:00 GMT"] {
            assert!(retry_delay(503, Some(&HeaderValue::from_str(header).unwrap())).is_none());
        }
    }
    fn server(responses: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<usize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || {
            let mut count = 0;
            let deadline = Instant::now() + Duration::from_secs(5);
            for (status, body) in responses {
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                        _ => return count,
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut incoming = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let read = socket.read(&mut buf).unwrap();
                    if read == 0 { break; }
                    incoming.extend_from_slice(&buf[..read]);
                    let raw = String::from_utf8_lossy(&incoming);
                    if let Some(end) = raw.find("\r\n\r\n") {
                        let length: usize = raw[..end].lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                        }).unwrap_or(0);
                        if incoming.len() >= end + 4 + length { break; }
                    }
                }
                let body = body.to_string();
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nRetry-After: 0\r\n\r\n{body}", body.len()).unwrap();
                count += 1;
            }
            count
        });
        (endpoint, thread)
    }
    #[tokio::test]
    async fn transient_failure_retries_once_and_preserves_answers() {
        let good = json!({"model":MODEL,"answers":{"r":{"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":1.0,"b":0.0}}}});
        let (endpoint, server) = server(vec![(529, json!({"error":{"code":529}})), (200, good.clone())]);
        let (answers, retries) = decide_at(reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap(), &endpoint, MODEL, "unit-test-only", request()).await.unwrap();
        assert_eq!(retries, 1);
        assert_eq!(Value::Object(answers), good["answers"]);
        assert_eq!(server.join().unwrap(), 2);
    }
    #[tokio::test]
    async fn retries_stop_at_two_attempts_and_reject_auth_or_invalid_answers() {
        let (endpoint, handle) = server(vec![(503, json!({})), (503, json!({}))]);
        assert_eq!(decide_at(reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap(), &endpoint, MODEL, "unit-test-only", request()).await.unwrap_err(), "provider_error");
        assert_eq!(handle.join().unwrap(), 2);
        for (status, body, error) in [(401, json!({}), "authentication"), (200, json!({"model":MODEL,"answers":{}}), "invalid_response")] {
            let (endpoint, handle) = server(vec![(status, body)]);
            assert_eq!(decide_at(reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap(), &endpoint, MODEL, "unit-test-only", request()).await.unwrap_err(), error);
            assert_eq!(handle.join().unwrap(), 1);
        }
    }

}
