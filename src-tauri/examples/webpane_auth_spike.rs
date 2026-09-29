use std::{
    env,
    error::Error,
    ffi::OsStr,
    fs,
    path::PathBuf,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

const CHATGPT_URL: &str = "https://chatgpt.com";

fn main() -> Result<(), Box<dyn Error>> {
    let data_directory = parse_data_directory()?;
    fs::create_dir_all(&data_directory)?;
    // Not `std::fs::canonicalize`: it returns a `\\?\` path on Windows, and
    // Chromium's network service will not create its cookie database under
    // one. The 2026-08-28 run of this spike concluded the profile handoff
    // worked while the folder it produced held no cookies at all.
    let data_directory = dunce::canonicalize(&data_directory)?;
    let started_at_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();

    println!("SPIKE_STARTED_AT_UNIX_MS={started_at_ms}");
    println!("SPIKE_PID={}", process::id());
    println!("SPIKE_DATA_DIRECTORY={}", data_directory.display());
    println!("SPIKE_URL={CHATGPT_URL}");

    let url = CHATGPT_URL.parse()?;
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.miyazaki.mycmux.webpane-auth-spike".into();

    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "webpane-auth-spike",
                tauri::WebviewUrl::External(url),
            )
            .title("mycmux Web pane auth spike")
            .inner_size(1200.0, 800.0)
            .data_directory(data_directory)
            .on_page_load(|_window, payload| {
                println!(
                    "SPIKE_PAGE_LOAD={:?} URL={}",
                    payload.event(),
                    payload.url()
                );
            })
            .build()?;

            println!("SPIKE_WINDOW_CREATED=true");
            Ok(())
        })
        .run(context)?;

    println!("SPIKE_EXITED=true");
    Ok(())
}

fn parse_data_directory() -> Result<PathBuf, String> {
    let mut args = env::args_os().skip(1);
    let flag = args
        .next()
        .ok_or_else(|| usage("missing --data-directory"))?;
    if flag != OsStr::new("--data-directory") {
        return Err(usage("the first argument must be --data-directory"));
    }

    let path = PathBuf::from(
        args.next()
            .ok_or_else(|| usage("missing data directory path"))?,
    );
    if args.next().is_some() {
        return Err(usage("unexpected extra argument"));
    }
    if !path.is_absolute() {
        return Err(usage("data directory must be an absolute path"));
    }

    Ok(path)
}

fn usage(reason: &str) -> String {
    format!("{reason}. Usage: webpane_auth_spike --data-directory <absolute-path>")
}
