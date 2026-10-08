use super::*;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: u64 = 2 * 1024 * 1024;
const REQUEST_LIMIT: Duration = Duration::from_secs(3);
const LOG_FORMAT: &str = "--format=%H%x00%P%x00%aI%x00%an%x00%s%x00";
pub(super) struct Runner { pub executable: PathBuf, pub timeout: Duration }
impl Default for Runner {
    fn default() -> Self { Self { executable: PathBuf::from("git"), timeout: REQUEST_LIMIT } }
}
impl Runner {
    fn run(&self, cwd: &Path, args: &[&str], deadline: Instant) -> Result<Vec<u8>, String> {
        if Instant::now() >= deadline { return Err("timeout".into()); }
        let mut command = Command::new(&self.executable);
        command.args(["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat"])
            .args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "gitUnavailable" } else { "gitFailed" })?;
        let stdout = child.stdout.take().ok_or("gitFailed")?;
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = vec![];
            let result = stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut out).map(|_| out);
            let _ = send.send(result);
        });
        loop {
            if Instant::now() >= deadline {
                let _ = child.kill(); let _ = child.wait(); return Err("timeout".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() { return Err("gitFailed".into()); }
                    let bytes = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .map_err(|_| "timeout")?.map_err(|_| "gitFailed")?;
                    if bytes.len() as u64 > OUTPUT_LIMIT { return Err("tooLarge".into()); }
                    return Ok(bytes);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("gitFailed".into()); }
            }
        }
    }
}
#[derive(Clone, Debug)]
pub(super) struct Commit {
    pub hash: String, pub parent: Option<String>, pub at: String, pub author: String, pub subject: String,
    pub path: String, pub old_path: String, pub status: String, pub added: Option<u64>, pub deleted: Option<u64>,
}
fn label(text: &str) -> String {
    super::super::redaction::mask(text, false).body.chars().filter(|c| !c.is_control()).take(512).collect::<String>().trim().to_owned()
}
pub(super) fn parse(bytes: &[u8]) -> Result<Vec<Commit>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "unsupported")?;
    let parts: Vec<_> = text.split('\0').collect();
    let mut out = vec![]; let mut i = 0;
    while i < parts.len() {
        let hash = parts[i].trim();
        if !hex(hash, &[40,64]) { i += 1; continue; }
        if i + 4 >= parts.len() { return Err("unsupported".into()); }
        let parent = parts[i+1].split_whitespace().next().filter(|h| hex(h, &[40,64])).map(str::to_owned);
        let at = parts[i+2].into(); let author = label(parts[i+3]); let subject = label(parts[i+4]); i += 5;
        let mut commit = Commit { hash: hash.into(), parent, at, author, subject, path: String::new(), old_path: String::new(),
            status: "M".into(), added: None, deleted: None };
        while i < parts.len() && !hex(parts[i].trim(), &[40,64]) {
            let token = parts[i].trim_start_matches('\n'); i += 1;
            if token.starts_with(':') {
                let status = token.split_whitespace().last().ok_or("unsupported")?;
                let first = parts.get(i).ok_or("unsupported")?; i += 1;
                let second = if status.starts_with('R') || status.starts_with('C') {
                    let value = parts.get(i).ok_or("unsupported")?; i += 1; *value
                } else { *first };
                if commit.path.is_empty() {
                    commit.old_path = (*first).into(); commit.path = second.into(); commit.status = status.into();
                }
            } else if token.contains('\t') {
                let nums: Vec<_> = token.splitn(3,'\t').collect();
                if nums.len() == 3 {
                    commit.added = nums[0].parse().ok(); commit.deleted = nums[1].parse().ok();
                    if nums[2].is_empty() { i = (i+2).min(parts.len()); }
                }
            }
        }
        if !commit.path.is_empty() && relative(&commit.path) && relative(&commit.old_path) { out.push(commit); }
    }
    Ok(out)
}
fn relative(path: &str) -> bool {
    !path.is_empty() && !path.contains(['\n','\r','\0']) && !Path::new(path).is_absolute()
        && Path::new(path).components().all(|c| matches!(c,std::path::Component::Normal(_)))
        && !safe::private(Path::new(path))
}
fn location(item: &Item, runner: &Runner, deadline: Instant) -> Result<(PathBuf,String),String> {
    let path = PathBuf::from(item.path.as_deref().ok_or("itemUnavailable")?);
    if !path.is_absolute() || safe::private(&path) || safe::private(&safe::canonical(&path))
        || ["runtime","privateCount"].contains(&item.kind.as_str()) || path.is_dir() { return Err("historyDenied".into()); }
    no_links(&path)?;
    let parent = path.parent().and_then(|p| p.ancestors().find(|p| p.is_dir())).ok_or("noRepository")?;
    let root = runner.run(parent,&["rev-parse","--show-toplevel"],deadline).map_err(|e| if e=="gitFailed" { "noRepository".into() } else { e })?;
    let root = PathBuf::from(std::str::from_utf8(&root).map_err(|_| "unsupported")?.trim());
    let root = safe::canonical(&root); let path = safe::canonical(&path);
    let rel = path.strip_prefix(&root).map_err(|_| "historyDenied")?.to_string_lossy().replace('\\',"/");
    if !relative(&rel) { return Err("historyDenied".into()); }
    Ok((root,rel))
}
fn commits(root: &Path, path: &str, runner: &Runner, deadline: Instant) -> Result<Vec<Commit>,String> {
    parse(&runner.run(root,&["log","--follow","-n","30",LOG_FORMAT,"--no-ext-diff","--no-textconv","--raw","--numstat","-z","--",path],deadline)?)
}
pub(super) fn changes(item: &Item, commits: Vec<Commit>) -> Vec<Change> {
    commits.into_iter().map(|c| Change { id: format!("git:{}:{}",item.id,c.hash), item_id: Some(item.id.clone()),
        service: item.service.clone(), layer: item.layer, display_name: item.display_name.clone(), path: item.path.clone(),
        kind: if c.status.starts_with('A') { "added" } else if c.status.starts_with('D') { "deleted" } else if c.status.starts_with('R') { "renamed" } else { "changed" }.into(),
        badge: "fileChanged".into(), source: "git".into(), at: c.at, before_bytes: None, after_bytes: None, amount_changes: vec![],
        hash: Some(c.hash), subject: Some(c.subject), author: if c.author.is_empty() { None } else { Some(c.author) },
        lines_added: c.added, lines_deleted: c.deleted }).collect()
}
pub(super) fn list(_home: &Path, _cwd: &Path, item: &Item, runner: &Runner) -> Result<GitHistory,String> {
    let deadline = Instant::now() + runner.timeout;
    let result = location(item,runner,deadline).and_then(|(root,path)| commits(&root,&path,runner,deadline));
    Ok(match result {
        Ok(c) => {
            let status = if !c.is_empty() { "ready".into() } else {
                location(item, runner, deadline).and_then(|(root, path)| {
                    let tracked = runner.run(&root, &["ls-files", "-z", "--", &path], deadline)?;
                    if !tracked.is_empty() { return Ok("noCommits".into()); }
                    // check-ignore exits 1 for an unignored file, so use a
                    // successful bounded listing instead of treating it as failure.
                    let ignored = runner.run(&root, &["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", &path], deadline)?;
                    Ok(if ignored.is_empty() { "untracked" } else { "ignored" }.into())
                }).unwrap_or_else(|e| e)
            };
            GitHistory { status, changes: changes(item,c) }
        },
        Err(status) => GitHistory { status, changes: vec![] },
    })
}
fn tree(root: &Path, revision: Option<&str>, path: &str, runner: &Runner, deadline: Instant) -> Result<Option<(u64,bool)>,String> {
    let Some(revision) = revision else { return Ok(None); };
    let out = runner.run(root,&["ls-tree","-l",revision,"--",path],deadline)?;
    let text=std::str::from_utf8(&out).map_err(|_|"unsupported")?;
    if text.is_empty() { return Ok(None); }
    let fields:Vec<_>=text.split_once('\t').ok_or("unsupported")?.0.split_whitespace().collect();
    if fields.len()!=4 { return Err("unsupported".into()); }
    Ok(fields[3].parse().ok().map(|size|(size,["100644","100755"].contains(&fields[0]))))
}
fn body(root: &Path, revision: Option<&str>, path: &str, runner: &Runner, deadline: Instant) -> Result<String,String> {
    let Some(revision) = revision else { return Ok(String::new()); };
    let out = runner.run(root,&["show","--no-ext-diff","--no-textconv",&format!("{revision}:{path}")],deadline)?;
    let text = String::from_utf8(out).map_err(|_| "unsupported")?;
    if text.contains('\0') { return Err("unsupported".into()); }
    Ok(text.replace("\r\n","\n").replace('\r',"\n"))
}
pub(super) fn fields(kind: &str, text: &str) -> Option<String> {
    let mut out = BTreeMap::<String,String>::new();
    if kind == "toml" {
        let value = text.parse::<toml_edit::DocumentMut>().ok()?;
        for key in ["model","model_reasoning_effort","approval_policy","sandbox_mode","personality"] {
            if let Some(v) = value.get(key).and_then(|v|v.as_str()).and_then(safe::identifier) { out.insert(key.into(),v); }
        }
        for (section,prefix) in [("plugins","plugin"),("mcp_servers","mcp")] {
            for (key,value) in value.get(section).and_then(|v|v.as_table_like()).into_iter().flat_map(|v|v.iter()) {
                if let Some(key) = safe::identifier(key) {
                    let enabled = value.get("enabled").and_then(|v|v.as_bool()).or_else(||value.as_bool()).unwrap_or(true);
                    out.insert(format!("{prefix}:{key}"),enabled.to_string());
                }
            }
        }
    } else {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        for key in ["model","effortLevel"] {
            if let Some(v) = value[key].as_str().and_then(safe::identifier) { out.insert(key.into(),v); }
        }
        if let Some(v) = value["permissions"]["defaultMode"].as_str().and_then(safe::identifier) { out.insert("defaultMode".into(),v); }
        out.insert("allowCount".into(),value["permissions"]["allow"].as_array().map_or(0,Vec::len).to_string());
        out.insert("envCount".into(),value["env"].as_object().map_or(0,serde_json::Map::len).to_string());
        for (section,prefix) in [("enabledPlugins","plugin"),("mcpServers","mcp")] {
            for (key,value) in value[section].as_object().into_iter().flatten() {
                if let Some(key) = safe::identifier(key) {
                    out.insert(format!("{prefix}:{key}"),value.as_bool().or_else(||value["enabled"].as_bool()).unwrap_or(true).to_string());
                }
            }
        }
        for (event,handlers) in value["hooks"].as_object().into_iter().flatten() {
            let Some(event) = safe::identifier(event) else { continue; };
            for (index,hook) in handlers.as_array().into_iter().flatten().flat_map(|h|h["hooks"].as_array().into_iter().flatten()).enumerate() {
                if let Some(command) = hook["command"].as_str() {
                    out.insert(format!("hook:{event}:{index}"),safe::script_name(command));
                }
            }
        }
    }
    Some(out.into_iter().map(|(k,v)|format!("{k}: {v}\n")).collect())
}
pub(super) fn lines(before: &str, after: &str) -> (Vec<DiffLine>,bool) {
    // Historic text never exposes values or offers a reveal path. Mask each
    // complete side before splitting, including multi-line containers.
    let before = super::super::redaction::mask(before, false).body;
    let after = super::super::redaction::mask(after, false).body;
    let a: Vec<_> = before.lines().collect(); let b: Vec<_> = after.lines().collect();
    let mut prefix = 0;
    while prefix < a.len().min(b.len()) && a[prefix] == b[prefix] { prefix+=1; }
    let mut suffix = 0;
    while suffix < (a.len()-prefix).min(b.len()-prefix) && a[a.len()-1-suffix] == b[b.len()-1-suffix] { suffix+=1; }
    let mut out = vec![];
    let mut push = |kind: &str, old_line, new_line, text: &str| out.push(DiffLine {
        kind: kind.into(),old_line,new_line,text:text.chars().take(4096).collect() });
    for (i,text) in a.iter().enumerate().take(prefix).skip(prefix.saturating_sub(3)) { push("context",Some(i+1),Some(i+1),text); }
    for (i,text) in a.iter().enumerate().take(a.len()-suffix).skip(prefix).take(500) { push("deleted",Some(i+1),None,text); }
    for (i,text) in b.iter().enumerate().take(b.len()-suffix).skip(prefix).take(500) { push("added",None,Some(i+1),text); }
    for i in 0..suffix.min(3) { push("context",Some(a.len()-suffix+i+1),Some(b.len()-suffix+i+1),a[a.len()-suffix+i]); }
    let truncated = a.len()-prefix-suffix > 500 || b.len()-prefix-suffix > 500 || out.iter().any(|l|l.text.chars().count()>=4096);
    (out,truncated)
}
fn empty(mode: &str, status: &str) -> HistoryDiff {
    HistoryDiff { mode: mode.into(), status: status.into(), lines: vec![],before_bytes: None, after_bytes: None,truncated: false }
}
pub(super) fn diff(home: &Path, cwd: &Path, item: &Item, hash: &str, runner: &Runner) -> Result<HistoryDiff,String> {
    if !hex(hash,&[40,64]) { return Err("revisionDenied".into()); }
    let deadline = Instant::now()+runner.timeout;
    let (root,path) = location(item,runner,deadline)?;
    // Only revisions in this item's bounded --follow log may be requested.
    let c = commits(&root,&path,runner,deadline)?.into_iter().find(|c|c.hash==hash).ok_or("revisionDenied")?;
    let before_revision = if c.status.starts_with('A') { None } else { c.parent.as_deref() };
    let after_revision = if c.status.starts_with('D') { None } else { Some(c.hash.as_str()) };
    let before_tree = tree(&root,before_revision,&c.old_path,runner,deadline)?;
    let after_tree = tree(&root,after_revision,&c.path,runner,deadline)?;
    let before_bytes = before_tree.map(|(size,_)|size);
    let after_bytes = after_tree.map(|(size,_)|size);
    let regular = before_tree.is_none_or(|(_,regular)|regular) && after_tree.is_none_or(|(_,regular)|regular);
    let allowed_path = |path: &str| {
        let mut historical = item.clone();
        historical.path = Some(root.join(path).to_string_lossy().into());
        super::super::authorized(home,cwd,&historical)
    };
    let doc = regular && item.layer != 4 && item.document_allowed && super::super::authorized(home,cwd,item)
        && (before_revision.is_none() || allowed_path(&c.old_path))
        && (after_revision.is_none() || allowed_path(&c.path));
    // A current settings type must not authorize a renamed memory or other blob.
    let settings_path = |path: &str| {
        let historical = root.join(path);
        let current = Path::new(item.path.as_deref().unwrap());
        historical.parent().zip(current.parent()).is_some_and(|(a,b)| safe::same_path(a,b))
            && match item.service.as_str() {
                "claude" => ["settings.json","settings.local.json"].contains(&safe::basename(&historical).as_str()),
                "codex" => ["config.toml","hooks.json"].contains(&safe::basename(&historical).as_str()),
                _ => false,
            }
    };
    let settings = regular && item.layer != 4 && ["settings","settingsLocal","hooks","mcp"].contains(&item.kind.as_str())
        && (before_revision.is_none() || settings_path(&c.old_path))
        && (after_revision.is_none() || settings_path(&c.path));
    let mode = if doc { "text" } else if settings { "fields" } else { "hidden" };
    if mode == "hidden" { return Ok(HistoryDiff { before_bytes,after_bytes,..empty(mode,"ready") }); }
    let result = (|| {
        let a = body(&root,before_revision,&c.old_path,runner,deadline)?;
        let b = body(&root,after_revision,&c.path,runner,deadline)?;
        let (a,b) = if settings {
            let format = if path.ends_with(".toml") { "toml" } else { "json" };
            (if a.is_empty() { String::new() } else { fields(format,&a).ok_or("unsupported")? },
             if b.is_empty() { String::new() } else { fields(format,&b).ok_or("unsupported")? })
        } else { (a,b) };
        Ok::<_,String>(lines(&a,&b))
    })();
    Ok(match result {
        Ok((lines,truncated)) => HistoryDiff { mode: mode.into(),lines,before_bytes,after_bytes,truncated,status:"ready".into() },
        Err(status) => HistoryDiff { before_bytes,after_bytes,..empty(mode,&status) },
    })
}
