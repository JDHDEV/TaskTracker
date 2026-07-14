use crate::error::{AppError, Result};

/// Service name under which keys appear in the OS credential store
/// (Windows Credential Manager on Windows).
const SERVICE: &str = "notes-app";

/// Save (or overwrite) the API key for a provider.
pub fn set_key(provider: &str, key: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, provider)?;
    if key.trim().is_empty() {
        // Saving an empty key means "remove it".
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    entry.set_password(key.trim())?;
    Ok(())
}

/// Fetch the key for a provider. Deliberately crate-private in spirit:
/// only the AI providers call this — there is no Tauri command that
/// returns a key to the frontend, so a compromised WebView can use keys
/// but never read them.
pub fn get_key(provider: &str) -> Result<String> {
    let entry = keyring::Entry::new(SERVICE, provider)?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err(AppError::MissingKey(provider.to_string())),
        Err(e) => Err(e.into()),
    }
}

pub fn has_key(provider: &str) -> bool {
    get_key(provider).is_ok()
}
