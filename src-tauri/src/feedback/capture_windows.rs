//! Capture only the calling WebView2 surface, before the feedback overlay is mounted.
use std::{cell::RefCell, rc::Rc, time::Duration};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_webview2::core::HSTRING;

const FAILED: &str = "画面を撮れませんでした";
pub(super) async fn capture(app: &AppHandle, label: &str) -> Result<String, String> {
    let webview = app.get_webview(label).ok_or(FAILED)?;
    let (tx, rx) = oneshot::channel::<Result<String, ()>>();
    webview.with_webview(move |platform| {
        if tx.is_closed() { return; }
        let sender = Rc::new(RefCell::new(Some(tx)));
        let completed = sender.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, reply| {
            let outcome = if status.is_err() { Err(()) } else {
                serde_json::from_str::<Value>(&reply).ok()
                    .and_then(|value| value.get("data").and_then(Value::as_str).filter(|data| !data.is_empty()).map(str::to_owned))
                    .ok_or(())
            };
            if let Some(tx) = completed.borrow_mut().take() { let _ = tx.send(outcome); }
            Ok(())
        }));
        let result = unsafe { platform.controller().CoreWebView2().and_then(|core| {
            core.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureScreenshot"),
                &HSTRING::from(r#"{"format":"png","fromSurface":true,"captureBeyondViewport":false}"#), &handler)
        }) };
        if result.is_err() {
            if let Some(tx) = sender.borrow_mut().take() { let _ = tx.send(Err(())); }
        }
    }).map_err(|_| FAILED)?;
    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(data))) => Ok(data),
        _ => Err(FAILED.into()),
    }
}
