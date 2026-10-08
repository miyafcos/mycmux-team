use super::model::Size;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DOCUMENT_LIMIT: u64 = 2 * 1024 * 1024;
#[cfg(test)]
thread_local! { pub static OPENED: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) }; }

pub fn private(path: &Path) -> bool {
    path.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy().to_lowercase();
            name == ".env"
                || name.ends_with(".env")
                || name.starts_with("credentials")
                || name == "auth.json"
                || name.starts_with("token")
                || name.ends_with(".key")
                || name.ends_with(".pem")
        }
        _ => false,
    })
}
pub fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}
pub fn normalized(path: &Path) -> String {
    normalized_spelling(&canonical(path).to_string_lossy())
}
fn windows_drive(path: &str) -> bool {
    path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(1) == Some(&b':')
}
fn normalized_spelling(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    // Canonicalization can fail for missing files or paths replayed on another OS.
    // Compare ordinary and extended-length drive/UNC spellings the same way.
    if let Some(rest) = s.strip_prefix("//?/") {
        if rest.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("UNC/")) {
            s = format!("//{}", &rest[4..]);
        } else if windows_drive(rest) {
            s = rest.to_owned();
        }
    }
    while s.ends_with('/') && s.len() > 1 {
        // A drive root must remain absolute, distinct from drive-relative C:.
        if s.len() == 3 && windows_drive(&s) {
            break;
        }
        s.pop();
    }
    if cfg!(windows) || windows_drive(&s) || s.starts_with("//") {
        s.to_lowercase()
    } else {
        s
    }
}
pub fn same_path(path: &Path, expected: &Path) -> bool {
    normalized(path) == normalized(expected)
}
pub fn open(path: &Path) -> Result<File, String> {
    if private(path) || private(&canonical(path)) {
        return Err("privateFile".into());
    }
    let file = File::open(path).map_err(|_| "fileUnavailable".to_owned())?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err("fileUnavailable".into());
    }
    #[cfg(test)]
    OPENED.with(|paths| paths.borrow_mut().push(path.to_owned()));
    Ok(file)
}
pub fn text(path: &Path, limit: u64) -> Option<String> {
    let file = open(path).ok()?;
    if file.metadata().ok()?.len() > limit {
        return None;
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).ok()?;
    if data.len() as u64 > limit {
        return None;
    }
    let text = String::from_utf8(data).ok()?;
    Some(
        text.trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n"),
    )
}
pub fn json(path: &Path) -> Option<Value> {
    serde_json::from_str(&text(path, 32 * 1024 * 1024)?).ok()
}
pub fn children(path: &Path) -> Option<Vec<PathBuf>> {
    if !path.exists() {
        return Some(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(path).ok()? {
        out.push(entry.ok()?.path());
    }
    out.sort();
    Some(out)
}
pub fn files(path: &Path, extensions: Option<&[&str]>) -> Option<Vec<PathBuf>> {
    fn visit(
        path: &Path,
        extensions: Option<&[&str]>,
        out: &mut Vec<PathBuf>,
        depth: usize,
    ) -> Option<()> {
        if depth > 24 {
            return None;
        }
        for file in children(path)? {
            let name = basename(&file);
            if ["__pycache__", "node_modules", ".git", ".venv", "venv"].contains(&name.as_str()) {
                continue;
            }
            let meta = fs::symlink_metadata(&file).ok()?;
            if meta.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if meta.is_dir() {
                visit(&file, extensions, out, depth + 1)?;
            } else if meta.is_file()
                && extensions.is_none_or(|e| {
                    e.contains(
                        &file
                            .extension()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase()
                            .as_str(),
                    )
                })
            {
                out.push(file);
            }
        }
        Some(())
    }
    let mut out = vec![];
    visit(path, extensions, &mut out, 0)?;
    Some(out)
}
pub fn basename(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into()
}
pub fn size(path: &Path, read: bool) -> Size {
    let bytes = fs::metadata(path).ok().map(|m| m.len());
    let text = if read {
        text(path, DOCUMENT_LIMIT)
    } else {
        None
    };
    Size {
        bytes,
        chars: text.as_ref().map(|s| s.chars().count() as u64),
        lines: text.as_ref().map(|s| s.lines().count() as u64),
    }
}
pub fn modified(path: &Path) -> Option<u64> {
    Some(
        fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as u64,
    )
}
pub fn identifier(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.is_empty()
        && value.len() <= 1024
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || "_-.:@/[]*|()^+$\\".contains(c))
    {
        Some(value.into())
    } else {
        None
    }
}
pub fn script_name(command: &str) -> String {
    let mut parts = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    for c in command.chars() {
        if c == '"' || c == '\'' {
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !word.is_empty() {
                parts.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        parts.push(word);
    }
    let exts = [
        "py", "ps1", "sh", "js", "mjs", "cjs", "ts", "cmd", "bat", "exe",
    ];
    // Retain the first script token, then stop. A later filename is an argument.
    // Inline shell / interpreter programs cannot be safely identified as a file.
    let mut option_value = false;
    for (index, token) in parts.iter().enumerate() {
        if option_value {
            option_value = false;
            continue;
        }
        if [
            "-c",
            "-Command",
            "-command",
            "--command",
            "-m",
            "--eval",
            "-e",
            "/c",
            "/C",
            "/k",
            "/K",
        ]
        .contains(&token.as_str())
        {
            return "unsupported".into();
        }
        if ["-X", "-W", "-ExecutionPolicy"].contains(&token.as_str()) {
            option_value = true;
            continue;
        }
        if token.starts_with('-')
            && ![
                "-u",
                "-B",
                "-I",
                "-E",
                "-s",
                "-S",
                "-NoProfile",
                "-NonInteractive",
                "-File",
            ]
            .contains(&token.as_str())
        {
            return "unsupported".into();
        }
        let path = PathBuf::from(token.replace('\\', "/"));
        if private(&path) {
            return "unsupported".into();
        }
        let name = basename(&path);
        let lower = name.to_lowercase();
        if index == 0 {
            let executable = lower.strip_suffix(".exe").unwrap_or(&lower);
            let python_version = executable.strip_prefix("python").is_some_and(|version| {
                version.chars().next().is_some_and(|c| c.is_ascii_digit())
                    && version.chars().all(|c| c.is_ascii_digit() || c == '.')
            });
            if python_version
                || [
                    "python",
                    "pythonw",
                    "py",
                    "powershell",
                    "pwsh",
                    "node",
                    "bash",
                    "sh",
                    "cmd",
                ]
                .contains(&executable)
            {
                continue;
            }
            // An unknown executable's later filename is an argument, not a script.
            if !path
                .extension()
                .is_some_and(|e| exts.contains(&e.to_string_lossy().to_lowercase().as_str()))
            {
                return "unsupported".into();
            }
        }
        let Some(extension) = path.extension() else {
            continue;
        };
        if exts.contains(&extension.to_string_lossy().to_lowercase().as_str()) {
            return identifier(&name).unwrap_or_else(|| "unsupported".into());
        }
    }
    "unsupported".into()
}
pub fn line_of(text: &str, key: &str) -> Option<u64> {
    text.lines()
        .position(|line| line.contains(key))
        .map(|i| i as u64 + 1)
}
pub fn project_key(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}
pub fn write_json(
    directory: &Path,
    name: &str,
    value: &impl serde::Serialize,
) -> Result<(), String> {
    if ![
        "cache.json",
        "catalog.json",
        "closed.json",
        "locations.json",
    ]
    .contains(&name)
    {
        return Err("writeDenied".into());
    }
    let target = state_target(directory, name)?;
    let bytes = serde_json::to_vec(value).map_err(|_| "serializationFailed".to_owned())?;
    let mut file =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| "stateUnavailable".to_owned())?;
    file.write_all(&bytes)
        .map_err(|_| "stateUnavailable".to_owned())?;
    file.as_file()
        .sync_all()
        .map_err(|_| "stateUnavailable".to_owned())?;
    for attempt in 0..8 {
        match file.persist(&target) {
            Ok(_) => return Ok(()),
            Err(error) => {
                #[cfg(windows)]
                if attempt < 7 && matches!(error.error.raw_os_error(), Some(5 | 32 | 33)) {
                    // A short-lived Windows reader/scanner can deny replacement.
                    // Retry the same completed temporary file; never write in place.
                    file = error.file;
                    std::thread::sleep(std::time::Duration::from_millis(5 * (attempt + 1)));
                    continue;
                }
                #[cfg(not(windows))]
                let _ = attempt;
                return Err(format!(
                    "stateReplaceFailed:{:?}:{}",
                    error.error.kind(),
                    error.error.raw_os_error().unwrap_or(0)
                ));
            }
        }
    }
    Err("stateReplaceFailed".into())
}

pub fn state_target(directory: &Path, name: &str) -> Result<PathBuf, String> {
    if ![
        "cache.json",
        "catalog.json",
        "closed.json",
        "locations.json",
        "closed.lock",
    ]
    .contains(&name)
    {
        return Err("writeDenied".into());
    }
    // Reject redirected user state before creating directories or replacing a file.
    let target = directory.join(name);
    for p in directory
        .ancestors()
        .chain(std::iter::once(target.as_path()))
    {
        if let Ok(m) = fs::symlink_metadata(p) {
            if m.file_type().is_symlink() {
                return Err("writeDenied".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err("writeDenied".into());
                }
            }
        }
    }
    fs::create_dir_all(directory).map_err(|_| "stateUnavailable".to_owned())?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_windows_drive_spellings_share_one_key() {
        for spelling in [
            r"C:\Users\Fixture\CLAUDE.md",
            "c:/users/fixture/CLAUDE.md/",
            r"\\?\C:\Users\Fixture\CLAUDE.md",
            "//?/C:/Users/Fixture/CLAUDE.md",
        ] {
            assert_eq!(normalized_spelling(spelling), "c:/users/fixture/claude.md");
        }
        assert_ne!(
            normalized_spelling("C:/Users/Fixture/CLAUDE.md"),
            normalized_spelling("D:/Users/Fixture/CLAUDE.md")
        );
    }

    #[test]
    fn normalized_windows_unc_spellings_share_one_key() {
        for spelling in [
            r"\\Server\Share\Folder\Note.md",
            "//server/share/FOLDER/note.md/",
            r"\\?\UNC\Server\Share\Folder\Note.md",
            "//?/unc/server/share/folder/note.md",
        ] {
            assert_eq!(normalized_spelling(spelling), "//server/share/folder/note.md");
        }
        assert_ne!(
            normalized_spelling("//server/share/folder/note.md"),
            normalized_spelling("//server/other/folder/note.md")
        );
    }

    #[test]
    fn normalized_spellings_preserve_roots_and_unix_case() {
        assert_eq!(normalized_spelling("/"), "/");
        assert_eq!(normalized_spelling(r"C:\"), "c:/");
        assert_eq!(normalized_spelling("C:////"), "c:/");
        assert_ne!(normalized_spelling("C:/"), normalized_spelling("C:"));
        assert_ne!(normalized_spelling("/"), normalized_spelling(""));
        assert_eq!(
            normalized_spelling("/Fixture/Note.md/"),
            if cfg!(windows) {
                "/fixture/note.md"
            } else {
                "/Fixture/Note.md"
            }
        );
        assert_eq!(
            normalized_spelling("/Fixture/Note.md") == normalized_spelling("/fixture/note.md"),
            cfg!(windows)
        );
    }

    #[test]
    fn normalized_missing_windows_paths_keep_one_identity() {
        let directory = tempfile::tempdir().unwrap();
        let ordinary = if cfg!(windows) {
            directory
                .path()
                .join("MYCMUX_MISSING_FIXTURE_0860")
                .join("Note.md")
        } else {
            PathBuf::from(r"C:\MYCMUX_MISSING_FIXTURE_0860\Note.md")
        };
        let extended = PathBuf::from(format!(
            r"\\?\{}",
            ordinary.to_string_lossy().replace('/', "\\").to_uppercase()
        ));
        assert!(!ordinary.exists() && !extended.exists());
        assert!(same_path(&ordinary, &extended));
        assert!(!same_path(&ordinary, &ordinary.with_file_name("other.md")));
    }
}
