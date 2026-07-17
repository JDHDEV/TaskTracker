use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

use super::{keys, rewrite_user_message, AiProvider, ChunkSink, REWRITE_SYSTEM_PROMPT};

/// Model used for rewrites. Check https://platform.openai.com/docs/models
/// for current names and swap freely — nothing else references this.
pub const MODEL: &str = "gpt-4o-mini";

const API_URL: &str = "https://api.openai.com/v1/chat/completions";

pub struct OpenAi;

#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
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
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

#[async_trait::async_trait]
impl AiProvider for OpenAi {
    fn id(&self) -> &'static str {
        "openai"
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
            messages: vec![
                Message {
                    role: "system",
                    content: REWRITE_SYSTEM_PROMPT.to_string(),
                },
                Message {
                    role: "user",
                    content: rewrite_user_message(text, instruction),
                },
            ],
            max_completion_tokens: Some(4096),
            stream: false,
        };

        let response = http
            .post(API_URL)
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!(
                "OpenAI API returned {status}: {body}"
            )));
        }

        let parsed: Response = response.json().await?;
        let out = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .unwrap_or_default();

        if out.trim().is_empty() {
            return Err(AppError::Provider(
                "OpenAI returned an empty response".into(),
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
            messages: vec![
                Message {
                    role: "system",
                    content: REWRITE_SYSTEM_PROMPT.to_string(),
                },
                Message {
                    role: "user",
                    content: rewrite_user_message(text, instruction),
                },
            ],
            max_completion_tokens: Some(4096),
            stream: true,
        };

        let mut response = http
            .post(API_URL)
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Provider(format!(
                "OpenAI API returned {status}: {body}"
            )));
        }

        // OpenAI's SSE frames each token as `data: {...}` with a
        // `choices[0].delta.content`, terminated by a literal `data: [DONE]`.
        // Chunks split anywhere, so buffer raw bytes and process complete lines
        // (see `take_lines`), flushing any newline-less final line at EOF.
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
                "OpenAI returned an empty response".into(),
            ));
        }
        Ok(acc.trim().to_string())
    }
}

/// Extract a token delta from one SSE line, or `None` for the `[DONE]`
/// sentinel, a non-`data:` frame, or a frame without text content. Never
/// errors on malformed JSON — unknown frames are simply skipped.
fn parse_delta(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let content = v
        .get("choices")?
        .as_array()?
        .first()?
        .get("delta")?
        .get("content")?
        .as_str()?;
    Some(content.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_delta;

    #[test]
    fn valid_delta_line_returns_the_content() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#;
        assert_eq!(parse_delta(line), Some("Hello".to_string()));
    }

    #[test]
    fn comment_line_returns_none() {
        let line = ": keep-alive comment";
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn malformed_json_after_data_prefix_returns_none_without_panic() {
        let line = "data: {not valid json";
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn done_sentinel_returns_none() {
        let line = "data: [DONE]";
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn frame_without_delta_content_returns_none() {
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(parse_delta(line), None);
    }

    #[test]
    fn script_markup_delta_text_is_returned_verbatim() {
        let line = r#"data: {"choices":[{"delta":{"content":"<script>alert(1)</script>"}}]}"#;
        assert_eq!(
            parse_delta(line),
            Some("<script>alert(1)</script>".to_string())
        );
    }
}
