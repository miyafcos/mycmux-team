//! Async IPC boundary for the profile-local directory ledger.

use tauri::Emitter;

use crate::launcher_dirs::{model::{LauncherDirsDoc, LauncherDirsView}, store};

async fn read_doc() -> Result<LauncherDirsView, String> {
    tauri::async_runtime::spawn_blocking(|| store::with_doc(|_| Ok(())))
        .await.map_err(|error| error.to_string())?
}

async fn change<F>(app: tauri::AppHandle, f: F) -> Result<LauncherDirsView, String>
where F: FnOnce(&mut LauncherDirsDoc) -> Result<(), String> + Send + 'static {
    let view = tauri::async_runtime::spawn_blocking(move || store::with_doc(f))
        .await.map_err(|error| error.to_string())??;
    app.emit("launcher-dirs://changed", ()).map_err(|error| error.to_string())?;
    Ok(view)
}

#[tauri::command]
pub async fn launcher_dirs_get(app: tauri::AppHandle) -> Result<LauncherDirsView, String> {
    let _ = app;
    read_doc().await
}

#[tauri::command]
pub async fn launcher_dirs_set_section_label(app: tauri::AppHandle, section_id: String, label: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| doc.set_section_label(&section_id, &label)).await
}

#[tauri::command]
pub async fn launcher_dirs_add_entry(app: tauri::AppHandle, section_id: String, path: String, label: Option<String>) -> Result<LauncherDirsView, String> {
    change(app, move |doc| doc.add_entry(&section_id, &path, label.as_deref())).await
}

#[tauri::command]
pub async fn launcher_dirs_update_entry(app: tauri::AppHandle, id: String, label: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| doc.update_entry(&id, &label)).await
}

#[tauri::command]
pub async fn launcher_dirs_remove_entry(app: tauri::AppHandle, id: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| { doc.remove_entry(&id); Ok(()) }).await
}

#[tauri::command]
pub async fn launcher_dirs_move_entry(app: tauri::AppHandle, id: String, direction: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| doc.move_entry(&id, &direction)).await
}

#[tauri::command]
pub async fn launcher_dirs_pin_entry(app: tauri::AppHandle, id: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| doc.pin_entry(&id)).await
}

#[tauri::command]
pub async fn launcher_dirs_ignore_path(app: tauri::AppHandle, path: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| { doc.ignore_path(&path); Ok(()) }).await
}

#[tauri::command]
pub async fn launcher_dirs_unignore_path(app: tauri::AppHandle, path: String) -> Result<LauncherDirsView, String> {
    change(app, move |doc| { doc.unignore_path(&path); Ok(()) }).await
}

#[tauri::command]
pub async fn launcher_dirs_export_roots(app: tauri::AppHandle) -> Result<LauncherDirsView, String> {
    change(app, |_| Ok(())).await
}

#[tauri::command]
pub async fn launcher_record_dir_mru(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store::record_dir_mru(&crate::test_profile::runtime_dir()?, &path))
        .await.map_err(|error| error.to_string())?
}
