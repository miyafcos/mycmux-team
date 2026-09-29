//! The Japanese text this module writes to disk or hands to the frontend, kept in
//! one file so the rest of `launcher_dirs` stays ASCII (the same rule
//! `launcherStrings.ts` follows on the frontend). Written by the parent session;
//! add constants here rather than putting non-ASCII literals elsewhere.

/// Built-in sections, in display order. The ids are fixed (`launcherHiddenIds`
/// and the bash `案件:` routing key on them); only the labels are the user's.
pub const DEFAULT_SECTIONS: [(&str, &str); 2] = [("dev", "開発"), ("anken", "案件")];

/// Comment lines at the top of the derived `launch-roots.txt`. Each line already
/// starts with `# ` and ends with a newline.
pub const ROOTS_TXT_HEADER: &str = "\
# mycmux が launch-dirs.json から書き出したファイルです。編集は 設定 → ランチャー で行ってください (手編集は次の書き出しで上書きされます)。
# 形式: 1行 = 表示名|フルパス。「案件: 」で始まる行が案件セクション。# short-root: の行は表示短縮の起点。
";

/// Prefix that routes a `launch-roots.txt` row to the anken section. The bash
/// parser (`__load_roots_section`) strips `案件: ` and `案件:`; the exporter
/// always writes this form.
pub const ANKEN_PREFIX: &str = "案件: ";

/// Field separator of a `launch-roots.txt` row (`表示名|フルパス`). A `|` inside
/// a label is replaced with `LABEL_SEPARATOR_REPLACEMENT` on export.
pub const FIELD_SEPARATOR: char = '|';
pub const LABEL_SEPARATOR_REPLACEMENT: char = '｜';

/// A label whose first character is `#` would read as a comment line in
/// `launch-roots.txt`; export writes this character instead (the JSON keeps the
/// user's label unchanged).
pub const LABEL_COMMENT_REPLACEMENT: char = '＃';

/// A dev-section label that starts with `案件:` would be routed to the anken
/// section by both readers; export writes the colon as this full-width form
/// (`案件：`) for dev rows so the row stays in the dev section.
pub const ANKEN_PREFIX_COLON_REPLACEMENT: &str = "案件：";

/// Comment key whose value is a directory the bash launcher shortens paths under.
pub const SHORT_ROOT_KEY: &str = "# short-root:";

/// Label prefix `update_launch_dev.py` put on its auto rows (`dev: name (MM/DD)`).
/// Stripped on import; never written on export.
pub const LEGACY_DEV_LABEL_PREFIX: &str = "dev: ";

/// Marker lines of the two auto blocks the retired private scripts maintained.
pub const LEGACY_DEV_BEGIN: &str = "# === AUTO-DEV BEGIN";
pub const LEGACY_DEV_END: &str = "# === AUTO-DEV END";
pub const LEGACY_ANKEN_BEGIN: &str = "# === AUTO-ANKEN BEGIN";
pub const LEGACY_ANKEN_END: &str = "# === AUTO-ANKEN END";

/// `rule_id` values given to rows imported from those blocks, so a later scan
/// rule can replace them wholesale.
pub const LEGACY_DEV_RULE_ID: &str = "legacy-dev";
pub const LEGACY_ANKEN_RULE_ID: &str = "legacy-anken";
