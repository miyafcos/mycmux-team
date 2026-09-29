use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[cfg(any(not(windows), test))]
const SCREENSHOT_UNSUPPORTED: &str = "web.screenshot is not supported on this platform yet";
#[cfg(any(not(windows), test))]
const TRUSTED_INPUT_UNSUPPORTED: &str = "trusted input is not supported on this platform yet";
#[cfg(any(not(windows), test))]
const FILE_INPUT_UNSUPPORTED: &str = "native file input is not supported on this platform yet";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneScreenshotResult {
    pub tab_id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WebPaneTrustedInput {
    Click {
        x: f64,
        y: f64,
        button: Option<String>,
        click_count: Option<u32>,
        expected_generation: Option<u64>,
    },
    Key {
        key: String,
        code: Option<String>,
        text: Option<String>,
        modifiers: Option<Vec<String>>,
        expected_generation: Option<u64>,
    },
    InsertText {
        text: String,
        expected_generation: Option<u64>,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        expected_generation: Option<u64>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneTrustedInputResult {
    pub tab_id: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneFile {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPaneSetFileInputResult {
    pub tab_id: String,
    pub files: Vec<WebPaneFile>,
}

#[tauri::command]
pub async fn webpane_screenshot(
    caller: tauri::Webview,
    app: AppHandle,
    tab_id: String,
    path: Option<String>,
    clip: Option<WebPaneClip>,
    budget_ms: Option<u64>,
    command: Option<String>,
) -> Result<WebPaneScreenshotResult, String> {
    if caller.label() != caller.window().label() {
        return Err("webpane_screenshot is only available to the primary app webview".to_string());
    }
    #[cfg(windows)]
    {
        let budget = NativeBudget::new("web.screenshot", budget_ms, command);
        budget
            .run(super::webpane_native_win::screenshot(
                &app, tab_id, path, clip, &budget,
            ))
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab_id, path, clip, budget_ms, command);
        Err(SCREENSHOT_UNSUPPORTED.to_string())
    }
}

#[tauri::command]
pub async fn webpane_input_trusted(
    caller: tauri::Webview,
    app: AppHandle,
    tab_id: String,
    action: WebPaneTrustedInput,
    budget_ms: Option<u64>,
    command: Option<String>,
) -> Result<WebPaneTrustedInputResult, String> {
    if caller.label() != caller.window().label() {
        return Err(
            "webpane_input_trusted is only available to the primary app webview".to_string(),
        );
    }
    #[cfg(windows)]
    {
        let budget = NativeBudget::new(action.command_name(), budget_ms, command);
        budget
            .run(super::webpane_native_win::input_trusted(
                &app, tab_id, action, &budget,
            ))
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab_id, action, budget_ms, command);
        Err(TRUSTED_INPUT_UNSUPPORTED.to_string())
    }
}

#[tauri::command]
pub async fn webpane_set_file_input(
    caller: tauri::Webview,
    app: AppHandle,
    tab_id: String,
    selector: String,
    paths: Vec<String>,
    expected_generation: Option<u64>,
    budget_ms: Option<u64>,
    command: Option<String>,
) -> Result<WebPaneSetFileInputResult, String> {
    if caller.label() != caller.window().label() {
        return Err(
            "webpane_set_file_input is only available to the primary app webview".to_string(),
        );
    }
    #[cfg(windows)]
    {
        let budget = NativeBudget::new("web.upload", budget_ms, command);
        budget
            .run(super::webpane_native_win::set_file_input(
                &app,
                tab_id,
                selector,
                paths,
                expected_generation,
                &budget,
            ))
            .await
    }
    #[cfg(not(windows))]
    {
        let _ = (
            app,
            tab_id,
            selector,
            paths,
            expected_generation,
            budget_ms,
            command,
        );
        Err(FILE_INPUT_UNSUPPORTED.to_string())
    }
}

#[cfg(any(windows, test))]
impl WebPaneTrustedInput {
    pub(super) fn expected_generation(&self) -> Option<u64> {
        match self {
            Self::Click {
                expected_generation,
                ..
            }
            | Self::Key {
                expected_generation,
                ..
            }
            | Self::InsertText {
                expected_generation,
                ..
            }
            | Self::Wheel {
                expected_generation,
                ..
            } => *expected_generation,
        }
    }

    fn command_name(&self) -> &'static str {
        match self {
            Self::Click { .. } => "web.click",
            Self::Key { .. } => "web.key",
            Self::InsertText { .. } => "web.type",
            Self::Wheel { .. } => "web.scroll",
        }
    }
}

#[cfg(any(windows, test))]
const CDP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
#[cfg(any(windows, test))]
const NATIVE_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

#[cfg(any(windows, test))]
#[derive(Clone)]
pub(super) struct NativeBudget {
    command: String,
    deadline: tokio::time::Instant,
}

#[cfg(any(windows, test))]
impl NativeBudget {
    fn new(default_command: &str, budget_ms: Option<u64>, command: Option<String>) -> Self {
        let duration = budget_ms
            .map(std::time::Duration::from_millis)
            .unwrap_or(NATIVE_BUDGET)
            .min(NATIVE_BUDGET);
        Self {
            command: command.unwrap_or_else(|| default_command.to_string()),
            deadline: tokio::time::Instant::now() + duration,
        }
    }

    fn exceeded(&self) -> String {
        format!("{} exceeded the 20s native budget", self.command)
    }

    fn call_timeout_at(&self, now: tokio::time::Instant) -> Result<std::time::Duration, String> {
        self.deadline
            .checked_duration_since(now)
            .filter(|remaining| !remaining.is_zero())
            .map(|remaining| remaining.min(CDP_TIMEOUT))
            .ok_or_else(|| self.exceeded())
    }

    pub(super) fn call_timeout(&self) -> Result<std::time::Duration, String> {
        self.call_timeout_at(tokio::time::Instant::now())
    }

    async fn run<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.call_timeout()?;
        let result = tokio::time::timeout_at(self.deadline, future)
            .await
            .map_err(|_| self.exceeded())?;
        // Prefer the command budget error if a shortened CDP timeout wins the race.
        self.call_timeout()?;
        result
    }
}

#[cfg(any(windows, test))]
pub(super) fn screenshot_path(
    home: &std::path::Path,
    tab_id: &str,
    requested: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<std::path::PathBuf, String> {
    super::webpane::webview_label(tab_id)?;
    let path = match requested {
        Some(path) => std::path::PathBuf::from(path),
        None => home
            .join(".mycmux")
            .join("handoff")
            .join("web")
            .join(tab_id)
            .join(format!("shot-{}.png", now.format("%Y%m%d-%H%M%S-%3f"))),
    };
    if !path.is_absolute() {
        return Err("screenshot path must be absolute".to_string());
    }
    if path.file_name().is_none() {
        return Err("screenshot path must name a file".to_string());
    }
    Ok(path)
}

#[cfg(any(windows, test))]
pub(super) fn write_screenshot(path: &std::path::Path, png: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "screenshot path has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create screenshot directory: {error}"))?;
    std::fs::write(path, png).map_err(|error| format!("failed to write screenshot: {error}"))
}

#[cfg(any(windows, test))]
pub(super) fn png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    if png.len() < 33
        || &png[..8] != b"\x89PNG\r\n\x1a\n"
        || png[8..12] != 13u32.to_be_bytes()
        || &png[12..16] != b"IHDR"
    {
        return Err("Page.captureScreenshot returned an invalid PNG IHDR".to_string());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err("Page.captureScreenshot returned an empty PNG".to_string());
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ihdr(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(13u32.to_be_bytes());
        png.extend(b"IHDR");
        png.extend(width.to_be_bytes());
        png.extend(height.to_be_bytes());
        png.extend([8, 6, 0, 0, 0]);
        png.extend(crc32fast::hash(&png[12..]).to_be_bytes());
        png
    }

    #[test]
    fn unsupported_platform_messages_are_stable() {
        assert_eq!(
            SCREENSHOT_UNSUPPORTED,
            "web.screenshot is not supported on this platform yet"
        );
        assert_eq!(
            TRUSTED_INPUT_UNSUPPORTED,
            "trusted input is not supported on this platform yet"
        );
        assert_eq!(
            FILE_INPUT_UNSUPPORTED,
            "native file input is not supported on this platform yet"
        );
    }

    #[test]
    fn trusted_actions_deserialize_camel_case_fields() {
        let click: WebPaneTrustedInput = serde_json::from_value(json!({
            "kind":"click", "x":12, "y":25, "clickCount":2
        }))
        .unwrap();
        assert!(matches!(
            click,
            WebPaneTrustedInput::Click {
                click_count: Some(2),
                button: None,
                ..
            }
        ));
        let wheel: WebPaneTrustedInput = serde_json::from_value(json!({
            "kind":"wheel", "x":12, "y":25, "deltaX":-10, "deltaY":100
        }))
        .unwrap();
        assert!(matches!(
            wheel,
            WebPaneTrustedInput::Wheel {
                delta_x: -10.0,
                delta_y: 100.0,
                ..
            }
        ));
        let insert: WebPaneTrustedInput =
            serde_json::from_value(json!({"kind":"insertText", "text":"hello"})).unwrap();
        assert!(matches!(insert, WebPaneTrustedInput::InsertText { .. }));
        let key: WebPaneTrustedInput =
            serde_json::from_value(json!({"kind":"key", "key":"Enter"})).unwrap();
        assert!(matches!(
            key,
            WebPaneTrustedInput::Key {
                code: None,
                text: None,
                modifiers: None,
                ..
            }
        ));
    }

    #[test]
    fn generation_is_optional_and_camel_case_for_every_trusted_action() {
        for (mut value, command) in [
            (json!({"kind":"click", "x":1, "y":2}), "web.click"),
            (json!({"kind":"key", "key":"Enter"}), "web.key"),
            (json!({"kind":"insertText", "text":"hello"}), "web.type"),
            (
                json!({"kind":"wheel", "x":1, "y":2, "deltaX":0, "deltaY":100}),
                "web.scroll",
            ),
        ] {
            let action: WebPaneTrustedInput = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(action.expected_generation(), None);
            assert_eq!(action.command_name(), command);
            value["expectedGeneration"] = json!(42);
            let action: WebPaneTrustedInput = serde_json::from_value(value).unwrap();
            assert_eq!(action.expected_generation(), Some(42));
            assert_eq!(
                serde_json::to_value(action).unwrap()["expectedGeneration"],
                42
            );
        }
    }

    #[test]
    fn native_budget_caps_cdp_calls_and_rejects_the_twenty_second_boundary() {
        let start = tokio::time::Instant::now();
        let budget = NativeBudget {
            command: "web.click".to_string(),
            deadline: start + NATIVE_BUDGET,
        };
        assert_eq!(CDP_TIMEOUT, std::time::Duration::from_secs(4));
        assert_eq!(NATIVE_BUDGET, std::time::Duration::from_secs(20));
        assert!(NATIVE_BUDGET < std::time::Duration::from_secs(30));
        assert_eq!(budget.call_timeout_at(start).unwrap(), CDP_TIMEOUT);
        assert_eq!(
            budget
                .call_timeout_at(start + std::time::Duration::from_secs(16))
                .unwrap(),
            CDP_TIMEOUT
        );
        assert_eq!(
            budget
                .call_timeout_at(start + std::time::Duration::from_millis(19500))
                .unwrap(),
            std::time::Duration::from_millis(500)
        );
        for now in [
            budget.deadline,
            budget.deadline + std::time::Duration::from_nanos(1),
        ] {
            assert_eq!(
                budget.call_timeout_at(now).unwrap_err(),
                "web.click exceeded the 20s native budget"
            );
        }
        let fresh = NativeBudget::new("web.screenshot", None, None);
        assert!(fresh.deadline >= start + NATIVE_BUDGET);
    }

    #[test]
    fn native_budget_uses_the_supplied_milliseconds_up_to_twenty_seconds() {
        for (supplied, expected_ms) in [
            (Some(0), 0),
            (Some(1500), 1500),
            (Some(19999), 19999),
            (Some(20000), 20000),
            (Some(20001), 20000),
            (Some(u64::MAX), 20000),
            (None, 20000),
        ] {
            let before = tokio::time::Instant::now();
            let budget = NativeBudget::new("web.key", supplied, None);
            let after = tokio::time::Instant::now();
            let expected = std::time::Duration::from_millis(expected_ms);
            assert!(budget.deadline >= before + expected);
            assert!(budget.deadline <= after + expected);
            assert_eq!(budget.command, "web.key");
            assert_eq!(budget.exceeded(), "web.key exceeded the 20s native budget");
        }
    }

    #[tokio::test]
    async fn native_budget_preserves_the_original_command_name_and_stops_at_zero() {
        let budget = NativeBudget::new("web.key", Some(0), Some("web.type".to_string()));
        let mut started = false;
        let result = budget
            .run(async {
                started = true;
                Ok(())
            })
            .await;
        assert_eq!(
            result.unwrap_err(),
            "web.type exceeded the 20s native budget"
        );
        assert!(!started);
        assert_eq!(
            NativeBudget::new("web.key", None, Some("web.type".to_string())).exceeded(),
            "web.type exceeded the 20s native budget"
        );
        for command in [
            "web.screenshot",
            "web.click",
            "web.key",
            "web.type",
            "web.scroll",
            "web.upload",
        ] {
            assert_eq!(
                NativeBudget::new(command, None, None).exceeded(),
                format!("{command} exceeded the 20s native budget")
            );
        }
    }

    #[tokio::test]
    async fn expired_native_budget_does_not_start_work() {
        let budget = NativeBudget {
            command: "web.upload".to_string(),
            deadline: tokio::time::Instant::now(),
        };
        let mut started = false;
        let result = budget
            .run(async {
                started = true;
                Ok(())
            })
            .await;
        assert_eq!(
            result.unwrap_err(),
            "web.upload exceeded the 20s native budget"
        );
        assert!(!started);
    }

    #[tokio::test]
    async fn native_budget_times_out_inflight_work_with_the_socket_command_name() {
        for command in [
            "web.screenshot",
            "web.click",
            "web.key",
            "web.type",
            "web.scroll",
            "web.upload",
        ] {
            let budget = NativeBudget {
                command: command.to_string(),
                deadline: tokio::time::Instant::now() + std::time::Duration::from_millis(5),
            };
            let result = budget
                .run(std::future::pending::<Result<(), String>>())
                .await;
            assert_eq!(
                result.unwrap_err(),
                format!("{command} exceeded the 20s native budget")
            );
        }
        assert_eq!(
            NativeBudget::new("web.key", None, None)
                .run(async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        assert_eq!(
            NativeBudget::new("web.key", None, None)
                .run(async { Err::<(), _>("CDP failure".to_string()) })
                .await
                .unwrap_err(),
            "CDP failure"
        );
    }

    #[test]
    fn native_results_serialize_to_the_wire_contract() {
        assert_eq!(
            serde_json::to_value(WebPaneScreenshotResult {
                tab_id: "tab_1".into(),
                path: "shot.png".into(),
                width: 800,
                height: 600,
                dpr: 1.5
            })
            .unwrap(),
            json!({"tabId":"tab_1", "path":"shot.png", "width":800, "height":600, "dpr":1.5})
        );
        assert_eq!(
            serde_json::to_value(WebPaneTrustedInputResult {
                tab_id: "tab_1".into(),
                kind: "insertText".into()
            })
            .unwrap(),
            json!({"tabId":"tab_1", "kind":"insertText"})
        );
        assert_eq!(
            serde_json::to_value(WebPaneSetFileInputResult {
                tab_id: "tab_1".into(),
                files: vec![WebPaneFile {
                    name: "a.txt".into(),
                    size: 42
                }]
            })
            .unwrap(),
            json!({"tabId":"tab_1", "files":[{"name":"a.txt", "size":42}]})
        );
    }

    #[test]
    fn screenshot_default_path_uses_utc_and_milliseconds() {
        let dir = tempfile::tempdir().unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-08T12:04:05.006+09:00")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let path = screenshot_path(dir.path(), "tab_1-abc", None, now).unwrap();
        assert_eq!(
            path,
            dir.path()
                .join(".mycmux/handoff/web/tab_1-abc/shot-20260908-030405-006.png")
        );
        assert!(!path.exists());
    }

    #[test]
    fn screenshot_rejects_relative_paths_and_unsafe_tab_ids() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["shot.png", "nested/shot.png", ""] {
            assert_eq!(
                screenshot_path(dir.path(), "tab_1", Some(path), chrono::Utc::now()).unwrap_err(),
                "screenshot path must be absolute"
            );
        }
        for tab in ["../escape", "", "a/b", "a\\b"] {
            assert!(screenshot_path(dir.path(), tab, None, chrono::Utc::now()).is_err());
        }
        #[cfg(windows)]
        for path in [r"C:shot.png", r"\shot.png"] {
            assert!(screenshot_path(dir.path(), "tab_1", Some(path), chrono::Utc::now()).is_err());
        }
    }

    #[test]
    fn screenshot_keeps_explicit_path_and_creates_missing_parents() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir.path().join("space here/nested/custom.png");
        let path = screenshot_path(
            std::path::Path::new(""),
            "tab_1",
            expected.to_str(),
            chrono::Utc::now(),
        )
        .unwrap();
        assert_eq!(path, expected);
        let png = ihdr(640, 480);
        write_screenshot(&path, &png).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), png);
    }

    #[test]
    fn screenshot_write_reports_directory_errors() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("file");
        std::fs::write(&parent, b"file").unwrap();
        assert!(write_screenshot(&parent.join("shot.png"), &ihdr(1, 1))
            .unwrap_err()
            .contains("failed to create screenshot directory"));
    }

    #[test]
    fn png_ihdr_dimensions_are_big_endian_and_checked() {
        assert_eq!(png_dimensions(&ihdr(1024, 768)).unwrap(), (1024, 768));
        for bytes in [
            vec![],
            ihdr(10, 10)[..24].to_vec(),
            ihdr(0, 10),
            ihdr(10, 0),
        ] {
            assert!(png_dimensions(&bytes).is_err());
        }
        for index in [0, 8, 12] {
            let mut png = ihdr(10, 10);
            png[index] ^= 1;
            assert!(png_dimensions(&png).is_err());
        }
    }
}
