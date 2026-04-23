use std::fs;
use std::path::{Path, PathBuf};

const MAX_ENV_BYTES: usize = 6_000;
const MAX_SKILL_NOTE_LEN: usize = 140;
const MAX_MEMORY_BLOCK_LINES: usize = 80;
const MAX_RULE_HEADINGS: usize = 40;

pub fn build_environment_text() -> String {
    let home = match resolve_home() {
        Some(path) => path,
        None => return String::new(),
    };

    let claude_dir = home.join(".claude");

    let mut sections: Vec<String> = Vec::new();

    if let Some(block) = build_skills_block(&claude_dir.join("skills").join("inventory.yaml")) {
        sections.push(block);
    }
    if let Some(block) = build_rules_block(&claude_dir.join("rules")) {
        sections.push(block);
    }
    if let Some(block) = build_claude_md_block(&home, &claude_dir) {
        sections.push(block);
    }
    if let Some(block) = build_memory_block(&claude_dir, &home) {
        sections.push(block);
    }

    if sections.is_empty() {
        return String::new();
    }

    let mut combined = String::from("## 環境情報 (自動スキャン)\n\n");
    combined.push_str("以下は You (buddy) が参照できる宮崎さんの Claude Code 環境要約。発話時は実在する skill 名や案件名を踏まえて具体的に答える。\n\n");
    combined.push_str(&sections.join("\n\n"));

    truncate_bytes(combined, MAX_ENV_BYTES)
}

fn resolve_home() -> Option<PathBuf> {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return Some(PathBuf::from(user_profile));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Some(PathBuf::from(home));
    }
    None
}

fn project_dir_name(home: &Path) -> String {
    home.to_string_lossy()
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

fn read_optional(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn build_skills_block(path: &Path) -> Option<String> {
    let raw = read_optional(path)?;
    let skills = parse_skill_inventory(&raw);
    if skills.is_empty() {
        return None;
    }

    let mut out = String::from("### スキル一覧 (inventory.yaml)\n");
    out.push_str("起動はユーザーが `/skill-name` か、note 記載のトリガーワードを発話。buddy が直接実行はできないが「この case は X 使えるな」と示唆できる。\n\n");
    for (name, entry) in skills.iter().take(30) {
        let maturity = entry.maturity.as_deref().unwrap_or("?");
        let modes = if entry.modes.is_empty() {
            String::new()
        } else {
            format!(" [{}]", entry.modes.join("/"))
        };
        let note = entry
            .note
            .as_deref()
            .map(|n| truncate_chars(n, MAX_SKILL_NOTE_LEN))
            .unwrap_or_default();
        out.push_str(&format!("- /{name} ({maturity}){modes} — {note}\n"));
    }
    Some(out)
}

struct SkillEntry {
    maturity: Option<String>,
    modes: Vec<String>,
    note: Option<String>,
}

fn parse_skill_inventory(raw: &str) -> Vec<(String, SkillEntry)> {
    let mut in_skills = false;
    let mut current_name: Option<String> = None;
    let mut current = SkillEntry {
        maturity: None,
        modes: Vec::new(),
        note: None,
    };
    let mut out: Vec<(String, SkillEntry)> = Vec::new();

    let flush = |name: &mut Option<String>, entry: &mut SkillEntry, out: &mut Vec<(String, SkillEntry)>| {
        if let Some(n) = name.take() {
            let taken = std::mem::replace(
                entry,
                SkillEntry {
                    maturity: None,
                    modes: Vec::new(),
                    note: None,
                },
            );
            out.push((n, taken));
        }
    };

    for line in raw.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }

        // top-level keys start at column 0
        if !line.starts_with(' ') {
            let f = flush;
            f(&mut current_name, &mut current, &mut out);
            in_skills = line.trim_end().starts_with("skills:");
            continue;
        }

        if !in_skills {
            continue;
        }

        // 2-space indent = skill name
        if line.starts_with("  ") && !line.starts_with("    ") {
            let trimmed = line.trim();
            if let Some(name) = trimmed.strip_suffix(':') {
                let f = flush;
                f(&mut current_name, &mut current, &mut out);
                if is_identifier(name) {
                    current_name = Some(name.to_string());
                }
            }
            continue;
        }

        // 4-space indent = skill attribute
        if line.starts_with("    ") && current_name.is_some() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("note:") {
                current.note = Some(clean_scalar(rest));
            } else if let Some(rest) = trimmed.strip_prefix("maturity:") {
                current.maturity = Some(clean_scalar(rest));
            } else if let Some(rest) = trimmed.strip_prefix("modes:") {
                current.modes = parse_inline_list(rest);
            }
        }
    }

    let f = flush;
    f(&mut current_name, &mut current, &mut out);
    out
}

fn clean_scalar(raw: &str) -> String {
    let s = raw.trim();
    let unquoted = s.trim_matches(|c: char| c == '"' || c == '\'');
    unquoted.to_string()
}

fn parse_inline_list(raw: &str) -> Vec<String> {
    let s = raw.trim().trim_start_matches('[').trim_end_matches(']');
    s.split(',')
        .map(clean_scalar)
        .filter(|t| !t.is_empty())
        .collect()
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn build_rules_block(dir: &Path) -> Option<String> {
    if !dir.exists() {
        return None;
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    files.sort();

    if files.is_empty() {
        return None;
    }

    let mut out = String::from("### ルール見出し (~/.claude/rules/)\n");
    let mut total_headings = 0usize;
    for path in files.iter() {
        let raw = match read_optional(path) {
            Some(r) => r,
            None => continue,
        };
        let name = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("rule");
        out.push_str(&format!("- **{name}**: "));

        let headings: Vec<&str> = raw
            .lines()
            .filter(|line| line.starts_with("## "))
            .map(|line| line.trim_start_matches("## ").trim())
            .collect();

        if headings.is_empty() {
            // fallback: first non-empty line
            if let Some(first) = raw.lines().find(|l| !l.trim().is_empty()) {
                out.push_str(&truncate_chars(first.trim_start_matches('#').trim(), 120));
            }
            out.push('\n');
            continue;
        }

        let joined: Vec<String> = headings
            .iter()
            .take(MAX_RULE_HEADINGS.saturating_sub(total_headings))
            .map(|h| h.to_string())
            .collect();
        total_headings += joined.len();
        out.push_str(&joined.join(" / "));
        out.push('\n');

        if total_headings >= MAX_RULE_HEADINGS {
            break;
        }
    }
    Some(out)
}

fn build_claude_md_block(home: &Path, claude_dir: &Path) -> Option<String> {
    let candidates = [
        claude_dir.join("CLAUDE.md"),
        home.join("CLAUDE.md"),
    ];
    let mut blocks: Vec<String> = Vec::new();
    for (i, path) in candidates.iter().enumerate() {
        let raw = match read_optional(path) {
            Some(r) => r,
            None => continue,
        };
        let label = if i == 0 { "global CLAUDE.md" } else { "home CLAUDE.md" };
        let excerpt = extract_section(&raw, "ワークフロー原則")
            .or_else(|| extract_section(&raw, "Workflow"))
            .or_else(|| extract_section(&raw, "Scope"))
            .unwrap_or_else(|| first_non_empty_lines(&raw, 6));
        let excerpt = truncate_chars(&excerpt, 900);
        if !excerpt.is_empty() {
            blocks.push(format!("- **{label}**\n{}", indent_lines(&excerpt)));
        }
    }
    if blocks.is_empty() {
        return None;
    }
    let mut out = String::from("### CLAUDE.md 要点\n");
    out.push_str(&blocks.join("\n"));
    Some(out)
}

fn build_memory_block(claude_dir: &Path, home: &Path) -> Option<String> {
    let project_dir = project_dir_name(home);
    let memory_path = claude_dir
        .join("projects")
        .join(&project_dir)
        .join("memory")
        .join("MEMORY.md");
    let raw = read_optional(&memory_path)?;

    let mut out = String::from("### Memory (~/.claude/projects/.../memory/MEMORY.md)\n");
    out.push_str("各リンクは該当メモファイルへの参照。詳細本文は渡していない。「この案件の詳細を知りたい」と求められたら memory の該当ファイル名を案内する。\n\n");

    let mut appended = false;
    for section_heading in ["Active Projects", "Feedback", "Known Issues", "Environment", "案件マップ"] {
        if let Some(section) = extract_section(&raw, section_heading) {
            let trimmed = trim_section_lines(&section, MAX_MEMORY_BLOCK_LINES);
            if !trimmed.is_empty() {
                out.push_str(&format!("#### {section_heading}\n{trimmed}\n\n"));
                appended = true;
            }
        }
    }

    if !appended {
        let preview = first_non_empty_lines(&raw, 30);
        if preview.is_empty() {
            return None;
        }
        out.push_str(&preview);
    }

    Some(out)
}

fn extract_section(raw: &str, heading_substring: &str) -> Option<String> {
    let mut capturing = false;
    let mut section_level: usize = 0;
    let mut buf = String::new();

    for line in raw.lines() {
        let level = heading_level(line);
        if let Some(lvl) = level {
            let title = line.trim_start_matches('#').trim();
            if capturing && lvl <= section_level {
                break;
            }
            if !capturing && title.contains(heading_substring) {
                capturing = true;
                section_level = lvl;
                continue;
            }
        }
        if capturing {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if buf.trim().is_empty() {
        None
    } else {
        Some(buf)
    }
}

fn heading_level(line: &str) -> Option<usize> {
    if !line.starts_with('#') {
        return None;
    }
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    Some(hashes)
}

fn first_non_empty_lines(raw: &str, max_lines: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        out.push_str(line);
        out.push('\n');
        count += 1;
        if count >= max_lines {
            break;
        }
    }
    out
}

fn trim_section_lines(raw: &str, max_lines: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for line in raw.lines() {
        out.push_str(line);
        out.push('\n');
        count += 1;
        if count >= max_lines {
            out.push_str("...（以下省略）\n");
            break;
        }
    }
    out.trim_end().to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn truncate_bytes(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s;
    }
    // Find a char boundary <= max_bytes
    let mut cutoff = max_bytes;
    while cutoff > 0 && !s.is_char_boundary(cutoff) {
        cutoff -= 1;
    }
    let mut truncated = s[..cutoff].to_string();
    truncated.push_str("\n…（環境情報は上限までで切り詰め）");
    truncated
}

fn indent_lines(raw: &str) -> String {
    raw.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}
