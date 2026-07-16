use chrono::Utc;
use mycmux_lib::usage::oauth_login::*;
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::Value;
use std::{
    io::{self, Write},
    time::Duration,
};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[tokio::main]
async fn main() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("HTTP client build failed: {error}"))?;

    let pkce_pairs = [generate_pkce(), generate_pkce()];
    let authorize_urls = [
        build_authorize_url(&pkce_pairs[0], REDIRECT_URI_CANDIDATES[0])?,
        build_authorize_url(&pkce_pairs[1], REDIRECT_URI_CANDIDATES[1])?,
    ];

    println!("[1] platform.claude.com");
    println!("{}", authorize_urls[0]);
    println!();
    println!("[2] console.anthropic.com");
    println!("{}", authorize_urls[1]);
    println!();

    let choice = prompt("Which URL did you authorize with? (1/2): ")?;
    let selected = match choice.trim() {
        "1" => 0,
        "2" => 1,
        _ => return Err("URL selection must be 1 or 2".to_string()),
    };

    let pasted = prompt("Paste code#state: ")?;
    let (code, state) = parse_pasted_code(&pasted)?;
    let pkce = &pkce_pairs[selected];
    if state != pkce.state {
        return Err("OAuth state mismatch".to_string());
    }

    let tokens = exchange_code(
        &client,
        &code,
        &state,
        &pkce.verifier,
        REDIRECT_URI_CANDIDATES[selected],
    )
    .await?;

    println!("OAuth token exchange succeeded.");
    println!("access_token: {}", redact(&tokens.access_token));
    match tokens.refresh_token.as_deref() {
        Some(token) => println!("refresh_token: {}", redact(token)),
        None => println!("refresh_token: (not returned)"),
    }
    println!("expires_in: {}", tokens.expires_in);
    println!(
        "scope: {}",
        tokens.scope.as_deref().unwrap_or("(not returned)")
    );
    println!(
        "account.email_address: {}",
        tokens
            .account
            .as_ref()
            .and_then(|account| account.email_address.as_deref())
            .unwrap_or("(not returned)")
    );
    println!(
        "organization.name: {}",
        tokens
            .organization
            .as_ref()
            .and_then(|organization| organization.name.as_deref())
            .unwrap_or("(not returned)")
    );

    let expires_at_ms = expires_at_ms_from(tokens.expires_in, Utc::now().timestamp_millis());
    let stored_tokens = serde_json::json!({
        "access_token": tokens.access_token.as_str(),
        "refresh_token": tokens.refresh_token.as_deref(),
        "expires_at_ms": expires_at_ms,
        "scope": tokens.scope.as_deref(),
    });
    let stored_tokens_chars = stored_tokens.to_string().chars().count();
    println!("StoredTokens-equivalent JSON length: {stored_tokens_chars} chars");

    let usage_response = client
        .get(USAGE_URL)
        .bearer_auth(&tokens.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(USER_AGENT, "claude-code/2.1.0")
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .send()
        .await
        .map_err(|error| format!("Claude usage network error: {error}"))?;
    let usage_status = usage_response.status();
    let usage_body = usage_response
        .text()
        .await
        .map_err(|error| format!("Claude usage response read failed: {error}"))?;
    let usage_json: Value = serde_json::from_str(&usage_body)
        .map_err(|error| format!("Claude usage JSON parse failed: {error}"))?;

    println!("Claude usage response ({usage_status}):");
    println!(
        "{}",
        serde_json::to_string_pretty(&usage_json)
            .map_err(|error| format!("Claude usage JSON formatting failed: {error}"))?
    );

    let refresh_choice = prompt("Test refresh? (y/N): ")?;
    if refresh_choice.trim().eq_ignore_ascii_case("y") {
        let Some(refresh_token) = tokens.refresh_token.as_deref() else {
            println!("Refresh skipped: no refresh_token was returned.");
            return Ok(());
        };

        let refreshed = refresh_access_token(&client, refresh_token).await?;
        let returned_refresh_token = refreshed.refresh_token.as_deref();
        println!("Refresh succeeded.");
        println!("access_token: {}", redact(&refreshed.access_token));
        match returned_refresh_token {
            Some(token) => println!("refresh_token: {}", redact(token)),
            None => println!("refresh_token: (not returned)"),
        }
        println!(
            "new refresh_token returned: {}",
            returned_refresh_token.is_some()
        );
        println!(
            "refresh_token rotated: {}",
            returned_refresh_token.is_some_and(|new_token| new_token != refresh_token)
        );
        println!("new expires_in: {}", refreshed.expires_in);
    }

    Ok(())
}

fn prompt(message: &str) -> Result<String, String> {
    print!("{message}");
    io::stdout()
        .flush()
        .map_err(|error| format!("stdout flush failed: {error}"))?;

    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("stdin read failed: {error}"))?;
    Ok(input)
}

fn redact(value: &str) -> String {
    let length = value.chars().count();
    let prefix = value.chars().take(12).collect::<String>();
    format!("{prefix}...(len={length})")
}
