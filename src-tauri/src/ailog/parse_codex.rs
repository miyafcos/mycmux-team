//! Parser for Codex rollout transcripts
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`).
//!
//! Three facts about the format matter for correctness:
//!
//! 1. **`total_token_usage` is cumulative, `last_token_usage` is the delta.**
//!    Per-turn rows use `last_token_usage`; summing both would roughly double
//!    the session.
//! 2. **`input_tokens` already contains `cached_input_tokens`.** The invariant
//!    `total_tokens == input_tokens + output_tokens` holds on real records, so
//!    the cached half is subtracted before storing the uncached input — cache
//!    reads are an order of magnitude cheaper and must not be billed at the
//!    full input rate.
//! 3. **`reasoning_output_tokens` is a subset of `output_tokens`.** It is kept
//!    for reporting but never priced separately.
//!
//! The model can change mid-session, so each `token_count` is attributed to
//! the model named by the most recent `turn_context`.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::ailog::{
    metrics, parse_ts, truncate_chars, ChunkData, ResultRow, SessionChunk, ToolRow, TurnRow,
    KIND_CODEX, ORIGIN_AILOG_INTERNAL, ORIGIN_OTHER, ORIGIN_UNKNOWN,
};

const FIRST_PROMPT_CHARS: usize = 300;
const AILOG_SUMMARIZER_MARKER: &str = "[mycmux-ailog-summarizer]";
const NEXT_ACTION_MARKER: &str = "[mycmux-next-action]";

/// Human-readable rollout evidence shared with the summary pipeline.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RolloutMaterial {
    pub user: Vec<String>,
    pub errors: Vec<String>,
    pub assistant_last: Option<String>,
}

pub fn extract_material(text: &str) -> RolloutMaterial {
    parse_rollout(text, "material-only", CodexParseState::default()).1
}

/// Leading markers that identify a `role: "user"` record as harness-injected
/// context rather than something the operator typed.
const INJECTED_PREFIXES: &[&str] = &[
    "<recommended_plugins>",
    "<user_instructions>",
    "<environment_context>",
    "<plan_mode>",
    "<system_reminder>",
    "<INSTRUCTIONS>",
    "# Codex CLI",
];

/// How a Codex source binds records to a session id.
///
/// `CanonicalFilename` is for a newly discovered standard rollout.
/// `LegacyCompat` keeps writing to a stored mismatched id without migrating it.
/// `InFileIdentity` is the nonstandard fixture path (`rollout-CX1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionBehavior {
    CanonicalFilename,
    LegacyCompat,
    InFileIdentity,
}

impl SessionBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CanonicalFilename => "canonical_filename",
            Self::LegacyCompat => "legacy_compat",
            Self::InFileIdentity => "in_file_identity",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "canonical_filename" => Some(Self::CanonicalFilename),
            "legacy_compat" => Some(Self::LegacyCompat),
            "in_file_identity" => Some(Self::InFileIdentity),
            _ => None,
        }
    }
}

impl Default for SessionBehavior {
    fn default() -> Self {
        Self::InFileIdentity
    }
}

/// Parser state carried across incremental chunks of one rollout.
///
/// Codex transcripts are append-only. A later byte range often starts after
/// `session_meta` / `turn_context`, so the indexer seeds the next parse from
/// the already-consumed prefix instead of resetting model/effort to None.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CodexParseState {
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// When true, later `session_meta.id` values cannot replace `session_id`.
    /// Set for legacy-compat sources whose stored id is not a filename UUID.
    pub session_locked: bool,
    pub session_behavior: SessionBehavior,
}

/// Extract the rollout UUID from a Codex file stem.
///
/// The documented grammar is `rollout-<timestamp>-<uuid>` where `<uuid>` is
/// the trailing 8-4-4-4-12 token. The ISO timestamp itself contains hyphens
/// (`2026-08-24T13-03-20`), so splitting on the first few `-` tokens yields a
/// composite `08-24T...-UUID` rather than the authoritative id.
///
/// Stems that do not match the grammar — including test fixtures such as
/// `rollout-CX1` and non-rollout names like `notes-<uuid>` — return unchanged
/// so in-file `session_meta.id` can still be adopted.
pub fn session_id_from_filename(stem: &str) -> &str {
    standard_rollout_filename_uuid(stem).unwrap_or(stem)
}

/// Trailing UUID of a standard `rollout-<timestamp>-<uuid>` stem.
///
/// Authoritative grammar is `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>`. Stems such
/// as `rollout-x-<uuid>` or `rollout-backup-<uuid>` are not standard.
pub fn standard_rollout_filename_uuid(stem: &str) -> Option<&str> {
    let rest = stem.strip_prefix("rollout-")?;
    let uuid = trailing_uuid(stem)?;
    let ts_len = rest.len().checked_sub(uuid.len() + 1)?;
    if ts_len == 0 {
        return None;
    }
    let timestamp = &rest[..ts_len];
    if !is_standard_rollout_timestamp(timestamp) {
        return None;
    }
    Some(uuid)
}

fn is_standard_rollout_timestamp(timestamp: &str) -> bool {
    let bytes = timestamp.as_bytes();
    if bytes.len() != 19 {
        return false;
    }
    fn digits(slice: &[u8]) -> bool {
        slice.iter().all(u8::is_ascii_digit)
    }
    digits(&bytes[0..4])
        && bytes[4] == b'-'
        && digits(&bytes[5..7])
        && bytes[7] == b'-'
        && digits(&bytes[8..10])
        && bytes[10] == b'T'
        && digits(&bytes[11..13])
        && bytes[13] == b'-'
        && digits(&bytes[14..16])
        && bytes[16] == b'-'
        && digits(&bytes[17..19])
}

/// True when `stored` is the pre-fix composite fallback for `filename_id`.
///
/// Old indexer code used `stem.splitn(3, '-')` and stored values like
/// `08-24T13-03-20-<uuid>` as the session id of an incremental chunk.
pub fn is_legacy_filename_session(stored: &str, filename_id: &str) -> bool {
    stored != filename_id
        && is_rollout_uuid(filename_id)
        && stored.ends_with(filename_id)
        && stored.contains('T')
}

/// True when an existing source should keep its stored session id.
///
/// Standard filename UUID is still authoritative for *new* sources. This
/// detector only marks the 0.57.1 compatibility path: append to the stored
/// id, never split/migrate it.
pub fn is_legacy_compat_source(stored: &str, filename_id: &str) -> bool {
    is_rollout_uuid(filename_id) && stored != filename_id
}

pub fn is_rollout_uuid(value: &str) -> bool {
    trailing_uuid(value).is_some() && value.len() == 36
}

fn trailing_uuid(stem: &str) -> Option<&str> {
    const UUID_LEN: usize = 36;
    if stem.len() < UUID_LEN {
        return None;
    }
    let start = stem.len() - UUID_LEN;
    if start > 0 && stem.as_bytes()[start - 1] != b'-' {
        return None;
    }
    let candidate = &stem[start..];
    if is_uuid_shape(candidate) {
        Some(candidate)
    } else {
        None
    }
}

fn is_uuid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Do not let a later `session_meta` (the parent thread id) replace a
/// filename-derived rollout UUID, and do not let it escape a legacy-compat
/// stored id. Test fixtures that are not UUIDs still adopt `payload.id`.
fn should_adopt_session_id(current: &str, incoming: &str, locked: bool) -> bool {
    if locked {
        return current.is_empty() || current == incoming;
    }
    true
}

/// Replay prefix records that affect parser state without emitting turns.
pub fn parse_state_from_text(text: &str) -> CodexParseState {
    let mut state = CodexParseState::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !(line.contains("\"session_meta\"")
            || line.contains("\"turn_context\"")
            || line.contains("thread_settings_applied"))
        {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let outer = value.get("type").and_then(Value::as_str).unwrap_or("");
        let inner = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match (outer, inner) {
            ("session_meta", _) => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    if should_adopt_session_id(
                        state.session_id.as_deref().unwrap_or(""),
                        id,
                        state.session_locked,
                    ) {
                        state.session_id = Some(id.to_string());
                    }
                }
            }
            ("turn_context", _) => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    state.model = Some(model.to_string());
                }
                if let Some(effort) = payload.get("effort").and_then(Value::as_str) {
                    state.effort = Some(effort.to_string());
                }
            }
            ("event_msg", "thread_settings_applied") => {
                let settings = payload
                    .get("thread_settings")
                    .cloned()
                    .unwrap_or(Value::Null);
                if state.model.is_none() {
                    state.model = settings
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if state.effort.is_none() {
                    state.effort = settings
                        .get("reasoning_effort")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            _ => {}
        }
    }
    state
}

/// Parse a run of complete JSONL lines from one rollout file.
///
/// `fallback_session` should be the rollout id embedded in the file name. For
/// a standard `rollout-<timestamp>-<uuid>` file that UUID is sticky: later
/// `session_meta` records (including a parent thread id) never replace it.
pub fn parse_chunk(text: &str, fallback_session: &str) -> ChunkData {
    let mut seed = CodexParseState::default();
    if is_rollout_uuid(fallback_session) {
        // This convenience API receives an already-extracted standard rollout
        // UUID. The indexer uses parse_chunk_with_state and carries the stricter
        // filename classification explicitly.
        seed.session_id = Some(fallback_session.to_string());
        seed.session_locked = true;
        seed.session_behavior = SessionBehavior::CanonicalFilename;
    }
    parse_chunk_with_state(text, fallback_session, seed)
}

/// Parse a chunk starting from previously observed model/effort.
///
/// `seed.session_id` is ignored when `fallback_session` is a standard rollout
/// UUID so a parent-only prefix cannot merge the child into the parent.
pub fn parse_chunk_with_state(
    text: &str,
    fallback_session: &str,
    seed: CodexParseState,
) -> ChunkData {
    parse_rollout(text, fallback_session, seed).0
}

/// Last model/effort recorded in `text`. Session identity is not taken from
/// suffix `session_meta` records; callers that need an id use the filename.
pub fn parse_model_state_from_text(text: &str) -> CodexParseState {
    let mut state = parse_state_from_text(text);
    state.session_id = None;
    state
}

/// Parse indexing data and summary evidence in one JSONL traversal so both
/// consumers agree on user messages, final assistant text, and errors.
fn parse_rollout(
    text: &str,
    fallback_session: &str,
    seed: CodexParseState,
) -> (ChunkData, RolloutMaterial) {
    let mut data = ChunkData::default();
    let lock_session = seed.session_locked;
    let session_id = if lock_session {
        seed.session_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .filter(|_| seed.session_locked)
            .unwrap_or(fallback_session)
            .to_string()
    } else {
        seed.session_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback_session)
            .to_string()
    };
    let mut session = SessionChunk::new(KIND_CODEX, session_id);
    let mut material = RolloutMaterial::default();

    let mut current_model: Option<String> = seed.model;
    let mut current_effort: Option<String> = seed.effort;
    let mut call_names: HashMap<String, String> = HashMap::new();
    let mut turn_starts: HashMap<String, i64> = HashMap::new();
    let mut seen_prompts: HashSet<String> = HashSet::new();
    let mut turn_keys: HashSet<String> = HashSet::new();
    let mut material_users: HashSet<String> = HashSet::new();
    let mut material_errors: HashSet<String> = HashSet::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                data.parse_errors += 1;
                continue;
            }
        };
        data.lines += 1;

        let ts = parse_ts(value.get("timestamp").and_then(Value::as_str)).unwrap_or(0);
        session.stamp(ts);
        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let outer = value.get("type").and_then(Value::as_str).unwrap_or("");
        let inner = payload.get("type").and_then(Value::as_str).unwrap_or("");

        match (outer, inner) {
            ("session_meta", _) => apply_session_meta(&mut session, &payload, lock_session),
            ("turn_context", _) => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    current_model = Some(model.to_string());
                }
                if let Some(effort) = payload.get("effort").and_then(Value::as_str) {
                    current_effort = Some(effort.to_string());
                }
                if session.cwd.is_none() {
                    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                        session.cwd = Some(cwd.to_string());
                    }
                }
            }
            ("event_msg", "thread_settings_applied") => {
                let settings = payload
                    .get("thread_settings")
                    .cloned()
                    .unwrap_or(Value::Null);
                if current_model.is_none() {
                    current_model = settings
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if current_effort.is_none() {
                    current_effort = settings
                        .get("reasoning_effort")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            ("event_msg", "token_count") => handle_token_count(
                &mut session,
                &value,
                &payload,
                ts,
                current_model.as_deref(),
                current_effort.as_deref(),
                &mut turn_keys,
            ),
            ("event_msg", "task_started") => {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    turn_starts.insert(turn_id.to_string(), ts);
                }
            }
            ("event_msg", "task_complete") => {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    if let Some(start) = turn_starts.remove(turn_id) {
                        if ts > start {
                            add_duration(&mut session, ts - start);
                        }
                    }
                }
            }
            ("event_msg", "turn_aborted") => {
                let duration = payload
                    .get("duration_ms")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if duration > 0 {
                    add_duration(&mut session, duration);
                }
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    turn_starts.remove(turn_id);
                }
                let reason = payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("turn aborted")
                    .trim()
                    .to_string();
                record_material_error(&mut material, &mut material_errors, reason, true);
            }
            ("event_msg", "user_message") => {
                if let Some(message) = payload.get("message").and_then(Value::as_str) {
                    if is_internal_marker(message.trim_start()) {
                        session.origin = ORIGIN_AILOG_INTERNAL.to_string();
                    }
                    record_user_text(&mut session, message, &mut seen_prompts);
                    record_material_user(&mut material, &mut material_users, message);
                }
            }
            ("event_msg", "context_compacted") => session.compact_count += 1,
            ("compacted", _) => session.compact_count += 1,
            ("response_item", "message") => {
                if payload.get("role").and_then(Value::as_str) == Some("user") {
                    let text = collect_text(payload.get("content"));
                    if is_internal_marker(text.trim_start()) {
                        session.origin = ORIGIN_AILOG_INTERNAL.to_string();
                    }
                    record_user_text(&mut session, &text, &mut seen_prompts);
                    record_material_user(&mut material, &mut material_users, &text);
                } else if payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    let text = collect_text(payload.get("content")).trim().to_string();
                    if !text.is_empty() {
                        material.assistant_last = Some(text);
                    }
                }
            }
            ("response_item", "function_call") | ("response_item", "custom_tool_call") => {
                handle_tool_call(&mut session, &payload, ts, inner, &mut call_names);
            }
            ("response_item", "function_call_output")
            | ("response_item", "custom_tool_call_output") => {
                let raw = payload
                    .get("output")
                    .or_else(|| payload.get("content"))
                    .map(|value| collect_text(Some(value)))
                    .unwrap_or_default();
                if payload
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || raw.to_ascii_lowercase().contains("error")
                {
                    record_material_error(&mut material, &mut material_errors, raw, false);
                }
                handle_tool_output(&mut session, &payload, ts, &call_names);
            }
            ("event_msg", "patch_apply_end") => {
                // The only place Codex reports patch success as a boolean.
                if let (Some(call_id), Some(success)) = (
                    payload.get("call_id").and_then(Value::as_str),
                    payload.get("success").and_then(Value::as_bool),
                ) {
                    if !success {
                        session.results.push(ResultRow {
                            call_id: call_id.to_string(),
                            ts,
                            is_error: true,
                            chars: 0,
                            name: Some("apply_patch".to_string()),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    session.turn_count_hint = session.turns.len() as i64;
    let session_id = session.session_id.clone();
    data.sessions.insert(session_id, session);
    (data, material)
}

fn record_material_user(material: &mut RolloutMaterial, seen: &mut HashSet<String>, text: &str) {
    let text = text.trim().to_string();
    if !text.is_empty() && !is_internal_marker(&text) && seen.insert(text.clone()) {
        material.user.push(text);
    }
}

fn is_internal_marker(text: &str) -> bool {
    text.starts_with(AILOG_SUMMARIZER_MARKER) || text.starts_with(NEXT_ACTION_MARKER)
}

fn record_material_error(
    material: &mut RolloutMaterial,
    seen: &mut HashSet<String>,
    text: String,
    include_empty: bool,
) {
    if (include_empty || !text.is_empty()) && seen.insert(text.clone()) {
        material.errors.push(text);
    }
}

fn apply_session_meta(session: &mut SessionChunk, payload: &Value, locked: bool) {
    // `payload.id` is the rollout's own id and matches the file name;
    // `payload.session_id` names the root thread a subagent belongs to.
    if let Some(id) = payload.get("id").and_then(Value::as_str) {
        if should_adopt_session_id(&session.session_id, id, locked) {
            session.session_id = id.to_string();
        }
    }
    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
        session.cwd = Some(cwd.to_string());
    }
    if let Some(version) = payload.get("cli_version").and_then(Value::as_str) {
        session.cli_version = Some(version.to_string());
    }
    if let Some(nickname) = payload.get("agent_nickname").and_then(Value::as_str) {
        let nickname = nickname.trim().to_string();
        if !nickname.is_empty() && !session.agent_names.contains(&nickname) {
            session.agent_names.push(nickname);
        }
    }
    if payload.get("thread_source").and_then(Value::as_str) == Some("subagent") {
        session.is_sidechain = true;
    }
    if payload
        .get("source")
        .and_then(Value::get_subagent)
        .unwrap_or(false)
    {
        session.is_sidechain = true;
    }

    let originator = payload.get("originator").and_then(Value::as_str);
    session.entrypoint = originator.map(str::to_string);
    // `source` is either a plain host string ("cli", "vscode") or an object
    // describing a subagent spawn.
    let source_str = payload.get("source").and_then(Value::as_str);
    session.origin = match (originator, source_str) {
        (Some("Claude Code"), _) => ORIGIN_OTHER.to_string(),
        (_, Some("vscode")) => ORIGIN_OTHER.to_string(),
        _ => ORIGIN_UNKNOWN.to_string(),
    };
}

trait SubagentSource {
    fn get_subagent(&self) -> Option<bool>;
}

impl SubagentSource for Value {
    fn get_subagent(&self) -> Option<bool> {
        self.as_object().map(|map| map.contains_key("subagent"))
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_token_count(
    session: &mut SessionChunk,
    value: &Value,
    payload: &Value,
    ts: i64,
    model: Option<&str>,
    effort: Option<&str>,
    turn_keys: &mut HashSet<String>,
) {
    let info = payload.get("info").cloned().unwrap_or(Value::Null);
    let last = info.get("last_token_usage").cloned().unwrap_or(Value::Null);
    let total = info
        .get("total_token_usage")
        .cloned()
        .unwrap_or(Value::Null);
    if last.is_null() {
        return;
    }

    // Content-derived so the key survives an incremental resume: a per-file
    // counter would restart at zero on the next chunk and collide.
    let ordinal = value.get("ordinal").and_then(Value::as_i64).unwrap_or(-1);
    let key = format!("tc:{ordinal}:{ts}:{}", num(&total, "total_tokens"));
    if !turn_keys.insert(key.clone()) {
        return;
    }

    let raw_input = num(&last, "input_tokens");
    let cached = num(&last, "cached_input_tokens");
    let uncached = (raw_input - cached).max(0);

    if let Some(rate_limits) = payload.get("rate_limits") {
        if let Some(plan) = rate_limits.get("plan_type").and_then(Value::as_str) {
            session.plan_type = Some(plan.to_string());
        }
    }

    session.turns.push(TurnRow {
        dedup_key: key,
        ts,
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
        service_tier: None,
        input_tokens: uncached,
        output_tokens: num(&last, "output_tokens"),
        cache_read_tokens: cached,
        // Codex reports a single cache-write counter with no TTL split; it is
        // stored in the 5-minute column and priced at the input rate.
        cache_write_5m_tokens: num(&last, "cache_write_input_tokens"),
        cache_write_1h_tokens: 0,
        reasoning_tokens: num(&last, "reasoning_output_tokens"),
        reported_cost_usd: None,
        duration_ms: None,
        tool_calls: 0,
        tool_errors: 0,
    });
}

fn add_duration(session: &mut SessionChunk, duration: i64) {
    session.active_ms += duration;
    if let Some(last) = session.turns.last_mut() {
        last.duration_ms = Some(last.duration_ms.unwrap_or(0) + duration);
    }
}

fn handle_tool_call(
    session: &mut SessionChunk,
    payload: &Value,
    ts: i64,
    inner: &str,
    call_names: &mut HashMap<String, String>,
) {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let call_id = payload
        .get("call_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(id) = &call_id {
        call_names.insert(id.clone(), name.clone());
    }

    // `function_call` carries a JSON string in `arguments`; `custom_tool_call`
    // carries free-form JS in `input` that wraps a `tools.*` call.
    let raw_args = if inner == "custom_tool_call" {
        payload.get("input").and_then(Value::as_str).unwrap_or("")
    } else {
        payload
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("")
    };

    let target = codex_target(&name, raw_args);
    if metrics::classify_tool(&name) == metrics::ToolClass::Edit {
        for path in patch_paths(raw_args) {
            session.touch_file(&path, ts, 1, 0);
        }
        session.write_chars += raw_args.chars().count() as i64;
    }

    if let Some(last) = session.turns.last_mut() {
        last.tool_calls += 1;
    }
    session.tools.push(ToolRow {
        call_id,
        ts,
        name,
        is_error: false,
        target,
        turn_key: session.turns.last().map(|turn| turn.dedup_key.clone()),
    });
    session.ends_on_tool = true;
}

fn handle_tool_output(
    session: &mut SessionChunk,
    payload: &Value,
    ts: i64,
    call_names: &HashMap<String, String>,
) {
    let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
        return;
    };
    let text = match payload.get("output") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => collect_text(payload.get("output")),
        _ => String::new(),
    };
    session.results.push(ResultRow {
        call_id: call_id.to_string(),
        ts,
        is_error: output_is_error(&text),
        chars: text.chars().count() as i64,
        name: call_names.get(call_id).cloned(),
    });
    session.ends_on_tool = false;
}

/// Deterministic failure test for a Codex tool result.
///
/// Codex has no `is_error` flag, so the only mechanical signal is the exit
/// code the shell wrapper prints. Every `Exit code: N` in the output is
/// examined; any non-zero marks the call as failed.
pub fn output_is_error(text: &str) -> bool {
    const MARKER: &str = "Exit code: ";
    let mut rest = text;
    let mut found = false;
    while let Some(pos) = rest.find(MARKER) {
        let after = &rest[pos + MARKER.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            found = true;
            if digits != "0" {
                return true;
            }
        }
        rest = &after[digits.len().min(after.len())..];
    }
    if found {
        return false;
    }
    text.contains("\"success\": false") || text.contains("\"success\":false")
}

fn codex_target(name: &str, raw_args: &str) -> Option<String> {
    match metrics::classify_tool(name) {
        metrics::ToolClass::Exec => {
            extract_field(raw_args, "command").and_then(|cmd| metrics::command_stem(&cmd))
        }
        metrics::ToolClass::Edit => patch_paths(raw_args).into_iter().next(),
        metrics::ToolClass::Fetch => {
            extract_field(raw_args, "query").or_else(|| extract_field(raw_args, "url"))
        }
        _ => None,
    }
}

/// Pull a string field out of either a JSON argument blob or the JS snippet a
/// `custom_tool_call` wraps around it. Both spell the key the same way, so a
/// single scan handles both without a JSON parser that the JS form would fail.
fn extract_field(raw: &str, key: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(found) = value.get(key).and_then(Value::as_str) {
            return Some(found.to_string());
        }
    }
    let quoted = format!("\"{key}\"");
    let start = raw
        .find(&quoted)
        .map(|pos| pos + quoted.len())
        .or_else(|| {
            let bare = format!("{key}:");
            raw.find(&bare).map(|pos| pos + bare.len())
        })?;
    let after = &raw[start..];
    let colon = after.find(':').map(|pos| pos + 1).unwrap_or(0);
    let after = &after[colon.min(after.len())..];
    let open = after.find('"')? + 1;
    let bytes = after.as_bytes();
    let mut index = open;
    let mut out = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if index + 1 < bytes.len() => {
                let next = bytes[index + 1];
                out.push(match next {
                    b'n' => '\n',
                    b't' => '\t',
                    other => other as char,
                });
                index += 2;
            }
            b'"' => break,
            other => {
                out.push(other as char);
                index += 1;
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Extract file paths from an `apply_patch` envelope.
fn patch_paths(raw: &str) -> Vec<String> {
    const MARKERS: &[&str] = &["*** Add File: ", "*** Update File: ", "*** Delete File: "];
    let mut paths = Vec::new();
    for line in raw.split("\\n").flat_map(|part| part.split('\n')) {
        for marker in MARKERS {
            if let Some(path) = line.trim().strip_prefix(marker) {
                let path = path.trim().trim_end_matches('"');
                if !path.is_empty() && !paths.contains(&path.to_string()) {
                    paths.push(path.to_string());
                }
            }
        }
    }
    paths
}

fn record_user_text(session: &mut SessionChunk, text: &str, seen: &mut HashSet<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if INJECTED_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return;
    }
    // The same prompt shows up as both an `event_msg/user_message` and a
    // `response_item/message`, so utterances are keyed by content.
    let key = truncate_chars(trimmed, 200);
    if !seen.insert(key) {
        return;
    }

    session.user_msg_count += 1;
    session.prompt_chars += trimmed.chars().count() as i64;
    if session.first_prompt.is_none() {
        session.first_prompt = Some(truncate_chars(trimmed, FIRST_PROMPT_CHARS));
    }
    if metrics::is_correction(trimmed) {
        session.correction_hits += 1;
    }
}

fn collect_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_rollout_parse_keeps_index_stats_and_material_in_sync() {
        let (data, material) = parse_rollout(
            concat!(
                "not-json\n",
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"same prompt"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"same prompt"}]}}"#,
            ),
            "fallback",
            CodexParseState::default(),
        );
        let session = data.sessions.get("fallback").expect("session");
        assert_eq!(data.lines, 2);
        assert_eq!(data.parse_errors, 1);
        assert_eq!(session.user_msg_count, 1);
        assert_eq!(material.user, vec!["same prompt"]);
    }

    #[test]
    fn summarizer_marker_classifies_codex_session_as_internal() {
        let data = parse_chunk(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"[mycmux-ailog-summarizer]\ninput"}}"#,
            "fallback",
        );
        assert_eq!(
            data.sessions.get("fallback").expect("session").origin,
            ORIGIN_AILOG_INTERNAL
        );
    }

    #[test]
    fn response_item_user_marker_classifies_codex_session_as_internal() {
        let data = parse_chunk(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"[mycmux-ailog-summarizer] input"}]}}"#,
            "fallback",
        );
        assert_eq!(
            data.sessions.get("fallback").expect("session").origin,
            ORIGIN_AILOG_INTERNAL
        );
    }

    #[test]
    fn next_action_event_marker_is_internal_and_excluded_from_material() {
        let (data, material) = parse_rollout(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"[mycmux-next-action] input"}}"#,
            "fallback",
            CodexParseState::default(),
        );
        assert_eq!(data.sessions["fallback"].origin, ORIGIN_AILOG_INTERNAL);
        assert!(material.user.is_empty());
    }

    #[test]
    fn next_action_response_marker_is_internal_and_excluded_from_material() {
        let (data, material) = parse_rollout(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"[mycmux-next-action] input"}]}}"#,
            "fallback",
            CodexParseState::default(),
        );
        assert_eq!(data.sessions["fallback"].origin, ORIGIN_AILOG_INTERNAL);
        assert!(material.user.is_empty());
    }

    #[test]
    fn filename_fallback_extracts_only_the_trailing_uuid() {
        let stem = "rollout-2026-08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e";
        assert_eq!(
            session_id_from_filename(stem),
            "01a031ef-e449-74a0-b12c-d69ae559cc9e"
        );
        assert_eq!(
            session_id_from_filename("rollout-CX1"),
            "rollout-CX1",
            "non-UUID fixtures keep the stem"
        );
        assert_eq!(
            session_id_from_filename("notes-01a031ef-e449-74a0-b12c-d69ae559cc9e"),
            "notes-01a031ef-e449-74a0-b12c-d69ae559cc9e",
            "non-rollout UUID stems are not sticky filename identities"
        );
        assert!(is_legacy_filename_session(
            "08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e",
            "01a031ef-e449-74a0-b12c-d69ae559cc9e"
        ));
        assert!(!is_legacy_filename_session(
            "01a031ef-e449-74a0-b12c-d69ae559cc9e",
            "01a031ef-e449-74a0-b12c-d69ae559cc9e"
        ));
        assert!(is_legacy_compat_source(
            "01a031ee-64b1-7b50-a51a-cd56a2abc586",
            "01a031ef-e449-74a0-b12c-d69ae559cc9e"
        ));
        assert!(!is_legacy_compat_source(
            "01a031ef-e449-74a0-b12c-d69ae559cc9e",
            "01a031ef-e449-74a0-b12c-d69ae559cc9e"
        ));
    }

    #[test]
    fn parent_session_meta_does_not_replace_rollout_uuid() {
        let uuid = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
        let parent = "01a031ee-64b1-7b50-a51a-cd56a2abc586";
        let text = format!(
            "{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"01a031ef-e449-74a0-b12c-d69ae559cc9e"}}"#,
            format!(r#"{{"type":"session_meta","payload":{{"id":"{parent}"}}}}"#)
        );
        let data = parse_chunk(&text, uuid);
        assert_eq!(data.sessions.len(), 1);
        assert!(data.sessions.contains_key(uuid));
        assert!(!data.sessions.contains_key(parent));
    }

    #[test]
    fn canonical_seed_keeps_filename_uuid() {
        let uuid = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
        let line = r#"{"timestamp":"2026-08-24T13:03:21.000Z","ordinal":2,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":20,"total_tokens":220},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20,"total_tokens":120}}}}"#;
        let data = parse_chunk_with_state(
            line,
            uuid,
            CodexParseState {
                session_id: Some(uuid.to_string()),
                model: Some("test-model-b".to_string()),
                effort: Some("high".to_string()),
                session_locked: true,
                session_behavior: SessionBehavior::CanonicalFilename,
                ..CodexParseState::default()
            },
        );
        assert!(data.sessions.contains_key(uuid));
    }

    #[test]
    fn seeded_token_count_keeps_previous_model_and_effort() {
        let uuid = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
        let line = r#"{"timestamp":"2026-08-24T13:03:21.000Z","ordinal":2,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":20,"total_tokens":220},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20,"total_tokens":120}}}}"#;
        let data = parse_chunk_with_state(
            line,
            uuid,
            CodexParseState {
                session_id: Some(uuid.to_string()),
                model: Some("test-model-b".to_string()),
                effort: Some("high".to_string()),
                ..CodexParseState::default()
            },
        );
        let session = data.sessions.get(uuid).expect("session");
        assert_eq!(session.turns.len(), 1);
        assert_eq!(session.turns[0].model.as_deref(), Some("test-model-b"));
        assert_eq!(session.turns[0].effort.as_deref(), Some("high"));
    }

    #[test]
    fn model_less_token_count_stays_unknown() {
        let line = r#"{"timestamp":"2026-08-24T13:03:21.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11},"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11}}}}"#;
        let data = parse_chunk(line, "no-model");
        let session = data.sessions.get("no-model").expect("session");
        assert_eq!(session.turns.len(), 1);
        assert_eq!(session.turns[0].model, None);
        assert_eq!(session.turns[0].effort, None);
    }

    #[test]
    fn prefix_state_uses_last_turn_context() {
        let text = concat!(
            r#"{"type":"session_meta","payload":{"id":"01a031ef-e449-74a0-b12c-d69ae559cc9e"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"test-model-a","effort":"high"}}"#,
            "\n",
            r#"{"type":"turn_context","payload":{"model":"test-model-b","effort":"xhigh"}}"#,
            "\n",
        );
        let state = parse_state_from_text(text);
        assert_eq!(
            state.session_id.as_deref(),
            Some("01a031ef-e449-74a0-b12c-d69ae559cc9e")
        );
        assert_eq!(state.model.as_deref(), Some("test-model-b"));
        assert_eq!(state.effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn standard_filename_rejects_non_timestamp_stems() {
        let uuid = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
        assert_eq!(
            standard_rollout_filename_uuid(&format!("rollout-x-{uuid}")),
            None
        );
        assert_eq!(
            session_id_from_filename(&format!("rollout-x-{uuid}")),
            format!("rollout-x-{uuid}")
        );
        assert_eq!(
            standard_rollout_filename_uuid(&format!("rollout-backup-{uuid}")),
            None
        );
        assert_eq!(standard_rollout_filename_uuid("rollout-CX1"), None);
        assert_eq!(
            standard_rollout_filename_uuid(
                "rollout-2026-08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e"
            ),
            Some(uuid)
        );
    }

    #[test]
    fn legacy_compat_lock_keeps_stored_composite_id() {
        let stored = "08-24T13-03-20-01a031ef-e449-74a0-b12c-d69ae559cc9e";
        let uuid = "01a031ef-e449-74a0-b12c-d69ae559cc9e";
        let text = format!(
            "{}\n",
            format!(r#"{{"type":"session_meta","payload":{{"id":"{uuid}"}}}}"#)
        );
        let data = parse_chunk_with_state(
            &text,
            stored,
            CodexParseState {
                session_id: Some(stored.to_string()),
                session_locked: true,
                session_behavior: SessionBehavior::LegacyCompat,
                ..CodexParseState::default()
            },
        );
        assert!(data.sessions.contains_key(stored));
        assert!(!data.sessions.contains_key(uuid));
    }
}
