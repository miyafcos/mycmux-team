#[test]
fn explicit_e2e_home_overrides_the_platform_home_and_rejects_invalid_roots() {
    let synthetic = tempfile::tempdir().unwrap();
    std::fs::write(synthetic.path().join("restore-fixture-home"), "synthetic fixture only").unwrap();
    // Use a different root from HOME/USERPROFILE, so this is red on Mac too.
    let previous = std::env::var_os("MYCMUX_E2E_HOME");
    let result = std::panic::catch_unwind(|| {
        std::env::set_var("MYCMUX_E2E_HOME", synthetic.path());
        assert_eq!(dirs::home_dir().as_deref(), Some(synthetic.path()), "W21-1: every dirs caller must use the explicit synthetic home");
        assert_eq!(crate::test_profile::runtime_dir().unwrap(), synthetic.path().join(".mycmux"));
        for invalid in ["", "relative", synthetic.path().join("missing-marker").to_str().unwrap()] {
            std::env::set_var("MYCMUX_E2E_HOME", invalid);
            assert!(dirs::home_dir().is_none(), "W21-1: invalid isolation must not fall back to the real profile");
        }
    });
    match previous { Some(value) => std::env::set_var("MYCMUX_E2E_HOME", value), None => std::env::remove_var("MYCMUX_E2E_HOME") }
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
