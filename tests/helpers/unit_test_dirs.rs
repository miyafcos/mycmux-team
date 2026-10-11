//! Owned roots for library unit tests; independent of platform HOME/USERPROFILE resolution.
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;

thread_local! { static FIXTURE_HOME: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }
static PROCESS_HOME: OnceLock<tempfile::TempDir> = OnceLock::new();

pub(crate) fn home_dir() -> PathBuf {
    if let Some(home) = FIXTURE_HOME.with(|value| value.borrow().clone()) { return home; }
    PROCESS_HOME.get_or_init(|| {
        let home = tempfile::Builder::new().prefix(&format!("mycmux-lib-{}-", std::process::id())).tempdir().expect("owned unit-test home");
        std::fs::write(home.path().join("unit-test-home"), format!("owned by lib test process {}\n", std::process::id())).expect("unit-test home marker");
        home
    }).path().to_path_buf()
}

/// A fixture installs its own TempDir, without changing process-global environment variables.
#[must_use]
pub(crate) struct FixtureHome {
    previous: Option<PathBuf>,
    _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}
pub(crate) fn fixture_home(home: &tempfile::TempDir) -> FixtureHome {
    assert!(home.path().is_absolute());
    std::fs::write(home.path().join("unit-test-home"), "explicit owned unit fixture\n").unwrap();
    let previous = FIXTURE_HOME.with(|value| value.replace(Some(home.path().to_path_buf())));
    FixtureHome { previous, _thread_bound: std::marker::PhantomData }
}
impl Drop for FixtureHome {
    fn drop(&mut self) { FIXTURE_HOME.with(|value| value.replace(self.previous.take())); }
}

#[test]
fn fixture_home_is_explicit_thread_local_and_restored() {
    let default = home_dir();
    let fixture = tempfile::tempdir().unwrap();
    {
        let _owned = fixture_home(&fixture);
        assert_eq!(dirs::home_dir().unwrap(), fixture.path());
        assert_eq!(crate::test_profile::runtime_dir().unwrap(), fixture.path().join(".mycmux"));
        assert_eq!(std::thread::spawn(home_dir).join().unwrap(), default);
    }
    assert_eq!(home_dir(), default);
    assert!(default.join("unit-test-home").is_file());
}
