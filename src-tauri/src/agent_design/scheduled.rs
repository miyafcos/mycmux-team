use std::collections::BTreeSet;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct Jobs {
    pub claude: Option<u64>,
    pub claude_enabled: Option<u64>,
    pub codex: Option<u64>,
    pub codex_enabled: Option<u64>,
}
fn csv(text: &str) -> Vec<Vec<String>> {
    let mut out = vec![];
    let mut row = vec![];
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => {
                row.push(std::mem::take(&mut cell));
            }
            '\n' if !quoted => {
                row.push(std::mem::take(&mut cell));
                out.push(std::mem::take(&mut row));
            }
            '\r' if !quoted => {}
            _ => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        out.push(row);
    }
    out
}
pub fn parse_windows(text: &str, claude_root: &Path, codex_root: &Path) -> Jobs {
    let rows = csv(text);
    let Some(header) = rows.first() else {
        return Jobs::default();
    };
    let find = |names: &[&str]| header.iter().position(|h| names.contains(&h.trim()));
    let Some(command) = find(&["Task To Run", "実行するタスク"]) else {
        return Jobs::default();
    };
    let Some(name) = find(&["TaskName", "Task Name", "タスク名"]) else {
        return Jobs::default();
    };
    let state = find(&["Scheduled Task State", "スケジュールされたタスクの状態"]);
    let mut all = [BTreeSet::new(), BTreeSet::new()];
    let mut enabled = [BTreeSet::new(), BTreeSet::new()];
    let roots = [
        claude_root
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase(),
        codex_root
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase(),
    ];
    for row in rows.iter().skip(1) {
        if row == header {
            continue;
        }
        let Some(run) = row.get(command) else {
            continue;
        };
        let Some(task) = row.get(name) else {
            continue;
        };
        let run = run.replace('\\', "/").to_lowercase();
        for i in 0..2 {
            if run.contains(&(roots[i].clone() + "/")) {
                all[i].insert(task.clone());
                if state
                    .and_then(|s| row.get(s))
                    .is_some_and(|s| ["Enabled", "有効"].contains(&s.trim()))
                {
                    enabled[i].insert(task.clone());
                }
            }
        }
    }
    Jobs {
        claude: Some(all[0].len() as u64),
        codex: Some(all[1].len() as u64),
        claude_enabled: state.map(|_| enabled[0].len() as u64),
        codex_enabled: state.map(|_| enabled[1].len() as u64),
    }
}
pub fn parse_plist(text: &str) -> Option<(Vec<String>, bool)> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut key = String::new();
    let mut in_key = false;
    let mut in_string = false;
    let mut args = false;
    let mut commands = vec![];
    let mut enabled = true;
    loop {
        match reader.read_event().ok()? {
            Event::Start(e) => match e.name().as_ref() {
                b"key" => in_key = true,
                b"array" if key == "ProgramArguments" => args = true,
                b"string" if args => in_string = true,
                _ => {}
            },
            Event::Text(e) => {
                let decoded = e.decode().ok()?;
                let text = quick_xml::escape::unescape(&decoded).ok()?.into_owned();
                if in_key {
                    key = text;
                } else if in_string {
                    commands.push(text);
                }
            }
            Event::Empty(e) if key == "Disabled" => {
                if e.name().as_ref() == b"true" {
                    enabled = false;
                }
            }
            Event::End(e) => match e.name().as_ref() {
                b"key" => in_key = false,
                b"string" => in_string = false,
                b"array" => args = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Some((commands, enabled))
}
pub fn parse_mac(plists: &[String], claude_root: &Path, codex_root: &Path) -> Jobs {
    let mut all = [0u64; 2];
    let mut on = [0u64; 2];
    let roots = [
        claude_root.to_string_lossy().replace('\\', "/"),
        codex_root.to_string_lossy().replace('\\', "/"),
    ];
    for plist in plists {
        let Some((args, enabled)) = parse_plist(plist) else {
            return Jobs::default();
        };
        let run = args.join(" ");
        for i in 0..2 {
            if run.contains(&(roots[i].clone() + "/")) {
                all[i] += 1;
                if enabled {
                    on[i] += 1;
                }
            }
        }
    }
    Jobs {
        claude: Some(all[0]),
        claude_enabled: Some(on[0]),
        codex: Some(all[1]),
        codex_enabled: Some(on[1]),
    }
}
pub fn collect(home: &Path, claude_root: &Path, codex_root: &Path) -> Jobs {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("schtasks")
            .args(["/query", "/fo", "csv", "/v"])
            .creation_flags(0x08000000)
            .output();
        if let Ok(output) = result {
            if output.status.success() {
                let text = String::from_utf8(output.stdout.clone())
                    .ok()
                    .unwrap_or_else(|| {
                        encoding_rs::SHIFT_JIS.decode(&output.stdout).0.into_owned()
                    });
                return parse_windows(&text, claude_root, codex_root);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(paths) = super::safe::children(&home.join("Library/LaunchAgents")) {
            let values: Option<Vec<_>> = paths
                .iter()
                .filter(|p| p.extension().is_some_and(|e| e == "plist"))
                .map(|p| super::safe::text(p, super::safe::DOCUMENT_LIMIT))
                .collect();
            if let Some(values) = values {
                return parse_mac(&values, claude_root, codex_root);
            }
        }
    }
    let _ = (home, claude_root, codex_root);
    Jobs::default()
}
