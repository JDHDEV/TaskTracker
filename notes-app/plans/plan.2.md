# Plan 2: Phase 2 — IPC Surface (Project/Tag Commands, Search Filter Wiring, api.ts Mirror)

**Created:** 2026-07-14
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Phase 2 of `docs/IMPLEMENTATION_PLAN.md` exposes the Phase-1 repository methods over the Tauri IPC boundary and mirrors them in the frontend's typed `api.ts` wrapper. It is a thin plumbing phase: no schema changes, no new dependencies, and (with one exception below) no new business logic — every new command is a one-line delegate to `Arc<dyn ItemRepository>`, exactly like the nine existing commands.

Concretely, Phase 2 delivers:
- Five new thin Tauri commands: `list_projects`, `create_project`, `rename_project`, `delete_project`, `list_active_tags`.
- Wiring a real `Option<ListFilter>` into the existing `search_items` command (which currently hardcodes `ListFilter::default()` with a Phase-1 TODO comment).
- Registration of the five new commands in `lib.rs`'s `generate_handler!`.
- Matching typed wrappers in `src/lib/api.ts` for all six (five new + updated `searchItems`).
- **One security addition folded in by user decision (see §10 Q1):** an `http(s)` scheme allowlist for `jira_url`, enforced at the repository write path (`create`/`update`) with a repo test — closing a window before Phase 3's opener sink ships.

**What Phase 2 does NOT touch (verified, not edited):** `list_items`, `create_item`, `update_item` (Rust and JS), and `src/types.ts`. Phase 1 already landed every DTO type and the whole-struct pass-through means the new `projectId`/`jiraUrl`/filter fields flow through those three commands with zero code change. This must be confirmed by inspection, not "extended."

## 2. Strategic Assessment

*(tech-lead agent — verdict: proceed)*

Phase 2 is correctly scoped as the next unit: repo (done) → IPC (this) → UI (next). Building the typed seam before the UI means Phase 3 codes against real functions, not stubs. Key points that shaped this plan:

- **The plan prose is slightly stale.** Phase 2's text says "Mirror everything in `src/lib/api.ts` and `src/types.ts`," but `src/types.ts` already carries `Project`, `ProjectWithCount`, `Sort`, and the new `NewItem`/`UpdateItem`/`ListFilter` fields (landed in Phase 1). The `types.ts` half of Phase 2 is **verify-only, not write**. Real work reduces to: 5 command functions + `generate_handler!` registration + `api.ts` wrappers.
- **`search_items` filter wiring is the one piece of real logic — and the plan prose omits it.** The Phase 2 paragraph names `list_items` but never mentions search. Yet `commands.rs:51-54` explicitly defers it ("wiring a real ListFilter through IPC is Phase 2"). If this is skipped, filters silently stop applying the moment the user types in the search box — a subtle correctness bug Phase 3 would inherit. This is the riskiest change because it is the only non-passthrough one and it's the easiest to overlook.
- **The IPC boundary is stringly-typed — argument names are the failure mode.** Tauri matches the `invoke` payload keys to command parameter names by exact string. Neither `tsc` nor `cargo` catches a mismatch; it fails at runtime with "command not found" / missing-argument. Existing commands hide this risk by passing whole DTOs (`input`, `patch`); the new scalar-arg commands (`create_project(name)`, `rename_project(id, name)`, `delete_project(id)`) are exactly where it bites. Every new wrapper's arg key must be spelled identically on both sides.
- **`create_project` returns `Project` while `list_projects` returns `ProjectWithCount`.** Decided (§5 D5): the frontend synthesizes `itemCount: 0` for a freshly created project or refetches; no contract change needed.

## 3. Research Findings

*(architect + api-designer agents; grounded against the actual Phase-1 code)*

### The thin-command pattern (`commands.rs`)
Every repo-backed command is `#[tauri::command] pub async fn`, takes `state: State<'_, AppState>` first, then bare typed params, and returns `crate::error::Result<T>` (alias for `Result<T, AppError>`; `AppError` serializes to its display string). The body is a single delegating `state.repo.<method>(...).await`. Two arg-shape idioms coexist and are both legitimate:
- **Bare params** for one or two scalars: `get_item(id: String)`, `update_item(id, patch)`, `set_api_key(provider, key)`.
- **A `#[derive(Deserialize)] #[serde(rename_all = "camelCase")]` DTO struct** only when a command owns a multi-field request object: `RewriteRequest` (`commands.rs:56-62`).

Trait methods take `name: &str`/`id: &str`; the commands own `String` params and pass `&name`/`&id` (mirror `get_item`/`update_item`, which own `id: String` and call with `&id`).

### Registration (`lib.rs`)
`tauri::generate_handler![...]` (`lib.rs:33-43`) is an explicit comma-terminated list of `commands::<name>`. A command not listed there is not callable — `invoke` fails at runtime, not compile time. There is no auto-discovery; every new command needs its own line. `search_items` is already registered — its signature change needs no registration edit.

### The `api.ts` wrapper pattern
Each capability is one exported function calling `invoke("<registered_snake_case_name>", { <args> })`. The registered command name is used verbatim (`"list_items"`, `"search_items"`). The keys of the args object **must exactly match the Rust parameter names** (minus `state`). Types come from `../types`; the import block (`api.ts:2-9`) is a sorted named-import list. The file-level comment encodes the CLAUDE.md invariant: components call only through `api.ts`, never `invoke()` directly (grep confirmed every `invoke` is confined to `src/lib/api.ts`).

### camelCase trap — a non-issue for Phase 2 (confirmed)
Tauri v2 converts snake_case *parameter* names to camelCase on the JS side. But every top-level arg name in this codebase (existing and proposed) is a single lowercase word — `filter`, `name`, `id`, `query` — so the conversion is a no-op and there is no argument-level trap. The camelCase concern lives only *inside* DTO structs, already handled by their serde attributes. (Latent gap worth a note, not action: a future multi-word param like `project_id` would require the JS key `projectId`.)

### What already works, unchanged (verified by inspection — do NOT edit)
- `list_items` (`commands.rs:19-24`) already takes `filter: Option<ListFilter>` and does `.unwrap_or_default()`; `ListFilter` already has `project_id`/`status`/`tags`/`sort`. The new filter fields flow through untouched. `listItems(filter?)` (`api.ts:14-16`) passes the whole object — no change.
- `create_item` takes `input: NewItem` whole; `update_item` takes `patch: UpdateItem` whole. Both DTOs already carry `projectId`/`jiraUrl`. No change to either command or wrapper. The plan line "Extended: `create_item`/`update_item` (projectId, jiraUrl)" is **already satisfied** by the whole-DTO pass-through.
- `src/types.ts` already mirrors every model Phase 2 touches. Verify-only.

### Existing `searchItems` caller
`notes-app/src/App.tsx:28` calls `await api.searchItems(search)` (single positional arg). Adding a trailing optional `filter?: ListFilter` is backward-compatible: the existing call still type-checks (`filter` is `undefined`), Tauri drops the `undefined`-valued key from the payload, and serde deserializes the absent key as `None` (standard `Option<T>` semantics, same as `list_items`' omitted `filter`). **No `App.tsx` change is required by this signature change.** Whether `App.tsx` should later pass the rail's filter state into `searchItems` is a Phase 3 UI concern.

## 4. Security Considerations

*(security-auditor agent; context: single-user local desktop app. Findings cite file:line; the two substantive ones were confirmed by direct inspection during planning.)*

**Critical / High: none.** The classic injection and secret-exposure vectors are already closed in the Phase-1 repository layer (parameterized binds throughout `push_filters` `sqlite.rs:101-121`, `fts_query()` sanitizer `:528-534`, closed `Sort` enum → static SQL `:127-152`, no command returns key material). Thin wrappers inherit all of it and reopen none of it.

**[Medium — FOLDED INTO PHASE 2 per §10 Q1] `jira_url` stored with no scheme validation.** CONFIRMED by direct read: `create` (`sqlite.rs:180-181`) and `update` (`sqlite.rs:291-292`) store `jira_url` verbatim after only an empty-string check. An arbitrary `javascript:`/`file:`/`data:` URL is persistable today via the existing `create_item`/`update_item` commands. The sink lands in Phase 3: `lib.rs:16` registers `tauri_plugin_opener::init()` and `capabilities/default.json` grants `opener:default` with **no scheme restriction**. **Requirement:** add an `http`/`https` allowlist at the repository write path (`create`/`update`), rejecting other schemes (and unparseable/relative values) with `AppError::Invalid`; add a repo test. Enforcing at the single write chokepoint means the DB can never hold a dangerous URL regardless of which future consumer (opener, enrichment, export) reads it — consistent with the CLAUDE.md doctrine that invariants live in the repository, not the UI. Phase 3 should still add a defense-in-depth re-check at open time.

**[Medium/Low — accepted as low residual, centralized note] Unexpected `AppError::Db` serializes raw sqlx text.** CONFIRMED: `error.rs:8-9,33-39` — `Db(#[from] sqlx::Error)` renders `database error: {raw sqlx message}`, which can name tables/columns. The *known* constraint leaks are already mapped to clean `Invalid` in Phase 1 (UNIQUE → `sqlite.rs:495-509`, FK → `:515-522`) and `delete_project` uses `BEGIN IMMEDIATE` to avoid a raced lock leak. Only *unexpected* runtime DB errors (disk full, corruption) leak raw text. For a single-user local app where operator == "attacker" and React text-escapes the string, this is low residual risk. **Decision:** the thin Phase 2 commands need no per-command handling; accept as low residual and note it (do NOT add ad-hoc validation in each command). A centralized generic-message catch-all is a possible future hardening, out of scope for Phase 2.

**[Low] New commands need `generate_handler!` lines, but NO capability change.** Consistent with the existing nine commands (which work today with only `core:default`/`opener:default` and no per-command entries): app-defined commands registered via `generate_handler!` are exposed to the window without a per-command capability allowlist entry; `capabilities/default.json` gates only plugin/core permissions. Omitting a registration line is a "command not found" runtime bug, not a privilege hole. **Confirm no `default.json` change is made — none is required.**

**[Low, forward-looking] No length/content bound on `name`/`project_id`/`jira_url`.** Negligible for single-user local SQLite (no tenant, no quota). Phase 3 must render these as React text nodes, never `dangerouslySetInnerHTML` (grep confirmed none exists today).

**Clean (verified):** `search_items` filter wiring cannot bypass `fts_query()` or the forced `archived = 0` exclusion (`sqlite.rs:341-362`) — provided the command keeps passing the user's raw text as the separate `query` argument and never folds it into a filter field. No secret-exposure regression (key commands untouched). No new dependency.

## 5. Design

### Approach
Replicate the established thin-command pattern for five pass-through commands; extend `search_items` to accept `Option<ListFilter>` mirroring `list_items`; register all five in `lib.rs`; add matching one-line `api.ts` wrappers. Verify (do not edit) the three item commands and `types.ts`. Separately, add the `jira_url` `http(s)` allowlist at the repository write path (the one piece of new logic, per user decision).

### Architecture
- **`commands.rs`** — add 5 commands, edit `search_items`, extend the `use crate::models::{...}` import to add `Project, ProjectWithCount` (kept alphabetical).
- **`lib.rs`** — append 5 command lines to `generate_handler!`.
- **`api.ts`** — add `Project, ProjectWithCount` to the `../types` import block (sorted), edit `searchItems`, add 5 wrapper functions.
- **`sqlite.rs`** — add `jira_url` scheme validation to `create` and `update` (the security addition); a small `validate_jira_url` helper alongside the existing normalization.
- **`tests/repo.rs`** — add the `jira_url` scheme-rejection test, plus two low-cost serde-shape tests (see §8).
- **Untouched:** `list_items`/`create_item`/`update_item`, `types.ts`, `models.rs`, migrations, `capabilities/default.json`, `error.rs`.

### Key Decisions

**D1 — Bare scalar params for the project commands, not wrapper DTOs.** `create_project(state, name: String)`, `rename_project(state, id: String, name: String)`, `delete_project(state, id: String)`. Rationale: matches the existing `set_api_key(provider, key)` / `update_item(id, patch)` precedent and the "write the minimum code" rule. `RewriteRequest` is the *exception* that earned a DTO by having three unrelated fields; one- and two-arg scalars do not. It is also already dictated by the `Project` struct's own doc comment in `models.rs` ("not `Deserialize` — `create_project`/`rename_project` take a plain name"). *Rejected: `CreateProjectRequest`/`RenameProjectRequest` DTOs — speculative structure for a thin layer.*

**D2 — `search_items` takes `Option<ListFilter>` named `filter`, byte-identical to `list_items`.** New Rust signature: `search_items(state, query: String, filter: Option<ListFilter>) -> Result<Vec<Item>>`, body `state.repo.search(&query, &filter.unwrap_or_default()).await`. Delete the Phase-1 TODO comment. `api.ts`: `searchItems(query: string, filter?: ListFilter)` → `invoke("search_items", { query, filter })`. The raw `query` stays its own argument and is never folded into a filter field (security-clean per §4). Backward-compatible with the existing `App.tsx:28` caller.

**D3 — Zero-arg commands call `invoke("name")` with no args object.** `list_projects` and `list_active_tags` have no params besides `state`. `invoke("list_projects")` is the natural, correct mapping (first zero-arg wrappers in the surface).

**D4 — The three item commands and `types.ts` are verified, not edited.** Their whole-DTO pass-through already carries the new fields. Editing them would be redundant churn and risks regression. The plan's acceptance explicitly includes confirming this by inspection.

**D5 — `create_project` returns `Project` (no `itemCount`); the frontend treats a new project as count 0.** `list_projects` returns `ProjectWithCount`. No contract change; a freshly created project has zero items by definition, so the UI synthesizes `itemCount: 0` or refetches `list_projects`. Trivial, decided now to avoid a Phase-3 surprise.

**D6 — `jira_url` `http(s)` allowlist at the repository write path (`create`/`update`).** A `validate_jira_url(&str) -> Result<()>` helper (or inline check) rejects any non-empty `jira_url` whose scheme is not `http` or `https` with `AppError::Invalid("JIRA link must be an http(s) URL")`. Applied after the empty-string→NULL normalization (empty clears, and is exempt). Two implementation paths (Q2):
- **`url` crate (only if flagged and accepted):** `Url::parse(s)` then check `scheme()` is `http`/`https` — this also enforces "parses as an absolute URL with a host."
- **Dependency-free (default, preferred):** a manual check that is **stronger than a bare prefix test** — it must (a) match the scheme case-insensitively (`http`/`https` schemes are case-insensitive per RFC 3986; a user-typed `HTTPS://…` should not be a false reject), and (b) require a non-empty host after `scheme://` (reject a bare `"http://"` / `"https://"` with nothing after it). A plain `starts_with("http://") || starts_with("https://")` is **NOT sufficient** — it is case-sensitive and admits an empty-host `"https://"`. Implement it as: lowercase the scheme portion, strip the `://`, and require at least one more character.

This is the only new logic in Phase 2 and the only `sqlite.rs`/`tests/repo.rs` edit. **Insertion (see Step 5):** a `jira_url` reject should `?`-return before any project-existence I/O in `create()`; functionally the two are independent early checks, so order does not matter, but validating first avoids a wasted `ensure_project_exists` round-trip. In `update()`, restructure the existing one-line ternary (`sqlite.rs:292`) so validation runs on the non-empty branch before assignment; the empty-clear branch skips validation and still sets `edited = true`.

## 6. Implementation Steps

1. **`commands.rs` — extend imports.** Change `use crate::models::{Item, ListFilter, NewItem, UpdateItem};` to add `Project, ProjectWithCount` (alphabetical: `Item, ListFilter, NewItem, Project, ProjectWithCount, UpdateItem`).
2. **`commands.rs` — wire `search_items` (D2).** Add `filter: Option<ListFilter>` param; body `state.repo.search(&query, &filter.unwrap_or_default()).await`; delete the Phase-1 TODO comment (`commands.rs:52`).
3. **`commands.rs` — add the five pass-through commands (D1, D3),** each a one-line delegate mirroring `list_items`/`delete_item`:
   - `list_projects(state) -> Result<Vec<ProjectWithCount>>` → `state.repo.list_projects().await`
   - `create_project(state, name: String) -> Result<Project>` → `state.repo.create_project(&name).await`
   - `rename_project(state, id: String, name: String) -> Result<Project>` → `state.repo.rename_project(&id, &name).await`
   - `delete_project(state, id: String) -> Result<()>` → `state.repo.delete_project(&id).await`
   - `list_active_tags(state) -> Result<Vec<String>>` → `state.repo.list_active_tags().await`
4. **`lib.rs` — register the five new commands** in `generate_handler![...]` (`lib.rs:33-43`), grouped after `search_items`. Do not touch the `search_items` line (already registered).
5. **`sqlite.rs` — add the `jira_url` `http(s)` allowlist (D6).** Add a `validate_jira_url` check (prefer dependency-free scheme check — flag if using `url` crate) invoked in `create` (after `let jira_url = input.jira_url.filter(...)`, on the `Some` value) and in `update` (inside the `if let Some(jira_url)` block, on the non-empty branch, before assignment). Empty string still clears and is exempt.
6. **`api.ts` — extend the `../types` import** to add `Project, ProjectWithCount` (keep sorted).
7. **`api.ts` — edit `searchItems` (D2):** `searchItems(query: string, filter?: ListFilter): Promise<Item[]>` → `invoke("search_items", { query, filter })`.
8. **`api.ts` — add the five wrappers (D1, D3):**
   - `listProjects(): Promise<ProjectWithCount[]>` → `invoke("list_projects")`
   - `createProject(name: string): Promise<Project>` → `invoke("create_project", { name })`
   - `renameProject(id: string, name: string): Promise<Project>` → `invoke("rename_project", { id, name })`
   - `deleteProject(id: string): Promise<void>` → `invoke("delete_project", { id })`
   - `listActiveTags(): Promise<string[]>` → `invoke("list_active_tags")`
9. **Verify, do NOT edit (D4):** confirm `list_items`, `create_item`, `update_item` (Rust + JS) and `src/types.ts` need no change — the new fields already flow through. Confirm `capabilities/default.json` needs no change.
10. **`tests/repo.rs` — add tests** per §8 (jira_url scheme rejection + two serde-shape tests).
11. **Run the CLAUDE.md verification block** (§9) and fix any failures, including the manual smoke test of each new command.

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/src/commands.rs` | Modify | Add 5 pass-through commands; wire `filter` into `search_items`; extend model import |
| `src-tauri/src/lib.rs` | Modify | Register 5 new commands in `generate_handler!` |
| `src/lib/api.ts` | Modify | Add 5 wrappers; update `searchItems(query, filter?)`; extend type import |
| `src-tauri/src/db/sqlite.rs` | Modify | Add `jira_url` `http(s)` scheme allowlist in `create`/`update` (D6) |
| `src-tauri/tests/repo.rs` | Modify | `jira_url` scheme-rejection test; `ListFilter` camelCase deserialize test; `Project`/`ProjectWithCount` serialize-shape test |
| `src-tauri/src/models.rs` | Verify only | Confirm no change needed (DTOs already carry all fields) |
| `src/types.ts` | Verify only | Confirm already mirrors everything (no edit) |
| `src-tauri/capabilities/default.json` | Verify only | Confirm NO change required for new commands |

**Note:** `commands.rs` is ONE file with two categories of change — the `search_items`/new-command/import edits above (Modify), and the `list_items`/`create_item`/`update_item` functions which are **verify-only, not edited** (D4). It is a single diff to one file, not two.

## 8. Test Strategy

*(test-writer agent; conventions: `#[tokio::test] async fn` per scenario, fresh `SqliteRepository::connect_in_memory()`, `matches!(err, AppError::...)`, same style as the existing `validation_and_serde_shape` test.)*

**The honest baseline:** the five new commands are one-line pass-throughs to repository methods that are ALREADY fully test-covered by Phase 1's `repo.rs` suite (`create_project_rejects_duplicate_cleanly`, `delete_project_blocked_message_names_count`, `active_tags_*`, filter/sort tests, etc.). The existing `list_items`/`get_item`/`delete_item` commands have never had command-level tests, and that is consistent and appropriate for thin wrappers. **Do not stand up a `tauri::test` mock-app / IPC harness** — a new dev-dependency and heavy infra disproportionate to five one-line wrappers. There is also **no frontend test infrastructure** (confirmed: `package.json` has no vitest/jest/testing-library and no `test` script) — do not introduce one; the established frontend verification is `tsc --noEmit` + `npm run build` + manual smoke.

- [ ] **Unit / Repository — `jira_url` scheme allowlist (D6, the one new-logic test):**
  - `create` with `jiraUrl: "javascript:alert(1)"` → `matches!(err, AppError::Invalid(_))`; likewise `file:`, `data:`, and a scheme-less/relative value.
  - **Weak-fallback guards (per D6):** bare `"https://"` (empty host, nothing after `://`) → `Invalid`; an uppercase-scheme `"HTTPS://jira.example.com/ABC-1"` → **accepted** (case-insensitive scheme). These two cases specifically catch a validator implemented as a naive case-sensitive `starts_with` prefix test.
  - `create`/`update` with a valid `https://…` (and `http://…`) JIRA URL → succeeds, value persisted and returned.
  - `update` clearing via `jiraUrl: ""` → `None`, no scheme error (empty is exempt).
  - **Non-vacuous check:** temporarily stub the validator to always-Ok and confirm the reject test goes red.
- [ ] **Unit / Repository — serde-shape gaps Phase 2's IPC actually depends on** (same style as `validation_and_serde_shape`):
  - `ListFilter` deserializes from camelCase JSON (`projectId`, `tags: [...]`, `sort: "priority"`, and all-omitted → defaults) — the exact shape `search_items`/`list_items` receive from `api.ts`. Never asserted before.
  - `Project`/`ProjectWithCount` serialize to camelCase (`createdAt`, `itemCount`) — pins the contract `src/types.ts` assumes; `Item`'s shape is already pinned, these are not.
- [ ] **Regression / build (must stay green):**
  - `cd src-tauri && cargo test` — full existing `repo.rs` suite unmodified must pass (proves the thin commands and the `jira_url` edit didn't disturb repository semantics).
  - `cargo build` — `commands.rs`, the extended `generate_handler!`, and `lib.rs` compile.
  - `npx tsc --noEmit` — validates the `api.ts` additions and updated `searchItems` at every call site (incl. `App.tsx:28`).
  - `npm run build` — production bundle clean.
- [ ] **Manual smoke (`npm run tauri dev`) — Phase 2's real regression surface** (IPC wiring is untyped end-to-end; nothing automated covers command-name/arg-key string matching):
  - Invoke each new command once: `list_projects` (empty state), `create_project` (valid; duplicate surfaces a readable error, not raw sqlx text), `rename_project`, `delete_project` (blocked with items assigned → readable error; succeeds once unassigned), `list_active_tags`.
  - Confirm `search_items` actually filters by the wired `ListFilter` (project/status/tag) end to end — repo tests prove the SQL; only the smoke test proves the frontend passes the filter through.
  - Confirm repository errors render as readable strings, not unhandled rejections or raw Rust errors.
  - One cold restart to confirm the extended `invoke_handler` and unchanged `setup()`/migrations still boot.

## 9. Success Criteria

- [ ] **Functional:** the five new commands are callable from `api.ts` and return the repository's results/errors; `search_items` honors a passed `ListFilter` (project/status/tag) and falls back to `list(filter)` on empty query; `list_items`/`create_item`/`update_item` still carry `projectId`/`jiraUrl`/filter fields unchanged; a non-`http(s)` `jira_url` is rejected with a clean `AppError::Invalid` at the write path.
- [ ] **Tests:** every test in §8 passes; the `jira_url` reject test was verified red against a stubbed validator.
- [ ] **Security:** `jira_url` `http(s)` allowlist implemented at the repository write path (§4/D6); `search_items` keeps `fts_query()` + forced `archived = 0`; no `capabilities/default.json` change; no raw key material returned.
- [ ] **Quality:** `cd src-tauri && cargo test` green; `npx tsc --noEmit` clean (strict, `noUnusedLocals`); `npm run build` clean; `models.rs`↔`types.ts` still agree (verified unchanged); manual smoke passes.
- [ ] **Discipline:** every new `invoke` lives only in `api.ts`; the three item commands and `types.ts` were confirmed unchanged (no redundant edits).

## 10. Risks & Open Questions

**Confirmed claim driving a plan decision (verified during planning by direct code read, not just an agent assertion):**
- **CONFIRMED — "`jira_url` is stored with no scheme validation; a `javascript:`/`file:` URL is persistable today and Phase 3's opener is scheme-unrestricted."** Verified against `sqlite.rs:180-181` (create), `:291-292` (update), `lib.rs:16` + `capabilities/default.json` (opener sink). **User decision (Q1): fold the `http(s)` allowlist into Phase 2** at the repository write path. This is the only piece of new logic in an otherwise pure-plumbing phase.
- **CONFIRMED — "unexpected `AppError::Db` serializes raw sqlx text."** Verified against `error.rs:8-9,33-39`. Accepted as low residual for a single-user local app; no per-command handling added. A centralized catch-all is possible future hardening, out of scope.

**Risks:**
- **Silent IPC arg-name mismatch.** Neither `tsc` nor `cargo` catches a mismatch between an `invoke` arg key and a Rust param name; it fails only at runtime. Mitigation: the manual smoke test (§8) exercises every new command once — the only automated-ish guard for this layer. The scalar-arg commands (`create_project`/`rename_project`/`delete_project`) are the exposure.
- **Forgetting a `generate_handler!` line.** Same runtime-only failure mode. Mitigation: cross-check the five names in `lib.rs` against `api.ts` during review; smoke-test each.
- **Accidentally "extending" `list_items`/`create_item`/`update_item`.** They need no change; editing them risks regression. Mitigation: D4 makes "verify, don't edit" explicit and a success criterion.
- **`search_items` signature change rippling to `App.tsx`.** Confirmed backward-compatible (trailing optional param; existing `searchItems(search)` call unaffected). No `App.tsx` edit required or intended in Phase 2.

**Open Questions (decide at implementation):**
- **Q1 — RESOLVED: fold `jira_url` `http(s)` allowlist into Phase 2** (user decision). Enforced at the repository write path with a test; Phase 3 adds a defense-in-depth open-time re-check.
- **Q2 — `jira_url` validator: new dependency or dependency-free?** Prefer a dependency-free scheme check (`http://`/`https://` prefix, or scheme parse without a crate). Flag before adding the `url` crate; per CLAUDE.md, any new dependency must be flagged. Default: no new dependency.
- **Q3 — command grouping/ordering in `commands.rs` and `generate_handler!`.** Cosmetic; group the five as a projects/tags block after `search_items`. No contract impact.

## 11. Code Review Checklist
After implementation, verify:
- [ ] No dead code or unused imports introduced (e.g. the `Project`/`ProjectWithCount` import is actually used)
- [ ] Error handling: repository errors pass through cleanly; `jira_url` reject returns `AppError::Invalid` with a readable message; no raw constraint/sqlx text added on any new path
- [ ] No security vulnerabilities: `jira_url` `http(s)` allowlist enforced at the write path; `search_items` keeps `fts_query()` + forced `archived = 0`; raw `query` never folded into a filter field; no `capabilities/default.json` change
- [ ] Security considerations from §4 addressed (D6 allowlist; `AppError::Db` residual accepted, not worsened)
- [ ] Code follows existing conventions: thin-command pattern; bare scalar params (D1); `Result<T>` return; `invoke` arg keys match Rust param names exactly; `api.ts` is the only `invoke` site; import blocks stay sorted
- [ ] All five new commands registered in `generate_handler!` AND mirrored in `api.ts` (names cross-checked)
- [ ] `list_items`/`create_item`/`update_item` and `types.ts` confirmed UNCHANGED (no redundant edits)
- [ ] Tests cover the new-logic path (jira_url) + serde shapes; the reject test verified red against a stub
- [ ] Changes are minimal — no unrelated refactoring; no Tauri test harness or frontend test framework introduced

## 12. Post-Review Improvements

*Implemented 2026-07-14. Four review agents ran on the final diff: api-designer (contract/arg-name parity), security-auditor (§4 items), code-reviewer (§11 checklist), test-writer (§8 tests + red-stub proof).*

**Verification results:** `cargo build` clean · `cargo test` 47 passed / 0 failed · `npx tsc --noEmit` exit 0 · `npm run build` clean. The `jira_url` reject test was proven red against a stubbed always-`Ok` validator, then green after revert (non-vacuous).

**Review outcome — all Phase 2 items PASS:**
- **api-designer:** all 6 commands defined + registered + wrapped with identical names; arg keys (`{query,filter}`, `{name}`, `{id,name}`, `{id}`, zero-arg) match Rust params exactly; return types align; import block sorted; no new DTO structs. No discrepancies.
- **security-auditor:** no Critical/High/Medium/Low findings. `jira_url` allowlist enforced at both write paths (create + update), case-insensitive, empty-host rejected, empty-clear exempt; `search_items` keeps `fts_query()` + forced `archived = 0`, raw query never folded into a filter field; no new SQL on command paths; `capabilities/default.json` unchanged; no new dependency (validator is std-only).
- **code-reviewer:** all §11 checklist items PASS. The three item commands and `types.ts` confirmed unedited by Phase 2 (the `models.rs`/`types.ts` deltas are Phase-1 uncommitted work, not this phase).

**Improvements applied in Phase 2:** none required — no Phase 2 finding warranted a code change; the implementation matched the plan.

**Findings surfaced but intentionally NOT changed (out of Phase 2 scope — recorded for follow-up):**
1. **[Pre-existing Phase-1 bug, NOT in Phase 2 diff] `create()` does not gate `due_at` by `Kind`.** `sqlite.rs` `create()` stores `due_at` unconditionally, so a `Note` created with `dueAt` set persists it — violating the "notes never carry dueAt" invariant that `update()` correctly enforces. This line is untouched by Phase 2 and fixing it is repository logic outside this phase's charter ("NOT new repository logic, with ONE exception" + "changes are minimal, no unrelated refactoring"). **Recommendation:** fix in a Phase-1 follow-up by gating `due_at` in `create()` like `status`/`priority` (`Kind::Task => …, Kind::Note => None`), with a regression test.
2. **[Known property of the D6-prescribed algorithm] `validate_jira_url` accepts `https:///path`** (empty authority, non-empty remainder). This is exactly the dependency-free algorithm D6 specifies ("strip the `://`, require at least one more character"); it is not a dangerous-scheme bypass (scheme is still `http(s)`). Phase 3's planned defense-in-depth open-time re-check is the backstop for malformed-but-http URLs. Left as-spec.
3. **[Pre-existing Phase-1 behavior] `project_id`/`jira_url` are emptiness-filtered but not trimmed** on `create` (unlike project `name`). A whitespace-only value is rejected downstream (`no such project` / invalid URL) rather than treated as absent. Low-impact inconsistency, out of Phase 2 scope.

**Not runnable in this environment:** the manual `npm run tauri dev` smoke test (§8) requires a running desktop GUI and, pre-Phase-3, has no UI controls to exercise the new commands — it must be run interactively by a human. The automated block that covers everything except live IPC string-matching is green; the IPC arg-name/command-name parity was instead cross-checked statically by the api-designer agent (all PASS).

## 13. Execution Prompt

```
Implement Phase 2 (IPC surface) of the worknotes app, following the plan at
notes-app/plans/plan.2.md. Read that plan file in full first — it is the authoritative
spec, including the design decisions (D1–D6) and the resolved open questions (Q1: the
jira_url http(s) allowlist IS in scope for Phase 2; Q2: prefer a dependency-free scheme
check — flag before adding the `url` crate).

Project root: notes-app/. Standard verification lives in notes-app/CLAUDE.md.

CONTEXT: Phase 1 (schema + repository) is already implemented (uncommitted). The
ItemRepository trait already exposes list_projects / create_project / rename_project /
delete_project / list_active_tags and the search(query, filter) signature. models.rs and
src/types.ts already carry Project, ProjectWithCount, Sort, and the new
Item/NewItem/UpdateItem/ListFilter fields. Phase 2 is the thin IPC/command layer plus the
api.ts wrappers — NOT new repository logic, with ONE exception: the jira_url allowlist (D6).

Implement the plan step by step, following Section 6 (Implementation Steps) in order:
  1. commands.rs: extend the models import (add Project, ProjectWithCount, alphabetical).
  2. commands.rs: wire search_items to take `filter: Option<ListFilter>` and forward
     `state.repo.search(&query, &filter.unwrap_or_default()).await`; delete the Phase-1
     TODO comment. (D2)
  3. commands.rs: add the five one-line pass-through commands with BARE scalar params
     (create_project(name), rename_project(id, name), delete_project(id)), not DTO structs
     (D1); zero-arg list_projects / list_active_tags (D3). Trait methods take &str, so pass
     &name / &id.
  4. lib.rs: register all five new commands in generate_handler! (search_items is already
     registered). A missing line is a runtime "command not found" bug — cross-check names.
  5. sqlite.rs: add the jira_url http(s) allowlist in create() and update() (D6). Reject
     non-empty jira_url whose scheme is not http/https (and non-absolute values) with
     AppError::Invalid; empty string still clears and is exempt. Prefer a dependency-free
     check; if you reach for the `url` crate, flag it first (CLAUDE.md: flag new deps).
  6. api.ts: extend the ../types import (add Project, ProjectWithCount, sorted); update
     searchItems(query, filter?) → invoke("search_items", { query, filter }); add the five
     wrappers with invoke arg keys matching the Rust param names EXACTLY (D1/D2/D3).
  7. VERIFY, do NOT edit (D4): confirm list_items / create_item / update_item (Rust + JS)
     and src/types.ts need no change — the new fields already flow through the whole-DTO
     pass-through. Confirm capabilities/default.json needs NO change. Editing these is a
     bug, not progress.
  8. tests/repo.rs: add the jira_url scheme-rejection test (and prove it red against a
     stubbed always-Ok validator), plus the ListFilter camelCase-deserialize and
     Project/ProjectWithCount serialize-shape tests (Section 8). Do NOT stand up a
     tauri::test IPC harness or a frontend test framework — neither is justified for a thin
     wrapper layer, and none exists today.

Use subagents during implementation (if a named agent type is unavailable, fall back to a
generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise
— with the role stated in the prompt):
  - Spawn an api-designer agent (or Explore) to review the final command contracts and the
    api.ts wrappers for arg-name/name parity against Section 3/Section 5.
  - Spawn a test-writer agent to write/extend tests/repo.rs per Section 8 and prove the
    jira_url reject test fails against a stubbed validator before trusting it.
  - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify the Section 4
    items in the actual diff: jira_url http(s) allowlist enforced at the write path,
    search_items still routes raw query only through fts_query() with forced archived=0, no
    raw sqlx text added on new paths, no capabilities change.
  - Spawn a code-reviewer agent (read-only: Read, Grep, Glob) on the full diff against the
    Section 11 checklist — especially "the three item commands and types.ts are UNCHANGED"
    and "every new command is both registered AND mirrored in api.ts."
  - No database-architect (no schema change), no frontend-specialist (no components — that's
    Phase 3), no devops/performance agent needed.

After implementation:
  - Run the Section 11 Code Review Checklist and address every item.
  - Document any improvements in Section 12 of the plan file and implement them.
  - Run the full verification block and fix regressions before finishing:
        cd src-tauri && cargo build   # confirms commands.rs + generate_handler! + lib.rs compile
        cd src-tauri && cargo test
        npx tsc --noEmit
        npm run build
    then a manual `npm run tauri dev` smoke test per Section 8: invoke each new command once
    (list_projects, create_project incl. duplicate → readable error, rename_project,
    delete_project incl. blocked-with-items → readable error, list_active_tags), confirm
    search_items filters end-to-end, and confirm a cold restart still boots.

Do not start Phase 3 (UI). Stop when Phase 2's Section 9 success criteria are met and all
tests/builds pass.
```
