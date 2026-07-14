use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

use super::{keys, rewrite_user_message, AiProvider, REWRITE_SYSTEM_PROMPT};

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
}
