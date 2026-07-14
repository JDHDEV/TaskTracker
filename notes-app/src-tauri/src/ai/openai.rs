use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

use super::{keys, rewrite_user_message, AiProvider, REWRITE_SYSTEM_PROMPT};

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
}
