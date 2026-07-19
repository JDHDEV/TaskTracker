-- Prompts: a per-project, versioned prompt library (plan.7). A prompt is a NEW
-- entity, not a third item `kind` — items fundamentally lack version history.
-- The canonical store is one file per prompt-level state + one immutable file
-- per version under `prompts/<prompt-uuid>/` (mirroring `items/<uuid>.md`); these
-- two tables are the git-ignored, rebuildable index over those files, so this
-- migration is inert until `rebuild_from_dir` fills it from the scan.
--
-- No `project_id` column: a prompt's project is the store it lives in (the
-- manager stamps ownership on return — the same principle items follow). No
-- `updated_at` column: it is DERIVED from the current version's `created_at`, so
-- it can never drift. "Current version" is the head of
-- `ORDER BY created_at DESC, id ASC` within a prompt — never a stored pointer,
-- so nothing mutable conflicts on a git merge.
CREATE TABLE prompts (
    id          TEXT PRIMARY KEY NOT NULL,   -- prompt UUID (= directory name)
    reusable    INTEGER NOT NULL DEFAULT 0,  -- 0/1; the only mutable prompt state
    created_at  TEXT NOT NULL                -- RFC 3339, fixed ms
);

CREATE TABLE prompt_versions (
    id          TEXT PRIMARY KEY NOT NULL,   -- version UUID (= file stem)
    prompt_id   TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'aiEnhanced'
    created_at  TEXT NOT NULL                -- RFC 3339, fixed ms; the version ordering key
);

-- Serves the current-version lookup (head of the ordering key per prompt) and
-- the newest-first history list without a sort step.
CREATE INDEX idx_prompt_versions_by_prompt
    ON prompt_versions (prompt_id, created_at DESC, id ASC);

-- Partial index for the `reusable = 1` filter (v1's only prompt filter).
CREATE INDEX idx_prompts_reusable
    ON prompts (reusable) WHERE reusable = 1;
