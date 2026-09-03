//! The directory candidates the launcher offers, read from the same two files
//! `launcher.sh` reads.
//!
//! The React launcher only picks a target; `launcher.sh` still owns the spawn
//! (session id, cwd restore, env preprocessing). These commands exist because
//! the picker moved to the frontend and nothing on that side could read
//! `~/.mycmux/launch-roots.txt` — `__load_roots_section` was the only parser in
//! the repo. The format stays as the bash side defines it, so a line edited by
//! hand keeps working in both launchers.

use std::path::PathBuf;

/// One row of `~/.mycmux/launch-roots.txt`, already split into its two fields.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LauncherDirEntry {
    /// Display name with the `案件:` prefix already stripped.
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct LauncherDirs {
    pub dev: Vec<LauncherDirEntry>,
    pub anken: Vec<LauncherDirEntry>,
    /// Most recently used directories, newest first. Paths only — the launcher
    /// shortens them for display.
    pub mru: Vec<String>,
}

/// Mirrors `__load_roots_section`: `表示名|フルパス`, `#` comments and blank
/// lines dropped, and a `案件:` prefix routing the row to the anken section.
fn parse_roots(contents: &str) -> (Vec<LauncherDirEntry>, Vec<LauncherDirEntry>) {
    let mut dev = Vec::new();
    let mut anken = Vec::new();

    for line in contents.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, path)) = line.split_once('|') else {
            continue;
        };
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        match name.strip_prefix("案件:") {
            Some(rest) => anken.push(LauncherDirEntry {
                label: rest.trim().to_string(),
                path: path.to_string(),
            }),
            None => dev.push(LauncherDirEntry {
                label: name.to_string(),
                path: path.to_string(),
            }),
        }
    }

    (dev, anken)
}

fn parse_mru(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn runtime_file(name: &str) -> Option<PathBuf> {
    crate::test_profile::runtime_dir()
        .ok()
        .map(|runtime_dir| runtime_dir.join(name))
}

/// Missing files are not an error: a fresh machine has neither, and the
/// launcher still has to draw its agent and web sections.
#[tauri::command]
pub async fn launcher_list_dirs() -> Result<LauncherDirs, String> {
    let roots = runtime_file("launch-roots.txt")
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mru = runtime_file("launch-dirs-mru.txt")
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();

    let (dev, anken) = parse_roots(&roots);
    Ok(LauncherDirs {
        dev,
        anken,
        mru: parse_mru(&mru),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_dev_and_anken_and_drops_comments() {
        let (dev, anken) = parse_roots(concat!(
            "# a comment\n",
            "\n",
            "mycmux (master)|C:/Users/miyaz/cmux-for-linux-dev-master\n",
            "案件: 駿台/モモスタ/数学 (●09/03)|C:/Users/miyaz/anken/math\n",
            "案件:東洋食品工業短期大学/2027年度入試|C:/Users/miyaz/anken/toyo\n",
        ));

        assert_eq!(
            dev,
            vec![LauncherDirEntry {
                label: "mycmux (master)".to_string(),
                path: "C:/Users/miyaz/cmux-for-linux-dev-master".to_string(),
            }]
        );
        assert_eq!(
            anken,
            vec![
                LauncherDirEntry {
                    label: "駿台/モモスタ/数学 (●09/03)".to_string(),
                    path: "C:/Users/miyaz/anken/math".to_string(),
                },
                LauncherDirEntry {
                    label: "東洋食品工業短期大学/2027年度入試".to_string(),
                    path: "C:/Users/miyaz/anken/toyo".to_string(),
                },
            ]
        );
    }

    #[test]
    fn drops_rows_missing_either_field() {
        let (dev, anken) = parse_roots("no-separator\n|C:/only/path\nlabel-only|\n");
        assert!(dev.is_empty());
        assert!(anken.is_empty());
    }

    #[test]
    fn keeps_a_path_that_contains_spaces_and_japanese() {
        let (_, anken) = parse_roots(
            "案件: なるゼミ/数学|C:/Users/miyaz/エデュ・プラニング合同会社 Dropbox/なるゼミ/数学\n",
        );
        assert_eq!(
            anken[0].path,
            "C:/Users/miyaz/エデュ・プラニング合同会社 Dropbox/なるゼミ/数学"
        );
    }

    #[test]
    fn mru_keeps_order_and_drops_blanks() {
        assert_eq!(
            parse_mru("C:/a\n\n  C:/b  \n"),
            vec!["C:/a".to_string(), "C:/b".to_string()]
        );
    }
}
