use super::*;

#[test]
fn claude_args_are_stable() {
    assert_eq!(
        AiConfig {
            provider: AiProvider::ClaudeCode,
            model: "m".into(),
            enabled: true
        }
        .args(),
        ["-p", "--model", "m", "--output-format", "text"]
    );
}
#[test]
fn codex_args_are_stable() {
    assert_eq!(
        AiConfig {
            provider: AiProvider::Codex,
            model: "m".into(),
            enabled: true
        }
        .args(),
        [
            "exec",
            "--model",
            "m",
            "-c",
            "features.fast_mode=false",
            "-"
        ]
    );
}
#[test]
fn args_never_contain_the_prompt() {
    assert!(!AiConfig::default()
        .args()
        .iter()
        .any(|arg| arg.contains("prompt body")));
}
#[test]
fn blank_model_falls_back_to_provider_default() {
    assert_eq!(
        AiConfig {
            model: "  ".into(),
            ..AiConfig::default()
        }
        .sanitized_model(),
        "gpt-5.6-luna"
    );
}
#[test]
fn dash_prefixed_model_falls_back_to_provider_default() {
    assert_eq!(
        AiConfig {
            model: "--bad".into(),
            ..AiConfig::default()
        }
        .sanitized_model(),
        "gpt-5.6-luna"
    );
}
#[test]
fn control_char_model_falls_back_to_provider_default() {
    assert_eq!(
        AiConfig {
            model: "bad\nmodel".into(),
            ..AiConfig::default()
        }
        .sanitized_model(),
        "gpt-5.6-luna"
    );
}
#[test]
fn arbitrary_unknown_model_is_passed_through() {
    assert_eq!(
        AiConfig {
            model: "future-model".into(),
            ..AiConfig::default()
        }
        .sanitized_model(),
        "future-model"
    );
}
#[test]
fn unknown_provider_string_falls_back_to_codex() {
    assert_eq!(AiProvider::from_storage("other"), AiProvider::Codex);
}
#[test]
fn env_strips_every_mycmux_variable() {
    let env = sanitized_env([
        ("PATH".into(), "safe".into()),
        ("mycmux_resume".into(), "x".into()),
        ("MYCMUX_X".into(), "x".into()),
    ]);
    assert_eq!(env.get("PATH").map(String::as_str), Some("safe"));
    assert!(!env
        .keys()
        .any(|key| key.to_ascii_uppercase().starts_with("MYCMUX_")));
}
