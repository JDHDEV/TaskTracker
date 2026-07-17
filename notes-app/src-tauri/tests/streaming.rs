//! Integration tests for the streaming-rewrite provider/`ChunkSink` contract
//! (Track 3).
//!
//! STRUCTURAL LIMIT: the real "editor body is never written until Replace
//! text" invariant lives entirely in `Editor.tsx` React state, and the
//! streaming Tauri command has no repository access to observe — there is
//! nothing in the backend to assert that invariant against. These tests
//! exercise only the provider/`ChunkSink` contract (ordering, cancellation,
//! the default-impl delegation, and the `RewriteEvent` wire shape); the
//! no-write-until-Replace behavior is covered by manual smoke only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use notes_app_lib::ai::{AiProvider, ChunkSink, RewriteErrorCode, RewriteEvent};
use notes_app_lib::error::Result;

/// Collects emitted chunks and can be told to report cancelled.
struct MockSink {
    chunks: Mutex<Vec<String>>,
    cancelled: AtomicBool,
    /// If set, `is_cancelled()` flips to true once this many chunks have
    /// been received (simulates the consumer requesting cancellation after
    /// observing N chunks arrive).
    cancel_after: Option<usize>,
}

impl MockSink {
    fn new() -> Self {
        Self {
            chunks: Mutex::new(Vec::new()),
            cancelled: AtomicBool::new(false),
            cancel_after: None,
        }
    }

    fn cancel_after(n: usize) -> Self {
        Self {
            chunks: Mutex::new(Vec::new()),
            cancelled: AtomicBool::new(false),
            cancel_after: Some(n),
        }
    }

    fn collected(&self) -> String {
        self.chunks.lock().unwrap().concat()
    }

    fn chunk_count(&self) -> usize {
        self.chunks.lock().unwrap().len()
    }
}

impl ChunkSink for MockSink {
    fn send_chunk(&self, delta: &str) {
        let mut chunks = self.chunks.lock().unwrap();
        chunks.push(delta.to_string());
        if let Some(n) = self.cancel_after {
            if chunks.len() >= n {
                self.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// A provider whose `rewrite_stream` emits an ordered list of deltas,
/// checking `sink.is_cancelled()` cooperatively between each one and
/// returning the partial accumulation early if so.
struct FakeStreamingProvider {
    deltas: Vec<&'static str>,
}

#[async_trait::async_trait]
impl AiProvider for FakeStreamingProvider {
    fn id(&self) -> &'static str {
        "fake-streaming"
    }

    async fn rewrite(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
    ) -> Result<String> {
        Ok(self.deltas.concat())
    }

    async fn rewrite_stream(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
        sink: &dyn ChunkSink,
    ) -> Result<String> {
        let mut acc = String::new();
        for delta in &self.deltas {
            if sink.is_cancelled() {
                return Ok(acc);
            }
            acc.push_str(delta);
            sink.send_chunk(delta);
        }
        Ok(acc)
    }
}

/// A deliberately broken streaming provider that ignores `is_cancelled()`
/// entirely — used only to prove test (c) is RED against non-cooperative
/// implementations before trusting it.
struct IgnoresCancellationProvider {
    deltas: Vec<&'static str>,
}

#[async_trait::async_trait]
impl AiProvider for IgnoresCancellationProvider {
    fn id(&self) -> &'static str {
        "ignores-cancellation"
    }

    async fn rewrite(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
    ) -> Result<String> {
        Ok(self.deltas.concat())
    }

    async fn rewrite_stream(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
        sink: &dyn ChunkSink,
    ) -> Result<String> {
        let mut acc = String::new();
        for delta in &self.deltas {
            // Deliberately does NOT check sink.is_cancelled().
            acc.push_str(delta);
            sink.send_chunk(delta);
        }
        Ok(acc)
    }
}

/// A provider that implements ONLY `rewrite`, relying on the default
/// `rewrite_stream` impl to delegate and emit a single chunk.
struct OneShotOnlyProvider;

#[async_trait::async_trait]
impl AiProvider for OneShotOnlyProvider {
    fn id(&self) -> &'static str {
        "one-shot-only"
    }

    async fn rewrite(
        &self,
        _http: &reqwest::Client,
        _text: &str,
        _instruction: &str,
    ) -> Result<String> {
        Ok("one shot result".to_string())
    }
    // rewrite_stream deliberately not overridden.
}

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

// --- (a) accumulation equals one-shot (ordering) ---------------------------

#[tokio::test]
async fn streaming_accumulation_matches_ordering_of_emitted_deltas() {
    let provider = FakeStreamingProvider {
        deltas: vec!["Hel", "lo, ", "world"],
    };
    let sink = MockSink::new();

    let result = provider
        .rewrite_stream(&http_client(), "irrelevant", "irrelevant", &sink)
        .await
        .unwrap();

    assert_eq!(result, "Hello, world");
    assert_eq!(sink.collected(), "Hello, world");
    assert_eq!(sink.collected(), result);
}

// --- (b) default rewrite_stream delegates to rewrite ------------------------

#[tokio::test]
async fn default_rewrite_stream_delegates_to_rewrite_and_emits_one_chunk() {
    let provider = OneShotOnlyProvider;
    let sink = MockSink::new();

    let result = provider
        .rewrite_stream(&http_client(), "irrelevant", "irrelevant", &sink)
        .await
        .unwrap();

    assert_eq!(result, "one shot result");
    assert_eq!(sink.chunk_count(), 1);
    assert_eq!(sink.collected(), "one shot result");
    assert_eq!(sink.collected(), result);
}

// --- (c) cooperative cancellation --------------------------------------------

#[tokio::test]
async fn cooperative_provider_stops_early_when_sink_reports_cancelled() {
    let provider = FakeStreamingProvider {
        deltas: vec!["Hel", "lo, ", "world"],
    };
    // Flip cancelled after the 2nd chunk is recorded.
    let sink = MockSink::cancel_after(2);

    let result = provider
        .rewrite_stream(&http_client(), "irrelevant", "irrelevant", &sink)
        .await
        .unwrap();

    let full_text = "Hello, world";
    assert!(sink.chunk_count() < 3, "expected fewer than all 3 deltas emitted");
    assert!(
        full_text.starts_with(&result),
        "partial result {result:?} must be a strict prefix of {full_text:?}"
    );
    assert_ne!(result, full_text, "cancellation should have cut the result short");
}

/// RED evidence for (c): a provider that ignores `is_cancelled()` emits every
/// delta regardless of the sink's cancellation flag, proving the cooperative
/// test above actually constrains cancellation behavior rather than passing
/// vacuously.
#[tokio::test]
async fn non_cooperative_provider_ignores_cancellation_and_emits_everything() {
    let provider = IgnoresCancellationProvider {
        deltas: vec!["Hel", "lo, ", "world"],
    };
    let sink = MockSink::cancel_after(2);

    let result = provider
        .rewrite_stream(&http_client(), "irrelevant", "irrelevant", &sink)
        .await
        .unwrap();

    // Documents the failure mode: all 3 chunks still emitted, full text
    // still returned, even though the sink asked to cancel after chunk 2.
    assert_eq!(sink.chunk_count(), 3);
    assert_eq!(result, "Hello, world");
}

// --- (d) RewriteEvent wire contract -----------------------------------------

#[tokio::test]
async fn rewrite_event_chunk_serializes_to_tagged_camel_case_json() {
    let event = RewriteEvent::Chunk { delta: "x".to_string() };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value, serde_json::json!({"type": "chunk", "delta": "x"}));
}

#[tokio::test]
async fn rewrite_event_done_serializes_to_tagged_camel_case_json() {
    let event = RewriteEvent::Done { text: "y".to_string() };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value, serde_json::json!({"type": "done", "text": "y"}));
}

#[tokio::test]
async fn rewrite_event_error_serializes_to_tagged_camel_case_json() {
    let event = RewriteEvent::Error {
        code: RewriteErrorCode::Cancelled,
        message: "m".to_string(),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"type": "error", "code": "cancelled", "message": "m"})
    );
}

#[tokio::test]
async fn rewrite_error_code_variants_serialize_to_camel_case_strings() {
    assert_eq!(
        serde_json::to_string(&RewriteErrorCode::Cancelled).unwrap(),
        "\"cancelled\""
    );
    assert_eq!(
        serde_json::to_string(&RewriteErrorCode::Network).unwrap(),
        "\"network\""
    );
    assert_eq!(
        serde_json::to_string(&RewriteErrorCode::Provider).unwrap(),
        "\"provider\""
    );
    assert_eq!(
        serde_json::to_string(&RewriteErrorCode::Invalid).unwrap(),
        "\"invalid\""
    );
}

// --- (e) markup delta passthrough --------------------------------------------

#[tokio::test]
async fn markup_in_a_delta_is_accumulated_verbatim_unsanitized() {
    let markup = "<img src=x onerror=alert(1)>";
    let provider = FakeStreamingProvider {
        deltas: vec!["before ", markup, " after"],
    };
    let sink = MockSink::new();

    let result = provider
        .rewrite_stream(&http_client(), "irrelevant", "irrelevant", &sink)
        .await
        .unwrap();

    assert!(result.contains(markup), "result must contain markup verbatim: {result:?}");
    assert!(
        sink.collected().contains(markup),
        "sink accumulation must contain markup verbatim: {:?}",
        sink.collected()
    );
    assert_eq!(result, format!("before {markup} after"));
}
