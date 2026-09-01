# worknotes — implementation plan

The delta between the shipped scaffold and `docs/DESIGN.md`. Phases are ordered by dependency; finish a phase (including its tests and acceptance checks) before starting the next. Every phase ends with the standard verification from `CLAUDE.md`.

## Phase 0 — plumbing

**0.1 Opener plugin** (needed by Phase 3's JIRA chip)
- `cargo add tauri-plugin-opener` in src-tauri; `npm i @tauri-apps/plugin-opener`
- Register in `lib.rs`: `.plugin(tauri_plugin_opener::init())`
- Add `"opener:default"` to `src-tauri/capabilities/default.json`

**0.2 Dark theme**
- Restructure `src/styles.css`: neutral tokens (`--bg --surface --ink --muted --line`) defined on `:root` (light) and overridden under `[data-theme="dark"]` with the dark values from DESIGN.md. Add the window-surround tokens. Accents (yellow set, danger, status dots, scrim) stay outside the theme scopes.
- Top bar gains the theme toggle (`Dark`/`Light`, label names the target theme); sets `data-theme` on `<html>`; persist choice in `localStorage`.

Acceptance: toggling flips every neutral surface; the review card, Save button, pin marks, and status dots are pixel-identical in both themes.

## Phase 1 — schema + repository

**1.1 Migration `0003_projects_jira.sql`**
```sql
CREATE TABLE projects (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
ALTER TABLE items ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE items ADD COLUMN jira_url TEXT;
CREATE INDEX idx_items_project ON items (project_id);
```
Projects are id-referenced so rename is one UPDATE; the UI trades in names, IPC trades in ids.

**1.2 Models** (`models.rs` + mirrored in `types.ts`)
- `Project { id, name, created_at }` (+ an item count in the list DTO — see 1.3)
- `Item` gains `project_id: Option<String>`, `jira_url: Option<String>`; same fields on `NewItem`/`UpdateItem` (empty string clears `jira_url`, `projectId: ""` clears the assignment — consistent with `dueAt`)
- `ListFilter` gains `project_id: Option<String>`, `status: Option<Status>`, `tags: Option<Vec<String>>` (OR-matched), `sort: Option<Sort>` where `Sort = Updated | Created | Priority | Status`

**1.3 Repository trait additions** (implement in `SqliteRepository`; each impl owns its SQL)
- `list_projects() -> Vec<ProjectWithCount>` — `LEFT JOIN` count of assigned items
- `create_project(name)`, `rename_project(id, name)` (trimmed, non-empty, unique)
- `delete_project(id)` — **must return an error while any item references it** (`AppError::Invalid("project still has N items assigned")`). The disabled UI button is presentation; this is the guard.
- `list_active_tags() -> Vec<String>` — the derived vocabulary:
```sql
SELECT DISTINCT je.value FROM items, json_each(items.tags) AS je
WHERE items.archived = 0 AND NOT (items.kind = 'task' AND items.status = 'done')
ORDER BY 1;
```
- Extend `list()` for the new filter fields. Tag OR-match:
  `AND EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value IN (…binds…))`
- Sort (always `pinned DESC` first, always `rowid DESC` last):
  - updated/created → `updated_at DESC` / `created_at DESC`
  - priority → notes last, then `CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END`
  - status → notes last, then `CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 END`
  - "notes last" = secondary key `CASE WHEN kind = 'note' THEN 1 ELSE 0 END` under those two modes
- `search()` applies the same post-filters where present.
- `update()`: `project_id`/`jira_url` count as content edits (bump `updated_at`).

**1.4 Tests** (extend `src-tauri/tests/repo.rs`)
- Project CRUD; rename reflected on listed items; `delete_project` fails with items assigned, succeeds at zero
- `list_active_tags` drops a tag when its last carrier is marked done or archived, restores it on reopen
- Tag OR-filter, status filter, project filter combine (AND) correctly
- Sort modes incl. notes-last and pinned-first supremacy
- `jira_url` set/clear via empty string; both new fields bump `updated_at`

## Phase 2 — IPC surface

New commands (thin, like the existing ones): `list_projects`, `create_project`, `rename_project`, `delete_project`, `list_active_tags`. Extended: `list_items` (new filter fields), `create_item`/`update_item` (projectId, jiraUrl). Mirror everything in `src/lib/api.ts` and `src/types.ts`. `Duplicate metadata` needs no new command — it's a frontend flow calling `create_item` with copied kind/status/priority/projectId/tags (never the JIRA link), then selecting the result.

## Phase 3 — UI (match DESIGN.md exactly; it specifies microcopy verbatim)

- **Top bar**: theme toggle + `Manage projects` + `API keys`
- **Rail**: `FILTER BY TAG` widget (badges + popup listing `list_active_tags` minus selected; `All tags selected.` empty state); project select (`All projects` + names); status filter; sort select. All filters AND-combined; tag filter OR within itself. If a refresh of the vocabulary no longer contains a selected filter tag, drop that badge and recompute.
- **Rows**: released tag style (~55% opacity) on done tasks; everything else per DESIGN.md
- **Editor**: `Duplicate metadata` button; project select; tags widget with `EXISTING TAGS` popup + `new tag` input (lowercase, strip `#`, dedupe); JIRA row (mono input + `KEY ↗` chip via opener; key = last URL path segment matching `ABC-123`, else `Open ticket ↗`; full URL as tooltip); released styling on done tasks' badges (dashed border + dimmed); Save button moves into the AI bar, right of `Rework`
- **Manage projects dialog**: inline rename, mono `N ITEM(S)` count, `Remove` disabled at count ≥ 1, add row, `Done`
- Preset chips now FILL the instruction input (they no longer fire immediately)

Acceptance: walk the "Reference sample state" section of DESIGN.md and reproduce it by hand, including: finishing the last `#admin` carrier removes `admin` from both popups and drops its filter badge; `Remove` is only enabled on a zero-count project (and the backend refuses regardless); the JIRA chip opens the default browser.

## Phase 4 — backlog (agreed, not yet scheduled)

- Due-date UI (backend fully supports `dueAt`; empty string clears)
- Streaming rewrites into the editor via Tauri channels
- ~~`PostgresRepository` (second `ItemRepository` impl; own SQL incl. `tsvector` search) for cloud sync~~ — **superseded as the sync direction** by "Projects as Loadable On-Disk Databases" (plans/plan.6.md), now fully shipped incl. Stage 2: sync is per-project directories in user-chosen locations — whole-file via OneDrive/Syncthing, OR git-based merge of the canonical `items/*.md` file-per-item store (with the SQLite `index.db` demoted to a git-ignored rebuildable index). The `ItemRepository` trait seam survives and a Postgres impl remains possible, but cloud-sync-via-Postgres is no longer the planned path.
- Installer via `npm run tauri build`
- JIRA enrichment (ticket status/title on the chip) via Atlassian's API — a third swap-point trait, same pattern as storage and AI
- ~~Unsaved-edit recovery across restarts~~ — **shipped** (plans/plan.15.md): dirty editor buffers (items, prompts, scratch — foreground and background tabs) snapshot to an app-private draft store (`app_data_dir\drafts\`, NOT a compatibility surface) on a 1 s-idle / 5 s-max-wait cadence and restore visibly on the next launch, with a two-button conflict bar when the entity changed underneath; graceful window close flushes first (the plan.14 R6 fold-in). Nothing autosaves — `items/<uuid>.md` and `scratch.md` still change only on explicit Save.
