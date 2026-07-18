-- The app-level catalog (catalog.db in app_data_dir), applied by a SECOND
-- embedded sqlx migrator distinct from the per-project migrations/. It records
-- the set of known projects and reconciles them by UUID (paths move), and hosts
-- the relocated non-secret app settings.
--
-- name and path are BOTH globally UNIQUE here — the per-project projects.name
-- UNIQUE no longer sees across files, so global uniqueness lives in the catalog.
-- This DB is app-internal and always inside app_data_dir, so it is NOT subject
-- to the foreign-DB hardening the per-project stores get.
CREATE TABLE projects (
    id           TEXT PRIMARY KEY NOT NULL,  -- UUID from the store's meta table
    name         TEXT NOT NULL UNIQUE,
    path         TEXT NOT NULL UNIQUE,       -- canonical project DIRECTORY path
    loaded       INTEGER NOT NULL DEFAULT 1,
    last_opened  TEXT                        -- RFC 3339, set when (re)loaded
);

-- Relocated from the per-project item DB (Section 4.5): the non-secret JIRA
-- config lives ONLY here, so a loaded project store can never influence app
-- settings. The legacy migration also stores its idempotency marker here.
CREATE TABLE app_settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
