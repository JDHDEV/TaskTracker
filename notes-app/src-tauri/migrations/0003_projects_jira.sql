-- Projects are id-referenced entities so renames don't rewrite items.
-- Name is UNIQUE (binary collation: "Backend" and "backend" are distinct).
CREATE TABLE projects (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL              -- RFC 3339
);

-- project_id and jira_url apply to both notes and tasks. Inline REFERENCES is
-- legal in ADD COLUMN because the new column defaults to NULL (existing rows
-- backfill as NULL). Table must exist first, hence the CREATE above.
ALTER TABLE items ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE items ADD COLUMN jira_url TEXT;

-- Backs the project_id filter, and the FK integrity scan SQLite runs on every
-- projects delete (without it, that scan is a full items table scan per delete).
CREATE INDEX idx_items_project ON items (project_id);
