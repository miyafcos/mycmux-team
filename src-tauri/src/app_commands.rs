// Rust compiles both the actual handler and the independent command metadata
// from the same token group in lib.rs; the build lexer does not supply metadata.
macro_rules! app_commands {
    ($($command:path),* $(,)?) => {
        #[doc(hidden)]
        pub const REGISTERED_APP_COMMAND_PATHS: &[&str] = &[$(stringify!($command)),*];
        fn app_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
            ipc_caller::guard_app_handler(tauri::generate_handler![$($command),*], REGISTERED_APP_COMMAND_PATHS)
        }
    };
}
