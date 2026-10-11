#[path = "../command_inventory.rs"]
mod inventory;

fn commands(source: &str) -> Result<Vec<String>, String> {
    inventory::parse_commands(source, "tauri::generate_handler")
}

#[test]
fn comments_with_delimiters_cannot_omit_the_last_command() {
    let source = r#"tauri::generate_handler![
        commands::create_session,
        // Socket replies [frontend completion]
        /* nested /* ] } ) */ comment */ socket::socket_response,
    ]"#;
    assert_eq!(commands(source).unwrap(), ["create_session", "socket_response"]);
}

#[test]
fn multiple_entries_on_one_line_match_separate_lines() {
    assert_eq!(commands("tauri::generate_handler![a::first, b::second,]").unwrap(), ["first", "second"]);
}

#[test]
fn alternate_macro_spacing_and_delimiters_are_recognized() {
    for source in ["tauri :: generate_handler ! [ a :: first, b::second ]",
                   "tauri::generate_handler! { a::first, b::second, }",
                   "tauri::generate_handler!(a::first, b::second)"] {
        assert_eq!(commands(source).unwrap(), ["first", "second"]);
    }
}

#[test]
fn macro_text_inside_comments_and_literals_is_not_registration() {
    let source = r###"// tauri::generate_handler![not_a_command]
      const TEXT: &str = "tauri::generate_handler![also_not_a_command]";
      const RAW: &str = r##" ] tauri::generate_handler![fake] "##;
      const CHAR: char = ']';
      tauri::generate_handler![commands::real_command]"###;
    assert_eq!(commands(source).unwrap(), ["real_command"]);
}

#[test]
fn attributes_expressions_and_literals_fail_closed() {
    for source in ["tauri::generate_handler![a::first, #[cfg(windows)] b::second]",
                   "tauri::generate_handler![a::first()]",
                   "tauri::generate_handler![a::first, [b::second]]",
                   "tauri::generate_handler![a::first, \"literal ]\"]",
                   "tauri::generate_handler![r#keyword]",
                   "tauri::generate_handler![a::first,,b::second]"] {
        assert!(commands(source).is_err(), "accepted unsupported syntax: {source}");
    }
}

#[test]
fn duplicates_missing_and_multiple_registrations_fail_closed() {
    for source in ["tauri::generate_handler![a::same, b::same]",
                   "tauri::generate_handler![]", "no registration",
                   "tauri::generate_handler![a::first]; tauri::generate_handler![b::second]"] {
        assert!(commands(source).is_err(), "accepted invalid inventory: {source}");
    }
}

#[test]
fn renaming_and_removing_commands_updates_the_inventory() {
    assert_eq!(commands("tauri::generate_handler![a::old, b::kept]").unwrap(), ["old", "kept"]);
    assert_eq!(commands("tauri::generate_handler![a::renamed, b::kept]").unwrap(), ["renamed", "kept"]);
    assert_eq!(commands("tauri::generate_handler![b::kept]").unwrap(), ["kept"]);
}

#[test]
fn malformed_comments_strings_and_delimiters_fail_closed() {
    for source in ["tauri::generate_handler![a::first /* unterminated ]",
                   "tauri::generate_handler![a::first, \"unterminated ]",
                   "tauri::generate_handler![a::first)", "tauri::generate_handler![a::first"] {
        assert!(commands(source).is_err(), "accepted malformed inventory: {source}");
    }
}
