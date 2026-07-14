use serde::Serialize;

/// One error type for the whole backend. Tauri requires command errors to
/// implement `Serialize`; we serialize to the display string so the frontend
/// always receives a human-readable message.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("item not found")]
    NotFound,

    #[error("credential store error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("no API key saved for {0} — add one in Settings")]
    MissingKey(String),

    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("{0}")]
    Provider(String),

    #[error("{0}")]
    Invalid(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
