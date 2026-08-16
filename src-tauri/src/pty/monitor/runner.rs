use super::*;

pub fn start_monitor(
    app_handle: AppHandle,
    manager: Arc<SessionManager>,
    metadata_store: MetadataStore,
    session_state_store: crate::session_state::SessionStateStore,
    frontend_visible: Arc<std::sync::atomic::AtomicBool>,
) {
    thread::spawn(move || {
        let mut sys = System::new();
        let mut last_metadata: HashMap<String, PtyMetadata> = HashMap::new();
        let mut detected_agent_sessions: HashMap<String, DetectedAgentCacheEntry> = HashMap::new();
        let mut failed_detected_agent_sessions: HashMap<String, FailedDetectedAgentCacheEntry> =
            HashMap::new();
        let mut last_output_evidence_at: HashMap<String, u64> = HashMap::new();
        let mut session_epochs: HashMap<String, u64> = HashMap::new();
        let mut codex_rollout_detector = CodexRolloutDetector::new();
        // `None` until the first report. Seeding this with `Instant::now() - 60s`
        // would panic when mycmux starts within a minute of boot, because the
        // Windows Instant epoch is boot time.
        let mut last_refresh_diagnostic: Option<Instant> = None;

        // RS-5: git branch detection runs on a dedicated worker pool instead
        // of inline in this loop. `git_branch_cwd` records the CWD that the
        // *last applied* git_branch in `last_metadata` corresponds to, kept
        // separate from `last_metadata`'s own `cwd` field (which is updated
        // every tick regardless of git status) so a CWD change is never lost
        // just because a request for it is still in flight — see the
        // `needs_git_check` comment below. `git_in_flight` prevents queueing
        // a second request for a session while one is already outstanding.
        let (git_result_tx, git_result_rx) = mpsc::channel::<GitBranchResult>();
        let git_request_tx = spawn_git_branch_workers(git_result_tx);
        let mut git_branch_cwd: HashMap<String, String> = HashMap::new();
        let mut git_in_flight: HashSet<String> = HashSet::new();

        loop {
            // OSC 7 handles CWD instantly for bash/zsh/fish;
            // sysinfo is now the fallback for cmd.exe / PowerShell and the
            // safety net that fills in git_branch / process_name.
            thread::sleep(monitor_refresh_interval(
                frontend_visible.load(std::sync::atomic::Ordering::Acquire),
            ));

            // Drain any git branch lookups that finished since the last tick.
            // Applying results here (before the per-session pass) means a
            // session whose lookup just completed uses the fresh branch for
            // this tick's `changed` comparison instead of the previous 5s
            // finding out via a second, redundant emit.
            while let Ok(result) = git_result_rx.try_recv() {
                git_in_flight.remove(&result.session_id);
                git_branch_cwd.insert(result.session_id.clone(), result.cwd.clone());
                if let Some(meta) = last_metadata.get_mut(&result.session_id) {
                    if meta.git_branch != result.git_branch {
                        meta.git_branch = result.git_branch;
                        metadata_store.insert(result.session_id.clone(), meta.clone());
                        let _ = app_handle.emit("pty_metadata", meta.clone());
                    }
                }
            }

            let pids = manager.iter_pids();
            let refresh_started = Instant::now();

            // `OnlyIfNotSet` means sysinfo pays the Windows PEB read once per
            // process, not once per tick: get_process_params() returns early when
            // cmd and cwd are already populated. Narrowing this to PTY descendants
            // therefore saves almost nothing (and short-lived spawns are inside the
            // PTY tree anyway) while it would hide externally launched agents from
            // collect_explicit_agent_session_ids below. Keep the full sweep; the
            // diagnostic underneath is what tells us whether this tick is costly.
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::OnlyIfNotSet)
                    .with_cwd(UpdateKind::OnlyIfNotSet),
            );
            let child_index = build_child_index(&sys);
            if last_refresh_diagnostic.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                let diagnostic = format!(
                    "[mycmux-diag monitor] refresh_ms={} tracked_ptys={} processes={}",
                    refresh_started.elapsed().as_millis(),
                    pids.len(),
                    sys.processes().len(),
                );
                eprintln!("{diagnostic}");
                crate::diag::log(&diagnostic);
                last_refresh_diagnostic = Some(Instant::now());
            }
            // Reserve every process-exact ID before per-pane fallback detection.
            // This prevents several --continue agents sharing a CWD from all
            // adopting the session that an exact --session-id process owns.
            let explicit_agent_session_ids = collect_explicit_agent_session_ids(&sys);
            let cached_agent_session_owners = reserve_cached_agent_session_ids(
                &mut detected_agent_sessions,
                &explicit_agent_session_ids,
            );
            let mut claimed_agent_session_ids = explicit_agent_session_ids;

            let agent_mappings = crate::commands::session_mapping::agent_mappings_for_ids(
                pids.iter().map(|(session_id, _)| session_id.as_str()),
            );
            let mapped_session_owners = mapped_agent_session_owners(&agent_mappings);

            for (session_id, pid_opt) in pids.iter().cloned() {
                if let Some(pid) = pid_opt {
                    let Some((session_epoch, last_output_at)) =
                        manager.session_observation(&session_id)
                    else {
                        continue;
                    };
                    session_epochs.insert(session_id.clone(), session_epoch);
                    if let Some(output_at) = last_output_at {
                        let previous = last_output_evidence_at
                            .get(&session_id)
                            .copied()
                            .unwrap_or_default();
                        if output_at > previous {
                            session_state_store.ingest(
                                session_id.clone(),
                                crate::session_state::Evidence::last_output(
                                    output_at,
                                    session_epoch,
                                    crate::session_state::OutputOrigin::Pty,
                                ),
                            );
                            last_output_evidence_at.insert(session_id.clone(), output_at);
                        }
                    }
                    let observed_at = crate::session_state::unix_epoch_millis();
                    // Resolve the foreground (deepest child) PID once per tick and
                    // reuse it for both CWD and process-name lookups — each helper
                    // previously re-walked the entire process table on its own.
                    let shell_pid = Pid::from_u32(pid);
                    let fg_pid = deepest_child_pid(&sys, &child_index, shell_pid);
                    let process_name = get_foreground_process_name(&sys, fg_pid);
                    let process_started_at = sys.process(fg_pid).and_then(|process| {
                        process
                            .start_time()
                            .checked_mul(1_000)
                            .and_then(|value| i64::try_from(value).ok())
                    });
                    let foreground_agent = agent_kind_from_process(&sys, fg_pid)
                        .map(|kind| (kind, fg_pid))
                        .or_else(|| find_agent_descendant(&sys, &child_index, shell_pid));
                    let agent_active = foreground_agent.is_some();
                    if let Some((DetectedAgentKind::Codex, agent_pid)) = foreground_agent {
                        if let Some(agent_started_at) = sys.process(agent_pid).and_then(|process| {
                            process.start_time().checked_mul(1_000)
                        }) {
                            let identity = CodexProcessIdentity {
                                pid: agent_pid.as_u32(),
                                started_at: agent_started_at,
                                session_epoch,
                            };
                            let exact_rollout_id =
                                session_id_from_agent_args(&sys, agent_pid, true);
                            for evidence in codex_rollout_detector.poll(
                                &session_id,
                                identity,
                                exact_rollout_id.as_deref(),
                            ) {
                                session_state_store.ingest(session_id.clone(), evidence);
                            }
                        }
                    } else {
                        codex_rollout_detector.remove(&session_id);
                    }
                    let cwd_pid = foreground_agent
                        .map(|(_, agent_pid)| agent_pid)
                        .unwrap_or(fg_pid);
                    let cwd = match get_process_cwd(&sys, shell_pid, cwd_pid) {
                        Some(c) if !c.is_empty() => c,
                        _ => continue,
                    };

                    // Check if CWD changed (relative to the CWD the *current*
                    // git_branch was actually resolved for, not just the last
                    // stored metadata.cwd) to avoid spamming git commands.
                    // Using `git_branch_cwd` here — rather than
                    // `last_metadata`'s `cwd` field, which is overwritten every
                    // tick regardless of git status — means a CWD change that
                    // arrives while a request for the previous CWD is still
                    // in flight is not lost: it keeps looking "needed" every
                    // tick until a request actually gets queued for it.
                    let needs_git_check = git_branch_cwd.get(&session_id) != Some(&cwd);
                    if needs_git_check && git_in_flight.insert(session_id.clone()) {
                        // RS-5: hand the (possibly slow) git invocation to the
                        // worker pool instead of blocking this loop — other
                        // sessions' metadata keeps updating every tick even
                        // while this lookup is still running.
                        let _ = git_request_tx.send(GitBranchRequest {
                            session_id: session_id.clone(),
                            cwd: cwd.clone(),
                        });
                    }
                    // Use the last known branch (possibly stale while a
                    // lookup for a new CWD is in flight) until the worker
                    // pool reports a fresh result via `git_result_rx`.
                    let git_branch = last_metadata
                        .get(&session_id)
                        .and_then(|m| m.git_branch.clone());

                    // Detect coding-agent session IDs only while that agent is foreground.
                    // When an agent exits, preserve the last ID in backend metadata; the
                    // frontend clears it when the foreground process returns to a shell.
                    match foreground_agent {
                        Some((kind, agent_pid)) => {
                            if cached_detected_agent_session_id(
                                &detected_agent_sessions,
                                &session_id,
                                agent_pid,
                                kind,
                            )
                            .is_none()
                            {
                                detected_agent_sessions.remove(&session_id);
                            }
                        }
                        None => {
                            detected_agent_sessions.remove(&session_id);
                            failed_detected_agent_sessions.remove(&session_id);
                        }
                    }
                    let previous_metadata = last_metadata.get(&session_id);
                    let previous_agent_kind = previous_metadata.and_then(|m| m.agent_kind.clone());
                    let previous_agent_session_id =
                        previous_metadata.and_then(|m| m.agent_session_id.clone());
                    let previous_claude_session_id =
                        previous_metadata.and_then(|m| m.claude_session_id.clone());
                    // Floor for the mtime-newest fallback: only session files
                    // created after this agent process started may be adopted.
                    // 30s slack absorbs clock/accounting skew.
                    let agent_min_created = foreground_agent.and_then(|(_, agent_pid)| {
                        sys.process(agent_pid).map(|process| {
                            std::time::UNIX_EPOCH
                                + Duration::from_secs(process.start_time().saturating_sub(30))
                        })
                    });
                    let excluded_agent_session_ids = agent_session_id_exclusions_for_pane(
                        &claimed_agent_session_ids,
                        &cached_agent_session_owners,
                        &mapped_session_owners,
                        &session_id,
                    );
                    let (agent_kind, agent_session_id, claude_session_id) = match foreground_agent {
                        Some((kind, agent_pid)) => match kind {
                            DetectedAgentKind::ClaudeCodex => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, false);
                                let detected = preferred_known_agent_session_id(
                                    exact,
                                    &agent_mappings,
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &excluded_agent_session_ids,
                                )
                                .or_else(|| {
                                    detect_agent_session_id_with_negative_ttl(
                                        &mut failed_detected_agent_sessions,
                                        &session_id,
                                        agent_pid,
                                        kind,
                                        || {
                                            detect_claude_codex_session_id(
                                                &cwd,
                                                agent_min_created,
                                                &excluded_agent_session_ids,
                                            )
                                        },
                                    )
                                });
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("claude-codex") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    }
                                    .filter(|candidate| {
                                        !excluded_agent_session_ids.contains(candidate)
                                    });
                                let agent_session_id = detected.or(previous_same_kind_session);
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                (
                                    agent_session_id
                                        .as_ref()
                                        .map(|_| "claude-codex".to_string()),
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                            DetectedAgentKind::Claude => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, false);
                                let mapped = mapped_agent_session_attribution_for_pane(
                                    &agent_mappings,
                                    &session_id,
                                    kind,
                                    &excluded_agent_session_ids,
                                    exact.as_deref(),
                                );
                                let cached = cached_detected_agent_session_id(
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                );
                                let previous_session_id = match previous_agent_kind.as_deref() {
                                    Some("claude-codex") => previous_agent_session_id.clone(),
                                    Some("claude") => previous_agent_session_id
                                        .clone()
                                        .or_else(|| previous_claude_session_id.clone()),
                                    _ => None,
                                };
                                let detection_exclusions = detection_exclusions_for_exact_session(
                                    &excluded_agent_session_ids,
                                    exact.as_deref(),
                                );
                                let attribution = select_claude_process_attribution(
                                    mapped,
                                    exact,
                                    cached,
                                    previous_agent_kind.as_deref(),
                                    previous_session_id,
                                    &excluded_agent_session_ids,
                                    || {
                                        detect_agent_session_id_with_negative_ttl(
                                            &mut failed_detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                            || {
                                                detect_claude_family_session_id(
                                                    &cwd,
                                                    agent_min_created,
                                                    &detection_exclusions,
                                                )
                                            },
                                        )
                                    },
                                );
                                let agent_session_id =
                                    attribution.as_ref().map(|value| value.session_id.clone());
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &agent_session_id,
                                );
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                let claude_session_id = attribution.as_ref().and_then(|value| {
                                    if value.agent_kind == "claude" {
                                        Some(value.session_id.clone())
                                    } else {
                                        previous_claude_session_id.clone()
                                    }
                                });
                                // Process detection and session-id discovery are independent.
                                // Emit the Claude kind immediately so the UI can expose actions
                                // in a disabled state while the transcript id is still resolving.
                                let agent_kind = Some(
                                    attribution
                                        .as_ref()
                                        .map(|value| value.agent_kind)
                                        .unwrap_or("claude")
                                        .to_string(),
                                );
                                (agent_kind, agent_session_id, claude_session_id)
                            }
                            DetectedAgentKind::Codex => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, true);
                                let detected = preferred_known_agent_session_id(
                                    exact,
                                    &agent_mappings,
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &excluded_agent_session_ids,
                                )
                                .or_else(|| {
                                    detect_agent_session_id_with_negative_ttl(
                                        &mut failed_detected_agent_sessions,
                                        &session_id,
                                        agent_pid,
                                        kind,
                                        || {
                                            detect_codex_session_id(
                                                &cwd,
                                                agent_min_created,
                                                &excluded_agent_session_ids,
                                            )
                                        },
                                    )
                                });
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("codex") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    }
                                    .filter(|candidate| {
                                        !excluded_agent_session_ids.contains(candidate)
                                    });
                                let agent_session_id = detected.or(previous_same_kind_session);
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                codex_agent_metadata_fields(
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                            DetectedAgentKind::Grok => {
                                // Grok always launches with an explicit --session-id, so the
                                // pane mapping is authoritative. There is no per-session log
                                // format to scan, hence no detection fallback here.
                                let exact = session_id_from_agent_args(&sys, agent_pid, false);
                                let detected = preferred_known_agent_session_id(
                                    exact,
                                    &agent_mappings,
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &excluded_agent_session_ids,
                                );
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("grok") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    }
                                    .filter(|candidate| {
                                        !excluded_agent_session_ids.contains(candidate)
                                    });
                                let agent_session_id = detected.or(previous_same_kind_session);
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                grok_agent_metadata_fields(
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                        },
                        None => (
                            previous_agent_kind.clone(),
                            previous_agent_session_id.clone(),
                            previous_claude_session_id.clone(),
                        ),
                    };

                    if foreground_agent.is_none()
                        && process_name.as_deref().is_some_and(is_shell_process)
                    {
                        // Failed descendant detection is not proof the agent is
                        // gone: MSYS bash orphans shebang-script children, so a
                        // live claude can be invisible here. Only drop the
                        // launcher-written mapping when no process anywhere owns
                        // the mapped session id (argv scan from this same tick).
                        let mapping_owned_by_live_process =
                            agent_mappings.get(&session_id).is_some_and(|mapping| {
                                claimed_agent_session_ids.contains(&mapping.session_id)
                            });
                        if !mapping_owned_by_live_process {
                            let _ = crate::commands::session_mapping::remove_session_mapping_file(
                                &session_id,
                            );
                        }
                    }

                    // Detect work→idle transition: previous foreground was a non-shell
                    // process (claude/node/python/…) and current is a shell.
                    // Emit a one-shot "pty_work_done" event so the UI can badge the pane.
                    if let (Some(prev_meta), Some(current)) =
                        (last_metadata.get(&session_id), process_name.as_ref())
                    {
                        if let Some(prev) = prev_meta.process_name.as_ref() {
                            if !is_shell_process(prev)
                                && is_shell_process(current)
                                && prev != current
                            {
                                let evt = PtyWorkDone {
                                    session_id: session_id.clone(),
                                    prev_process: prev.clone(),
                                    current_process: current.to_string(),
                                };
                                session_state_store.ingest(
                                    session_id.clone(),
                                    crate::session_state::Evidence::work_done(
                                        observed_at,
                                        session_epoch,
                                        prev.clone(),
                                        current.to_string(),
                                    ),
                                );
                                let _ = app_handle.emit("pty_work_done", evt);
                            }
                        }
                    }

                    if let (Some(kind), Some(current_agent_session_id)) =
                        (agent_kind.as_deref(), agent_session_id.as_deref())
                    {
                        let process_identity_matches = foreground_agent.is_some_and(|(detected_kind, _)| {
                            mapping_kind_is_grounded_in_detected_process(kind, detected_kind)
                        });
                        if process_identity_matches && should_write_agent_session_mapping(
                            &agent_mappings,
                            &session_id,
                            kind,
                            current_agent_session_id,
                        ) {
                            write_detected_agent_session_mapping(
                                &session_id,
                                kind,
                                current_agent_session_id,
                            );
                        }
                    }

                    let (process_status, process_status_at) = process_status_from_observation(
                        process_name.as_deref(),
                        process_started_at,
                    );
                    let status_changed = last_metadata
                        .get(&session_id)
                        .is_none_or(|old| old.process_status != process_status);
                    if status_changed {
                        let status = match process_status.as_deref() {
                            Some("working") => crate::session_state::MonitorStatus::Working,
                            Some("idle") => crate::session_state::MonitorStatus::Idle,
                            _ => crate::session_state::MonitorStatus::Unknown,
                        };
                        let process = process_started_at.and_then(|started_at| {
                            u64::try_from(started_at).ok().map(|started_at| {
                                crate::session_state::ProcessIdentity {
                                    pid: fg_pid.as_u32(),
                                    started_at,
                                }
                            })
                        });
                        session_state_store.ingest(
                            session_id.clone(),
                            crate::session_state::Evidence::monitor_status(
                                observed_at,
                                session_epoch,
                                status,
                                process,
                            ),
                        );
                    }
                    let metadata = PtyMetadata {
                        session_id: session_id.clone(),
                        cwd: cwd.clone(),
                        git_branch: git_branch.clone(),
                        process_name: process_name.clone(),
                        process_status,
                        process_status_at,
                        last_output_at: last_output_evidence_at.get(&session_id).copied(),
                        agent_active,
                        claude_session_id: claude_session_id.clone(),
                        agent_kind: agent_kind.clone(),
                        agent_session_id: agent_session_id.clone(),
                    };

                    let changed = match last_metadata.get(&session_id) {
                        Some(old) => {
                            old.cwd != cwd
                                || old.git_branch != git_branch
                                || old.process_name != process_name
                                || old.process_status != metadata.process_status
                                || old.process_status_at != metadata.process_status_at
                                || old.last_output_at != metadata.last_output_at
                                || old.agent_active != agent_active
                                || old.claude_session_id != claude_session_id
                                || old.agent_kind != agent_kind
                                || old.agent_session_id != agent_session_id
                        }
                        None => true,
                    };

                    // Always track last_metadata for work-done detection, even if
                    // not "changed" enough to re-emit pty_metadata.
                    last_metadata.insert(session_id.clone(), metadata.clone());
                    if changed {
                        metadata_store.insert(session_id.clone(), metadata.clone());
                        let _ = app_handle.emit("pty_metadata", metadata);
                    }
                }
            }

            // Cleanup dead sessions
            let active_keys: std::collections::HashSet<String> =
                pids.into_iter().map(|(k, _)| k).collect();
            let removed_sessions: Vec<String> = last_metadata
                .keys()
                .filter(|session_id| !active_keys.contains(*session_id))
                .cloned()
                .collect();
            for session_id in removed_sessions {
                if let Some(session_epoch) = session_epochs.get(&session_id).copied() {
                    session_state_store.ingest(
                        session_id,
                        crate::session_state::Evidence::socket_lifecycle(
                            crate::session_state::unix_epoch_millis(),
                            session_epoch,
                            crate::session_state::Lifecycle::Exited,
                        ),
                    );
                }
            }
            last_metadata.retain(|k, _| active_keys.contains(k));
            detected_agent_sessions.retain(|k, _| active_keys.contains(k));
            failed_detected_agent_sessions.retain(|k, _| active_keys.contains(k));
            last_output_evidence_at.retain(|k, _| active_keys.contains(k));
            session_epochs.retain(|k, _| active_keys.contains(k));
            codex_rollout_detector.retain_active(&active_keys);
            metadata_store.retain(|k, _| active_keys.contains(k));
            // git_in_flight is *not* pruned for dead sessions here: a request
            // may still be running on a worker thread, and the drain step at
            // the top of the next tick removes the entry once that request's
            // result (or the worker dropping it) comes back, regardless of
            // whether the session is still active.
            git_branch_cwd.retain(|k, _| active_keys.contains(k));
        }
    });
}

fn monitor_refresh_interval(frontend_visible: bool) -> Duration {
    Duration::from_secs(if frontend_visible { 10 } else { 20 })
}

#[cfg(test)]
mod tests {
    use super::monitor_refresh_interval;
    use std::time::Duration;

    #[test]
    fn refresh_interval_slows_only_when_frontend_is_hidden() {
        assert_eq!(monitor_refresh_interval(true), Duration::from_secs(10));
        assert_eq!(monitor_refresh_interval(false), Duration::from_secs(20));
    }
}
