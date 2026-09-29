use tauri::State;

use crate::AppState;

#[tauri::command]
pub async fn agent_prompt_try_answer(
    state: State<'_, AppState>,
    pty_session_id: String,
    prompt_id: String,
) -> Result<bool, String> {
    state
        .hook_service
        .try_answer_prompt(pty_session_id, prompt_id)
        .await
}

#[tauri::command]
pub async fn agent_prompt_is_current_launch(
    state: State<'_, AppState>,
    pty_session_id: String,
    launch_id: String,
) -> Result<bool, String> {
    state
        .hook_service
        .is_current_launch(pty_session_id, launch_id)
        .await
}
