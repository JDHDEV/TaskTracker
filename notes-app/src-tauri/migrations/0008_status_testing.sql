-- Widen the task status vocabulary (plan.14 F2: `testing`). The status CHECK
-- from 0001 is dropped ENTIRELY rather than widened (D4): `index.db` is not a
-- compatibility surface (it is rebuilt from the canonical files on every load),
-- and the closed Rust `Status` enum plus `itemfile::parse` are the real gate —
-- so the NEXT status addition needs no migration at all.
--
-- SQLite cannot drop a CHECK in place, so this is the documented table rebuild.
-- Traps this file deliberately avoids (D4/S-3):
--  * Rows are COPIED, never truncated: `migrate_db_to_files` runs migrations on
--    a legacy Stage-1 `project.db` BEFORE exporting its rows to files, and the
--    `project.db.pre-stage2.bak` backup is taken AFTER migration — a truncating
--    rewrite here would silently and unrecoverably empty those stores.
--  * The copy carries `rowid`: `items_fts` is an external-content index keyed
--    on the content table's rowid, so letting SQLite re-number rows would
--    silently desync every search.
--  * The three sync triggers are recreated byte-for-byte from 0001 under their
--    exact names — the `KNOWN_TRIGGERS` hardening allowlist (which runs BEFORE
--    migrations on every open) rejects any other name as a foreign DB. It does
--    NOT detect a missing trigger, hence the trailing FTS rebuild and the
--    search-after-migration test in tests/project_manager.rs.
--  * The kind/priority CHECKs and the `REFERENCES projects(id)` clause from
--    0003 are kept verbatim — connections open with foreign_keys(true), so
--    silently dropping the FK would be an unenforced-integrity regression.
--  * No transient table survives: `items_new` is renamed away in this same
--    migration, keeping the `KNOWN_TABLES` allowlist happy on the next open.

-- IF EXISTS: the KNOWN_TRIGGERS gate rejects a WRONG-named trigger but cannot
-- detect a MISSING one, so a tampered store missing a trigger would otherwise
-- abort here — fatal for a Stage-1 project.db, whose file IS the data (a
-- Stage-2 index.db is merely delete-and-reopen).
DROP TRIGGER IF EXISTS items_after_insert;
DROP TRIGGER IF EXISTS items_after_delete;
DROP TRIGGER IF EXISTS items_after_update;

-- Column order matches the ALTER-accumulated shape of the old table (0001 +
-- 0002 + 0003 + 0007). Hygiene, not a hard requirement: sqlx's FromRow
-- resolves columns by NAME, so nothing is position-sensitive.
CREATE TABLE items_new (
    id             TEXT PRIMARY KEY NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('note', 'task')),
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    status         TEXT,                       -- closed vocabulary enforced by models::Status, not a CHECK (D4)
    due_at         TEXT,                       -- RFC 3339, tasks only
    tags           TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    created_at     TEXT NOT NULL,              -- RFC 3339
    updated_at     TEXT NOT NULL,              -- RFC 3339
    archived       INTEGER NOT NULL DEFAULT 0,
    priority       TEXT CHECK (priority IN ('low', 'normal', 'high')),
    pinned         INTEGER NOT NULL DEFAULT 0,
    project_id     TEXT REFERENCES projects(id),
    jira_url       TEXT,
    schema_version TEXT NOT NULL DEFAULT '1.0.0'
);

INSERT INTO items_new
    (rowid, id, kind, title, body, status, due_at, tags, created_at, updated_at,
     archived, priority, pinned, project_id, jira_url, schema_version)
SELECT rowid, id, kind, title, body, status, due_at, tags, created_at, updated_at,
       archived, priority, pinned, project_id, jira_url, schema_version
FROM items;

-- The old table's indexes drop with it; recreate them against the new table.
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX idx_items_kind ON items (kind, archived, updated_at DESC);
CREATE INDEX idx_items_list ON items (archived, pinned DESC, updated_at DESC);
CREATE INDEX idx_items_project ON items (project_id);

-- Byte-for-byte from 0001_init.sql — the names are load-bearing (KNOWN_TRIGGERS).
CREATE TRIGGER items_after_insert AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, title, body)
    VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER items_after_delete AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER items_after_update AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO items_fts (rowid, title, body)
    VALUES (new.rowid, new.title, new.body);
END;

-- Recompute the whole FTS index from the rebuilt table: the copied rowids keep
-- it aligned, and the rebuild repairs any drift the swap could have introduced.
INSERT INTO items_fts(items_fts) VALUES('rebuild');
