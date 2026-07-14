-- One table covers both notes and tasks; `kind` discriminates and the
-- task-only columns stay NULL for notes. Tags are a JSON array so new
-- metadata never needs a join table until you actually want one.
CREATE TABLE items (
    id          TEXT PRIMARY KEY NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('note', 'task')),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    status      TEXT CHECK (status IN ('todo', 'doing', 'done')),
    due_at      TEXT,                       -- RFC 3339, tasks only
    tags        TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    created_at  TEXT NOT NULL,              -- RFC 3339
    updated_at  TEXT NOT NULL,              -- RFC 3339
    archived    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_items_kind ON items (kind, archived, updated_at DESC);

-- Full-text search over title + body, kept in sync with triggers.
-- external-content table: FTS5 stores only the index, rows live in `items`.
CREATE VIRTUAL TABLE items_fts USING fts5(
    title,
    body,
    content = 'items',
    content_rowid = 'rowid'
);

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
