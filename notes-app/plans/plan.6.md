# Plan 6: Projects as Loadable On-Disk Databases (+ git-mergeable storage direction)

**Created:** 2026-07-17
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Redefine "project" from *a row in the single shared `notes.db`* to *a self-contained database at a user-chosen location on disk*. Users can load and unload projects at will; all notes, tasks, and tags belong to exactly one project's store; the tag vocabulary shown in the app is the union of derived tags across all currently loaded projects (the same tag name may exist in several projects and appears once).

This is a **replacement** of the current project concept (Obsidian-vault-style workspaces), not an extension of it: the `projects` table, `items.project_id` FK, and the delete-guard encode the model being retired. The feature also carries an open question — how to structure data on disk so git-based merging is viable — which this plan resolves with a staged answer (Section 5, Decision 5).

**Staging (the load-bearing structural decision):**
- **Stage 1 (this plan's execution scope):** projects as per-project SQLite files inside user-chosen project directories, with a `ProjectManager` registry, load/unload, cross-DB merge for list/search/tags, security hardening for user-supplied paths and foreign DB files, and a one-time migration of existing data.
- **Stage 2 (designed here, gated on explicit user confirmation):** git-mergeable storage — one Markdown-with-frontmatter file per item as the canonical store, with the per-project SQLite DB demoted to a git-ignored, rebuildable index. Stage 1 is deliberately shaped so Stage 2 is additive (project = directory, not bare file; tiebreak moved off `rowid`).

## 2. Strategic Assessment

*(Source: tech-lead agent.)*

- **Split the request.** "Project = loadable DB file on disk" is coherent and buildable at bounded cost. "Git-mergeable storage" is a different, far riskier ambition that fights SQLite head-on (a SQLite file is an opaque binary to git; WAL churns it constantly). Treating them as one feature is how a single-user notes app becomes a distributed-systems project.
- **Roadmap conflict, flagged not fatal:** `docs/IMPLEMENTATION_PLAN.md:84` names a `PostgresRepository` "for cloud sync" in the Phase 4 backlog (verified: agreed backlog, not scheduled). This feature is an alternative sync philosophy. Adopting this plan supersedes that backlog line for sync; the trait seam it relies on survives either way.
- **Churn warning:** row-based projects shipped in Phase 3 with tests; this deletes most of that subsystem. Accepted consciously as part of this plan's approval.
- **Riskiest parts, ranked:** (1) the git-mergeability requirement conflicting with SQLite — resolved by staging; (2) cross-DB search/order breaking two invariants at once (per-DB FTS `rank` is not comparable across corpora; the `rowid` tiebreak is per-DB and collides across files); (3) the legacy data migration being a one-way, user-involved data move outside the additive-migration convention; (4) the derived-tag invariant quietly redefining to "…in a currently loaded project."
- **Tags are the most compatible part:** the derived-vocabulary invariant (no tags table) survives unchanged — the union is `list_active_tags()` per loaded DB, merged.
- **Highest-level approach:** model a project as a self-contained workspace the user opens and closes, implemented as a registry of per-directory `SqliteRepository` instances behind a fan-out/merge layer; defer the git-mergeable canonical format to a gated Stage 2 rather than letting it dictate the storage engine up front.
- **Gating question for Stage 2** (do not implement without the user answering it): *is git-based merge — as opposed to whole-file sync via OneDrive/Syncthing — actually required?* If whole-file sync suffices, Stage 2 may never be needed.

## 3. Research Findings

*(Sources: architect and database-architect agents; all file:line claims below were CONFIRMED by an adversarial verification pass.)*

### Current architecture (what the feature touches)

- **Single wiring point:** `src-tauri/src/lib.rs` `setup()` (lines 19–44) computes `app_data_dir()/notes.db`, calls `SqliteRepository::connect(&db_path)` once, and manages `AppState { repo: Arc<dyn ItemRepository>, http, cancellations }` (`src-tauri/src/commands.rs:19-26`). Exactly one repository exists app-wide; **no existing command accepts a filesystem path** (verified across the full `invoke_handler` list, `lib.rs:46-69`).
- **The storage seam:** `ItemRepository` trait, `src-tauri/src/db/mod.rs:13-46` — 15 async methods. Item ops are per-store; `list_projects`/`create_project`/`rename_project`/`delete_project` and `get_setting`/`set_setting` are single-DB CRUD that must move up out of the trait under this feature.
- **Connect path:** `SqliteRepository::connect()` (`src-tauri/src/db/sqlite.rs:30-44`) always sets `create_if_missing(true)`, WAL journal mode, `foreign_keys(true)`, `max_connections(4)`, and unconditionally runs `sqlx::migrate!("./migrations")`. There is no open-without-creating or open-without-migrating path anywhere (verified).
- **Ordering:** every list query ends with the tiebreak `i.rowid DESC` (`sqlite.rs:160`); search joins FTS by rowid (`items_fts.rowid = i.rowid`, `sqlite.rs:366-367`) and orders by `rank` (`sqlite.rs:375`). `items_fts` is an external-content FTS5 table keyed on `items.rowid` (`migrations/0001_init.sql:21-26`) with three sync triggers (lines 28–43).
- **Projects today:** `projects` table (`0003_projects_jira.sql`, `name` UNIQUE), nullable `items.project_id` FK, delete-guard as `BEGIN IMMEDIATE` count-then-delete (`sqlite.rs:462-491`). Error scrubbers `map_fk_violation`/`map_unique_violation` exist only on query paths; the connect path propagates raw `sqlx::Error`/`MigrateError` text, which `AppError` serializes verbatim to the frontend (`src-tauri/src/error.rs:8-12, 39-46`) (verified).
- **Ids:** items and projects are `uuid::Uuid::new_v4()` (`sqlite.rs:200, 413`); Cargo enables only the `v4` feature (verified). Cross-DB item-id uniqueness therefore already holds statistically.
- **Settings:** `app_settings` k/v (`0004_app_settings.sql`) holds JIRA base URL + email; the API token is keyring-only.
- **Frontend:** `src/lib/api.ts` is the sole IPC boundary. `src/App.tsx` holds `projects`, `activeTags`, `projectFilter`, `tagFilter` as flat state; `loadItems` (App.tsx:55-71) commits `setItems()` unconditionally with **no request-token/cancellation guard** (verified — only the AI stream and JIRA hook have cancellation); `loadMeta` fans out `listProjects` + `listActiveTags`; tag-lifecycle pruning via `recomputeTagFilter` (`src/lib/tags.ts:25-27`, App.tsx:100-105) is the exact reusable mechanism for "union shrinks when a project unloads."
- **Dependencies/capabilities:** neither `tauri-plugin-dialog` nor `tauri-plugin-fs` is present; `capabilities/default.json` grants only `core:default` + `opener:allow-open-url` (verified). `[dev-dependencies]` has no tempfile crate (verified).
- **Test setup:** `src-tauri/tests/repo.rs` builds real repos via `connect_in_memory()`; a `test-support`-feature timestamp seam (`set_timestamps_for_test`) forces equal timestamps. Vitest is node-environment pure-logic only (`vitest.config.ts`), tests live beside `src/lib/*.ts` (verified).

### Cross-DB mechanics (database-architect)

- **Merge in Rust, not `ATTACH`:** `ATTACH` is connection-local; the pool of 4 (`sqlite.rs:37-40`) hands out arbitrary connections, so runtime attach/detach would force abandoning the pool; default attach limit is 10; and FTS5 `MATCH` cannot span attached DBs anyway — you would still write one `MATCH` per DB and `UNION ALL`. N-queries-merged-in-Rust wins at this scale. A transient in-memory aggregate DB is the escape hatch **only** if a single globally-ranked search list is later required.
- **Tiebreak:** rowids collide across files and are reassigned on any future index rebuild. Replace the `rowid DESC` tiebreak with `(created_at DESC, id ASC)` — `created_at` is already minted at fixed millisecond precision (`now_rfc3339`, `sqlite.rs:20-22`) and `id` is a UUID, so the order is deterministic and machine-independent. This is a **semantic change** (creation-time order, not literal insertion order) that CLAUDE.md's invariant wording must be updated to reflect. (UUIDv7 time-ordered ids were considered as a stronger alternative; rejected for Stage 1 to keep scope minimal — new ids would diverge from existing v4 ids for no Stage-1 benefit.)
- **Search ranking:** bm25 `rank` values are not comparable across corpora. Present merged search results **ordered per-project by rank, grouped by project** (honest and cheap). A global-rank mode is deferred.
- **Project identity:** the DB path is not identity (files move). Each per-project DB carries a `meta` table (`project_id` UUID, `project_name`, `schema_version`, `created_at`); the app-level catalog keys projects by that UUID and reconciles paths on load. Copied file → same UUID at a second path → refuse to load the copy alongside the original (offer "duplicate project" later if ever needed). Moved file → update the stored path.
- **Catalog:** a small `catalog.db` in `app_data_dir` (own migration dir), holding `projects(id PK, name UNIQUE, path UNIQUE, loaded, last_opened)` and the relocated `app_settings`. SQLite over JSON for atomicity, UNIQUE constraints (global name/path uniqueness — the per-DB `projects.name UNIQUE` no longer sees other projects), and idiom consistency.
- **Migration-version edge:** a project DB created by a **newer** app version makes `sqlx::migrate!` fail with `VersionMissing`/`VersionMismatch`. Catch per-file and surface "created by a newer version of worknotes" — one bad file must not fail startup or a load command.
- **WAL vs git:** WAL `-wal`/`-shm` sidecars are machine-local and must never be committed. Stage 1 keeps WAL (DBs live in project dirs the user may git-track, so `create_project` writes a `.gitignore` for the DB + sidecars — see Decision 5). Stage 2 makes this moot by git-ignoring the whole index DB.
- **Accepted limitation:** `updated_at` is wall-clock; across machines that sync, recency sort can misorder items authored on skewed clocks. Not fixable without logical clocks; documented, not engineered around.

### Frontend findings (frontend-specialist)

- The tag union costs the frontend almost nothing: `TagFilter`/`EditorTags` consume a flat `activeTags: string[]`, and the prune-on-shrink effect already handles vocabulary shrinking on unload.
- `ManageProjectsDialog` must become a project-manager surface with **three visually and verbally distinct actions**: *Unload* (reversible, closes the store), *Forget* (removes from catalog, file untouched), *Delete files* (destructive, confirm dialog naming the actual path). Reusing one `.btn-danger` affordance for all three would flatten reversible and irreversible actions — the exact ambiguity today's UI never has to solve.
- Sharpest UX gap: **unloading a project while its item is open in the editor** — `selected` resolves from `items.find(...)` (App.tsx:108); unload would silently drop unsaved edits. Unload must warn/confirm when the open item (or dirty draft) belongs to the target project.
- `App.tsx`'s conflated `projects: ProjectWithCount[]` splits into *known projects* (catalog: id, name, path, loaded) and derived loaded-set views; `ManageProjectsDialog`'s duplicate self-fetched project state collapses into props from App.
- The in-flight-query race (no request token in `loadItems`) becomes a genuine correctness bug once unload exists: a slow `listItems` can resolve after unload and repopulate the list with items from a closed store. A monotonic request token is required (same shape as the `cancelled` flag in `Editor.tsx:236-247`).
- New-item creation now targets a **write destination**, not a soft label: create into the project selected in the rail filter; when the filter is "All projects", the editor's project select becomes required before Save enables; with zero loaded projects, New note/New task are disabled and the empty state explains why.
- List rows need a muted project label when more than one project is loaded (tags/titles are otherwise ambiguous across projects); DESIGN.md has no slot for this today — spec update required, no new colors (loaded/unloaded indicators use existing `--done`/`--muted`/`--danger` tokens).
- Native file dialogs escape React focus management — restore focus to the trigger after the picker promise settles, mirroring `usePopover`'s discipline. Screen-reader announcement (`role="status"` live region, as in the AI review card) when an unload evicts the open item.

## 4. Security Considerations

*(Source: security-auditor agent; current posture verified strong — parameterized SQL, FTS sanitizer, keyring-only secrets, strict CSP, zero `dangerouslySetInnerHTML`. This feature adds two trust boundaries the app has never had: user-supplied filesystem paths over IPC, and untrusted DB/file content.)*

Priority-ordered requirements to build in from the start:

1. **[Critical] Path validation in Rust, server-side, on every path-accepting command.** The OS file picker is UX, not a security boundary — the picked path re-enters via `invoke` and a compromised webview can forge it. Validate regardless of origin: reject UNC paths (`\\`/`//` prefixes — SMB NetNTLM leak), `\\.\` device paths, NTFS ADS (`:` in the final component), and any `..` segment in the **raw input**; canonicalize (`dunce::canonicalize` or `std::fs::canonicalize` + strip verbatim prefix) and reject if canonicalization fails; run all containment checks against the **canonical** result: require the target to be a directory the user can write, and reject locations under the app's own data dir except for the default projects dir. Tauri fs-plugin scopes do **not** cover sqlx's direct `filename()` open — validation must live in our Rust code.
2. **[Critical] Split "create" from "open".** `connect()`'s unconditional `create_if_missing(true)` becomes a file-creation primitive once paths are user-supplied (WAL also spawns `-wal`/`-shm` sidecars at any pointed-at location). New API: `create_at(path)` (fails if the DB already exists) vs `open_existing(path)` (`create_if_missing(false)`, fails cleanly if missing).
3. **[High] Treat every opened project DB as untrusted input** (it may arrive via git clone/shared folder): before running migrations — check `PRAGMA application_id` equals our marker (set it in the new migration; refuse foreign DBs), run `PRAGMA quick_check`, set `PRAGMA trusted_schema=OFF`, enumerate `sqlite_master` and refuse DBs containing triggers/views/tables outside the known schema set, keep extension loading disabled (sqlx default), enforce a max file size before opening. Only then `sqlx::migrate!`. Map `VersionMissing`/`VersionMismatch` to a clean message.
4. **[High] Preserve the no-HTML-rendering invariant and strict CSP** (`default-src 'self'; connect-src 'self'`). Stage 2 renders nothing new — item bodies stay in `<textarea>`/`<pre>` as React text nodes. No Markdown-to-HTML rendering is in scope in either stage; if it ever is, it requires sanitization review first.
5. **[Medium] Settings and secrets never come from project stores.** `app_settings` (JIRA config) lives in the catalog only; ignore any `app_settings` rows found inside a loaded project DB. Keyring stays global; no key material is ever written to a project directory. `create_project` writes a `.gitignore` covering DB + WAL sidecars so a git-tracked project dir never commits them.
6. **[Medium] Scrub open/connect errors.** Add a mapping so path/open/migrate failures surface as clean `AppError::Invalid` messages without echoing full filesystem paths or raw SQLite text into the UI (extend the existing scrubber pattern; test with the same `!msg.contains(...)` style as `create_project_rejects_duplicate_cleanly`).
7. **[Medium] Stage 2 file safety (when gated in):** filenames derived only from the UUID id, never from titles/tags (traversal, `CON`/`NUL` reserved names, ADS); frontmatter parsed with size caps and no panics; files containing git conflict markers rejected per-file with the filename identified.
8. **[Low] New-dependency vetting:** `tauri-plugin-dialog` (first-party; scope its capability to open/save dialogs only), `tempfile` (dev-only). Do **not** add `tauri-plugin-fs` (would grant the webview filesystem reach; all fs stays in Rust). Flag any Stage-2 additions (frontmatter parsing) at implementation time.

## 5. Design

### Approach

Introduce a **`ProjectManager`** registry above the existing `ItemRepository` trait. The trait remains the per-project storage contract — one `SqliteRepository` instance per loaded project — and the manager owns the loaded set, routes item writes to the right store, fans out reads (list/search/tags) and k-way-merges results in Rust. A small **catalog** (`catalog.db` in `app_data_dir`) records known projects (UUID, name, path, loaded flag) and hosts the relocated `app_settings`. A **project is a directory** chosen by the user; Stage 1 stores `project.db` inside it (plus a generated `.gitignore`); Stage 2 would add `items/*.md` beside it and demote the DB to a rebuildable index — the directory shape means Stage 2 changes the directory's contents, not the user's mental model or the catalog.

### Architecture

```
Frontend (src/lib/api.ts — unchanged discipline: only IPC boundary)
   │  new: listProjects (catalog+loaded state), createProject(dir,name),
   │       openProject(dir), loadProject(id), unloadProject(id),
   │       forgetProject(id), deleteProjectFiles(id), pickProjectFolder()
   ▼
commands.rs — AppState { manager: Arc<ProjectManager>, http, cancellations }
   │
   ▼
projects/mod.rs   ProjectManager
   ├─ catalog: Catalog (projects/catalog.rs → catalog.db, own migration dir)
   ├─ loaded: RwLock<HashMap<ProjectId, LoadedProject { name, path, repo: Arc<dyn ItemRepository> }>>
   ├─ routing: create/update/delete/get → repo_for(project_id) (mirrors ai::provider_for registry)
   └─ fan-out: list_all / search_all / active_tags_union → per-repo query + k-way merge
   ▼
db/mod.rs  ItemRepository (slimmed: item ops + list_active_tags + search; project CRUD
           and settings move out) — db/sqlite.rs unchanged in spirit, per-project instance
```

- **Ordering across stores:** per-DB SQL tiebreak changes from `i.rowid DESC` to `i.created_at DESC, i.id ASC` (`push_sort`), and the Rust merge comparator uses exactly `(pinned DESC, sort-mode key, created_at DESC, id ASC)` so merged order equals what a single DB would produce. Search results are grouped by project, each group ordered by its own FTS rank.
- **Startup:** open the catalog, then attempt to load every project with `loaded = 1`; each failure (moved file, newer version, corrupt) becomes a non-fatal per-project warning surfaced to the UI, never a startup abort.
- **Unload:** remove from the map, `pool.close().await` (releases Windows file locks and WAL sidecars), set `loaded = 0` in the catalog. `close()` waits for checked-out connections; a query racing the close must resolve or surface as a clean error, never a panic — covered by a dedicated test.
- **Legacy migration (one-time, app-level — not a sqlx migration):** on startup, if legacy `notes.db` exists and the catalog has no `migrated` marker: create one project directory per existing `projects` row under a default location (`app_data_dir/projects/<name>/`), plus a **"Personal"** project for `project_id IS NULL` items; copy items verbatim (same `id`, `created_at`, `updated_at`, `tags`, `jira_url`); copy the legacy `app_settings` rows (JIRA config) into the catalog's `app_settings` so existing configuration survives; verify source item count == sum of destination counts before marking migrated; keep `notes.db` untouched as a backup (renamed `notes.db.pre-projects.bak`). Users can later move project dirs via Forget + Open.

### Key Decisions

1. **Manager/registry above the trait — not a composite `ItemRepository`, not `ATTACH`.** A composite impl can't express "create into which store" without polluting every DTO; `ATTACH` is connection-local (incompatible with the 4-connection pool), capped at 10, and doesn't help FTS anyway. The registry mirrors the existing `ai::provider_for` pattern and makes the merge logic independently testable. *Trade-off accepted:* item commands grow a `projectId` argument; the frontend must always know the target project.
2. **Catalog is SQLite (`catalog.db`, own `migrations_catalog/` dir), not JSON.** Atomic writes, UNIQUE(name) and UNIQUE(path) for free, and it reuses the sqlx idiom the codebase already speaks. `app_settings` relocates here (it is app-wide config, and per-project stores must not influence it — Section 4.5).
3. **Tiebreak moves to `(created_at DESC, id ASC)`; CLAUDE.md invariant rewritten accordingly.** rowid cannot order a merged set (collides across files, unstable across rebuilds). Millisecond-pinned `created_at` + UUID gives a deterministic, machine-independent total order. This intentionally re-specs "insertion sequence" → "creation time, then id"; the old `sort_rowid_tiebreak_is_stable` test is replaced, and the invariant "equal timestamps must never flap" is preserved by construction.
4. **Project identity = UUID in an in-DB `meta` table; path is an attribute.** Catalog reconciles by UUID on load (moved file → path update; duplicated file → refuse second load). `meta` is added by a normal additive migration (`0005_meta.sql`) so every project DB self-describes; the legacy `projects` table and `project_id` column remain in the per-project schema as vacuous dead weight (migrations are never edited) — documented, unused, not repurposed. Concretely: per-store writes always store `project_id = NULL` (the nullable FK stays satisfied, `ensure_project_exists` is deleted along with the in-store project CRUD), and the **manager stamps the owning project's UUID onto every `Item` it returns** — the column inside the file is never the source of truth.
5. **Git-mergeability answer (the open question):** **file-per-item Markdown + YAML frontmatter as the canonical store, with the per-project SQLite DB as a git-ignored rebuildable index — implemented as gated Stage 2, not now.** Rationale: it is the only direction that keeps every invariant (FTS5, sort frame, derived tags, updatedAt semantics) because SQLite remains the query engine, merely demoted to cache; disjoint item edits never conflict in git; same-item edits conflict at line granularity that humans resolve. Append-only logs rejected (every concurrent session conflicts at end-of-file; compaction wrecks history); CRDTs rejected (heavy dependency whose binary blobs git can't merge — it replaces git merging rather than enabling it); committing SQLite binaries rejected outright; `sqlite3 .dump` text rejected (statement-granularity conflicts don't map to user intent). Stage 1 ships whole-file sync compatibility (single self-contained dir; `.gitignore` for volatile sidecars); Stage 2 proceeds **only** after the user confirms git-merge (vs whole-file sync) is a real need — the tech-lead's gating question in Section 2.
6. **Search UX across projects: grouped by project, per-group rank order.** Honest about bm25 incomparability, cheap, and matches how users think about workspaces. A global-rank mode via a transient in-memory aggregate is explicitly deferred.
7. **Three distinct project-removal verbs.** *Unload* (close store, catalog `loaded=0`), *Forget* (remove catalog row, files untouched), *Delete files* (destructive: require unloaded-first, confirm naming the absolute path, delete DB + sidecars + generated `.gitignore`, then catalog row). The old count-based delete-guard retires with the old model; its spirit survives as the unloaded-first requirement + path-naming confirmation.

## 6. Implementation Steps

Ordered; each is small and independently verifiable (its tests and typecheck pass before moving on). Steps 1–15 are Stage 1. Backend first, IPC surface second, frontend third, migration and docs last.

1. **Add dev/test scaffolding.** Add `tempfile` to `[dev-dependencies]` in `src-tauri/Cargo.toml` (flagged new dep). Extend the `test-support` seam in `db/sqlite.rs` with `set_id_for_test` (mirroring `set_timestamps_for_test`) so id-collision tests can force ids.
2. **Migration `0005_meta.sql`:** create `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`; set `PRAGMA application_id` to the worknotes marker via migration SQL. Single source of truth for the marker is a Rust const (`db::WORKNOTES_APPLICATION_ID: i32`); the SQL literal must equal it, enforced by a test that reads `PRAGMA application_id` from a freshly created store and compares against the const. Verify existing `repo.rs` suite still passes (the migration is additive and inert for current behavior).
3. **Tiebreak change:** in `push_sort` (`db/sqlite.rs:160`), replace `", i.rowid DESC"` with `", i.created_at DESC, i.id ASC"`. Replace `sort_rowid_tiebreak_is_stable` with an equal-timestamp test asserting the new deterministic order (this also retires the known flaky test — see project memory). Update the invariant wording in `CLAUDE.md` in the same commit.
4. **Split connect paths in `db/sqlite.rs`:** `create_at(path)` (errors if file exists; sets WAL, runs migrations, stamps `meta.project_id`/`project_name`/`schema_version`) and `open_existing(path)` (`create_if_missing(false)`; pre-open hardening per Section 4.3: size cap, `application_id` check, `quick_check`, `trusted_schema=OFF`, `sqlite_master` allowlist; then migrations with `VersionMissing`/`VersionMismatch` mapped to clean messages). Keep `connect()` only as a thin legacy-internal helper or remove it once `lib.rs` no longer calls it.
5. **Path validation module `src-tauri/src/projects/paths.rs`:** `validate_project_dir(raw: &str, app_data_dir: &Path) -> Result<PathBuf, AppError>` implementing Section 4.1 (raw-input UNC/device/ADS/`..` rejection, canonicalization, then writability and the not-inside-`app_data_dir` rule with the default-projects-dir exception — the app data dir is a parameter, not derived inside). Deterministic given its inputs; unit tests in the same file or `tests/`.
6. **Catalog (`src-tauri/src/projects/catalog.rs` + `src-tauri/migrations_catalog/0001_catalog.sql`):** `projects(id PK, name UNIQUE, path UNIQUE, loaded, last_opened)` + `app_settings(key, value)`; a second `sqlx::migrate!("./migrations_catalog")` embedded migrator; CRUD with scrubbed unique-violation errors ("A project named X already exists" / "That folder is already a project").
7. **Slim the `ItemRepository` trait (`db/mod.rs`):** remove `list_projects`/`create_project`/`rename_project`/`delete_project`/`get_setting`/`set_setting`; drop the `project_id` filter from `ListFilter` handling in `push_filters` (a whole store is one project — the manager filters by choosing which stores to query). **Delete `ensure_project_exists` and its call sites in `create()`/`update()` (`sqlite.rs:70-79, 194-196, 297`)** — per-store writes always store `project_id = NULL` per Decision 4, and `NewItem.project_id` is consumed by the *manager* for routing, never forwarded into the store. Update `models.rs`: `Item.project_id` is stamped by the manager on every return (which store it came from) and required on `NewItem`; remove it from `UpdateItem` (items do not move between stores in v1); add the `ProjectInfo` DTO (`id`, `name`, `path`, `loaded`, optional `itemCount`) that `list_projects` will return. Mirror all of it in `src/types.ts` (same commit).
8. **`ProjectManager` (`src-tauri/src/projects/mod.rs`):** loaded-set `RwLock<HashMap<...>>`; `create_project(dir, name)` (validate → create dir contents: `project.db` via `create_at`, write `.gitignore` with `project.db*`), `open_project(dir)` (validate → `open_existing` → read `meta.project_id` → reconcile catalog by UUID: new row / moved-path update / duplicate-UUID refusal), `load(id)`, `unload(id)` (close pool, flip catalog flag), `forget(id)` (must be unloaded), `delete_files(id)` (must be unloaded; delete `project.db`, `-wal`, `-shm`, generated `.gitignore`, then catalog row), `repo_for(project_id)`, `list_all(filter)`, `search_all(query, filter)`, `active_tags_union()` — fan-out + k-way merge with the Decision-3 comparator; search returns groups keyed by project.
9. **Backend tests (`src-tauri/tests/project_manager.rs`)** per Section 8's checklist: lifecycle, routing, union, cross-DB ordering (equal timestamps across two stores via the test seam), search grouping + archived exclusion, hardening rejections (non-DB file, foreign application_id, unknown trigger, newer-version DB), path validation, id-collision behavior, WAL persistence across reopen, double-load-same-path guard, unload-vs-in-flight-query race (clean error, no panic), Windows locked-file delete-while-loaded failure.
10. **Legacy migration module (`src-tauri/src/projects/legacy.rs` — app-level, one-time, in Rust):** as specced in Section 5 Architecture: split items into per-project stores, "Personal" store for `project_id IS NULL` items, **copy legacy `app_settings` (JIRA config) into the catalog**, idempotent via the catalog `migrated` marker, item-count-verified before the source is renamed to `.bak`, per-project failure isolation. Built and integration-tested standalone (fixture DB constructed from the real migrations + seeded rows in a temp dir, asserting counts, "Personal" routing, settings arrival in the catalog, and rerun idempotence) **before** anything calls it.
11. **Rewire `lib.rs` + `commands.rs`:** `AppState.repo` → `AppState.manager`; item commands route via manager (`create_item` now requires `projectId`; `get`/`update`/`delete`/`set_*` locate the owning loaded store by item id); JIRA settings commands route to the catalog; add `list_projects` (catalog rows + loaded flags + per-loaded item counts), `create_project`, `open_project`, `load_project`, `unload_project`, `forget_project`, `delete_project_files`. Startup: catalog open → legacy migration (step 10's module, already tested) → load `loaded=1` projects with per-project error isolation (no `.expect()` on any per-project path — collect warnings into a startup payload the frontend can show).
12. **Dialog plugin (flagged new dependency):** add `tauri-plugin-dialog` (Cargo + `@tauri-apps/plugin-dialog` npm + capability entry scoped to open/save dialogs only) for the native folder picker. Command `pick_project_folder` stays thin; validation still happens in `open_project`/`create_project`.
13. **Frontend API + state:** extend `src/lib/api.ts` + `src/types.ts` with the new commands/DTOs (`ProjectInfo { id, name, path, loaded, itemCount? }`). In `App.tsx`: split state into `knownProjects` + derived loaded set; add a monotonic request token to `loadItems` so stale resolutions never commit — implement the token-compare logic as a pure helper in `src/lib/projects.ts` so it is unit-testable, with only the thin wiring in `App.tsx`; `refreshAll` after load/unload; disable New note/New task when nothing is loaded, with a distinct "No projects loaded — open or create one to start." empty state; unload confirmation when the open editor item or a dirty draft belongs to the target project, with a `role="status"` announcement on eviction.
14. **Frontend surfaces:** rework `ManageProjectsDialog.tsx` into the project manager (rows: name, muted path, loaded toggle, overflow of Forget/Delete-files with the three-verb distinction and path-naming confirm; "Open project…"/"Create project…" via the picker; focus restored to trigger after native dialogs; two empty states — none known vs none loaded). `ItemList.tsx`: muted project label on rows when >1 project loaded; project filter select now lists loaded projects only. `Editor.tsx`: project select = loaded projects, required for new drafts when the rail filter is "All". Pure helpers (`src/lib/projects.ts`: tag-union, loaded-set reducers, request-token compare, merge keying by `${projectId}:${id}`) with Vitest tests beside them. Styling via existing tokens only.
15. **Docs in the same PR:** update `CLAUDE.md` (project concept, tag invariant wording "≥1 non-archived, not-done item in a *currently loaded* project", tiebreak invariant, remove the stale "and once added: project" parenthetical from the `updatedAt` content-edit list — project reassignment is out of scope in v1, new architecture bullet for `ProjectManager`/catalog); add a DESIGN.md section for the project manager surface (three verbs, empty states, project labels); mark the plan's Section 10 decisions as resolved; note the superseded Postgres-sync backlog line in `IMPLEMENTATION_PLAN.md`.

**Stage 2 (gated — user confirmed git-merge is required; IMPLEMENTED — see Section 12 "Stage 2"):**

16. Canonical serializer/deserializer for item files (`<uuid>.md`, YAML frontmatter with stable key order/LF/fixed-precision timestamps; body = raw text). Round-trip + idempotent-export + kind-gating-on-import tests first.
17. Write path becomes file-then-index (write `.md`, upsert index row); load becomes scan-then-rebuild (`INSERT INTO items_fts(items_fts) VALUES('rebuild')`); `project.db` renamed `index.db`, added to the generated `.gitignore`; manual "Reload project" action for post-`git pull` staleness (file watcher explicitly deferred).
18. Merge-shaped fixture tests (disjoint adds, same-item-different-fields auto-merge, conflict-marker rejection with per-file partial-success reporting).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/migrations/0005_meta.sql` | Create | `meta` table + `application_id` stamp (additive; applies to all item DBs) |
| `src-tauri/migrations_catalog/0001_catalog.sql` | Create | Catalog schema: known projects + relocated `app_settings` |
| `src-tauri/src/projects/mod.rs` | Create | `ProjectManager`: loaded set, lifecycle, routing, fan-out + k-way merge |
| `src-tauri/src/projects/catalog.rs` | Create | Catalog store over `catalog.db` (second embedded migrator) |
| `src-tauri/src/projects/paths.rs` | Create | Server-side path validation (Section 4.1) + unit tests |
| `src-tauri/src/projects/legacy.rs` | Create | One-time legacy `notes.db` split + settings relocation (step 10) |
| `src-tauri/tests/project_manager.rs` | Create | Multi-store lifecycle/routing/union/ordering/hardening integration tests |
| `src/lib/projects.ts` + `src/lib/projects.test.ts` | Create | Pure helpers: tag union, loaded-set reducers, composite merge keys |
| `src-tauri/src/db/sqlite.rs` | Modify | `create_at`/`open_existing` split + hardening; tiebreak change; `set_id_for_test` seam; retire in-DB project CRUD/settings |
| `src-tauri/src/db/mod.rs` | Modify | Slim `ItemRepository` to item-scoped ops |
| `src-tauri/src/models.rs` | Modify | `NewItem.project_id` required; drop from `UpdateItem`; `ProjectInfo` DTO |
| `src-tauri/src/error.rs` | Modify | Clean variants/messages for open/validate/version failures (no raw paths/SQLite text) |
| `src-tauri/src/commands.rs` | Modify | `AppState.manager`; project lifecycle commands; item commands route via manager; settings → catalog |
| `src-tauri/src/lib.rs` | Modify | Catalog + manager wiring; legacy migration hook; per-project startup error isolation (no `.expect()`) |
| `src-tauri/Cargo.toml` | Modify | + `tauri-plugin-dialog`, + `tempfile` (dev) — both flagged |
| `src-tauri/capabilities/default.json` | Modify | + dialog permissions (minimal scope) |
| `package.json` | Modify | + `@tauri-apps/plugin-dialog` |
| `src/lib/api.ts`, `src/types.ts` | Modify | New commands + DTO mirrors (change both or neither) |
| `src/App.tsx` | Modify | State split; request-token guard; unload confirm/announce; empty states; create-target rule |
| `src/components/ManageProjectsDialog.tsx` | Modify | Project manager surface: three verbs, picker flows, dual empty states |
| `src/components/ItemList.tsx` | Modify | Project labels on rows; loaded-projects filter |
| `src/components/Editor.tsx` | Modify | Loaded-projects select; required target on new drafts |
| `src/styles.css` | Modify | Manager-surface styles from existing tokens only |
| `CLAUDE.md`, `docs/DESIGN.md`, `docs/IMPLEMENTATION_PLAN.md` | Modify | Re-specced invariants, new UI spec section, superseded backlog note |
| *(Stage 2)* `src-tauri/src/store/itemfile.rs`, `tests/export_import.rs` | Create | Canonical item-file serde + index rebuild + merge-fixture tests |

## 8. Test Strategy

*(Source: test-writer agent. Conventions: real SQLite always — `connect_in_memory()` for logic, `tempfile` temp dirs for filesystem behavior; never mock the engine, the trait, or the merge logic; `#[tokio::test]`, snake_case names, `AppError` + message-substring assertions; frontend tests are node-env Vitest pure-logic beside `src/lib/*.ts` — no component tests, no new test frameworks. Existing in-DB project-CRUD tests in `repo.rs` are removed in the same commit that retires the model — dead-but-passing tests for a retired concept are a defect.)*

- [ ] **Unit Tests (Rust — creation/opening):**
  - [ ] Create at fresh dir → fully-migrated, independently usable store; two projects at two paths are fully independent
  - [ ] Create where a DB already exists → clean error, never truncates; open-nonexistent → clean error (create/open are not reachable from each other's paths)
  - [ ] Open a hand-built `0001`-only schema file → upgrades through migrations cleanly; reopen after unclean pool drop (WAL) loses no committed writes
  - [ ] Foreign `application_id`, non-DB garbage file, DB with an unknown trigger, oversized file → each rejected with a clean scrubbed message (no raw SQLite text, no full path)
  - [ ] Newer-version DB (extra `_sqlx_migrations` row) → "created by a newer version" error; does not abort other loads
  - [ ] Path validation: UNC, device path, ADS component, raw `..` segment, nonexistent parent, path-is-a-file, read-only dir (flake risk if the test runner has elevated privileges — note it in the test), inside-app-data rejection
- [ ] **Integration Tests (Rust — manager):**
  - [ ] Load/unload lifecycle: membership exact; unload closes the pool (file deletable on Windows afterward) and never touches data; a query racing an unload resolves or errors cleanly (start a query, close the pool, assert clean error — no panic); double-load same path rejected; unload-not-loaded → clean NotFound; duplicate-UUID second path refused; moved-file path reconciliation
  - [ ] Routing: create lands only in the target store; get/update/delete route by id across loaded stores; id in no loaded store → NotFound (no auto-load); create with no target / not-loaded target → clean rejection; forced id collision across two stores (test seam): merged list keeps both, project-qualified retrieval unambiguous
  - [ ] Tag union: disjoint → sorted dedup; same tag in both → once; **last carrier archived/done in A while B still carries it → survives** (headline spec scenario); last carrier anywhere gone → drops; unload drops B-exclusive tags, reload restores; zero loaded → empty, not error
  - [ ] Search: hits from both stores, attributed and grouped by project; archived exclusion holds cross-store; status/tag filters AND-combine post-merge; FTS-hostile input sanitized identically per store; unloaded project's hits gone on next call; zero loaded → empty
  - [ ] Ordering: `pinned DESC` global; equal timestamps across two stores → stable deterministic `(created_at, id)` order over repeated calls; sort modes interleave globally (not per-project concatenation)
  - [ ] Per-store invariant regression subset run against a *secondary* loaded store (timestamp-bump rules, archive exclusion, tag lifecycle) — catches "wired only to the primary DB" bugs
  - [ ] Legacy migration: fixture single-DB → split verified by counts; NULL-project items land in "Personal"; legacy `app_settings` (JIRA config) readable from the catalog afterward; idempotent on rerun; source preserved as `.bak`
  - [ ] Delete-files: refused while loaded (Windows lock); removes DB + `-wal`/`-shm` + generated `.gitignore`; forget leaves files intact and reloadable
- [ ] **Frontend (Vitest, pure logic in `src/lib/projects.ts`):**
  - [ ] Tag union: dedupe/sort/empty/zero-project; drop-and-reappear across unload/reload (mirrors `tags.test.ts` style)
  - [ ] Loaded-set reducers: add-dedup, no-op double-load, remove-not-loaded
  - [ ] Merged-list keying: same-id-different-project pair not collapsed (composite `${projectId}:${id}` asserted)
  - [ ] Request-token helper (required extraction per step 13): stale token's result not committed; newer token wins regardless of resolution order
- [ ] **Edge Cases & Error Scenarios:** covered inline above (invalid paths, hostile files, version skew, locks, collisions, zero-loaded states)
- [ ] **E2E / manual smoke (`npm run tauri dev`):** create A + B in Explorer-visible folders; load both; disjoint + shared tags show correct union; archive last carrier in A with B still carrying → tag survives; unload B → items/tags/search results vanish immediately, reload restores; search matching both shows grouped attribution; relaunch restores the loaded set (or clean empty state); unwritable location and renamed-`.txt` file → clean toasts, no raw SQLite text; unload with open dirty editor item → confirmation; last project unloaded → sane empty state, New buttons disabled; legacy DB migrates once with counts intact
- [ ] **(Stage 2 only):** byte-identical idempotent export; round-trip equality incl. kind-gating on import; id + filename stability; conflict-marker rejection with per-file partial success; two-branch disjoint-add and same-item-different-field git-merge fixtures import correctly; no keyring material in any exported file

## 9. Success Criteria

- [ ] **Functional:** a project can be created at / opened from a user-chosen folder, loaded, and unloaded at will; items CRUD routes to the owning project store; list/search show only loaded projects' non-archived items with stable cross-project ordering; the tag vocabulary is the live union across loaded projects (same name appears once; survives while any loaded carrier lives); the three removal verbs behave per Decision 7; existing single-DB data migrates once, count-verified, with the original preserved as backup; startup with a missing/corrupt/newer project file degrades to a per-project warning, never a crash
- [ ] **Tests:** all tests from Section 8 pass (`cd notes-app/src-tauri && cargo test`, `npx tsc --noEmit`, `npm run build` clean); removed-model tests deleted in the same commit
- [ ] **Security:** all Section 4 mitigations implemented — path rejection, foreign-DB rejection, error scrubbing, and settings isolation negatively tested; the dialog capability's minimal scope verified by manual review (Section 11), as capability JSON isn't exercisable by the test conventions
- [ ] **Quality:** invariants re-specced in CLAUDE.md/DESIGN.md in the same PR; no raw `invoke()` outside `api.ts`; `types.ts` ↔ `models.rs` mirrored; styling from existing tokens only

## 10. Risks & Open Questions

- **Adversarial-verifier verdicts:** all 10 load-bearing research claims (connect-path behavior, rowid/FTS coupling, single-repo wiring, raw error serialization, absent dialog/fs plugins, Postgres backlog line, pool size, uuid v4-only, missing frontend request guard, Vitest/tempfile status) were **CONFIRMED** against source. One caveat: the Postgres sync line is *agreed backlog, not scheduled* — this plan supersedes it as the sync direction, which the user implicitly accepts by approving this plan.
- **USER DECISION — Stage 2 gate (RESOLVED — user confirmed git-based merging is required; implemented):** the open question "is git-based *merging* (vs whole-file sync via OneDrive/Syncthing) a real requirement?" was answered **yes** in the implementing session. **Stage 2 (steps 16–18) is now implemented:** the canonical store is one Markdown-with-frontmatter file per item (`items/<uuid>.md`), the SQLite DB is a git-ignored rebuildable `index.db`, writes are file-then-index, load is scan-then-rebuild, a Stage-1 `project.db` is upgraded in place (count-verified, `.bak` kept) on first load, and a manual Reload action re-reads files after a `git pull`. Frontmatter is a hand-rolled byte-deterministic format (no YAML dependency — flagged and chosen over adding one). See the Stage 2 subsection of Section 12.
- **USER SIGN-OFF — two semantic flips (RESOLVED — approved by plan acceptance, both implemented in Stage 1):** (1) list tiebreak is now creation-time-then-id (`created_at DESC, id ASC`), reflected in the CLAUDE.md invariant and the Rust merge comparator; (2) "delete a project" is the three-verb destructive model (Unload / Forget / Delete files) with unloaded-first + path-naming confirm.
- **Default project-directory location (RESOLVED):** migrated legacy projects land in `app_data_dir/projects/<name>/`; users relocate later via Forget + Open. Alternative (prompting during migration) rejected as a worse first-run experience.
- **`updated_at` clock skew across machines** can misorder recency sort after sync — accepted limitation, documented, no logical clocks.
- **Windows file locks:** delete/move of a loaded project's files will fail until the pool closes; enforced by unloaded-first rules and covered by tests, but third-party lockers (AV, indexers) can still surface transient errors — surface them cleanly.
- **Search grouping is a UX change** (grouped by project instead of one ranked list) — justified by bm25 incomparability; revisit with a transient aggregate index only if users push back.
- **This machine's near-full C: drive** breaks cargo linking (LNK1318, see project memory) — the execution prompt carries the workaround; CI-quality verification may need disk cleanup first.
- **Item moves between projects are out of scope for v1** (`UpdateItem` loses `project_id`); a future "move item" is a copy-delete across stores with id preservation — noted, not designed.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` is on; retired project-CRUD paths fully removed, not orphaned)
- [ ] Error handling covers failure modes (per-project isolation at startup and load; no `.expect()`/`.unwrap()` on any user-path or foreign-file operation)
- [ ] No security vulnerabilities (injection, XSS, credential exposure) — no raw paths or SQLite text over IPC; no key material near project dirs
- [ ] Security considerations from Section 4 addressed (path validation, create/open split, foreign-DB checks, settings isolation, minimal capabilities)
- [ ] Code follows existing project conventions (api.ts-only IPC, serde camelCase mirrors, runtime sqlx only, additive migrations, tokens-only styling)
- [ ] Tests cover happy path, edge cases, and error scenarios (Section 8 checklist fully represented; removed-model tests deleted)
- [ ] No performance regressions (fan-out queries bounded by loaded-set size; no N+1 per item; merge is O(total items) per call)
- [ ] Changes are minimal — no unrelated refactoring bundled in

## 12. Post-Review Improvements

Improvements made in response to the in-flight review agents (database-architect, backend + frontend code-reviewers, frontend-specialist), all implemented in this body of work.

### Database-architect (migration 0005 / catalog / legacy)
- **[Critical] `application_id` literal fixed.** `0005_meta.sql` stamped `1464685652` (`0x574D5454`) while the Rust const `WORKNOTES_APPLICATION_ID` is `0x574B_4E54` = `1464553044`; every created store would have been rejected as foreign on reopen. Corrected the SQL literal to `1464553044`; the step-2 equality test (`application_id_matches_const`) now guards it.
- **[High] Legacy migration made catalog-atomic.** Replaced per-group incremental `catalog.insert` with a single `Catalog::commit_migration` transaction (all project rows + relocated settings + the done-marker commit together, or none do), so a crash/clash mid-migration can never leave a partial catalog that collides with the next attempt.
- **[High] Orphaned `project_id` items no longer dropped.** Items whose legacy `project_id` matches no surviving project row now route to "Personal" alongside NULL-project items, so `copied == source_total` always reconciles for intact source data (no permanent rollback loop).
- **[Medium] Legacy read/insert errors scrubbed** to `AppError::Invalid` (Section 4.6), and **`create_at`'s meta stamp wrapped in a transaction** so a crash mid-stamp can't leave a half-identified store.

### Backend code-reviewer
- **[Critical] Wrote the missing `tests/project_manager.rs`** (the step-9 deliverable): lifecycle, routing, tag-union (incl. the headline cross-project survival scenario), search grouping/filters, global-interleave ordering, secondary-store invariant regression, and `create_at`/`open_existing` hardening rejections (garbage/foreign/unknown-trigger/newer-version), plus WAL persistence and copy/move reconciliation.
- **[Warning] Cross-store id-collision routing hardened.** `owner`/`get` now probe every loaded store and refuse a duplicate id with a distinguishable error instead of silently routing a write to whichever store enumerated first.
- **[Warning] Removed the now-dead `SqliteRepository::connect()`** (step 4's "remove once `lib.rs` no longer calls it").
- **[Warning] `create` into a not-loaded project** now returns `Invalid("that project isn't loaded")` instead of the misleading generic `NotFound`.
- **[Warning] Scrubbed raw sqlx text** from `create_at`'s meta transaction and `read_meta`/`meta_value`.
- **[Warning] `count_active` (a `COUNT(*)`) replaces materializing every row** for the project item-count chip in `list_projects`/`project_info`.

### Frontend code-reviewer + frontend-specialist
- **[Critical] A newly-created item no longer vanishes** when its project differs from the rail's project filter — `createFromDraft` relaxes `projectFilter` the same way it already relaxed the kind filter.
- **[Warning] `projectFilter` is pruned** (mirroring the tag-filter prune) when its project leaves the loaded set, so the rail select never strands on a missing/closed project.
- **[Warning] The draft's live target project is lifted to App** (`onTargetChange`), so the unload-eviction confirm reflects the picker's current choice, not just the value seeded at draft creation.
- **[Warning] Focus restoration after the native picker** is deferred to the next frame (`requestAnimationFrame`) so it isn't a no-op on the still-disabled trigger button.
- **[Warning] Unload routed through the dialog's `busy` guard** (blocks re-entrant Load/Unload on the same row).
- **[Warning] Unload vs Forget made visually distinct** (Forget is quiet + dashed; danger red stays reserved for Delete files).
- **[Copy] Item-count chip pluralized** ("1 ITEM" / "N ITEMS"); **DESIGN.md reference-sample** updated off the retired Remove-guard model; **dead `.project-count` CSS removed**; project rows use semantic `<ul>/<li>`.

### Security-auditor (Section 4 mitigations)
Verdict: **all seven Section 4 items PRESENT**; only Low/informational gaps. Fixed:
- **[GAP-2, test-coverage] Added the two negative tests the plan names** but that were absent: (a) settings isolation — a rogue `app_settings` row seeded into a loaded project store is never surfaced (`get_setting` reads the catalog only); (b) unload-vs-in-flight-query race — a query on a closed pool returns a clean `Err`, never a panic.

Accepted (documented, not changed):
- **[GAP-1, Low] Runtime item-query failures on a loaded store** surface `AppError::Db` (raw SQLite text, but NO filesystem path). Outside Section 4.6's explicit open/create/migrate/meta scope, and only reachable via a valid-but-corrupt foreign DB already loaded whose corruption evades `quick_check`. Accepted rather than blanket-scrubbing every item query (which would degrade diagnostics for legitimate errors); can be revisited if it matters.
- **[GAP-3, Info] `load`/`startup_load` open the catalog-stored path without re-running `validate_project_dir`.** Safe within the stated threat model (the catalog is only written by the already-validating `create_project`/`open_project`; a malicious path could enter only via out-of-band `catalog.db` tampering, a higher privilege than the modeled webview attacker), and `open_existing`'s foreign-DB hardening still applies. Not re-validated to avoid a per-startup writability-probe side effect on every project dir.

### Deliberate scope decisions (not changed)
- **Search result shape:** `search_all` returns a flat `Vec<Item>` with per-project contiguous blocks (ordered by project name, each block in its own FTS-rank order) rather than a nested grouped DTO — the flat shape keeps the frontend's `items: Item[]` contract and, with the row project label, delivers Decision 6's "grouped by project, per-group rank" honestly. A nested grouped DTO / global-rank mode remains deferred.
- **Catalog raw errors** (`Catalog::list`/`get`/etc.) are left as `AppError::Db`: the catalog is app-internal at a fixed `app_data_dir` path, so its errors carry no user-supplied path — outside Section 4.6's user-path scope.
- **List selection keys by bare `id`, not the composite `${projectId}:${id}`:** a wrong-item resolution needs two loaded stores sharing an id, which real UUIDs never produce and the duplicate-UUID load guard refuses — accepted as a can't-happen edge; the merged list itself correctly keeps both (composite-key tested).
- **Dialog open/close focus-trap** (Escape/focus-return) is NOT added to `ManageProjectsDialog`: it's a pre-existing gap shared with `SettingsDialog`, out of this feature's scope.
- **Root `CLAUDE.md`** (repo-root, distinct from `notes-app/CLAUDE.md`) is a pre-existing broadly-stale duplicate; the authoritative `notes-app/CLAUDE.md` is fully updated, and the root divergence is flagged for the user to consolidate rather than partially edited.

### Stage 2 (steps 16–18) — implemented after user confirmation that git-merge is required

- **Frontmatter representation (flagged dependency decision):** hand-rolled canonical serializer/parser in `src-tauri/src/store/itemfile.rs` — **no new dependency**. Chosen over adding a YAML crate because it (a) guarantees byte-deterministic output for idempotent export, (b) has no YAML alias/anchor/deep-nesting DoS surface, and (c) is a fixed, panic-free field reader with a per-file size cap. Output is still ordinary YAML frontmatter other tools can read.
- **Storage shape:** canonical `items/<uuid>.md` (one file per item) + git-ignored rebuildable `index.db` (the former `project.db`). Writes are **file-then-index** (`db/sqlite.rs`: the store gained an `items_dir` seam; `create`/`update`/`delete` write/remove the `.md` before touching the index row). Load is **scan-then-rebuild** (`rebuild_from_dir`: transactional `DELETE` + re-insert from `itemfile::scan` + FTS `'rebuild'`, duplicate ids reported not collided). Reads still serve from the index unchanged.
- **Stage-1 → Stage-2 in-place upgrade (NOT spelled out in steps 16–18, added for data safety):** the plan's step 17 said "`project.db` renamed `index.db`", but a bare rename plus scan-then-rebuild would erase a store that has DB rows and no item files yet. `migrate_db_to_files` exports every row into a **sibling `items.tmp/` staging dir**, verifies every file round-trips (read+parse), and only then **publishes `items/` via a single atomic rename** — so `items/` appears ONLY when the conversion is complete; an interrupted conversion (crash / disk-full mid-export) leaves `items/` absent and the source `project.db` untouched, and the next load retries cleanly. Then it keeps `project.db` → `project.db.pre-stage2.bak` (never deleted). This is the same count-verified discipline as the `notes.db` legacy migration, and protects the user's four real on-disk Stage-1 projects, which hit this path on the first launch of the new binary. `open_store` triggers it only when `items/` is absent, so it is idempotent and never rebuilds from an empty directory. **(This atomic-staging design replaced an earlier version that created `items/` before the export finished — an adversarial-verifier pass found that a partial export would flip the layout detector and silently strand the unexported rows on the next launch; the staging rename closes that hole.)**
- **Reload action (step 17):** `reload_project` command → `ProjectManager::reload` (close + re-open from files), returning per-file import warnings (conflict-marker/malformed files) surfaced by a quiet **Reload** button in the project manager for post-`git pull` staleness. Reload is routed through `App` (like Unload): when it would stale an *existing* open item it confirms, then evicts it (with a `role="status"` notice) so a subsequent Save can't clobber a pulled change; a new unsaved draft is left alone. File watcher deferred as specced.
- **Git-portable identity `project.json` (added in response to a code-reviewer Critical):** because `index.db` is git-ignored, a clone would carry NO identity if it lived only in the DB meta — every clone would mint a fresh UUID, and two clones on one machine would collide every item id (breaking `owner()` and double-listing items). A tiny git-tracked `project.json` (`{id, name}`) carries the identity, so a clone keeps it and the existing copy/duplicate-load guards fire. Identity resolution when minting a fresh index: `project.json` → the just-converted store's own identity → the known catalog UUID → a fresh UUID; the resolved identity is then written back to `project.json` (write-if-absent, stable in v1). `rebuild_from_dir` preserves the index's `meta` (rebuilds only `items` + FTS), so a reload keeps identity too.
- **Tests:** `store::itemfile` unit tests (round-trip, byte-identical idempotent export, kind-gating, conflict markers incl. lone-opener-is-not-a-conflict, unsafe-id rejection, no-secrets); `tests/export_import.rs` (disjoint-add + clean-3-way-merge import, per-file conflict partial success, id/filename stability); `tests/project_manager.rs` extended (Stage-2 layout, in-place upgrade preserving items + writing `project.json`, git-clone-builds-index, clone-of-known-project-refused, cross-store id-collision refusal, reload add/remove, reload conflict warnings) and its Stage-1 tests migrated to the `index.db`/`items/` layout. Full suite: **171 Rust + 75 vitest passing, tsc + build clean, 0 warnings.**
- **Security (Section 4.7):** filenames derived only from the UUID id (traversal/reserved-name/ADS rejected via `is_uuid`), restricted panic-free parser with a size cap, conflict-marker rejection with per-file partial success; a security-auditor pass confirmed all 4.7 items PRESENT with only Low/Info residuals — the scan-time size-check TOCTOU is now hardened to a bounded read (`read_capped`); own-file content in diagnostic warnings (text nodes, no path/secret) and `AppError::Db` on genuine engine faults (no path, within accepted GAP-1 scope) remain accepted.

**Stage 2 review findings — applied:**
- **[Critical, adversarial-verifier] Interrupted-conversion data loss** — the export created `items/` before finishing, so a partial export was mistaken for a finished Stage-2 store on the next launch and stranded the unexported rows. Fixed with sibling-`items.tmp/` staging + atomic publish (above). This was a live risk on the near-full disk.
- **[Critical, code-reviewer] Clone-mints-colliding-identity** — a git clone (no `index.db`) minted a fresh UUID, so two clones on one machine collided item ids. Fixed with the git-portable `project.json` identity (above); a new test refuses a clone of an already-known project.
- **[Warning, code-reviewer] Reload could clobber an open item** — routed Reload through `App` with confirm + eviction for an open existing item (above).
- **[Low] Conflict-marker false positives** — a lone `<<<<<<<`/`>>>>>>>` body line no longer trips detection (both an opener AND a closer are required), so one such line can't block a whole project; TOCTOU bounded read; write_item fsync caveat documented; `create_dir_all` error idiom cleaned up.
- **[Smoke test] `window.confirm` is suppressed by the Tauri v2 webview**, so every confirm (Delete item, Unload/Reload eviction, Delete files — including the pre-existing Stage-1 ones, never GUI-tested) silently no-op'd. Replaced with the dialog plugin's async `ask()` via a new `api.confirmDialog()` (plugin IPC kept in `api.ts`), plus the `dialog:allow-ask` capability. Verified in the GUI: all four prompts now render; the full Stage-2 E2E smoke pass (upgrade of the four real projects, file-then-index writes, Reload add/remove/conflict, delete verbs) passed.

**Stage 2 accepted trade-offs (documented, not changed):**
- **File-then-index write, second-step failure:** if the canonical file write succeeds but the index write then fails (only reachable while the pool is closing/closed — e.g. a write racing an unload), the call returns an error while the file change persisted. This is not data loss: the file is the source of truth, so the change is correct and self-heals into the index on the next load; the error message is merely pessimistic in that narrow window. Rolling back the file would add complexity for a teardown-only race.
- **Blocking `std::fs` in async paths:** item writes and the load-time `rebuild_from_dir` scan use synchronous `std::fs` on the async runtime rather than `spawn_blocking`. Acceptable at single-user desktop scale with the 4 MB/file cap; flagged for revisit only if a project grows large enough for the scan to contend with concurrent commands.
- **Notes over ~4 MB or containing a full git-conflict triad in the body:** on load these are skipped from the index with a per-file warning (the `.md` file is preserved on disk, never deleted); the 4 MB cap is an untrusted-clone DoS guard and such notes are pathological for a work-notes app.

## 13. Execution Prompt

```
Implement the plan at notes-app/plans/plan.6.md ("Projects as Loadable On-Disk Databases").

Read that plan file in full first — it is the authoritative spec for this work. Also read
notes-app/CLAUDE.md (conventions and invariants; the plan re-specs two of them deliberately).

Scope: implement Stage 1 only — Implementation Steps 1 through 15 in Section 6, in order.
Do NOT implement Stage 2 (steps 16–18, the git-mergeable file-per-item store) unless I have
explicitly confirmed in this session that git-based merging is required; if that confirmation
is absent, stop after step 15 and ask.

Two pre-flagged decisions are approved by my acceptance of this plan: the list tiebreak moves
to (created_at DESC, id ASC), and project deletion becomes the three-verb model (Unload /
Forget / Delete files). Two new dependencies are approved: tauri-plugin-dialog (+ its npm
package and a minimally-scoped capability entry) and tempfile (dev-only). Flag any OTHER
dependency before adding it.

Work step by step:
- Complete each numbered step in Section 6 and verify it (its tests + `npx tsc --noEmit`)
  before starting the next. Keep commits/edits minimal per step; no unrelated refactoring.
- Enforce every Section 4 security requirement as you go (Rust-side path validation,
  create/open split, foreign-DB hardening, error scrubbing, settings isolation) — these are
  requirements, not suggestions.
- Keep src/types.ts and src-tauri/src/models.rs mirrored in the same edit, and route all IPC
  through src/lib/api.ts.
- Update CLAUDE.md / docs/DESIGN.md / docs/IMPLEMENTATION_PLAN.md as specified in step 15,
  in the same body of work.

Use subagents during implementation (if a named agent type is unavailable, fall back to a
generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise —
with the role stated in the prompt):
- After the backend steps (1–12) and again after the frontend steps (13–14), spawn a
  code-reviewer agent (read-only: Read, Grep, Glob) to review the diff against the plan's
  Section 5 design and Section 11 checklist; fix what it finds before proceeding.
- Spawn a test-writer agent to implement the Section 8 test strategy alongside the code
  (backend tests with steps 3–10, frontend pure-logic tests with steps 13–14); every new
  invariant lands with its test in the same commit.
- After step 15, spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify every
  Section 4 mitigation is present and negatively tested where testable; fix gaps it finds.
- Spawn conditional domain agents only where the work touches their domain: a
  database-architect to review migration 0005, the catalog schema, and the legacy-split
  module (step 10) before step 11 wires it into startup; a frontend-specialist to review the
  ManageProjectsDialog rework and the unload/eviction UX in step 14. Skip api-designer,
  devops-engineer, and performance-optimizer unless something unexpected pulls them in.

After implementation:
- Run the full Section 11 code review checklist and resolve every unchecked item.
- Document any improvements made in response to review in Section 12 of the plan file, and
  implement them.
- Run the existing verification suite and fix regressions before finishing:
    cd notes-app/src-tauri && cargo test
    cd notes-app && npx tsc --noEmit
    cd notes-app && npm run build
  Machine note: this PC's C: drive is near-full and cargo linking can fail with LNK1318 —
  if that happens, clean src-tauri/target and build with debuginfo disabled (see the project
  memory note "cargo test disk-full workaround"), then re-run.
- Finish with a manual smoke pass per Section 8's E2E list in `npm run tauri dev`, and report
  which smoke items you verified and which remain for me.

Report failures plainly — failing tests, skipped steps, and unverified assumptions are
results, not things to smooth over. Do not commit or push unless I explicitly ask.
```
