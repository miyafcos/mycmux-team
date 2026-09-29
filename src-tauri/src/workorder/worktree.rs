//! Deterministic, non-destructive WorkOrder worktree preparation.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::WorkOrderId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreePlan {
    pub repo_root: PathBuf,
    pub branch: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeError {
    NotRepository(PathBuf),
    ExistingPathIsNotExpectedWorktree(PathBuf),
    Io(String),
    Git(String),
    Join(String),
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRepository(path) => write!(formatter, "not a git repository: {}", path.display()),
            Self::ExistingPathIsNotExpectedWorktree(path) => write!(
                formatter,
                "existing path is not the expected worktree: {}",
                path.display()
            ),
            Self::Io(message) | Self::Git(message) | Self::Join(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for WorktreeError {}

pub fn plan_for(work_order_id: &WorkOrderId, repo_root: &Path) -> WorktreePlan {
    let prefix = work_order_id.as_str().chars().take(8).collect::<String>();
    let name = format!("workorder-{prefix}-integration");
    let parent = repo_root.parent().unwrap_or(repo_root);
    WorktreePlan {
        repo_root: repo_root.to_path_buf(),
        branch: name.clone(),
        path: parent.join(".mycmux-worktrees").join(name),
    }
}

/// Creates the named worktree once. Existing worktrees are verified and reused;
/// this module deliberately never removes a worktree.
pub async fn ensure_worktree(plan: &WorktreePlan) -> Result<PathBuf, WorktreeError> {
    let plan = plan.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_worktree_blocking(&plan))
        .await
        .map_err(|error| WorktreeError::Join(error.to_string()))?
}

fn ensure_worktree_blocking(plan: &WorktreePlan) -> Result<PathBuf, WorktreeError> {
    verify_repository(&plan.repo_root)?;
    if plan.path.exists() {
        return if worktree_matches(plan)? {
            Ok(plan.path.clone())
        } else {
            Err(WorktreeError::ExistingPathIsNotExpectedWorktree(
                plan.path.clone(),
            ))
        };
    }
    if let Some(parent) = plan.path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| WorktreeError::Io(error.to_string()))?;
    }
    let output = Command::new("git")
        .current_dir(&plan.repo_root)
        .args(["worktree", "add", "-b", &plan.branch])
        .arg(&plan.path)
        .output()
        .map_err(|error| WorktreeError::Io(format!("run git worktree add: {error}")))?;
    if output.status.success() {
        return Ok(plan.path.clone());
    }
    // A second window may have won the race. Treat only the exact expected
    // registered worktree as success; never fall back to the main branch.
    if worktree_matches(plan)? {
        return Ok(plan.path.clone());
    }
    Err(WorktreeError::Git(format!(
        "git worktree add failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

/// Resolves the repository that owns `cwd` at run time. The repository root can
/// never be a build-time constant: the shipped binary runs against whatever
/// project the operator has open, and a baked-in path would either fail outright
/// or silently create the worktree in an unrelated repository.
pub async fn resolve_repo_root(cwd: PathBuf) -> Result<PathBuf, WorktreeError> {
    tauri::async_runtime::spawn_blocking(move || resolve_repo_root_blocking(&cwd))
        .await
        .map_err(|error| WorktreeError::Join(error.to_string()))?
}

fn resolve_repo_root_blocking(cwd: &Path) -> Result<PathBuf, WorktreeError> {
    if !cwd.is_dir() {
        return Err(WorktreeError::NotRepository(cwd.to_path_buf()));
    }
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| WorktreeError::Io(format!("run git rev-parse: {error}")))?;
    if !output.status.success() {
        return Err(WorktreeError::NotRepository(cwd.to_path_buf()));
    }
    let reported = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if reported.is_empty() {
        return Err(WorktreeError::NotRepository(cwd.to_path_buf()));
    }
    PathBuf::from(reported)
        .canonicalize()
        .map_err(|error| WorktreeError::Io(format!("canonicalize git root: {error}")))
}

fn verify_repository(repo_root: &Path) -> Result<(), WorktreeError> {
    let output = Command::new("git")
        .current_dir(repo_root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| WorktreeError::Io(format!("run git rev-parse: {error}")))?;
    if !output.status.success() {
        return Err(WorktreeError::NotRepository(repo_root.to_path_buf()));
    }
    let reported = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let expected = repo_root
        .canonicalize()
        .map_err(|error| WorktreeError::Io(format!("canonicalize repository: {error}")))?;
    let reported = reported
        .canonicalize()
        .map_err(|error| WorktreeError::Io(format!("canonicalize git root: {error}")))?;
    if reported == expected {
        Ok(())
    } else {
        Err(WorktreeError::NotRepository(repo_root.to_path_buf()))
    }
}

fn worktree_matches(plan: &WorktreePlan) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .current_dir(&plan.repo_root)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|error| WorktreeError::Io(format!("run git worktree list: {error}")))?;
    if !output.status.success() {
        return Err(WorktreeError::Git(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let expected_path = plan
        .path
        .canonicalize()
        .unwrap_or_else(|_| plan.path.clone());
    let expected_branch = format!("refs/heads/{}", plan.branch);
    let mut path = None::<PathBuf>;
    let mut branch = None::<String>;
    for line in String::from_utf8_lossy(&output.stdout).lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(value));
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(value.to_owned());
        } else if line.is_empty() {
            if let Some(candidate) = path.take() {
                let candidate = candidate.canonicalize().unwrap_or(candidate);
                if candidate == expected_path && branch.as_deref() == Some(expected_branch.as_str()) {
                    return Ok(true);
                }
            }
            branch = None;
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn order_id() -> WorkOrderId {
        WorkOrderId::try_new("12345678-1234-1234-1234-123456789abc").unwrap()
    }

    #[test]
    fn plan_is_deterministic_and_outside_repository() {
        let root = PathBuf::from("C:/example/repo");
        let first = plan_for(&order_id(), &root);
        let second = plan_for(&order_id(), &root);
        assert_eq!(first, second);
        assert_eq!(first.branch, "workorder-12345678-integration");
        assert_eq!(
            first.path,
            PathBuf::from("C:/example/.mycmux-worktrees/workorder-12345678-integration")
        );
        assert!(!first.path.starts_with(&root));
    }

    #[tokio::test]
    async fn existing_worktree_is_reused_without_recreating_it() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let init = Command::new("git").current_dir(&root).args(["init"]).status().unwrap();
        assert!(init.success());
        let commit = Command::new("git")
            .current_dir(&root)
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ])
            .status()
            .unwrap();
        assert!(commit.success());
        let plan = plan_for(&order_id(), &root);
        let first = ensure_worktree(&plan).await.unwrap();
        let listed_after_first = registered_worktree_count(&root);
        let second = ensure_worktree(&plan).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(listed_after_first, registered_worktree_count(&root));
    }

    fn registered_worktree_count(root: &Path) -> usize {
        let output = Command::new("git")
            .current_dir(root)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count()
    }

    #[tokio::test]
    async fn repository_root_comes_from_the_running_directory() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        let nested = root.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(Command::new("git")
            .current_dir(&root)
            .args(["init"])
            .status()
            .unwrap()
            .success());

        let resolved = resolve_repo_root(nested).await.unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn a_directory_that_is_not_there_is_refused() {
        let temp = tempdir().unwrap();
        let missing = temp.path().join("never-created");

        // GO must stop rather than fall back to some other repository when the
        // directory it was given does not exist.
        assert!(matches!(
            resolve_repo_root(missing).await,
            Err(WorktreeError::NotRepository(_))
        ));
    }
}
