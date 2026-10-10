//! A second caller check behind Tauri's app ACL. Use the resolved *request*
//! context: the current top-level URL alone is wrong for frames and races.
use tauri::ipc::{CommandArg, CommandItem, Invoke, InvokeError, InvokeMessage};
use tauri::utils::acl::{resolved::ResolvedCommand, ExecutionContext};

pub(crate) struct IpcCaller {
    command: &'static str,
    webview: String,
    window: String,
    origin_kind: &'static str,
}

impl<'a, R: tauri::Runtime> CommandArg<'a, R> for IpcCaller {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        Ok(Self::from_message(command.name, command.message, command.acl))
    }
}

impl IpcCaller {
    fn from_message<R: tauri::Runtime>(
        command: &'static str,
        message: &InvokeMessage<R>,
        acl: &Option<Vec<ResolvedCommand>>,
    ) -> Self {
        let webview = message.webview_ref();
        Self {
            command,
            webview: webview.label().to_string(),
            window: webview.window().label().to_string(),
            origin_kind: request_origin_kind(acl.as_deref()),
        }
    }

    fn require_local_app(&self) -> Result<(), String> {
        let primary = self.window == "main"
            || self.window.strip_prefix("mycmux-w").is_some_and(|suffix| !suffix.is_empty());
        if self.origin_kind == "local" && primary && self.webview == self.window {
            return Ok(());
        }
        self.log_denied();
        Err(format!("{} requires the local primary app webview", self.command))
    }

    pub(crate) fn log_denied(&self) {
        crate::diag::warn("ipc-denied", &denial_record(self.command, &self.webview, self.origin_kind));
    }
}

const CHILD_REPLY_COMMANDS: &[&str] = &[
    "webpane_read_result", "webpane_push_result", "webpane_eval_result", "webpane_forward_shortcut",
];

fn request_origin_kind(acl: Option<&[ResolvedCommand]>) -> &'static str {
    match acl {
        Some(entries) if entries.iter().any(|entry| matches!(entry.context, ExecutionContext::Local)) => "local",
        Some(_) => "remote",
        None => "unresolved",
    }
}

fn dispatch_after_guard<T>(caller: &IpcCaller, dispatch: impl FnOnce() -> T) -> Result<T, String> {
    if !CHILD_REPLY_COMMANDS.contains(&caller.command) { caller.require_local_app()?; }
    Ok(dispatch())
}

/// One boundary before argument decoding and every registered app handler.
/// R4 keeps its own request/child/shortcut binding instead of this primary check.
pub(crate) fn guard_app_handler<R: tauri::Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    registered_paths: &'static [&'static str],
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        // Log only compiler-registered command names, never an unknown input string.
        let Some(command) = registered_paths.iter()
            .map(|path| path.rsplit("::").next().unwrap().trim())
            .find(|command| *command == invoke.message.command()) else {
                return false;
            };
        let caller = IpcCaller::from_message(command, &invoke.message, &invoke.acl);
        let resolver = invoke.resolver.clone();
        match dispatch_after_guard(&caller, || handler(invoke)) {
            Ok(handled) => handled,
            Err(error) => { resolver.reject(error); true }
        }
    }
}

fn denial_record(command: &str, webview: &str, origin_kind: &str) -> String {
    // Debug escaping keeps even an unusual backend label on one log line.
    format!("command={command} webview={webview:?} origin={origin_kind}")
}

/// Injected by Tauri, never deserialized from page-controlled arguments.
/// One parameter on a sensitive command enforces the common check before its
/// function body (and before any filesystem/process/terminal work).
pub(crate) struct TrustedAppCaller;

impl<'a, R: tauri::Runtime> CommandArg<'a, R> for TrustedAppCaller {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        IpcCaller::from_command(command)?.require_local_app().map_err(InvokeError::from)?;
        Ok(Self)
    }
}

#[cfg(test)]
#[path = "../tests/app_ipc_acl.rs"]
mod acl_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(webview: &str, window: &str, origin_kind: &'static str) -> IpcCaller {
        IpcCaller { command: "create_session", webview: webview.into(), window: window.into(), origin_kind }
    }

    #[test]
    fn local_primary_main_and_detached_windows_pass() {
        for label in ["main", "mycmux-w1", "mycmux-w23"] {
            assert!(caller(label, label, "local").require_local_app().is_ok());
        }
    }

    #[test]
    fn children_remote_primary_and_missing_acl_fail_closed() {
        for (webview, window, origin) in [
            ("web-pane-test", "main", "local"),
            ("web-pane-test", "mycmux-w1", "local"),
            ("main", "main", "remote"),
            ("mycmux-w1", "mycmux-w1", "remote"),
            ("main", "main", "unresolved"),
            ("main", "mycmux-w1", "local"),
            ("popup-1", "popup-1", "local"),
            ("mycmux-w", "mycmux-w", "local"),
        ] {
            assert!(caller(webview, window, origin).require_local_app().is_err());
        }
    }

    #[test]
    fn denial_record_contains_only_command_escaped_label_and_origin_kind() {
        assert_eq!(denial_record("create_session", "web-pane-test", "remote"),
            "command=create_session webview=\"web-pane-test\" origin=remote");
        let record = denial_record("webpane_read_result", "web-pane-test\nother", "remote");
        assert!(!record.contains('\n'));
        assert!(!record.contains("request_id="));
    }

    #[test]
    fn erroneous_acl_grants_cannot_dispatch_any_non_r4_command() {
        use std::collections::BTreeMap;
        use tauri::ipc::Origin;
        use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
        use tauri::utils::platform::Target;
        let manifest_json = include_str!("../gen/schemas/acl-manifests.json");
        let bad_grant: Capability = serde_json::from_value(serde_json::json!({
            "identifier": "deliberately-excessive-test-grant", "local": true,
            "webviews": ["main", "mycmux-w*", "web-pane-*", "popup-*"],
            "remote": { "urls": ["https://*:*"] }, "permissions": ["app-local"]
        })).unwrap();
        for target in [Target::Windows, Target::MacOS, Target::Linux] {
            let manifests: BTreeMap<String, Manifest> = serde_json::from_str(manifest_json).unwrap();
            let resolved = Resolved::resolve(&manifests, BTreeMap::from([
                (bad_grant.identifier.clone(), bad_grant.clone())
            ]), target).unwrap();
            let authority = tauri::runtime_authority!(manifests, resolved);
            for path in crate::REGISTERED_APP_COMMAND_PATHS {
                let command = path.rsplit("::").next().unwrap().trim();
                if CHILD_REPLY_COMMANDS.contains(&command) { continue; }
                for (window, webview, origin) in [
                    ("main", "web-pane-test", Origin::Local),
                    ("main", "web-pane-test", Origin::Remote { url: "https://example.test/".parse().unwrap() }),
                    ("main", "main", Origin::Remote { url: "https://example.test/".parse().unwrap() }),
                    ("mycmux-w1", "mycmux-w1", Origin::Remote { url: "https://example.test/".parse().unwrap() }),
                    ("popup-1", "popup-1", Origin::Local),
                ] {
                    let acl = authority.resolve_access(command, window, webview, &origin).unwrap();
                    let caller = IpcCaller { command, window: window.into(), webview: webview.into(),
                        origin_kind: request_origin_kind(Some(&acl)) };
                    let mut dispatched = false;
                    assert!(dispatch_after_guard(&caller, || { dispatched = true; }).is_err(), "{target}: {command}");
                    assert!(!dispatched, "{target}: {command} body ran despite guard");
                }
                for label in ["main", "mycmux-w1"] {
                    let acl = authority.resolve_access(command, label, label, &Origin::Local).unwrap();
                    let caller = IpcCaller { command, window: label.into(), webview: label.into(),
                        origin_kind: request_origin_kind(Some(&acl)) };
                    let mut dispatched = false;
                    assert!(dispatch_after_guard(&caller, || { dispatched = true; }).is_ok());
                    assert!(dispatched);
                }
            }
        }
    }

    #[test]
    fn r4_dispatch_keeps_its_separate_binding_checks() {
        for command in CHILD_REPLY_COMMANDS {
            let caller = IpcCaller { command, window: "main".into(), webview: "web-pane-test".into(), origin_kind: "remote" };
            assert_eq!(dispatch_after_guard(&caller, || 1), Ok(1));
        }
        let caller = caller("main", "main", "unresolved");
        assert!(dispatch_after_guard(&caller, || panic!("must not dispatch")).is_err());
    }

}
