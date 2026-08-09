#[derive(Debug, Default)]
struct SessionDigest {
    cwd: Option<String>,
    git_branch: Option<String>,
    user_prompts: Vec<String>,
    last_assistant_text: String,
    files_read: Vec<String>,
    files_written: Vec<String>,
    turn_count: usize,
}

fn norm_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

struct PathMapper {
    dropbox_root: Option<String>,
}

impl PathMapper {
    /// 絶対パスを {DROPBOX} トークン形式へ。戻り値 (パス, Dropbox内かどうか)。
    fn tokenize(&self, path: &str) -> (String, bool) {
        let normalized = norm_slashes(path);
        if let Some(root) = &self.dropbox_root {
            let root = norm_slashes(root);
            let root = root.trim_end_matches('/');
            let lower = normalized.to_lowercase();
            let root_lower = root.to_lowercase();
            if lower
                .strip_prefix(&root_lower)
                .and_then(|suffix| suffix.strip_prefix('/'))
                .is_some()
            {
                let root_component_count = root.split('/').count();
                if let Some(suffix) = normalized
                    .splitn(root_component_count + 1, '/')
                    .nth(root_component_count)
                {
                    return (format!("{DROPBOX_TOKEN}/{suffix}"), true);
                }
            }
            if lower == root_lower {
                return (DROPBOX_TOKEN.to_string(), true);
            }
        }
        (normalized, false)
    }
}

fn user_text(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if entry
        .get("isMeta")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let message = entry.get("message")?.as_object()?;
    let content = message.get("content")?;
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else if let Some(blocks) = content.as_array() {
        let parts: Vec<&str> = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        parts.join("\n")
    } else {
        return None;
    };
    let stripped = text.trim();
    if stripped.is_empty()
        || stripped.starts_with("<command-name>")
        || stripped.starts_with("<local-command")
    {
        return None;
    }
    Some(stripped.to_string())
}

fn digest_claude_transcript(jsonl_path: &Path) -> Result<SessionDigest, String> {
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let reader = std::io::BufReader::new(file);
    let mut digest = SessionDigest::default();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !entry.is_object() {
            continue;
        }
        if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
            digest.cwd = Some(cwd.to_string());
        }
        if let Some(branch) = entry.get("gitBranch").and_then(Value::as_str) {
            if !branch.is_empty() {
                digest.git_branch = Some(branch.to_string());
            }
        }
        if let Some(text) = user_text(&entry) {
            digest.user_prompts.push(text);
            digest.turn_count += 1;
        }
        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let blocks = entry
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array);
        let Some(blocks) = blocks else { continue };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            digest.last_assistant_text = text.to_string();
                        }
                    }
                }
                Some("tool_use") => {
                    let Some(name) = block.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let is_write = WRITE_TOOLS.contains(&name);
                    if !is_write && name != READ_TOOL {
                        continue;
                    }
                    let file_path = block
                        .get("input")
                        .and_then(|input| input.get("file_path"))
                        .and_then(Value::as_str);
                    let Some(file_path) = file_path else { continue };
                    if file_path.is_empty() {
                        continue;
                    }
                    let bucket = if is_write {
                        &mut digest.files_written
                    } else {
                        &mut digest.files_read
                    };
                    if !bucket.iter().any(|existing| existing == file_path) {
                        bucket.push(file_path.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(digest)
}

#[derive(Debug)]
struct CodexSessionMeta {
    id: String,
    root_session_id: String,
    cwd: Option<String>,
    git_branch: Option<String>,
}

fn read_codex_session_meta(jsonl_path: &Path) -> Result<CodexSessionMeta, String> {
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut first_line = String::new();
    if reader
        .read_line(&mut first_line)
        .map_err(|error| format!("Failed to read {}: {error}", jsonl_path.display()))?
        == 0
    {
        return Err("Codex transcript is empty".to_string());
    }
    let entry: Value = serde_json::from_str(first_line.trim_end())
        .map_err(|error| format!("Invalid Codex session metadata: {error}"))?;
    if entry.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err("Codex transcript does not start with session_meta".to_string());
    }
    let payload = entry
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "Codex session_meta payload is invalid".to_string())?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex session id is missing".to_string())?
        .to_string();
    let root_session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex root session id is missing".to_string())?
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let git_branch = payload
        .get("git")
        .and_then(|git| git.get("branch"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(CodexSessionMeta {
        id,
        root_session_id,
        cwd,
        git_branch,
    })
}

fn message_content_text(payload: &Value, block_type: &str) -> Option<String> {
    let parts = payload
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some(block_type))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn collect_apply_patch_paths(input: &str, paths: &mut Vec<String>) {
    for line in input.lines() {
        let path = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
            .iter()
            .find_map(|prefix| line.trim().strip_prefix(prefix))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(path) = path {
            if !paths.iter().any(|existing| existing == path) {
                paths.push(path.to_string());
            }
        }
    }
}

fn digest_codex_transcript(jsonl_path: &Path) -> Result<SessionDigest, String> {
    let meta = read_codex_session_meta(jsonl_path)?;
    if meta.id != meta.root_session_id {
        return Err("Codex transcript is a child rollout, not a root session".to_string());
    }
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let reader = std::io::BufReader::new(file);
    let mut digest = SessionDigest {
        cwd: meta.cwd,
        git_branch: meta.git_branch,
        ..SessionDigest::default()
    };
    let mut fallback_users = Vec::new();
    let mut fallback_assistant = String::new();
    let mut latest_agent_message = String::new();
    let mut latest_final_message = String::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let top_type = entry.get("type").and_then(Value::as_str);
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        if top_type == Some("event_msg") {
            match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        if digest
                            .user_prompts
                            .last()
                            .is_none_or(|last| last != message)
                        {
                            digest.user_prompts.push(message.to_string());
                        }
                    }
                }
                Some("agent_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        latest_agent_message = message.to_string();
                        if payload.get("phase").and_then(Value::as_str) == Some("final") {
                            latest_final_message = message.to_string();
                        }
                    }
                }
                _ => {}
            }
        }
        if top_type != Some("response_item") {
            continue;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => match payload.get("role").and_then(Value::as_str) {
                Some("user") => {
                    if let Some(text) = message_content_text(payload, "input_text") {
                        fallback_users.push(text);
                    }
                }
                Some("assistant") => {
                    if let Some(text) = message_content_text(payload, "output_text") {
                        fallback_assistant = text;
                    }
                }
                _ => {}
            },
            Some("custom_tool_call") | Some("function_call") => {
                for key in ["input", "arguments"] {
                    if let Some(input) = payload.get(key).and_then(Value::as_str) {
                        collect_apply_patch_paths(input, &mut digest.files_written);
                    }
                }
            }
            _ => {}
        }
    }
    if digest.user_prompts.is_empty() {
        digest.user_prompts = fallback_users;
    }
    digest.turn_count = digest.user_prompts.len();
    digest.last_assistant_text = if latest_final_message.is_empty() {
        if latest_agent_message.is_empty() {
            fallback_assistant
        } else {
            latest_agent_message
        }
    } else {
        latest_final_message
    };
    Ok(digest)
}

fn truncate(text: &str, limit: usize) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= limit {
        return flattened;
    }
    let mut result: String = flattened.chars().take(limit.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn build_summary_line(explicit: Option<&str>, digest: &SessionDigest) -> String {
    if let Some(explicit) = explicit {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return truncate(trimmed, 80);
        }
    }
    if let Some(last) = digest.user_prompts.last() {
        return truncate(last, 80);
    }
    "(サマリ未設定)".to_string()
}

fn build_handoff_md(
    digest: &SessionDigest,
    mapper: &PathMapper,
    summary_line: &str,
    author: &str,
    next_step: Option<&str>,
) -> (String, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();

    let cwd_line = match &digest.cwd {
        Some(cwd) => {
            let (token, inside) = mapper.tokenize(cwd);
            if !inside {
                warnings.push(format!("作業ディレクトリ {token} は Dropbox 外"));
            }
            format!("`{token}`{}", if inside { "" } else { " ⚠Dropbox外" })
        }
        None => "(不明)".to_string(),
    };

    let render_paths = |paths: &[String], warnings: &mut Vec<String>| -> Vec<String> {
        if paths.is_empty() {
            return vec!["- (なし)".to_string()];
        }
        paths
            .iter()
            .map(|raw| {
                let (token, inside) = mapper.tokenize(raw);
                if !inside {
                    warnings.push(format!("{token} は Dropbox 外 (相手側に存在しない可能性)"));
                }
                format!("- `{token}`{}", if inside { "" } else { " ⚠Dropbox外" })
            })
            .collect()
    };

    let first_prompt = digest
        .user_prompts
        .first()
        .map(|prompt| truncate(prompt, 300))
        .unwrap_or_else(|| "(記録なし)".to_string());
    let last_assistant = if digest.last_assistant_text.is_empty() {
        "(記録なし)".to_string()
    } else {
        truncate(&digest.last_assistant_text, 600)
    };

    let mut lines: Vec<String> = vec![
        format!("# 引き継ぎ: {summary_line}"),
        String::new(),
        format!("- 記録者: {author} / やり取り {} 往復", digest.turn_count),
        format!("- 作業ディレクトリ: {cwd_line}"),
    ];
    if let Some(branch) = &digest.git_branch {
        lines.push(format!("- git ブランチ: `{branch}`"));
    }
    lines.extend([
        String::new(),
        "## 依頼の始まり (最初の指示)".to_string(),
        first_prompt,
        String::new(),
        "## 現在地 (最後の応答の要旨)".to_string(),
        last_assistant,
        String::new(),
        "## 次の一手".to_string(),
        next_step
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                "(記録者が未記入 — 会話ごと続ける場合は、会話の続きから確認してください)"
                    .to_string()
            }),
        String::new(),
        "## 変更したファイル".to_string(),
    ]);
    lines.extend(render_paths(&digest.files_written, &mut warnings));
    lines.extend([String::new(), "## 参照したファイル".to_string()]);
    lines.extend(render_paths(&digest.files_read, &mut warnings));
    lines.extend([
        String::new(),
        "## 環境の前提".to_string(),
        "- 会話の記憶は引き継がれますが、記録者のマシンにあるツール・MCP・権限は付いてきません。"
            .to_string(),
        "- パスの `{DROPBOX}` はあなたのローカル Dropbox ルートに読み替えてください (mycmux は自動展開)。"
            .to_string(),
        String::new(),
    ]);
    (lines.join("\n"), warnings)
}
