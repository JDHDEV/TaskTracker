pub mod anthropic;
pub mod keys;
pub mod openai;

use serde::Serialize;

use crate::error::{AppError, Result};

/// A vendor-neutral sink for streamed rewrite output. This keeps Tauri's
/// `Channel` type out of the provider impls the same way `ItemRepository`
/// keeps SQLite out of the commands: a provider emits text deltas and polls
/// for cancellation, and never knows the chunks travel over an IPC channel.
pub trait ChunkSink: Send + Sync {
    /// Emit one text delta to the consumer.
    fn send_chunk(&self, delta: &str);

    /// True once the consumer has requested cancellation. The stream loop
    /// checks this cooperatively between chunks and stops early.
    fn is_cancelled(&self) -> bool;
}

/// The model swap point, mirroring `ItemRepository` on the storage side.
/// Commands ask for a provider by id and call `rewrite`; which vendor,
/// which model, and which HTTP shape is entirely this module's business.
/// Adding a third provider (or a local model) is one new impl plus one
/// match arm below.
#[async_trait::async_trait]
pub trait AiProvider: Send + Sync {
    /// Stable id used by the frontend and the credential store
    /// ("anthropic", "openai").
    fn id(&self) -> &'static str;

    /// Rewrite `text` according to `instruction`, returning only the
    /// rewritten text.
    async fn rewrite(
        &self,
        http: &reqwest::Client,
        text: &str,
        instruction: &str,
    ) -> Result<String>;

    /// Streaming variant: emit the rewrite as text deltas through `sink` and
    /// return the full accumulated text. The default delegates to `rewrite()`
    /// and emits the whole result as one chunk, so a provider that can't
    /// stream still satisfies the trait.
    async fn rewrite_stream(
        &self,
        http: &reqwest::Client,
        text: &str,
        instruction: &str,
        sink: &dyn ChunkSink,
    ) -> Result<String> {
        let out = self.rewrite(http, text, instruction).await?;
        sink.send_chunk(&out);
        Ok(out)
    }
}

/// One event on the rewrite stream channel. Camel-cased tagged union: exactly
/// one `Done` or `Error` is the terminal signal (`Chunk`s precede it). Mirror
/// in `src/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RewriteEvent {
    Chunk { delta: String },
    Done { text: String },
    Error { code: RewriteErrorCode, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RewriteErrorCode {
    Cancelled,
    Network,
    Provider,
    Invalid,
}

pub fn provider_for(id: &str) -> Result<Box<dyn AiProvider>> {
    match id {
        "anthropic" => Ok(Box::new(anthropic::Anthropic)),
        "openai" => Ok(Box::new(openai::OpenAi)),
        other => Err(AppError::Invalid(format!("unknown AI provider: {other}"))),
    }
}

/// Shared editing brief. Kept vendor-neutral so both providers behave the
/// same way and the UI can treat the result as a drop-in replacement.
pub const REWRITE_SYSTEM_PROMPT: &str = "You are an editor built into a personal notes and tasks app. \
You will receive a piece of the user's own writing and an instruction for how to rework it. \
Apply the instruction faithfully. Preserve the meaning, any facts, names, numbers, links, \
and code blocks, and keep the original formatting style (plain text stays plain, lists stay lists) \
unless the instruction says otherwise. Reply with ONLY the reworked text — no preamble, \
no explanations, no quotation marks around the result.";

/// Builds the single user message both providers send.
pub fn rewrite_user_message(text: &str, instruction: &str) -> String {
    format!("Instruction: {instruction}\n\nText to rework:\n{text}")
}

/// The rework instruction that turns the shared editor brief into a title
/// generator. There is deliberately NO separate title system prompt (D3): both
/// vendors hardcode `REWRITE_SYSTEM_PROMPT` as their system message, so the
/// title ask rides entirely in this instruction, bounded downstream by
/// `sanitize_title`.
pub const TITLE_INSTRUCTION: &str = "Write a short, specific title for this text — \
a few words, no ending punctuation and no quotation marks around it. \
Reply with ONLY the title.";

/// Clean untrusted model output into a safe single-line title. Titles render in
/// the list row and in the native delete-confirm dialog, so this bounds the
/// blast radius of a disobedient or injection-steered model: take the first
/// non-empty line, strip one pair of wrapping quotes (inner quotes survive),
/// drop control characters, and char-safe truncate at 120 chars. The result may
/// be empty (whitespace-only input) — callers treat that as a failure.
pub fn sanitize_title(raw: &str) -> String {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let unquoted = strip_wrapping_quotes(line).trim();
    let cleaned: String = unquoted.chars().filter(|c| !is_title_junk(*c)).collect();
    cleaned.trim().chars().take(120).collect()
}

/// Characters dropped from a sanitized title. Beyond ASCII/Unicode control
/// chars (Cc), this removes the invisible format and separator characters that
/// render as no glyph yet can visually spoof or reflow the title where it shows
/// without an explicit accept step (the list row, the native delete-confirm
/// dialog): bidirectional overrides/isolates, zero-width joiners/spaces, and
/// line/paragraph separators. React text nodes plus the strict CSP already
/// preclude XSS — this bounds visual spoofing.
fn is_title_junk(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{200B}'..='\u{200F}'   // zero-width space/NJ/J, LRM, RLM
            | '\u{202A}'..='\u{202E}' // bidi embeddings + overrides
            | '\u{2060}'              // word joiner
            | '\u{2066}'..='\u{2069}' // bidi isolates
            | '\u{2028}'              // line separator
            | '\u{2029}'              // paragraph separator
            | '\u{FEFF}'              // zero-width no-break space / BOM
        )
}

/// Strip exactly one matching pair of wrapping quotes (straight or curly),
/// leaving any interior quotes intact. Returns the slice unchanged when it is
/// not quote-wrapped.
fn strip_wrapping_quotes(s: &str) -> &str {
    let first = match s.chars().next() {
        Some(c) => c,
        None => return s,
    };
    let last = s.chars().next_back().unwrap(); // non-empty: `first` exists
    let paired = matches!(
        (first, last),
        ('"', '"') | ('\'', '\'') | ('\u{201C}', '\u{201D}') | ('\u{2018}', '\u{2019}')
    );
    if !paired {
        return s;
    }
    let start = first.len_utf8();
    let end = s.len() - last.len_utf8();
    if start <= end {
        &s[start..end]
    } else {
        s // a lone quote char — nothing to unwrap
    }
}

/// Core of the `ai_generate_title` command, factored out so integration tests
/// can drive it with a fake `AiProvider` (the `#[tauri::command]` wrapper needs
/// `State<AppState>` and cannot run outside a live Tauri app — see
/// `tests/ai_title.rs`). Generates a title for `text` through the provider's
/// existing `rewrite` capability under `TITLE_INSTRUCTION`, then sanitizes the
/// untrusted result. `MissingKey` passes through with its distinct Settings
/// copy; every other provider/HTTP error collapses to one generic message so
/// raw upstream response bodies never reach a toast (D9).
pub async fn generate_title(
    provider: &dyn AiProvider,
    http: &reqwest::Client,
    text: &str,
) -> Result<String> {
    if text.trim().is_empty() {
        return Err(AppError::Invalid(
            "there is no text to generate a title from".into(),
        ));
    }
    let raw = provider
        .rewrite(http, text, TITLE_INSTRUCTION)
        .await
        .map_err(|err| match err {
            AppError::MissingKey(_) => err,
            _ => AppError::Provider("couldn't generate a title — try again".into()),
        })?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return Err(AppError::Provider(
            "couldn't generate a title — try again".into(),
        ));
    }
    Ok(title)
}

/// Pulls complete `\n`-terminated lines out of a growing SSE byte buffer,
/// returning each decoded line and leaving any trailing partial bytes in
/// `buf`. Splitting on the `\n` byte (0x0A) is UTF-8-safe — it never appears
/// inside a multibyte sequence — so a codepoint straddling two network chunks
/// is reassembled before it is decoded, never turning into a replacement char.
/// Pass `flush = true` once the connection has closed to also take a final
/// line that never received a trailing newline, so its delta isn't dropped.
pub(crate) fn take_lines(buf: &mut Vec<u8>, flush: bool) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=nl).collect();
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    if flush && !buf.is_empty() {
        let line = std::mem::take(buf);
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::{sanitize_title, take_lines};

    #[test]
    fn sanitize_title_passes_a_clean_one_line_title_through_trimmed() {
        assert_eq!(
            sanitize_title("  Ship the cutover checklist  "),
            "Ship the cutover checklist"
        );
    }

    #[test]
    fn sanitize_title_takes_only_the_first_non_empty_line() {
        assert_eq!(
            sanitize_title("\n\n  First real line \nSecond line\n"),
            "First real line"
        );
    }

    #[test]
    fn sanitize_title_strips_wrapping_quotes_but_keeps_inner_ones() {
        assert_eq!(
            sanitize_title(r#""Freeze the "schema" changes""#),
            r#"Freeze the "schema" changes"#
        );
        assert_eq!(sanitize_title("'single wrapped'"), "single wrapped");
        assert_eq!(sanitize_title("\u{201C}curly wrapped\u{201D}"), "curly wrapped");
        // A lone quote char is not a pair — left intact, no panic.
        assert_eq!(sanitize_title("\""), "\"");
    }

    #[test]
    fn sanitize_title_strips_control_characters_and_whitespace_only_is_empty() {
        assert_eq!(sanitize_title("Clean\u{0007}\u{0000}title"), "Cleantitle");
        assert_eq!(sanitize_title("   \n\t  "), "");
        assert_eq!(sanitize_title(""), "");
    }

    #[test]
    fn sanitize_title_strips_bidi_zero_width_and_separator_characters() {
        // Bidi override (U+202E), zero-width space (U+200B), line separator
        // (U+2028) — invisible glyphs that could spoof/reflow the rendered title.
        let out = sanitize_title("Ship\u{202E}\u{200B}the\u{2028}cutover");
        assert!(
            !out.chars().any(|c| matches!(
                c,
                '\u{202E}' | '\u{200B}' | '\u{2028}'
            )),
            "invisible format/separator chars must be stripped: {out:?}"
        );
        // The visible letters survive.
        assert!(out.contains("Ship") && out.contains("cutover"));
    }

    #[test]
    fn sanitize_title_truncates_to_120_chars_without_splitting_multibyte() {
        let long = "é".repeat(200); // 2 bytes each — a byte-index truncation would panic
        let out = sanitize_title(&long);
        assert_eq!(out.chars().count(), 120);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn returns_only_complete_lines_and_retains_the_remainder() {
        let mut buf = b"data: one\ndata: two\ndata: par".to_vec();
        let lines = take_lines(&mut buf, false);
        assert_eq!(lines, vec!["data: one\n", "data: two\n"]);
        assert_eq!(buf, b"data: par"); // partial line kept for the next chunk
    }

    #[test]
    fn flush_takes_a_trailing_line_with_no_newline() {
        // The connection closed right after a final frame with no trailing \n.
        let mut buf = b"data: last".to_vec();
        assert!(take_lines(&mut buf, false).is_empty()); // not flushed → withheld
        let lines = take_lines(&mut buf, true);
        assert_eq!(lines, vec!["data: last"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn a_multibyte_codepoint_split_across_chunks_decodes_cleanly() {
        // "é" is 0xC3 0xA9; split it across two chunk appends.
        let mut buf = vec![0xC3];
        assert!(take_lines(&mut buf, false).is_empty()); // half a codepoint, held
        buf.extend_from_slice(&[0xA9, b'\n']);
        let lines = take_lines(&mut buf, false);
        assert_eq!(lines, vec!["é\n"]); // reassembled, no U+FFFD
    }
}
