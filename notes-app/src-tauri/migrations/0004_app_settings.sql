-- Non-secret app configuration as a small key/value store. The JIRA base URL
-- and account email live here (readable back for the Settings UI); the API
-- token stays in the OS credential store, never in this table. Additive: the
-- repository owns this the same way it owns items/projects.
CREATE TABLE app_settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
