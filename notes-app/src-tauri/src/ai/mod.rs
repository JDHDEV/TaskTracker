pub mod anthropic;
pub mod keys;
pub mod openai;

use crate::error::{AppError, Result};

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
