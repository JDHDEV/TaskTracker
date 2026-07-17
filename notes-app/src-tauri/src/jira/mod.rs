//! JIRA ticket enrichment — the third swap point, mirroring `AiProvider` and
//! `ItemRepository`. A `JiraProvider` fetches a ticket's title/status from a
//! vendor's REST API; which vendor and which HTTP shape is this module's
//! business, exactly as SQLite is the repository's and Anthropic is the AI
//! provider's.
//!
//! SECURITY (the Critical item): enrichment is **host-pinned** to the
//! server-held `JiraConfig.base_url`. The stored `item.jira_url` is used ONLY
//! to re-extract the ticket key here in the backend (`extract_ticket_key`);
//! its host is discarded and is never a request destination. An `item.jira_url`
//! of `http://169.254.169.254/latest/meta-data/` therefore triggers no request
//! to that host — its last path segment isn't a ticket key, so extraction
//! returns `None` and the command fails before any network call; and even a
//! key-shaped foreign URL only yields the key, which is then requested against
//! the configured Atlassian host (`issue_url`).

use serde_json::Value;

use crate::error::{AppError, Result};
use crate::models::{JiraConfig, StatusCategory, TicketMeta};

/// Credential-store entry id for the JIRA API token (parallel to the AI
/// provider ids). Boolean-only presence, never returned to the frontend.
pub const TOKEN_ID: &str = "atlassian";

/// Mint an RFC 3339 timestamp with fixed millisecond precision (matches the
/// repository's `now_rfc3339`, K10).
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// The enrichment swap point. `fetch_ticket` is handed the server-held config
/// and the already-re-extracted key — never the raw `jira_url` — so an impl
/// cannot be tricked into calling an attacker-chosen host.
#[async_trait::async_trait]
pub trait JiraProvider: Send + Sync {
    fn id(&self) -> &'static str;

    async fn fetch_ticket(
        &self,
        http: &reqwest::Client,
        config: &JiraConfig,
        token: &str,
        key: &str,
    ) -> Result<TicketMeta>;
}

pub fn jira_provider_for(id: &str) -> Result<Box<dyn JiraProvider>> {
    match id {
        "atlassian-cloud" => Ok(Box::new(AtlassianCloud)),
        other => Err(AppError::Invalid(format!("unknown JIRA provider: {other}"))),
    }
}

/// The default (and, for v1, only) provider id. Atlassian Server/Data Center
/// reached EOL in Feb 2024, so Cloud is the single supported flavor.
pub const DEFAULT_PROVIDER: &str = "atlassian-cloud";

pub struct AtlassianCloud;

#[async_trait::async_trait]
impl JiraProvider for AtlassianCloud {
    fn id(&self) -> &'static str {
        DEFAULT_PROVIDER
    }

    async fn fetch_ticket(
        &self,
        http: &reqwest::Client,
        config: &JiraConfig,
        token: &str,
        key: &str,
    ) -> Result<TicketMeta> {
        // Destination is built ONLY from the configured base_url (host-pinned).
        let url = issue_url(&config.base_url, key);
        let response = http
            .get(&url)
            .query(&[("fields", "summary,status")])
            // Cloud auth is HTTP Basic email:api_token (not Bearer). The token
            // travels only as this header, never in a URL/body/error/log.
            .basic_auth(&config.email, Some(token))
            .header("Accept", "application/json")
            // reqwest has no default timeout; an unbounded on-demand lookup
            // would hang the chip forever.
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            // Status only — never the auth header or response body.
            return Err(status_to_error(status));
        }
        let body = response.text().await?;
        parse_issue(&body, key, &now_rfc3339())
    }
}

/// Build the issue endpoint from the CONFIGURED base URL and a ticket key.
/// This is the host-pinning boundary: the only origin that ever reaches the
/// network is `base_url`'s. Trailing slashes on the base are tolerated.
pub fn issue_url(base_url: &str, key: &str) -> String {
    format!(
        "{}/rest/api/3/issue/{}",
        base_url.trim_end_matches('/'),
        key
    )
}

/// Re-extract a ticket key from a stored `jira_url`, server-side. Rust port of
/// `jira.ts`'s anchored `^[A-Za-z][A-Za-z0-9]*-\d+$` on the last path segment.
/// Parsing via `Url` (not string slicing) means query/fragment are dropped and
/// the key regex governs the one dynamic path segment — so `../`, `?`, `#`, and
/// whitespace can't smuggle anything through. Returns the UPPERCASED key, or
/// `None` when the URL doesn't parse or has no key-shaped last segment.
pub fn extract_ticket_key(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.filter(|s| !s.is_empty()).next_back()?;
    if is_ticket_key(last) {
        Some(last.to_ascii_uppercase())
    } else {
        None
    }
}

/// `^[A-Za-z][A-Za-z0-9]*-\d+$`, hand-checked to avoid a regex dependency and
/// any ReDoS surface. A leading letter, then letters/digits, a single `-`
/// before the number, and one-or-more digits to the end.
fn is_ticket_key(s: &str) -> bool {
    let Some((project, number)) = s.rsplit_once('-') else {
        return false;
    };
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let mut chars = project.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric())
}

/// Validate a JIRA site URL for the config save path AND before any fetch:
/// must be a parseable `https` URL with a non-empty host. `https`-only keeps
/// TLS verification meaningful (no cleartext token, no downgrade).
pub fn validate_base_url(base_url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(base_url)
        .map_err(|_| AppError::Invalid("JIRA site URL must be a valid URL".into()))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Invalid("JIRA site URL must use https".into()));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(AppError::Invalid("JIRA site URL must include a host".into()));
    }
    Ok(())
}

/// Map a non-2xx JIRA response to a clean, non-leaking error. Distinct 429
/// (rate limit) and auth/not-found cases; everything carries the status number
/// only — never the auth header, never the response body.
pub fn status_to_error(status: reqwest::StatusCode) -> AppError {
    match status.as_u16() {
        429 => AppError::RateLimited,
        401 | 403 => {
            AppError::Provider("JIRA authentication failed — check the email and API token".into())
        }
        404 => AppError::Provider("JIRA ticket not found".into()),
        other => AppError::Provider(format!("JIRA request failed ({other})")),
    }
}

/// Parse the `GET /rest/api/3/issue/{key}?fields=summary,status` body into a
/// `TicketMeta`. Missing optional fields degrade to empty strings rather than
/// erroring — a ticket with no summary still enriches. The coarse
/// `statusCategory.key` (stable across workflows) drives the UI dot; an unknown
/// or absent bucket falls back to the neutral `New`.
pub fn parse_issue(body: &str, fallback_key: &str, fetched_at: &str) -> Result<TicketMeta> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AppError::Provider("JIRA returned an unreadable response".into()))?;

    let fields = v.get("fields");
    let title = fields
        .and_then(|f| f.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let status_obj = fields.and_then(|f| f.get("status"));
    let status = status_obj
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let category_key = status_obj
        .and_then(|s| s.get("statusCategory"))
        .and_then(|c| c.get("key"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let status_category = match category_key {
        "done" => StatusCategory::Done,
        "indeterminate" => StatusCategory::Indeterminate,
        _ => StatusCategory::New,
    };

    let key = v
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or(fallback_key)
        .to_string();

    Ok(TicketMeta {
        key,
        title,
        status,
        status_category,
        fetched_at: fetched_at.to_string(),
    })
}
