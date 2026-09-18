//! The macOS menu bar.
//!
//! Tauri's default menu is fine except for one item: its Quit sends
//! `terminate:`, which ends the process without giving any window the chance to
//! write what it holds. The menu is therefore built here, identical to the
//! default in every other respect, with Quit replaced by an item that runs the
//! coordinated quit (`commands::quit`) and a Window entry that brings the main
//! window back after its close button hid it.
//!
//! Windows and Linux get no menu, exactly as before.

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::AppHandle;

/// Menu item ids the app handles itself.
#[cfg(target_os = "macos")]
pub const QUIT_ITEM_ID: &str = "mycmux://quit";
#[cfg(target_os = "macos")]
pub const SHOW_MAIN_ITEM_ID: &str = "mycmux://show-main";

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, QUIT_ITEM_ID, "mycmux を終了", true, Some("Cmd+Q"))?;
    let show_main = MenuItem::with_id(
        app,
        SHOW_MAIN_ITEM_ID,
        "mycmux のウィンドウ",
        true,
        Some("Cmd+0"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        "mycmux",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    // Without these the system shortcuts they carry (⌘C / ⌘V / ⌘X / ⌘A / ⌘Z)
    // do nothing in a WKWebView text field.
    let edit_menu = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("取り消す"))?,
            &PredefinedMenuItem::redo(app, Some("やり直す"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("切り取り"))?,
            &PredefinedMenuItem::copy(app, Some("コピー"))?,
            &PredefinedMenuItem::paste(app, Some("貼り付け"))?,
            &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "ウィンドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("しまう"))?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &show_main,
            &PredefinedMenuItem::close_window(app, Some("ウィンドウを閉じる"))?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        QUIT_ITEM_ID => crate::commands::quit::begin_quit(app),
        SHOW_MAIN_ITEM_ID => crate::commands::window::show_main_window(app),
        _ => {}
    });
    Ok(())
}
