use std::fs::{self, File, FileTimes};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use flate2::read::GzDecoder;

use crate::ailog::mirror::{
    mirror_destination, run_once_with, write_metadata_gzip, FreeSpace, MirrorConfig,
    WARNING_TIER2_LOW_SPACE,
};
use crate::ailog::{index, KIND_CODEX};

struct FixedFreeSpace(Option<u64>);

impl FreeSpace for FixedFreeSpace {
    fn available_bytes(&self, _destination: &Path) -> Option<u64> {
        self.0
    }
}

struct MirrorFixture {
    _dir: tempfile::TempDir,
    source_root: PathBuf,
    tier1_root: PathBuf,
    tier2_root: PathBuf,
    state_path: PathBuf,
}

impl MirrorFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source_root = dir.path().join("source");
        let tier1_root = dir.path().join("tier1");
        let tier2_root = dir.path().join("tier2");
        fs::create_dir_all(&source_root).unwrap();
        let state_path = tier1_root.join(".mirror-state.json");
        Self {
            _dir: dir,
            source_root,
            tier1_root,
            tier2_root,
            state_path,
        }
    }

    fn config(&self, tier2: bool) -> MirrorConfig {
        MirrorConfig {
            sources: vec![(KIND_CODEX, self.source_root.clone())],
            tier1_root: self.tier1_root.clone(),
            tier2_root: tier2.then(|| self.tier2_root.clone()),
            state_path: self.state_path.clone(),
        }
    }

    fn write_source(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.source_root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
}

fn decode(path: &Path) -> Vec<u8> {
    let mut output = Vec::new();
    GzDecoder::new(File::open(path).unwrap())
        .read_to_end(&mut output)
        .unwrap();
    output
}

// The metadata filter is unused while tier 1 is off, but it is the thing a
// future metadata tier would be built on, so its record selection stays
// pinned rather than drifting untested.
#[test]
fn metadata_filter_keeps_exactly_the_three_index_record_kinds() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source(
        "rollout.jsonl",
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\"}}\r\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"m\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{}}\n",
        )
        .as_bytes(),
    );
    let destination = fixture.tier1_root.join("filtered.jsonl.gz");

    write_metadata_gzip(&source, &destination).unwrap();

    assert_eq!(
        decode(&destination),
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\"}}\r\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"m\"}}\n",
        )
        .as_bytes()
    );
}

#[test]
fn unchanged_stamp_skips_but_size_or_mtime_change_rewrites() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source(
        "2026/08/rollout.jsonl",
        b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"a\"}}
",
    );
    let config = fixture.config(true);
    let free = FixedFreeSpace(Some(u64::MAX));
    let destination = mirror_destination(
        &fixture.source_root,
        &source,
        &fixture.tier2_root,
        KIND_CODEX,
    )
    .unwrap();
    let fixed_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(fixed_time))
        .unwrap();

    let first = run_once_with(&config, &free);
    assert_eq!(first.tier2_written, 1);
    let first_bytes = fs::read(&destination).unwrap();

    let second = run_once_with(&config, &free);
    assert_eq!(second.tier2_written, 0);
    assert_eq!(second.tier2_skipped_unchanged, 1);
    assert_eq!(fs::read(&destination).unwrap(), first_bytes);

    // A live rollout is appended to while its session runs, so a mirror taken
    // once would freeze a partial file. Growth has to bring it back.
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"{\"type\":\"turn_context\",\"payload\":{}}
")
        .unwrap();
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(fixed_time))
        .unwrap();
    let size_moved = run_once_with(&config, &free);
    assert_eq!(size_moved.tier2_written, 1);
    let size_bytes = fs::read(&destination).unwrap();
    assert_ne!(size_bytes, first_bytes);

    // Rewritten in place at the same length: only the mtime says so.
    let same_len = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"b\"}}
{\"type\":\"turn_context\",\"payload\":{}}
";
    assert_eq!(same_len.len() as u64, fs::metadata(&source).unwrap().len());
    fs::write(&source, same_len).unwrap();
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(fixed_time + Duration::from_secs(5)))
        .unwrap();
    let mtime_moved = run_once_with(&config, &free);
    assert_eq!(mtime_moved.tier2_written, 1);
    assert!(String::from_utf8(decode(&destination)).unwrap().contains("\"id\":\"b\""));
}

// The local archive root belongs to session_archive.py, which writes full text
// there and skips any destination already newer than its source. Writing a
// metadata-only copy first would silently prevent the full one forever, so
// nothing is written locally at all.
#[test]
fn nothing_is_written_into_the_local_archive_root() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source(
        "2026/08/27/rollout.jsonl",
        b"{\"type\":\"session_meta\",\"payload\":{}}
",
    );
    let config = fixture.config(true);

    let report = run_once_with(&config, &FixedFreeSpace(Some(u64::MAX)));

    assert_eq!(report.tier1_written, 0);
    assert_eq!(report.tier1_skipped_kind, 1);
    assert_eq!(report.tier2_written, 1);
    let local = mirror_destination(
        &fixture.source_root,
        &source,
        &fixture.tier1_root,
        KIND_CODEX,
    )
    .unwrap();
    assert!(!local.exists(), "the local archive root is left to session_archive.py");
    let mut found = Vec::new();
    index::collect_archive_jsonl(&fixture.tier1_root.join(KIND_CODEX), &mut found, None);
    assert!(found.is_empty());
}

// Running out of room stops the off-machine copy, never the index that the
// analysis actually depends on.
#[test]
fn low_space_skips_the_full_text_tier_and_says_so() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source(
        "rollout.jsonl",
        b"{\"type\":\"session_meta\",\"payload\":{}}
",
    );
    let config = fixture.config(true);
    let report = run_once_with(
        &config,
        &FixedFreeSpace(Some(10 * 1024 * 1024 * 1024 - 1)),
    );
    let tier2 = mirror_destination(
        &fixture.source_root,
        &source,
        &fixture.tier2_root,
        KIND_CODEX,
    )
    .unwrap();

    assert!(!tier2.exists());
    assert_eq!(report.tier2_written, 0);
    assert_eq!(report.tier2_skipped_space, 1);
    assert_eq!(
        report.warning_code.as_deref(),
        Some(WARNING_TIER2_LOW_SPACE)
    );
}
