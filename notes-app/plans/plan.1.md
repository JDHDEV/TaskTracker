# Plan 1: Phase 1 — Schema + Repository (Projects, JIRA URL, Tag Vocabulary, Filters & Sort)

**Created:** 2026-07-13
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Phase 1 of `docs/IMPLEMENTATION_PLAN.md` is the **backend-only** foundation for the projects, tag-filtering, and JIRA-link features. It adds one additive migration, extends the data models (mirrored in `types.ts`), grows the `ItemRepository` trait plus its `SqliteRepository` implementation, and covers every new invariant with repository integration tests in `tests/repo.rs`.

Scope is storage + repository logic only. **No IPC commands and no UI** — those are Phases 2 and 3. The one unavoidable cross-cut is the CLAUDE.md "change `src/types.ts` and `models.rs` together or neither" rule, so `types.ts` is edited in this phase even though no frontend consumes the new DTOs yet.

Concretely, Phase 1 delivers:
- A `projects` table (id, name UNIQUE, created_at) and two new `items` columns: `project_id` (FK → projects) and `jira_url`.
- New repository methods: `list_projects`, `create_project`, `rename_project`, `delete_project` (with a removal guard), and `list_active_tags` (the derived tag vocabulary).
- Extended `list()` (and `search()`) filtering: project filter, status filter, OR-matched tag filter, and four sort modes (Updated / Created / Priority / Status).
- `project_id` / `jira_url` treated as content edits (bump `updatedAt`), on **both** notes and tasks.

## 2. Strategic Assessment

*(tech-lead agent)*

**Verdict: proceed.** Phase 1 is correctly identified as the foundational, standalone backend unit. Pinning the invariants (removal guard, derived-tag vocabulary, ordering) with `repo.rs` tests before any IPC/UI exists is exactly the right sequencing.

Key points the tech-lead surfaced, which shaped this plan:
- **No real Phase 0 dependency.** Phase 0.1 (opener plugin, for Phase 3's JIRA chip) and 0.2 (dark theme, pure CSS) do not touch Rust storage. Phase 1 can land independently. The `types.ts` update alongside `models.rs` is required by convention, not scope creep.
- **`search()`'s signature must change** — this is the single most likely thing to get built wrong. The plan text says "search() applies the same post-filters," which is impossible without threading `ListFilter` into `search()`. This is a real `ItemRepository` interface change (see §5, Decision D1), not an impl detail.
- **Project-name uniqueness must be an explicit repo pre-check**, not a reliance on the raw SQLite `UNIQUE` constraint error (which would leak `UNIQUE constraint failed: projects.name` past the trait). See Decision D2.
- **`project_id` / `jira_url` are NOT task-only** — they must be merged in `update()` *outside* the `if kind == Task` gate that guards status/priority/dueAt. Notes carry projects and JIRA links too. See Decision D3.
- **Riskiest part (correctness):** the shared filter/sort query builder — specifically preserving the `pinned DESC … rowid DESC` ordering invariant while adding sort modes, and the empty-tag-list `IN ()` footgun.
- **Highest-level approach:** extract one shared WHERE-clause builder driven by `ListFilter`, used by both `list()` and `search()`, so the ordering invariant and filter logic live in exactly one place.

## 3. Research Findings

*(architect + database-architect agents)*

### Current code shape
- `items` is a single table for notes and tasks; `kind` discriminates. `status`/`priority`/`due_at` are NULL for notes. `tags` is `TEXT NOT NULL DEFAULT '[]'` holding a JSON string array — **no join table** (tag vocabulary is derived).
- FTS5 external-content table `items_fts(title, body)` is synced by three triggers on `items` (after insert/delete/update). It indexes **title and body only** — adding `project_id`/`jira_url` requires **no trigger change and no reindex**. JIRA keys and project names will not be FTS-searchable (acceptable for Phase 1).
- Existing indexes: `idx_items_kind`, `idx_items_list`.
- The empty-string-clears / omitted-unchanged pattern **already exists for `due_at`** — the exact template to copy for `project_id`/`jira_url`.
- `AppError::Invalid(String)` already backs the empty-title guard — reuse it for all new failures (empty/duplicate name, project-still-referenced). No new error variant needed.

### Current trait signatures (`src-tauri/src/db/mod.rs`)
```rust
async fn list(&self, filter: &ListFilter) -> Result<Vec<Item>>;
async fn get(&self, id: &str) -> Result<Item>;
async fn create(&self, input: NewItem) -> Result<Item>;
async fn update(&self, id: &str, patch: UpdateItem) -> Result<Item>;
async fn delete(&self, id: &str) -> Result<()>;
async fn search(&self, query: &str) -> Result<Vec<Item>>;   // <-- signature changes (D1)
```

### Prior art to imitate
- **`due_at` handling** in `sqlite.rs` `create`/`update` — the empty-string-clears / omitted-unchanged template (but `project_id`/`jira_url` merge *outside* the task gate, see D3).
- **`ListFilter` + `QueryBuilder`** in `list()` — the `push_bind`/`push` idiom and the `ORDER BY pinned DESC, …, rowid DESC` frame to preserve.
- **Existing `search()`** — the FTS `JOIN … MATCH … ORDER BY rank` shape and empty-query fallback to `list()`.
- **`tags: Json<Vec<String>>`** round-tripping — the model for the `json_each` queries.
- **Ordering/pinning tests** in `repo.rs` — the template for new sort-mode and pinned-supremacy tests.
- **Migration style** of `0002_priority_pinned.sql` — additive `ALTER TABLE ADD COLUMN`, index last.

### Database findings (database-architect)
- `ALTER TABLE items ADD COLUMN project_id TEXT REFERENCES projects(id)` is **legal** in SQLite — inline `REFERENCES` in `ADD COLUMN` is permitted precisely because the new column defaults to NULL (no `DEFAULT`, no `NOT NULL`). Existing rows backfill as NULL cleanly. `CREATE TABLE projects` must precede the `ALTER` statements in the file.
- **`idx_items_project` is justified for two reasons:** (a) it backs the `project_id = ?` filter, and (b) SQLite scans the child table to validate FK integrity on every `projects` delete — without the index that is a full `items` scan per delete.
- **`list_active_tags`** query is correct as written in the plan. `json_each('[]')` yields zero rows, so empty/null tag arrays contribute nothing (no NULL guard needed). The exclusion predicate `NOT (kind='task' AND status='done')` is correct under three-valued logic: notes (`status` NULL) are always included; done tasks are excluded.
- **`list_projects` must use `COUNT(i.id)`, never `COUNT(*)`** — with a LEFT JOIN, a zero-item project produces one all-NULL row; `COUNT(*)` would miscount it as 1, `COUNT(i.id)` correctly returns 0. This is what makes zero-count projects both appear and read as 0.
- **Tag OR-filter** binds each value via `QueryBuilder` `separated(", ").push_bind(v)`. `push_tuples` is the wrong helper (that's for `VALUES` groups). The empty-list case must skip the clause entirely (see D4).
- **Sort CASE key order:** `pinned DESC`, then notes-last (`CASE WHEN kind='note' THEN 1 ELSE 0 END`) under Priority/Status modes only, then the metric CASE, then `rowid DESC`. Notes' NULL priority/status need no `COALESCE` — they're already bucketed last.
- **Do NOT add indexes for the sort modes.** `list()` scans the whole non-archived working set regardless; CASE expressions aren't sargable; at hundreds of rows the transient sort is sub-millisecond. `idx_items_project` is the only justified new index.
- **Open decision — `COLLATE NOCASE` on `projects.name`:** binary collation means `"Backend"` and `"backend"` are distinct. If case-insensitive project-name uniqueness is wanted, the column must be `name TEXT NOT NULL UNIQUE COLLATE NOCASE` **in this migration** (irreversible without a table rebuild). See §10 Open Question Q1 — default is binary collation unless the user says otherwise.

## 4. Security Considerations

*(security-auditor agent; context: local single-user desktop app — injection and data-integrity dominate, classic web-auth is N/A)*

Phase 1 has **no traditional injection hole** as specified, provided the implementation keeps the existing `QueryBuilder`/`push_bind` discipline. Concrete requirements to build in:

- **[High → downgraded, see §10] FK enforcement in tests.** Three agents claimed `connect_in_memory()` omits `.foreign_keys(true)` and therefore tests wouldn't enforce the new FK. **This was REFUTED** by the adversarial-verifier: sqlx 0.8 enables `PRAGMA foreign_keys = ON` by default on every connection, including `from_str("sqlite::memory:")`. No FK-pragma fix is needed. (The redundant `.foreign_keys(true)` in `connect()` may be left as-is.)
- **[High] `delete_project` must be an atomic count-then-delete.** The pool is `max_connections(4)`; a bare "SELECT COUNT then DELETE" on two checkouts is a TOCTOU window that could orphan a `project_id`. Run the COUNT and DELETE inside a single transaction (`BEGIN IMMEDIATE … COMMIT`). The app-level COUNT guard is the authoritative mechanism (it produces the required friendly message); the FK is defense-in-depth.
- **[Medium] Tag OR-filter — bind every value, guard empty list.** Every tag value must be a `push_bind`, never string-concatenated. `Some(vec![])` renders `IN ()` which is a **SQLite syntax error** that aborts the whole query — treat `Some(empty)` and `None` identically as "no tag filter" (skip the clause).
- **[Medium] Sort keys map from the closed `Sort` enum to static SQL fragments** chosen by a Rust `match`, never from user text. `Sort` is a serde enum — any out-of-range value fails deserialization before reaching SQL. Never `push_bind`/`push` a user-derived column name.
- **[Medium] Map UNIQUE/constraint violations to `AppError::Invalid`.** A duplicate project name must not surface as `database error: UNIQUE constraint failed: projects.name` (leaks schema + storage engine). Detect the unique violation (`sqlx::Error::Database`, `is_unique_violation()`) and return a clean `AppError::Invalid("a project named \"{name}\" already exists")`. Prefer an explicit trim/non-empty/duplicate pre-check, with the constraint as a backstop.
- **[Low] `search()` refactor must keep the `fts_query()` sanitizer and `archived = 0` exclusion.** Converting the static-bind search query into a `QueryBuilder` must keep the `MATCH` argument as the sanitizer output (bound), bind all new filters, and never return archived items.
- **[Low, Phase 3 forward-looking] `jira_url` scheme allowlist.** In Phase 1 `jira_url` is inert stored TEXT — no vulnerability. But Phase 3 opens it in the default browser via `tauri-plugin-opener`; a stored `javascript:`/`data:`/`file:` URL would then execute/exfiltrate. Record the requirement to allowlist `http(s)` (at storage time here, or at open time in Phase 3). Out of scope for Phase 1 beyond this note.
- **No new dependency risk** — pure SQL + Rust using existing `sqlx`, `uuid`, `chrono`, `serde`.

## 5. Design

### Approach
Extract a single shared WHERE-clause builder driven by `ListFilter`, used by both `list()` and `search()`, so filter logic and the ordering invariant live in one place. Alias the base table as `items i` in both paths so the shared builder emits `i.`-qualified predicates. Keep sort keys as static SQL literals selected by a `match` on the `Sort` enum. Reuse `AppError::Invalid` for all new failures. Copy the `due_at` empty-string-clears pattern for the two new content fields, merging them outside the task-only gate.

### Architecture
- **Migration** `0003_projects_jira.sql` runs after `0002` via `sqlx::migrate!` at startup. Additive only.
- **Models** (`models.rs`) gain `Sort`, `Project`, `ProjectWithCount`, and four struct field-additions; `types.ts` mirrors them in the same commit.
- **Trait** (`db/mod.rs`) gains five new methods and one changed signature (`search`).
- **Impl** (`sqlite.rs`) gains a private `push_filters` helper, rewrites `list()`/`search()` to use it, implements the five new methods, and extends `create`/`update` column lists.
- **Commands** (`commands.rs`) gets a one-line fix so `search_items` still compiles (Phase 1 passes `&ListFilter::default()`; wiring a real filter is Phase 2).
- Everything else (IPC surface, UI) is untouched — Phases 2 and 3.

### Key Decisions

**D1 — Change `search()` to `async fn search(&self, query: &str, filter: &ListFilter) -> Result<Vec<Item>>`.** This is the only way to honor "search applies the same post-filters." The empty-query fallback delegates to `list(filter)` (so a cleared search box with an active tag filter still respects it). Ripple: one-line change to `commands.rs::search_items` → `state.repo.search(&query, &ListFilter::default()).await`.
- *Rejected:* filtering search results in Rust after fetch (violates "each impl owns its SQL", can't honor tag/status at the SQL layer, two code paths).

**D2 — Explicit name validation in `create_project`/`rename_project`.** Trim; reject empty → `AppError::Invalid("project name must not be empty")`; detect unique violation → `AppError::Invalid("a project named \"{name}\" already exists")`. The `UNIQUE` constraint stays as a backstop, not the primary error path. `rename_project` returns `AppError::NotFound` when `rows_affected() == 0`. Renaming a project to its own current name must succeed — the duplicate-name pre-check must exclude the row being renamed (`WHERE name = ?1 AND id <> ?2`), or a naive "does this name exist" check would reject the no-op rename that the §8 test requires.

**D2a — Nonexistent `project_id` on `create()`/`update()`.** With FK enforcement on (see §10 verdict), assigning an item a `project_id` that doesn't exist raises `sqlx::Error::Database("FOREIGN KEY constraint failed")`, which the current `AppError::Db` mapping (`error.rs:8-9`) would leak as raw DB text — the exact leak D2 guards against. Add an explicit existence pre-check in `create()`/`update()` when `project_id` is `Some(non-empty)`: `SELECT 1 FROM projects WHERE id = ?` → if absent, `AppError::Invalid("no such project")`. (Clearing via `""` → NULL skips the check.)

**D3 — Merge `project_id`/`jira_url` outside the task-only kind gate in `update()`.** They apply to notes and tasks. Place the two `if let Some(...)` blocks alongside the kind-agnostic `title`/`body`/`tags` merges, each setting `edited = true` so the existing `if edited { updated_at = now }` bumps the timestamp. Pin/archive flips still must not bump.

**D4 — Tag filter: skip the clause unless `tags` is `Some` and non-empty.** Prevents the `IN ()` syntax error. `None` and `Some(vec![])` both mean "no tag filter."

**D5 — `search()` orders by `rank` only** (not the list sort modes or pinned-first). Relevance is the point of search; this matches current behavior and existing tests. The shared builder supplies WHERE clauses to both paths; ORDER BY differs (list = pinned/sort/rowid; search = rank).

**D5a — `search()`'s `archived = 0` exclusion is forced, NOT driven by `filter.archived`.** CLAUDE.md excludes archived items "from the default list AND from search"; `list()` allows an override via `filter.archived` (default-only exclusion), but `search()` must always hardcode `i.archived = 0` regardless of what `filter.archived` says. The shared `push_filters` helper therefore must NOT emit the archived predicate — each caller supplies its own: `list()` emits `archived = filter.archived.unwrap_or(false)`, `search()` hardcodes `archived = 0`. `push_filters` handles only kind, project, status, and tags.

**D6 — `delete_project` guard is an explicit `COUNT(*)` inside a transaction** (not FK cascade, not a bare two-statement sequence). Count includes archived items (an archived item still references the project). If count > 0 → `AppError::Invalid("project still has N items assigned")`. Otherwise run `DELETE FROM projects WHERE id = ?` and map `rows_affected() == 0` → `AppError::NotFound` (distinguishes "no such project" from "project with 0 items"), analogous to `rename_project`.

**D7 — `list_projects` counts ALL assigned items (including archived)** so the UI's `N ITEM(S)` display agrees with the delete guard. Uses `COUNT(i.id)` with LEFT JOIN + GROUP BY, ordered by name.

## 6. Implementation Steps

1. **Create `src-tauri/migrations/0003_projects_jira.sql`** — `CREATE TABLE projects` first, then the two `ALTER TABLE items ADD COLUMN` statements, then `CREATE INDEX idx_items_project`. Use the plan's DDL verbatim (subject to Q1 on `COLLATE NOCASE`). Do not touch FTS triggers.
2. **Extend `src-tauri/src/models.rs`:**
   - Add `Sort` enum (`Updated | Created | Priority | Status`), `#[derive(…, Serialize, Deserialize)]`, `#[serde(rename_all = "lowercase")]` to match the existing `Kind`/`Status`/`Priority` enums (single-word variants serialize identically either way — match the established convention).
   - Add `Project { id, name, created_at }` (`Serialize, sqlx::FromRow`, camelCase — drop `Deserialize`; `create_project`/`rename_project` take a plain `name` string, so nothing deserializes a `Project` in Phase 1).
   - Add `ProjectWithCount { id, name, created_at, item_count: i64 }` (`Serialize, sqlx::FromRow`, camelCase → `itemCount`).
   - Add `project_id: Option<String>` and `jira_url: Option<String>` to `Item`; add the same two as `#[serde(default)] Option<String>` to `NewItem` and `UpdateItem`.
   - Add `#[serde(default)]` `project_id: Option<String>`, `status: Option<Status>`, `tags: Option<Vec<String>>`, `sort: Option<Sort>` to `ListFilter`.
3. **Mirror in `src/types.ts`** (same commit): `Sort` union, `Project`, `ProjectWithCount extends Project`, extend `Item` (`projectId: string | null`, `jiraUrl: string | null`), `NewItem`/`UpdateItem` (`projectId?`, `jiraUrl?`), `ListFilter` (`projectId?`, `status?`, `tags?`, `sort?`).
4. **Update the trait in `src-tauri/src/db/mod.rs`:** import `Project`, `ProjectWithCount`; change `search` signature (D1); add the five new method signatures with doc comments in the existing style.
5. **Extend `create()`/`update()` in `sqlite.rs`:** add `project_id`/`jira_url` to the INSERT column list + VALUES + binds (renumber placeholders). In `create()`, normalize `""` → NULL via `.filter(|s| !s.is_empty())` like `due_at`. In `update()`, add the two merge blocks **outside** the task gate (D3) with full merge-patch semantics: `Some("")` → NULL, `Some(x)` → set, `None` → unchanged; each sets `edited = true`.
6. **Add the shared `push_filters` helper and rewrite `list()`/`search()` in `sqlite.rs`:** alias `items i` in both; `push_filters` emits kind, project, status, and tag-EXISTS predicates only (D4) — **not** archived. Each caller supplies archived itself: `list()` uses `filter.archived.unwrap_or(false)`, `search()` hardcodes `archived = 0` (D5a). `list()` ORDER BY = pinned/sort-match/rowid (D5); `search()` keeps `MATCH` via `fts_query()`, filters, `ORDER BY rank`; empty-query fallback → `list(filter)`.
7. **Implement the five new methods in `sqlite.rs`:** `list_projects` (D7), `create_project`/`rename_project` (D2), `delete_project` (D6, transactional), `list_active_tags` (plan's `json_each` query). Add the `project_id` existence pre-check to `create()`/`update()` (D2a).
8. **Fix `commands.rs::search_items`** to pass `&ListFilter::default()` (one line).
9. **Update `tests/repo.rs`:** update the `new_item` helper (add `project_id: None, jira_url: None`); update the `ListFilter { … }` literals (in `crud_search_and_fts`) to `..Default::default()`; update the **seven existing bare `repo.search(term)` calls** in `crud_search_and_fts` to pass a second `&ListFilter` argument (D1's signature change); add the new tests per §8. If the tiebreak test needs equal timestamps, add the test-only seam described in §8.
10. **Run the CLAUDE.md verification block** (§9) and fix any failures.

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/migrations/0003_projects_jira.sql` | Create | `projects` table, `items.project_id` + `items.jira_url` columns, `idx_items_project` |
| `src-tauri/src/models.rs` | Modify | `Sort`, `Project`, `ProjectWithCount`; new fields on `Item`/`NewItem`/`UpdateItem`/`ListFilter` |
| `src/types.ts` | Modify | Mirror all model changes (camelCase) |
| `src-tauri/src/db/mod.rs` | Modify | Change `search` signature; add 5 trait methods + imports |
| `src-tauri/src/db/sqlite.rs` | Modify | `push_filters` helper; rewrite `list`/`search`; implement 5 methods; extend `create`/`update` binds + merge blocks |
| `src-tauri/src/commands.rs` | Modify | One-line `search_items` fix (`&ListFilter::default()`) |
| `src-tauri/tests/repo.rs` | Modify | Update helper/literals; add Phase 1 tests (+ optional timestamp seam) |
| `src-tauri/src/error.rs` | Verify only | Confirm `AppError::Invalid` / `NotFound` cover new cases (no change expected) |

## 8. Test Strategy

*(test-writer agent; conventions: one `#[tokio::test] async fn` per scenario, fresh `SqliteRepository::connect_in_memory()` per test, `assert_eq!`/`assert!`, error assertions via `matches!(err, AppError::Invalid(_))`)*

**Prerequisite — timestamp seam:** there is no existing way to force two items to share `created_at`/`updated_at` (both come from `Utc::now()`; the pool is private). Natural collision is non-deterministic → a flaky tiebreak test. Add a minimal `#[cfg(test)]`-gated seam on `SqliteRepository` (raw `UPDATE` to stamp `created_at`/`updated_at`) **before** writing the `rowid DESC` tiebreak assertion. Do not test the tiebreak against natural collision.

**Compile-breaks to fix first:** (a) existing `ListFilter { kind: …, archived: … }` literals in `crud_search_and_fts` become `..Default::default()`; (b) the `new_item` helper gains `project_id: None, jira_url: None`; (c) all **seven** bare `repo.search(term)` calls in `crud_search_and_fts` (`tests/repo.rs:88, 92, 96, 99, 105, 106, 113`) gain a `&ListFilter::default()` second argument (D1).

- [ ] **Unit / Repository — Project CRUD:**
  - `create_project`: trims name; returned project has non-empty id, trimmed name, RFC3339 `created_at`.
  - `create_project` whitespace-only name (`"   "`) → `AppError::Invalid` (not panic, not raw DB error).
  - `create_project` duplicate (exact and after-trim, e.g. `"Ops"` then `" Ops "`) → `matches!(err, AppError::Invalid(_))`, NOT a leaked `sqlx` unique-constraint error.
  - `create_project` case sensitivity (Q1): pins the chosen collation — with the default (binary), `"Ops"` and `"OPS"` coexist as distinct projects; if `COLLATE NOCASE` is chosen, the second → `Invalid`. Lock in whichever default the user picks.
  - `rename_project`: reflected in a later `list_projects()`; assigned items keep the same `project_id` (id-referenced, rename-safe).
  - `rename_project` to its own current name → succeeds (no self-collision; proves the `id <> ?` predicate in D2).
  - `rename_project` to a name another project already holds → `AppError::Invalid`.
  - `rename_project` nonexistent id → `AppError::NotFound`.
  - `list_projects` counts: seed 0, 1, N items across projects; assert each count — **including a zero-item project appearing with count 0** (proves LEFT JOIN + `COUNT(i.id)`).
- [ ] **Unit / Repository — `delete_project`:**
  - Zero items → succeeds; project gone from `list_projects()`.
  - N=1 and N=2 assigned items → `AppError::Invalid` whose **message names the count** (assert substring, not just `is_err()` — a leaked FK `AppError::Db` would also be `is_err()` but violates the contract).
  - After a failed delete, project still present (guard didn't partially apply).
  - Reassign/unassign the item, then delete → succeeds (live count, not a one-time flag).
  - Nonexistent id → `AppError::NotFound`.
- [ ] **Unit / Repository — `list_active_tags`:**
  - Union of disjoint tag sets, `DISTINCT`, sorted — assert exact `Vec<String>` equality (catches missing `ORDER BY`).
  - Dedupe: shared tag appears once.
  - Drop on archive of sole carrier; drop on marking sole-carrier task `done`; **a note with the same tag is NOT dropped when a task with that tag is done** (proves kind+status joint predicate).
  - Restore on reopen (`done`→`todo`) and on unarchive.
  - Multi-carrier survives partial removal (only last-carrier removal drops the tag).
  - Empty tags array contributes nothing; no items → empty `Vec`, not an error.
- [ ] **Integration — Filters combine (AND across types, OR within tags):**
  - Project filter alone; status filter alone (a note has no status → must not match/error).
  - Tag OR: items `["a"]`,`["b"]`,`["a","b"]`,`["c"]`, filter `["a","b"]` → first three, excludes `c`-only.
  - **Empty tag list `Some(vec![])` == `None`** (same set as unfiltered) and raises **no** SQL error — highest-risk edge, assert explicitly.
  - Tag list with a tag no item carries → empty result, not an error.
  - Combined project + status + tag-OR: seed items matching all/some/none → only fully-matching returned (proves AND-across-categories, the bug where everything gets OR'd).
  - Archived exclusion still holds when combined with new filters.
- [ ] **Integration — Sort modes:**
  - `Updated` (default and explicit) unchanged; `sort: None` == `Sort::Updated`.
  - `Created` distinguished from `Updated` (create A, create B, edit A's body → Created orders by creation).
  - `Priority`: High, Normal, Low, then note last.
  - `Status`: Doing, Todo, Done, then note last.
  - Pinned supremacy under each mode (pin the would-be-last item → sorts first). At minimum one Priority + one Status case.
  - `rowid DESC` tiebreak (**depends on the timestamp seam**): equal timestamps → stable order across repeated `list()` calls, `rowid DESC` within the tied set.
- [ ] **Integration — `search()` post-filters (given D1 signature):**
  - Term matching items across two projects, filtered to one → only that project's hit.
  - Tag-OR + search term combined (filter refines the FTS match).
  - Existing empty-query-fallback and hostile-FTS-syntax tests still pass (calls updated to pass a filter).
  - Archived-excluded-from-search invariant holds with a filter present.
  - **Forced archived exclusion (D5a):** `search(term, ListFilter { archived: Some(true), .. })` still returns NO archived items (search ignores `filter.archived` — unlike `list()`, which honors it). This is the concrete test for D5a; without it the shared-builder refactor could silently leak archived items into search.
- [ ] **Unit / Repository — `jira_url` + `project_id` semantics:**
  - Set on create; both persisted and returned.
  - **Set on a note, not just a task** (explicitly assert notes can carry both — this is where Phase 1 breaks the "notes are metadata-light" pattern, so pin it or a future copy-paste guard will silently block it).
  - Update then clear via `Some("".into())` → `None` (mirrors `due_at`); same for `project_id`.
  - Omitted field (`None`) leaves existing value unchanged (send an unrelated `title` patch, assert both survive).
  - Setting `jira_url` alone bumps `updated_at`; setting `project_id` alone bumps `updated_at`.
  - **Nonexistent `project_id` (D2a):** assigning a `project_id` that doesn't exist, via both `create()` and `update()`, → `AppError::Invalid` (existence pre-check), NOT a leaked raw `FOREIGN KEY constraint failed` DB error.
  - **Non-bump regression:** after populating the new fields, pin/unpin and archive/unarchive → `updated_at` must NOT move (the new UPDATE column list didn't start writing `updated_at` unconditionally).
  - Serde shape: extend `validation_and_serde_shape` — `json["projectId"]` / `json["jiraUrl"]` present, camelCase, `null` when unset.

**Edge Cases & Error Scenarios (must be non-vacuous — write-then-verify-red):**
- Empty tag-list no-op: assert equality with the unfiltered list count, then temporarily stub the branch to return `[]` and confirm the test fails.
- `delete_project` message: assert the enum variant AND message substring; stub the guard to always-succeed and confirm the test fails.

## 9. Success Criteria

- [ ] **Functional:** projects can be created/renamed/listed with correct (incl. zero) counts; `delete_project` refuses while items reference the project and succeeds at zero; `list_active_tags` returns the correct derived vocabulary through the full drop/restore lifecycle; `list()`/`search()` honor project + status + OR-tag filters (AND-combined) and all four sort modes with pinned-first / rowid-tiebreak ordering; `project_id`/`jira_url` set/clear/unchanged correctly on both notes and tasks and bump `updatedAt`.
- [ ] **Tests:** every test in §8 passes; the two flagged non-vacuous tests were verified red against a stub.
- [ ] **Security:** D2 (clean `Invalid` on duplicate name), D4 (empty-tag no-op), D6 (transactional guard) implemented; sort keys driven by the closed enum; `search()` keeps `fts_query()` + archived exclusion.
- [ ] **Quality:** `cd src-tauri && cargo test` green; `npx tsc --noEmit` clean (strict, `noUnusedLocals`); `npm run build` clean; `models.rs` and `types.ts` agree.

Verification block (run all):
```
cd src-tauri && cargo test
npx tsc --noEmit
npm run build
npm run tauri dev   # manual smoke: app boots, migration applies, existing list/search still work
```

## 10. Risks & Open Questions

**Adversarial-verifier verdicts on claims raised by research agents:**
- **REFUTED — "`connect_in_memory()` omits FK enforcement, so tests don't exercise the new FK."** sqlx 0.8 enables `PRAGMA foreign_keys = ON` by default on every connection (verified against sqlx source at tags 0.8.0 and 0.8.3), including `from_str("sqlite::memory:")`. The `.foreign_keys(true)` call in `connect()` is a redundant no-op; both constructors enforce FKs identically. **Consequence for the plan:** no FK-pragma fix is required. (Residual: verifier could not run a live `PRAGMA` check — no cargo on the machine, no Cargo.lock — but the sqlx source is unambiguous across 0.8.x. Low residual risk; the `delete_project` COUNT guard is authoritative regardless of FK, so the plan does not depend on this verdict.)

**Risks:**
- **`search()` signature change ripples to Phase 2.** Mitigated: Phase 1 passes `&ListFilter::default()` from `commands.rs`; real wiring is Phase 2. Keep the change to one line.
- **Ordering invariant regressions.** The shared builder centralizes ORDER BY, but the pinned/rowid frame and notes-last (Priority/Status only) must be exact — covered by the pinned-supremacy and tiebreak tests. Tiebreak test is blocked on the timestamp seam.
- **`delete_project` TOCTOU** — mitigated by the transaction (D6); theoretical at single-user scale but cheap insurance.
- **Non-vacuous edge tests** (empty tag list, delete message) can silently pass — mitigated by the write-then-verify-red requirement.

**Open Questions (decide before/at implementation):**
- **Q1 — `COLLATE NOCASE` on `projects.name`?** Binary collation (default) treats `"Backend"`/`"backend"` as distinct project names. Case-insensitive uniqueness requires `COLLATE NOCASE` in migration `0003` and is irreversible without a table rebuild. **Default: binary collation** unless the user prefers case-insensitive. DESIGN.md does not specify; flag for user.
- **Q2 — `list_projects` ordering** is unspecified in the plan. Default: `ORDER BY p.name`. Tests should not over-assert an unspecified order beyond "all present" unless the user confirms name-ordering is the contract.
- **Q3 — Within-bucket ordering under Priority/Status sort:** the plan specifies CASE→`rowid DESC`. Optionally insert `updated_at DESC` before `rowid DESC` for recency within a same-priority bucket. Default: follow the plan (CASE→rowid) — do not add unless requested.

## 11. Code Review Checklist
After implementation, verify:
- [ ] No dead code or unused imports introduced
- [ ] Error handling covers failure modes (empty/duplicate name → `Invalid`; missing id → `NotFound`; referenced project → `Invalid` with count)
- [ ] No security vulnerabilities: every filter value is a bind; sort keys from the closed enum only; no raw SQLite constraint text reaches the caller; `fts_query()` + `archived = 0` preserved in `search()`
- [ ] Security considerations from §4 addressed (D2, D4, D6; empty-tag guard; scheme-allowlist note recorded for Phase 3)
- [ ] Code follows existing project conventions (`due_at` pattern for the new fields; QueryBuilder idiom; migration style; serde camelCase; `models.rs`↔`types.ts` parity)
- [ ] Tests cover happy path, edge cases, and error scenarios; the two flagged tests verified red against a stub
- [ ] No performance regressions (only `idx_items_project` added; no speculative sort indexes; N+1 avoided in `list_projects` via single GROUP BY)
- [ ] Changes are minimal — no unrelated refactoring; `project_id`/`jira_url` merged outside the task gate (D3); pin/archive still don't bump `updatedAt`

## 12. Post-Review Improvements

Two narrow deviations from the plan's own stated intent were surfaced independently by the security-auditor and code-reviewer agents (both low-probability at single-user desktop scale, but cheap to close and required by the §11 checklist item "no raw SQLite constraint text reaches the caller"). Both implemented:

1. **`delete_project` now uses `BEGIN IMMEDIATE`** (D6 specifies it literally). `self.pool.begin()` issues a *deferred* `BEGIN`, so the `COUNT` read takes no write lock and the later `DELETE` must upgrade the lock — under a concurrent writer that upgrade can surface as a raw `database is locked` error (leaked via `AppError::Db`). Switched to `self.pool.begin_with("BEGIN IMMEDIATE")` (sqlx 0.8.3+), which takes the write lock up front while preserving the `Transaction`'s RAII rollback-on-drop. `sqlite.rs` `delete_project`.

2. **FK-violation backstop on the item `create()`/`update()` writes.** `ensure_project_exists` is a pre-check with a TOCTOU window: if a project is deleted between the check and the write, the FK fires and the raw `FOREIGN KEY constraint failed` would leak as `AppError::Db` — the exact leak D2a guards against, just via a race the pre-check alone can't close (the duplicate-name path already had `map_unique_violation` as its backstop; the FK path had none). Added `map_fk_violation`, mapping an FK constraint error to the same clean `AppError::Invalid("no such project")`, applied to both item write statements. `sqlite.rs` `create`/`update` + new `map_fk_violation` helper.

**Note on the test seam (deviation from §6/§8 wording):** the plan calls for a `#[cfg(test)]`-gated timestamp seam. `tests/repo.rs` is an *integration* test — a separate crate that compiles `notes_app_lib` **without** `cfg(test)` — so a `#[cfg(test)]` method would be invisible to it and fail to compile. Implemented instead as a `test-support` cargo feature (off by default, so the seam never ships in release/`tauri` builds) enabled for the test crate via a self dev-dependency (`Cargo.toml`). `set_timestamps_for_test` is gated `#[cfg(feature = "test-support")]`. This preserves the plan's intent (test-only seam, not production API) with the only mechanism that actually works for an integration-test crate.

Both concurrency fixes are defense-in-depth for a single-user local app; the normal (non-raced) paths are covered by `nonexistent_project_id_is_invalid_on_create_and_update`, `delete_project_blocked_message_names_count`, and the other project tests. The raced FK-backstop path is not deterministically unit-testable, but was confirmed reachable during the non-vacuous stub proof (with the app-level guard stubbed out, `delete_project` surfaced `FOREIGN KEY constraint failed`, demonstrating the FK backstop is a real, exercised path).

## 13. Execution Prompt

```
Implement Phase 1 (schema + repository) of the worknotes app, following the plan at
notes-app/plans/plan.1.md. Read that plan file in full first — it is the authoritative
spec for this work, including the design decisions (D1–D7), the open questions (Q1–Q3),
and the adversarial-verifier verdict in Section 10 (do NOT add an FK-pragma fix — sqlx 0.8
already enables foreign_keys by default; this was verified).

Project root: notes-app/. Standard verification lives in notes-app/CLAUDE.md.

Before writing code, resolve the open questions in Section 10 with the user if they are
material to you (Q1 COLLATE NOCASE is the only irreversible one — default to binary
collation if the user does not object). Do not block on Q2/Q3; follow the plan defaults.

Implement the plan step by step, following Section 6 (Implementation Steps) in order:
  1. Create migration 0003_projects_jira.sql (table before ALTERs; index last; do not
     touch FTS triggers).
  2. Extend models.rs (Sort, Project, ProjectWithCount, new fields) AND mirror src/types.ts
     in the same change — CLAUDE.md requires "both or neither".
  3. Update the ItemRepository trait in db/mod.rs (change search signature per D1; add the
     five new methods).
  4. Implement in db/sqlite.rs: shared push_filters WHERE builder used by list() and
     search(); the five new methods; extend create()/update() binds; merge project_id/
     jira_url OUTSIDE the task-only kind gate (D3); empty-string-clears like due_at (prose
     in §6 step 5 / §5 D3); skip the tag filter clause on an empty list (D4); force
     archived=0 in search() regardless of filter.archived (D5a); transactional
     delete_project guard with NotFound-on-zero-rows (D6); map unique violations and
     nonexistent project_id to AppError::Invalid (D2, D2a).
  5. One-line commands.rs fix so search_items compiles (pass &ListFilter::default()).
  6. Extend tests/repo.rs per Section 8 — including the #[cfg(test)] timestamp seam needed
     for the rowid-DESC tiebreak test, and update existing ListFilter literals to
     ..Default::default().

Use subagents during implementation (if a named agent type is unavailable, fall back to a
generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise
— with the role stated in the prompt):
  - After the migration + repository code is written, spawn a database-architect agent to
    review 0003_projects_jira.sql and the new SQL (LEFT JOIN count, json_each queries, tag
    EXISTS binding, sort CASE ordering) against Section 3.
  - Spawn a test-writer agent to write/extend the tests/repo.rs suite per Section 8, and to
    prove the two flagged non-vacuous tests (empty-tag no-op, delete_project message) fail
    against a temporary stub before trusting them.
  - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify the Section 4
    mitigations in the actual diff (bind discipline, empty-IN guard, enum-only sort keys,
    no raw constraint text leaked — including the nonexistent-project_id FK path D2a and
    duplicate-name path D2, forced archived=0 in search() D5a, fts_query() preserved).
  - Spawn a code-reviewer agent (read-only: Read, Grep, Glob) on the full diff.
  - No api-designer / frontend-specialist / devops-engineer needed — Phase 1 touches no IPC,
    UI, or infra. (IPC is Phase 2, UI is Phase 3.)

After implementation:
  - Run the Section 11 Code Review Checklist and address every item.
  - Document any improvements in Section 12 of the plan file and implement them.
  - Run the full verification block and fix regressions before finishing:
        cd src-tauri && cargo test
        npx tsc --noEmit
        npm run build
    (and a manual `npm run tauri dev` smoke test that the app boots and the migration applies).

Do not start Phase 2 or Phase 3. Stop when Phase 1's acceptance criteria (Section 9) are met
and all tests pass.
```
