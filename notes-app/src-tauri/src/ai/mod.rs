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
    use super::take_lines;

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
