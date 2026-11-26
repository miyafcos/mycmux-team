use std::fs::{self, File, FileTimes};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use flate2::read::GzDecoder;

use crate::ailog::mirror::{
    available_on_mount, mirror_destination, run_once_with, set_full_text_root, write_metadata_gzip,
    FreeSpace, MirrorConfig,
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

#[test]
fn lane_a_no_full_text_destination_leaves_the_mirror_idle() {
    struct NoSpaceProbe;
    impl FreeSpace for NoSpaceProbe {
        fn available_bytes(&self, _: &Path) -> Option<u64> {
            panic!("the mirror is disabled");
        }
    }

    let fixture = MirrorFixture::new();
    fixture.write_source("rollout.jsonl", b"{fixture}\n");
    let mut config = fixture.config(false);
    config.state_path = fixture._dir.path().join("state.json");
    // This state would fail to parse if the disabled mirror accessed it.
    fs::write(&config.state_path, b"obsolete mirror state").unwrap();
    let report = run_once_with(&config, &NoSpaceProbe);
    assert_eq!(report, crate::ailog::mirror::MirrorReport::default());
    assert_eq!(fs::read(&config.state_path).unwrap(), b"obsolete mirror state");
    assert!(!fixture.tier2_root.exists());
    assert!(!fixture.tier1_root.exists());
}

#[test]
fn lane_a_full_text_mirror_setting_requires_an_absolute_path_and_persists_off() {
    use crate::db::storage;

    let serial = storage::persistence_test_lock();
    storage::reset_quarantined_schema_for_test();
    let fixture = MirrorFixture::new();
    let settings = fixture._dir.path().join("data.json");
    let destination = fixture.tier2_root.to_str().unwrap();
    let relative = set_full_text_root(settings.as_path(), Some("relative/path".into()));
    let wrote_file_for_relative = settings.exists();
    let configured = set_full_text_root(settings.as_path(), Some(destination.to_owned())).unwrap();
    let reloaded = storage::load(settings.as_path()).unwrap().settings.ailog_mirror_full_text_root;
    let disabled = set_full_text_root(settings.as_path(), None).unwrap();
    assert!(disabled.revision > configured.revision);
    let configured = configured.root;
    let disabled = disabled.root;
    let reloaded_off = storage::load(settings.as_path()).unwrap().settings.ailog_mirror_full_text_root;
    drop(serial);

    assert_eq!(relative.unwrap_err(), "ailog.mirror.root_not_absolute");
    assert!(!wrote_file_for_relative);
    assert_eq!(configured.as_deref(), Some(destination));
    assert_eq!(reloaded, configured);
    assert_eq!(disabled, None);
    assert_eq!(reloaded_off, None);
}

#[test]
fn full_mirror_writes_replaces_and_skips_destinations_over_260_chars() {
    let mut fixture = MirrorFixture::new();
    for _ in 0..7 {
        fixture.tier2_root.push("long-mirror-directory-0123456789abcdef");
    }
    let source = fixture.write_source("rollout.jsonl", b"first transcript\n");
    let config = fixture.config(true);
    let free = FixedFreeSpace(Some(u64::MAX));
    let destination = mirror_destination(
        &fixture.source_root,
        &source,
        &fixture.tier2_root,
        KIND_CODEX,
    )
    .unwrap();
    assert!(destination.as_os_str().len() > 260);

    let first = run_once_with(&config, &free);
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(first.tier2_written, 1);
    assert_eq!(decode(&destination), b"first transcript\n");

    fs::write(&source, b"second, longer transcript\n").unwrap();
    let second = run_once_with(&config, &free);
    assert!(second.errors.is_empty(), "{:?}", second.errors);
    assert_eq!(second.tier2_written, 1);
    assert_eq!(decode(&destination), b"second, longer transcript\n");

    let third = run_once_with(&config, &free);
    assert!(third.errors.is_empty(), "{:?}", third.errors);
    assert_eq!(third.tier2_written, 0);
    assert_eq!(third.tier2_skipped_unchanged, 1);
    assert_eq!(fs::read_dir(destination.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn lane_d_switching_back_refreshes_the_full_text_copy() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source("2026/08/rollout.jsonl", b"{\"part\":1}\n");
    let config_a = fixture.config(true);
    let mut config_b = config_a.clone();
    let root_b = fixture._dir.path().join("another-mirror");
    config_b.tier2_root = Some(root_b.clone());
    let free = FixedFreeSpace(Some(u64::MAX));
    let gzip_a = mirror_destination(&fixture.source_root, &source, &fixture.tier2_root, KIND_CODEX).unwrap();
    let gzip_b = mirror_destination(&fixture.source_root, &source, &root_b, KIND_CODEX).unwrap();

    assert_eq!(run_once_with(&config_a, &free).tier2_written, 1);
    assert_eq!(decode(&gzip_a), b"{\"part\":1}\n");
    fs::OpenOptions::new().append(true).open(&source).unwrap()
        .write_all(b"{\"part\":2}\n").unwrap();
    let full = fs::read(&source).unwrap();
    assert_eq!(run_once_with(&config_b, &free).tier2_written, 1);
    assert_eq!(decode(&gzip_b), full);
    assert_ne!(decode(&gzip_a), full);

    run_once_with(&config_a, &free);
    assert_eq!(decode(&gzip_a), full);
    assert_eq!(run_once_with(&config_a, &free).tier2_skipped_unchanged, 1);
}

#[test]
fn lane_d_free_space_uses_the_deepest_ancestor_mount() {
    let (root, nested, sibling, child) = if cfg!(windows) {
        (r"C:\", r"C:\mnt\data", r"c:\MNT\data-old\logs", r"c:\MNT\DATA\logs")
    } else {
        ("/", "/mnt/data", "/mnt/data-old/logs", "/mnt/data/logs")
    };
    let mounts = [(Path::new(nested), 20), (Path::new(root), 5)];
    assert_eq!(available_on_mount(Path::new(child), mounts), Some(20));
    assert_eq!(available_on_mount(Path::new(sibling), mounts), Some(5));
}

#[test]
fn lane_f_checks_the_real_mount_for_an_existing_or_uncreated_destination() {
    struct MountedSpace<'a>([(&'a Path, u64); 3]);
    impl FreeSpace for MountedSpace<'_> {
        fn available_bytes(&self, destination: &Path) -> Option<u64> {
            available_on_mount(destination, self.0)
        }
    }

    let fixture = MirrorFixture::new();
    let base = fixture._dir.path().canonicalize().unwrap();
    #[cfg(windows)]
    let base = PathBuf::from(crate::pty::path_norm::strip_extended_length_prefix(&base.to_string_lossy()));
    let visible_mount = base.join("visible");
    let real_mount = base.join("actual").join("nested");
    fs::create_dir_all(visible_mount.join("step")).unwrap();
    fs::create_dir_all(&real_mount).unwrap();
    let link = visible_mount.join("redirect");
    #[cfg(unix)]
    let link_created = {
        std::os::unix::fs::symlink(&real_mount, &link).unwrap();
        true
    };
    #[cfg(windows)]
    let link_created = {
        // mklink accepts plain DOS spellings rather than Win32 extended paths.
        let plain = |p: &Path| crate::pty::path_norm::strip_extended_length_prefix(&p.to_string_lossy());
        let output = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
            .arg(plain(&link)).arg(plain(&real_mount)).output();
        let created = output.is_ok_and(|out| out.status.success());
        if !created {
            eprintln!("junction unavailable; testing parent traversal instead");
        }
        created
    };
    let real = if link_created {
        visible_mount.join("step").join("..").join("redirect")
    } else {
        visible_mount.join("..").join("actual").join("nested")
    };
    let available = MountedSpace([
        (&real_mount, 5 << 30),
        (&visible_mount, 20 << 30),
        (&base, 20 << 30),
    ]);
    let source = fixture.write_source("rollout.jsonl", b"fixture transcript\n");
    let mut config = fixture.config(true);
    for destination in [real.clone(), real.join("not-created").join("deeper")] {
        let gzip = mirror_destination(&fixture.source_root, &source, &destination, KIND_CODEX).unwrap();
        config.tier2_root = Some(destination);
        let report = run_once_with(&config, &available);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.warning_code.as_deref(), Some(WARNING_TIER2_LOW_SPACE));
        assert_eq!(report.tier2_skipped_space, 1);
        assert!(!gzip.exists());
    }
}

#[test]
fn lane_f_refreshes_full_text_on_swapped_media_with_the_same_display_path() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source("rollout.jsonl", b"{\"part\":1}\n");
    let config = fixture.config(true);
    let free = FixedFreeSpace(Some(u64::MAX));
    let display = &fixture.tier2_root;
    let offline_a = fixture._dir.path().join("offline-a");
    let offline_b = fixture._dir.path().join("offline-b");
    let destination = mirror_destination(&fixture.source_root, &source, display, KIND_CODEX).unwrap();

    assert_eq!(run_once_with(&config, &free).tier2_written, 1);
    assert_eq!(decode(&destination), b"{\"part\":1}\n");
    let partial_size = fs::metadata(&destination).unwrap().len();
    fs::rename(display, &offline_a).unwrap();
    fs::create_dir(display).unwrap();
    fs::OpenOptions::new().append(true).open(&source).unwrap()
        .write_all(b"{\"part\":2,\"text\":\"second portion of the fixture transcript\"}\n").unwrap();

    let full = fs::read(&source).unwrap();
    assert_eq!(run_once_with(&config, &free).tier2_written, 1);
    assert_eq!(decode(&destination), full);
    assert_ne!(fs::metadata(&destination).unwrap().len(), partial_size);
    assert_eq!(run_once_with(&config, &free).tier2_skipped_unchanged, 1);
    fs::rename(display, &offline_b).unwrap();
    fs::rename(&offline_a, display).unwrap();

    let report = run_once_with(&config, &free);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(decode(&destination), full);
    assert_eq!(report.tier2_written, 1);
    assert_eq!(run_once_with(&config, &free).tier2_skipped_unchanged, 1);
}

#[test]
fn lane_f_legacy_full_text_state_cannot_prove_the_copy_is_current() {
    let fixture = MirrorFixture::new();
    let source = fixture.write_source("rollout.jsonl", b"fixture transcript\n");
    let mut config = fixture.config(true);
    let free = FixedFreeSpace(Some(u64::MAX));
    let destination = mirror_destination(&fixture.source_root, &source, &fixture.tier2_root, KIND_CODEX).unwrap();
    assert_eq!(run_once_with(&config, &free).tier2_written, 1);

    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&config.state_path).unwrap()).unwrap();
    for entry in state["sources"].as_object_mut().unwrap().values_mut() {
        entry.as_object_mut().unwrap().remove("tier2_destination");
    }
    config.state_path = fixture._dir.path().join("legacy-mirror-state.json");
    fs::write(&config.state_path, serde_json::to_vec(&state).unwrap()).unwrap();

    let report = run_once_with(&config, &free);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.tier2_written, 1);
    assert_eq!(decode(&destination), b"fixture transcript\n");
    assert_eq!(run_once_with(&config, &free).tier2_skipped_unchanged, 1);
}
