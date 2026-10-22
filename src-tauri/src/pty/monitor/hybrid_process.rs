pub(crate) fn is_hybrid_wrapper(name: &str, args: &[String]) -> bool {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or(name).to_ascii_lowercase();
    let leaf = leaf.strip_suffix(".exe").unwrap_or(&leaf);
    if leaf == "claude-codex-native" { return true; }
    if !matches!(leaf, "powershell" | "pwsh") { return false; }
    let mut index = 1;
    while let Some(argument) = args.get(index) {
        if argument.eq_ignore_ascii_case("-file") || argument.eq_ignore_ascii_case("-f") {
            return args.get(index + 1).is_some_and(|path|
                path.rsplit(['/', '\\']).next().is_some_and(|file| file.eq_ignore_ascii_case("claude-codex.ps1")));
        }
        if !argument.starts_with('-') || argument.eq_ignore_ascii_case("-command")
            || argument.eq_ignore_ascii_case("-c") || argument.eq_ignore_ascii_case("-encodedcommand") { return false; }
        if argument.eq_ignore_ascii_case("-executionpolicy") || argument.eq_ignore_ascii_case("-windowstyle") { index += 1; }
        index += 1;
    }
    false
}

pub(crate) struct Ancestor {
    pub parent: Option<u32>,
    pub started_at: u64,
    pub transparent_shell: bool,
    pub hybrid_wrapper: bool,
}

pub(crate) fn has_hybrid_ancestor(start: u32, mut lookup: impl FnMut(u32) -> Option<Ancestor>) -> bool {
    let Some(mut child) = lookup(start) else { return false; };
    let mut seen = std::collections::HashSet::from([start]);
    for _ in 0..16 {
        let Some(parent_id) = child.parent else { return false; };
        if !seen.insert(parent_id) { return false; }
        let Some(parent) = lookup(parent_id) else { return false; };
        if parent.started_at > child.started_at { return false; }
        if parent.hybrid_wrapper { return true; }
        if !parent.transparent_shell { return false; }
        child = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|value| value.to_string()).collect() }
    #[test]
    fn native_and_powershell_wrapper_are_exact_not_prompt_matches() {
        assert!(is_hybrid_wrapper("C:/bin/claude-codex-native.exe", &[]));
        assert!(is_hybrid_wrapper("powershell.exe", &args(&["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/bin/claude-codex.ps1", "--resume", "id"])));
        assert!(!is_hybrid_wrapper("claude.exe", &args(&["claude", "read claude-codex-native.exe"])));
        assert!(!is_hybrid_wrapper("powershell.exe", &args(&["powershell", "-Command", "echo", "-File", "claude-codex.ps1"])));
        assert!(!is_hybrid_wrapper("not-claude-codex-native.exe", &[]));
    }
    #[test]
    fn direct_and_shell_wrapped_claude_keep_the_actual_child_identity() {
        for shell in [false, true] {
            let found = has_hybrid_ancestor(3, |pid| match pid {
                3 => Some(Ancestor { parent: Some(if shell { 2 } else { 1 }), started_at: 30, transparent_shell: false, hybrid_wrapper: false }),
                2 => Some(Ancestor { parent: Some(1), started_at: 20, transparent_shell: true, hybrid_wrapper: false }),
                1 => Some(Ancestor { parent: None, started_at: 10, transparent_shell: false, hybrid_wrapper: true }),
                _ => None,
            });
            assert!(found);
        }
    }
    #[test]
    fn nested_agents_missing_parents_and_recycled_pids_are_not_wrappers() {
        for boundary in ["agent", "missing", "recycled", "cycle"] {
            assert!(!has_hybrid_ancestor(3, |pid| match pid {
                3 => Some(Ancestor { parent: Some(2), started_at: 30, transparent_shell: false, hybrid_wrapper: false }),
                2 if boundary != "missing" => Some(Ancestor { parent: Some(if boundary == "cycle" { 3 } else { 1 }),
                    started_at: if boundary == "recycled" { 40 } else { 20 }, transparent_shell: boundary != "agent", hybrid_wrapper: false }),
                1 => Some(Ancestor { parent: None, started_at: 10, transparent_shell: false, hybrid_wrapper: true }),
                _ => None,
            }), "{boundary}");
        }
    }
}
