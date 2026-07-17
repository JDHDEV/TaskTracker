//! JIRA enrichment tests (Phase 4 Track 4). The command layer
//! (`get_jira_ticket`) needs `State<AppState>` + a live network and can't run
//! outside a Tauri app — the same limit as `ai_rewrite_stream` — so these lock
//! down the pure, security-critical pieces it composes: server-side ticket-key
//! re-extraction, host-pinned URL construction (the SSRF guard), response
//! mapping, and status→error classification.

use notes_app_lib::error::AppError;
use notes_app_lib::jira;
use notes_app_lib::models::StatusCategory;

// --- Ticket-key re-extraction (server-side port of jira.ts) ---------------

#[test]
fn extracts_key_from_a_browse_url() {
    assert_eq!(
        jira::extract_ticket_key("https://acme.atlassian.net/browse/PLAT-142").as_deref(),
        Some("PLAT-142")
    );
}

#[test]
fn extraction_uppercases_the_key() {
    assert_eq!(
        jira::extract_ticket_key("https://acme.atlassian.net/browse/plat-142").as_deref(),
        Some("PLAT-142")
    );
}

#[test]
fn extraction_ignores_a_trailing_slash() {
    assert_eq!(
        jira::extract_ticket_key("https://acme.atlassian.net/browse/PLAT-142/").as_deref(),
        Some("PLAT-142")
    );
}

#[test]
fn extraction_ignores_query_and_fragment() {
    // Parsing via Url drops ?/# before the key regex sees the last segment.
    assert_eq!(
        jira::extract_ticket_key("https://acme.atlassian.net/browse/PLAT-142?focused=1#c").as_deref(),
        Some("PLAT-142")
    );
}

#[test]
fn no_key_for_a_non_ticket_last_segment() {
    assert_eq!(
        jira::extract_ticket_key("https://acme.atlassian.net/secure/Dashboard.jspa"),
        None
    );
    assert_eq!(jira::extract_ticket_key("https://acme.atlassian.net/"), None);
    // leading digit, missing number, and doubled dash all fail the anchor
    assert_eq!(jira::extract_ticket_key("https://x/browse/1PLAT-2"), None);
    assert_eq!(jira::extract_ticket_key("https://x/browse/PLAT-"), None);
    assert_eq!(jira::extract_ticket_key("https://x/browse/PLAT"), None);
}

#[test]
fn no_key_for_an_unparseable_url() {
    assert_eq!(jira::extract_ticket_key("not a url"), None);
    assert_eq!(jira::extract_ticket_key(""), None);
}

// --- SSRF guard: destination is host-pinned to the configured base URL -----

/// Mirrors exactly what `get_jira_ticket` composes: extract a key from the
/// stored `jira_url`, then build the request URL from the CONFIGURED base URL.
/// `None` means "no key ⇒ command errors before any network call".
fn resolve_destination(jira_url: &str, configured_base: &str) -> Option<String> {
    jira::extract_ticket_key(jira_url).map(|key| jira::issue_url(configured_base, &key))
}

#[test]
fn ssrf_metadata_host_url_triggers_no_lookup() {
    // The classic SSRF target. Its last path segment ("meta-data") is not a
    // ticket key, so extraction yields None and the command fails before it
    // ever touches the network — no request to 169.254.169.254.
    assert_eq!(
        resolve_destination(
            "http://169.254.169.254/latest/meta-data/",
            "https://acme.atlassian.net"
        ),
        None
    );
}

#[test]
fn ssrf_key_shaped_foreign_url_is_still_dialed_at_the_configured_host() {
    // Even when a hostile jira_url carries a valid-looking key, the ONLY origin
    // that reaches the network is the configured base URL — the jira_url host
    // is discarded after key extraction. Red against a "dial jira_url's host"
    // regression.
    let dest = resolve_destination(
        "http://169.254.169.254/browse/PLAT-142",
        "https://acme.atlassian.net",
    )
    .expect("a key-shaped segment resolves");
    let host = reqwest::Url::parse(&dest).unwrap().host_str().unwrap().to_string();
    assert_eq!(host, "acme.atlassian.net");
    assert!(!dest.contains("169.254.169.254"));
    assert_eq!(dest, "https://acme.atlassian.net/rest/api/3/issue/PLAT-142");
}

#[test]
fn issue_url_tolerates_a_trailing_slash_on_the_base() {
    assert_eq!(
        jira::issue_url("https://acme.atlassian.net/", "PLAT-142"),
        "https://acme.atlassian.net/rest/api/3/issue/PLAT-142"
    );
}

// --- base-URL validation ---------------------------------------------------

#[test]
fn base_url_must_be_https_with_a_host() {
    assert!(jira::validate_base_url("https://acme.atlassian.net").is_ok());
    assert!(matches!(
        jira::validate_base_url("http://acme.atlassian.net"),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        jira::validate_base_url("ftp://acme"),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        jira::validate_base_url("not a url"),
        Err(AppError::Invalid(_))
    ));
}

// --- Response mapping ------------------------------------------------------

const FETCHED: &str = "2026-07-16T00:00:00.000Z";

fn issue_json(summary: &str, status_name: &str, category: &str) -> String {
    format!(
        r#"{{"key":"PLAT-142","fields":{{"summary":{summary:?},"status":{{"name":{status_name:?},"statusCategory":{{"key":{category:?}}}}}}}}}"#
    )
}

#[test]
fn maps_summary_status_and_category() {
    let meta =
        jira::parse_issue(&issue_json("Fix the thing", "In Progress", "indeterminate"), "PLAT-142", FETCHED)
            .unwrap();
    assert_eq!(meta.key, "PLAT-142");
    assert_eq!(meta.title, "Fix the thing");
    assert_eq!(meta.status, "In Progress");
    assert_eq!(meta.status_category, StatusCategory::Indeterminate);
    assert_eq!(meta.fetched_at, FETCHED);
}

#[test]
fn maps_all_three_status_categories() {
    for (key, expected) in [
        ("new", StatusCategory::New),
        ("indeterminate", StatusCategory::Indeterminate),
        ("done", StatusCategory::Done),
    ] {
        let meta = jira::parse_issue(&issue_json("t", "s", key), "PLAT-1", FETCHED).unwrap();
        assert_eq!(meta.status_category, expected, "category {key}");
    }
}

#[test]
fn unknown_or_absent_category_falls_back_to_new() {
    let meta = jira::parse_issue(&issue_json("t", "s", "weird"), "PLAT-1", FETCHED).unwrap();
    assert_eq!(meta.status_category, StatusCategory::New);
    // status object entirely absent → still New, empty status, no panic
    let meta = jira::parse_issue(r#"{"key":"PLAT-1","fields":{}}"#, "PLAT-1", FETCHED).unwrap();
    assert_eq!(meta.status_category, StatusCategory::New);
    assert_eq!(meta.status, "");
}

#[test]
fn missing_summary_degrades_to_empty_title() {
    let meta = jira::parse_issue(
        r#"{"key":"PLAT-1","fields":{"status":{"name":"To Do","statusCategory":{"key":"new"}}}}"#,
        "PLAT-1",
        FETCHED,
    )
    .unwrap();
    assert_eq!(meta.title, "");
    assert_eq!(meta.status, "To Do");
}

#[test]
fn falls_back_to_the_extracted_key_when_the_body_omits_it() {
    let meta = jira::parse_issue(r#"{"fields":{}}"#, "PLAT-9", FETCHED).unwrap();
    assert_eq!(meta.key, "PLAT-9");
}

#[test]
fn markup_in_the_summary_is_carried_verbatim() {
    // The backend passes remote text through unchanged; the frontend renders it
    // as a React text node (never HTML). Prove the string is not mangled here.
    let meta = jira::parse_issue(
        &issue_json("<img src=x onerror=alert(1)>", "Done", "done"),
        "PLAT-1",
        FETCHED,
    )
    .unwrap();
    assert_eq!(meta.title, "<img src=x onerror=alert(1)>");
}

#[test]
fn unreadable_body_is_a_clean_provider_error() {
    assert!(matches!(
        jira::parse_issue("{not json", "PLAT-1", FETCHED),
        Err(AppError::Provider(_))
    ));
}

// --- status classification -------------------------------------------------

#[test]
fn status_classification_is_distinct_and_non_leaking() {
    use reqwest::StatusCode;
    assert!(matches!(
        jira::status_to_error(StatusCode::TOO_MANY_REQUESTS),
        AppError::RateLimited
    ));
    assert!(matches!(
        jira::status_to_error(StatusCode::UNAUTHORIZED),
        AppError::Provider(_)
    ));
    assert!(matches!(
        jira::status_to_error(StatusCode::FORBIDDEN),
        AppError::Provider(_)
    ));
    assert!(matches!(
        jira::status_to_error(StatusCode::NOT_FOUND),
        AppError::Provider(_)
    ));
    // No message carries an auth header or token — auth failures name neither.
    let AppError::Provider(msg) = jira::status_to_error(StatusCode::UNAUTHORIZED) else {
        panic!("expected Provider");
    };
    assert!(!msg.to_lowercase().contains("authorization"));
}

// --- provider registry ------------------------------------------------------

#[test]
fn provider_registry_resolves_cloud_and_rejects_unknown() {
    assert_eq!(
        jira::jira_provider_for(jira::DEFAULT_PROVIDER).unwrap().id(),
        "atlassian-cloud"
    );
    assert!(matches!(
        jira::jira_provider_for("server"),
        Err(AppError::Invalid(_))
    ));
}
