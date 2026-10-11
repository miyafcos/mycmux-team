// Actual cc4dae78e (L16 merge first-parent) classifier, kept independently.
pub(crate) fn is_noninteractive_agent(kind: &str, args: &[String]) -> bool {
    match kind {
        "claude" | "claude-codex" => args.iter().any(|arg| matches!(arg.as_str(), "-p" | "--print")),
        "codex" => {
            let executable = args.first().map(|arg| arg.to_ascii_lowercase());
            let leaf = executable.as_deref().map(|arg| arg.rsplit(['/', '\\']).next().unwrap_or(arg).trim_end_matches(".exe"));
            let mut index = if matches!(leaf, Some("node" | "bun")) { 2 } else { 1 };
            while let Some(arg) = args.get(index) {
                if arg == "--" { return false; }
                if matches!(arg.as_str(), "-p" | "--profile" | "-c" | "--config" | "-m" | "--model"
                    | "-s" | "--sandbox" | "-a" | "--ask-for-approval" | "-C" | "--cd" | "--add-dir"
                    | "--local-provider" | "--enable" | "--disable" | "-i" | "--image") {
                    index += 2;
                } else if arg.starts_with('-') {
                    index += 1;
                } else {
                    return matches!(arg.as_str(), "exec" | "e");
                }
            }
            false
        }
        // Preserve the existing Grok (and other provider) policy.
        _ => args.iter().any(|arg| matches!(arg.as_str(), "-p" | "--print" | "--exec")),
    }
}
