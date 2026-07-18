-- Each per-project DB self-describes. Project identity is the UUID stored here,
-- never the file path (files move; the catalog reconciles by this UUID). The
-- manager also stamps project_name/schema_version at create time.
--
-- PRAGMA application_id marks the file as a worknotes store so a foreign SQLite
-- database is rejected before any migration runs (Section 4.3). The integer
-- below MUST equal the Rust const db::WORKNOTES_APPLICATION_ID (0x574B4E54,
-- "WKNT"); a test reads it back from a freshly created store and asserts the
-- match. It is header state, written transactionally with the rest of this
-- migration.
PRAGMA application_id = 1464553044;

CREATE TABLE meta (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
