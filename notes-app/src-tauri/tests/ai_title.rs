//! Integration tests for the AI title-generation path (Plan 5). They drive
//! `ai::generate_title` DIRECTLY with hand-rolled fake `AiProvider`s: the
//! `#[tauri::command] ai_generate_title` wrapper needs `State<AppState>` and
//! cannot run outside a live Tauri app (the same structural limit as
//! `ai_rewrite_stream` and `get_jira_ticket`), so the wrapper itself stays
//! untested and every piece of testable logic lives in the free
//! `generate_title` core it delegates to.

use std::sync::atomic::{AtomicBool, Ordering};

use notes_app_lib::ai::{self, AiProvider};
use notes_app_lib::error::{AppError, Result};

/// Hand-rolled fake provider, scripted per scenario. Records whether `rewrite`
/// was actually invoked so the empty-text guard test can prove the short-circuit.
struct FakeProvider {
    outcome: Outcome,
    called: AtomicBool,
}

enum Outcome {
    /// `rewrite` returns this raw string (pre-sanitization).
    Returns(&'static str),
    /// `rewrite` fails with the given error kind.
    Fails(ErrKind),
}

enum ErrKind {
    MissingKey,
    Provider(&'static str),
    Http,
    Invalid(&'static str),
}

impl FakeProvider {
    fn returning(raw: &'static str) -> Self {
        Self {
            outcome: Outcome::Returns(raw),
            called: AtomicBool::new(false),
        }
    }

    fn failing(kind: ErrKind) -> Self {
        Self {
            outcome: Outcome::Fails(kind),
            called: AtomicBool::new(false),
        }
    }

    fn was_called(&self) -> bool {
        self.called.load(Ordering::SeqCst)
    }
}

/// A real `reqwest::Error`, built offline and deterministically: an unparseable
/// URL fails at builder time with no network I/O. Lets the `Http` scenario use
/// the genuine variant rather than a stand-in.
fn a_reqwest_error() -> reqwest::Error {
    reqwest::Client::new()
        .get("not a url")
        .build()
        .expect_err("an unparseable URL must fail to build")
}

#[async_trait::async_trait]
impl AiProvider for FakeProvider {
    fn id(&self) -> &'static str {
        "fake"
    }

    async fn rewrite(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
    ) -> Result<String> {
        self.called.store(true, Ordering::SeqCst);
        match &self.outcome {
            Outcome::Returns(raw) => Ok((*raw).to_string()),
            Outcome::Fails(kind) => Err(match kind {
                ErrKind::MissingKey => AppError::MissingKey("anthropic".into()),
                ErrKind::Provider(body) => AppError::Provider((*body).to_string()),
                ErrKind::Http => AppError::Http(a_reqwest_error()),
                ErrKind::Invalid(msg) => AppError::Invalid((*msg).to_string()),
            }),
        }
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

const GENERIC_COPY: &str = "couldn't generate a title — try again";

// --- happy path ------------------------------------------------------------

#[tokio::test]
async fn happy_path_returns_the_sanitized_title() {
    // Multi-line + wrapping quotes: proves sanitize_title runs on provider output.
    let provider = FakeProvider::returning("\"Cutover checklist\"\nignored second line");
    let title = ai::generate_title(&provider, &http(), "some body text")
        .await
        .expect("should succeed");
    assert_eq!(title, "Cutover checklist");
    assert!(provider.was_called());
}

// --- empty-text guard runs before the provider -----------------------------

#[tokio::test]
async fn empty_text_errors_before_calling_the_provider() {
    let provider = FakeProvider::returning("unused");
    let err = ai::generate_title(&provider, &http(), "   \n\t ")
        .await
        .expect_err("whitespace-only text must be rejected");
    assert!(matches!(err, AppError::Invalid(_)));
    assert!(
        !provider.was_called(),
        "the provider must not be called for empty text"
    );
}

// --- MissingKey passes through with its distinct copy ----------------------

#[tokio::test]
async fn missing_key_propagates_with_the_settings_copy() {
    let provider = FakeProvider::failing(ErrKind::MissingKey);
    let err = ai::generate_title(&provider, &http(), "body")
        .await
        .expect_err("missing key must error");
    assert!(matches!(err, AppError::MissingKey(_)));
    // The distinct, actionable copy survives (single-sourced in error.rs Display).
    assert!(err.to_string().contains("add one in Settings"));
    assert_ne!(err.to_string(), GENERIC_COPY);
}

// --- Provider/Http failures collapse to the generic copy, body scrubbed -----

#[tokio::test]
async fn provider_error_collapses_to_generic_copy_without_the_raw_body() {
    // Shape mirrors the real vendor code: "Anthropic API returned 401: {body}".
    let provider = FakeProvider::failing(ErrKind::Provider(
        "Anthropic API returned 401: {\"error\":\"invalid_api_key sk-secret-leak\"}",
    ));
    let err = ai::generate_title(&provider, &http(), "body")
        .await
        .expect_err("provider error must surface");
    assert_eq!(err.to_string(), GENERIC_COPY);
    assert!(
        !err.to_string().contains("sk-secret-leak"),
        "raw upstream body must not leak into the message"
    );
}

#[tokio::test]
async fn http_error_collapses_to_generic_copy() {
    let provider = FakeProvider::failing(ErrKind::Http);
    let err = ai::generate_title(&provider, &http(), "body")
        .await
        .expect_err("http error must surface");
    assert_eq!(err.to_string(), GENERIC_COPY);
}

#[tokio::test]
async fn other_provider_error_variants_also_collapse_to_generic_copy() {
    // Any non-MissingKey error maps to the generic copy — even an Invalid that
    // somehow arrives from the provider layer (defensive, D9).
    let provider = FakeProvider::failing(ErrKind::Invalid("some internal detail"));
    let err = ai::generate_title(&provider, &http(), "body")
        .await
        .expect_err("must surface");
    assert_eq!(err.to_string(), GENERIC_COPY);
    assert!(!err.to_string().contains("some internal detail"));
}

// --- empty-after-sanitize is a failure, never an empty-string success -------

#[tokio::test]
async fn whitespace_only_generation_is_a_generic_error_not_empty_success() {
    let provider = FakeProvider::returning("   \n  \t ");
    let err = ai::generate_title(&provider, &http(), "body")
        .await
        .expect_err("an all-whitespace generation must not succeed");
    assert!(matches!(err, AppError::Provider(_)));
    assert_eq!(err.to_string(), GENERIC_COPY);
}

// --- RED evidence: sanitization is load-bearing -----------------------------

/// Proves the happy-path assertion actually depends on `sanitize_title`: if
/// `generate_title` returned the provider's raw output verbatim, the returned
/// title would still carry the wrapping quotes and the second line, and the
/// happy-path `assert_eq!` above would fail. Mirrors the `IgnoresCancellation`
/// discipline in `tests/streaming.rs`.
#[tokio::test]
async fn sanitization_actually_transforms_multiline_quoted_output() {
    let raw = "\"Cutover checklist\"\nignored second line";
    let provider = FakeProvider::returning(raw);
    let title = ai::generate_title(&provider, &http(), "body").await.unwrap();
    assert_ne!(title, raw, "raw model output must not pass through unsanitized");
    assert_eq!(title, "Cutover checklist");
    // Direct pin: the raw string sanitized equals the title the core returned.
    assert_eq!(ai::sanitize_title(raw), title);
}
