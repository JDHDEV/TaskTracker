use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

use super::{keys, rewrite_user_message, AiProvider, ChunkSink, REWRITE_SYSTEM_PROMPT};

/// Model used for rewrites. Sonnet is a good default for editing quality;
/// swap in a Haiku-class model if you want cheaper/faster. Current model
/// names: https://docs.claude.com/en/docs/about-claude/models/overview
pub const MODEL: &str = "claude-sonnet-4-6";

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

pub struct Anthropic;

#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "is_false")]
    stream: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[async_trait::async_trait]
impl AiProvider for Anthropic {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn rewrite(
        &self,
        http: &reqwest::Client,
        text: &str,
        instruction: &str,
    ) -> Result<String> {
        let api_key = keys::get_key(self.id())?;

        let request = Request {
            model: MODEL,
            max_tokens: 4096,
            system: REWRITE_SYSTEM_PROMPT,
            messages: vec![Message {
                role: "user",
                content: rewrite_user_message(text, instruction),
            }],
            stream: false,
        };

        let response = http
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!(
                "Anthropic API returned {status}: {body}"
            )));
        }

        let parsed: Response = response.json().await?;

        let out: String = parsed
            .content
            .iter()
            .filter(|block| block.kind == "text")
            .filter_map(|block| block.text.as_deref())
            .collect::<Vec<_>>()
            .join("");

        if out.trim().is_empty() {
            return Err(AppError::Provider(
                "Anthropic returned an empty response".into(),
            ));
        }
        Ok(out.trim().to_string())
    }

    async fn rewrite_stream(
        &self,
        http: &reqwest::Client,
        text: &str,
        instruction: &str,
        sink: &dyn ChunkSink,
    ) -> Result<String> {
        let api_key = keys::get_key(self.id())?;

        let request = Request {
            model: MODEL,
            max_tokens: 4096,
            system: REWRITE_SYSTEM_PROMPT,
            messages: vec![Message {
                role: "user",
                content: rewrite_user_message(text, instruction),
            }],
            stream: true,
        };

        let mut response = http
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!(
                "Anthropic API returned {status}: {body}"
            )));
        }

        // Anthropic's SSE frames text as `data: {...}` lines carrying a
        // `content_block_delta` with a `text_delta`. Chunks split anywhere, so
        // buffer raw bytes and process complete lines (see `take_lines`),
        // flushing any newline-less final line once the body ends.
        let mut acc = String::new();
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let bytes = response.chunk().await?;
            if sink.is_cancelled() {
                return Ok(acc); // command turns this into a Cancelled terminal
            }
            let eof = bytes.is_none();
            if let Some(bytes) = bytes {
                buf.extend_from_slice(&bytes);
            }
            for line in super::take_lines(&mut buf, eof) {
                if let Some(delta) = parse_delta(line.trim_end()) {
                    if !delta.is_empty() {
                        acc.push_str(&delta);
                        sink.send_chunk(&delta);
                    }
                }
            }
            if eof {
                break;
            }
        }

        if acc.trim().is_empty() {
            return Err(AppError::Provider(
                "Anthropic returned an empty response".into(),
            ));
        }
        Ok(acc.trim().to_string())
    }
}

/// Extract a text delta from one SSE line, or `None` if the line is a
/// non-`data:` frame or a non-text event. Never errors on malformed JSON —
/// unknown frames are simply skipped.
fn parse_delta(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if v.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let delta = v.get("delta")?;
    if delta.get("type")?.as_str()? != "text_delta" {
        return None;
    }
    Some(delta.get("text")?.as_str()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_delta;

    #[test]
    fn valid_text_delta_line_returns_the_text() {
        let line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        assert_eq!(parse_delta(line), Some("Hello".to_string()));
    }

    #[test]
    fn non_data_line_returns_none() {
        let line = "event: content_block_delta";
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn malformed_json_after_data_prefix_returns_none_without_panic() {
        let line = "data: {not valid json";
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn non_content_block_delta_frame_returns_none() {
        let line = r#"data: {"type":"message_start","message":{"id":"msg_1"}}"#;
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn content_block_delta_with_non_text_delta_type_returns_none() {
        let line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#;
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn script_markup_delta_text_is_returned_verbatim() {
        let line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<script>alert(1)</script>"}}"#;
        assert_eq!(
            parse_delta(line),
            Some("<script>alert(1)</script>".to_string())
        );
    }
}
