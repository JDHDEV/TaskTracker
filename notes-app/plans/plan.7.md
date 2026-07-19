# Plan 7: Prompts Page (per-project versioned prompts with AI enhancement)

**Created:** 2026-07-18
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Add a second top-level page, **Prompts**, alongside the existing **Worknotes** page. A header tab pair switches between the two; both pages share the exact same project catalog (no duplicate project system). On the Prompts page a user creates, views, and manages **prompts** scoped to a project. Each prompt can be marked **reusable** (filterable), and every content edit — including an AI-enhanced save — is captured as an immutable **version**, giving each prompt a full, viewable history in which the original is never lost. The AI "enhance" action reuses the existing streaming rewrite pipeline verbatim; accepting a proposal persists it as a new version.

Why it matters: the app already proves the need for reusable, curated prompt text in miniature (the hardcoded rewrite `PRESETS` in `AiBar.tsx`). This feature promotes that into a first-class, versioned, per-project prompt library while riding the storage and AI abstractions that plan.6 and earlier phases already built.

**A "prompt" is a new entity, not a third item `kind`, and its history lives in the canonical git-mergeable file store — not only in the rebuildable index.** These two decisions are the spine of the plan and are validated below.

## 2. Strategic Assessment

*(Source: tech-lead agent, validated by architect + database-architect.)*

The tech lead flagged one ambiguity and three architectural steers:

- **Ambiguity (resolved by the requirements themselves):** "prompt" could mean (a) reusable AI *rewrite instructions* (today's hardcoded presets) or (b) a general per-project *prompt library*. The requirements — a full page, per-project prompts, reusable flag, full version history, AI enhance — unambiguously describe reading (b). This plan builds (b). The existing presets remain the AI-instruction chips and are unaffected.
- **Steer 1 — new entity, not a `kind`.** `Kind` is a closed `Note | Task` enum fixed at creation and hardwired into serialize/parse kind-gating (`store/itemfile.rs`), create/update gating (`db/sqlite.rs`), sort bucketing and derived tags (`projects/mod.rs`), and FTS. Overloading it would ripple through all of them and *still* not provide versioning, which items fundamentally lack. **Confirmed necessary by the architect.**
- **Steer 2 — history in the canonical file store.** plan.6 (commit 88f3056) made the canonical store one git-mergeable Markdown file per item, with `index.db` a rebuildable, git-ignored cache. Versioning must live in the file store or it vanishes on reload/clone. **Confirmed by the database-architect.**
- **Steer 3 — AI enhance rides the existing `AiProvider` streaming rewrite.** "Save improved version, preserve original" is exactly the app's existing "AI rewrites are proposals; nothing replaces content without explicit user action" invariant. **Confirmed by the frontend specialist** — `aiRewriteStream`/`aiGenerateTitle` are already content-agnostic; no new AI command is needed.

**Riskiest part:** touching the per-project store's hardening without breaking existing projects — specifically the foreign-DB schema allowlist (see §4, H1). Second-riskiest: getting the versioning *storage representation* right so history survives git merges (see §5).

**Highest-level recommended approach:** Add a `PromptRepository` trait implemented by the existing `SqliteRepository` (shared pool), back it with a new `prompts/` canonical file subtree + two rebuildable index tables (migration `0006`), and add a router-free `page` toggle in `App.tsx` that renders a new `PromptsPage` reusing the Worknotes two-pane CSS and the AI rewrite flow.

## 3. Research Findings

### 3.1 Codebase map (architect)

- **A project is a directory, not a row.** The app-level `catalog.db` (`projects/catalog.rs`) records which directories are known/loaded; inside each project directory the canonical store is `items/<uuid>.md` files, with `index.db` a git-ignored rebuildable cache. (`CLAUDE.md:13-15`, `projects/mod.rs`.)
- **File format template:** `store/itemfile.rs` — `serialize`/`parse` (fixed key order, LF, fixed-precision timestamps, restricted panic-free parser, UUID-only filenames `is_uuid` at `:77-85`, atomic temp-then-rename `write_item` `:276-286`, 4 MB cap, git-conflict-marker rejection `:368-379`, per-file partial-success scan `:311-357`).
- **Write path is file-then-index; load path is scan-then-rebuild:** `db/sqlite.rs` `create`/`update`/`delete` (`:509`, `:604`, `:634`) write the `.md` before the index row; `rebuild_from_dir` (`:291-338`) opens a txn, `DELETE FROM items`, re-inserts parsed files, rebuilds `items_fts`, preserving `meta` identity.
- **Two swap-point traits:** `ItemRepository` (`db/mod.rs:22-46`) and `AiProvider` (`ai/mod.rs:27-57`). Commands depend on `ProjectManager` (`projects/mod.rs:82`), never a concrete impl.
- **Manager:** `LoadedProject { name, repo: Arc<dyn ItemRepository> }` (`:77-80`), routing (`create`/`owner` `:375`, `:539`), fan-out reads with k-way merge (`list_all`/`search_all` `:414`/`:432`, comparator `item_order` `:901-916`), `open_store` (`:666-700`), `remove_store_files` (`:811-831`).
- **Frontend shell:** `App.tsx` — **no router** (confirmed: no `react-router` import; state via `useState` + conditional JSX). Header/topbar `:253-268`; shared project state `knownProjects`/`loaded` `:35-37`; two-pane body `:288-356`; modal dialogs gated by `useState`. `ItemList.tsx` (rail) and `Editor.tsx` (detail + AI rewrite flow) are the templates. `AiBar.tsx` holds hardcoded `PRESETS` `:18-23`. The frontend touches the backend only through `src/lib/api.ts`; `src/types.ts` mirrors `models.rs` in serde camelCase.
- **AI rewrite wiring (prior art to imitate):** `Editor.rework` (`:230-298`) streams tokens via `api.aiRewriteStream` (`api.ts:137-178`) → `ai_rewrite_stream` (`commands.rs:237`); nothing touches the body until `Replace text` (`Editor.tsx:513-525`). This propose-then-accept split *is* "improved version saveable, original preserved."

### 3.2 Corrected/added facts

- **Ordering invariant correction (database-architect):** the root `CLAUDE.md` "rowid tiebreak" wording is **stale**. plan.6 moved list ordering to `(created_at DESC, id ASC)` because rowids collide across per-project files and are reassigned on every index rebuild (`push_sort` `sqlite.rs:447`, `item_order` `projects/mod.rs:901-916`). Prompt versions therefore order on `created_at DESC, id ASC` — never rowid.
- **Project-removal guard is retired (test-writer + database-architect):** the old count-based "block delete if items exist" guard went away with the row-based model (plan.6 Decision 7). The CLAUDE.md invariant describing it is stale for this area. The current model is Unload / Forget / Delete-files over per-directory stores. **Prompts inherit cascade for free** — they live in the project directory, so deleting a project's files deletes its prompts. No guard to build; instead `remove_store_files` must be taught to sweep `prompts/` (see §4 H3).
- **Highest migration is `0005_meta.sql`** (per-project index migrator); next is **`0006_prompts.sql`**. The catalog migrator stays at `0001` — prompts are per-project, never catalog.

## 4. Security Considerations

*(Source: security-auditor; the two load-bearing claims below were independently CONFIRMED by an adversarial-verifier.)*

### High

- **H1 — Foreign-DB schema allowlist will brick every existing project unless widened (CONFIRMED).** `open_existing` (`db/sqlite.rs:139-213`) checks `sqlite_master` against hardcoded `KNOWN_TABLES` (`:31-38`) / `KNOWN_TRIGGERS` (`:41`) and rejects any unknown object as "that file is not a worknotes project" (`foreign_db_error` `:711-713`). This check runs **before** `sqlx::migrate!` (`:208`). The FTS allowance is the exact prefix `name.starts_with("items_fts")` (`:195`) — a `prompts_fts` would *not* satisfy it. Sequence: first open after upgrade passes, migration adds the new tables, the **next** open sees them and rejects the whole store. **Requirement:** in the same change as `0006`, extend `KNOWN_TABLES` with `prompts` and `prompt_versions` (and `KNOWN_TRIGGERS` / a `prompts_fts` prefix arm only if FTS is added — it is not in v1). Do **not** relax the allowlist to allow-all. Add a reopen-after-migrate test (the mechanism is already reproduced by `open_existing_rejects_an_unknown_trigger`, `tests/project_manager.rs:722-738`).
- **H2 — Version-history integrity must be backend-owned and append-only.** Version ids and timestamps are minted server-side (`now_rfc3339` `sqlite.rs:19-21`, `uuid`), never client-supplied. The repository must never rewrite or delete an existing version file (original preserved is a repository invariant, not a UI promise — `CLAUDE.md:19`). Version filenames derive **only** from a backend-minted UUID via `is_uuid` (`itemfile.rs:77-85`) — never from title, the reusable flag, or any user text (path-traversal/ADS/reserved-name safety). **Concurrency is solved by design:** each version is a new UUID-named immutable file, so two concurrent "enhance-and-save" calls create two distinct files with no shared counter to race and no lost update (current is *derived*, not a stored pointer).
- **H3 — Delete-files and index-rebuild must learn about prompts (CONFIRMED path).** `remove_store_files` (`projects/mod.rs:811-831`) currently sweeps only `index.db*`, `project.db*`, `.bak`, `items/`, `.gitignore` — it must **also** remove `prompts/`, or destructive "Delete files" leaves sensitive prompt bodies on disk (data remanence). `rebuild_from_dir` (`sqlite.rs:291-338`) rebuilds only `items` — it must also `DELETE FROM prompt_versions; DELETE FROM prompts;` and repopulate from a `promptfile::scan(prompts_dir)` in the same transaction (parent rows before child rows), or a Reload after `git pull` shows stale/empty prompts, violating "files are source of truth."

### Medium

- **M1 — Any prompt search must go through `fts_query()`; never raw `MATCH`, never string-interpolated SQL.** v1 ships **no** prompt full-text search (only the reusable filter, which is a bound `WHERE reusable = 1`), so this is a guardrail for any future search: reuse `fts_query` (`sqlite.rs:764-770`) and bind every value with `push_bind`. FTS for prompts, if ever added, must be a **separate** corpus (`prompt_versions_fts`), never merged into `items_fts` (bm25 ranks aren't comparable across corpora), and would then need its own allowlist entries.
- **M2 — The AI enhance path must scrub provider errors (CONFIRMED existing leak).** Both `ai_rewrite`/`ai_rewrite_stream` propagate the **raw upstream HTTP body** to the UI (`anthropic.rs:87-89,141-143`, `openai.rs:92-94,148-150` → `commands.rs:170,281-284` → `api.ts:158-159` → `Editor.tsx:273`), whereas `generate_title` scrubs every non-`MissingKey` error to a generic string (`ai/mod.rs:190-196`). Because enhance reuses this exact stream path, it inherits the leak. **Requirement:** map provider/HTTP errors in the shared stream terminal (and `ai_rewrite`) to a generic message, preserving only the distinct `MissingKey` case — mirroring `generate_title`. This is a small pre-existing-bug fix bundled because the enhance feature rides the same code (in-scope, not speculative). Flag that it also changes existing rewrite error display (an improvement, low risk).
- **M3 — Prompt content egress + no-secrets/no-logging.** "Enhance" POSTs prompt bodies to Anthropic/OpenAI over TLS (inherent, by design — document it as an egress point). Preserve the two existing invariants: never log prompt bodies (the backend is provably log-free on this path today), and never write keyring/secret material into prompt files. Add a `serialized_bytes_carry_no_secret_material`-style test for the prompt file serializer (mirror `itemfile.rs:726-736`). The strict CSP (`connect-src 'self'`, `tauri.conf.json:22`) already forces egress through Rust — do not add a webview `fetch` to a vendor.
- **M4 — No HTML/markdown rendering of prompt or model output (XSS).** The app renders all free text as React text nodes / `<textarea>` / `<pre>` today (zero `dangerouslySetInnerHTML`/`innerHTML`/markdown libs). Enhanced output is untrusted model output persisted to history; keep it in text nodes. If a preview is ever wanted, use a renderer that emits no raw HTML. Strip control/bidi/zero-width chars from any single-line display of model output the way `sanitize_title` does (`ai/mod.rs:116-145`).

### Low

- **L1 — No new dependencies.** The design reuses everything (no diff/git/markdown lib needed). Flag and justify any proposed crate/npm package before adding it (Global Rules); prefer std over pulling `git2`.
- **L2 — The prompt file store replicates itemfile hardening verbatim** — inherited by reusing `itemfile` primitives (size cap, panic-free restricted parse, conflict-marker rejection, UUID filenames, atomic write) rather than reimplementing. One-file-per-version merges more granularly than an in-file history array (which would conflict the *entire* prompt on a same-region edit).
- **L3 — Validate inputs.** `reusable` is a strict boolean; prompt title is trimmed/non-empty (mirror the item title check `sqlite.rs:469-473`); the enhance instruction reaches only the LLM, never a filename/SQL/HTML sink.

## 5. Design

### Approach

Build prompts as a **new entity with its own `PromptRepository` trait**, implemented by the existing `SqliteRepository` (which will implement *both* traits over one shared connection pool). Persist prompts + full version history in a new **canonical `prompts/` file subtree** inside each project directory, mirroring `items/`, with two **rebuildable index tables** in `index.db` (migration `0006`). Add a **router-free page toggle** in `App.tsx` and a `PromptsPage` that reuses the Worknotes two-pane CSS and the AI rewrite streaming flow.

### Architecture

**Versioning storage — chosen representation (Option B / (a), recommended by both architect and database-architect):**

```
<project-dir>/
  items/<uuid>.md                       (existing — unchanged)
  prompts/
    <prompt-uuid>/
      prompt.md                         mutable prompt-level state: id, reusable, created_at
      <version-uuid>.md                 immutable version: id, source, created_at, title (frontmatter) + body (content)
      <version-uuid>.md                 (another immutable version)
```

- **Prompt identity** = directory name (UUID). **Version identity** = file stem (UUID). Both reuse `itemfile::is_uuid`.
- **Every content edit and every AI-enhanced save writes a NEW immutable `<version-uuid>.md`** and never touches existing version files. Two branches each adding a version → two disjoint new files → clean git merge, both preserved. AI-enhance is not special-cased — it is just another new version with `source: "aiEnhanced"`.
- **"Current version" is DERIVED, never stored:** head of `ORDER BY created_at DESC, id ASC` within a prompt (fixed-ms RFC3339 → deterministic, rebuild-immune, never flaps). No `is_current` pointer to conflict on merge.
- **`prompt.md` holds only genuinely mutable prompt-level state** (`reusable` + `id` + `created_at`) — the only mutable prompt file, so a reusable toggle 3-way-merges cleanly. If `prompt.md` is lost/corrupt, the scan **synthesizes** the prompt row from its versions (`reusable=false`, `created_at = min(version created_at)`) so versions are never orphaned.

Rejected alternatives: **(c) rely on external git** — fails because whole-file sync (OneDrive/Syncthing) with no git is first-class, and pre-commit history would be invisible; **(b) stored `is_current` pointer** — the pointer is mutable state rewritten across files on every edit, guaranteeing merge conflicts; **single-file embedded history** — appending rewrites one growing file, guaranteeing same-region conflicts, and index-only history vanishes on rebuild.

**Migration `0006_prompts.sql`** (additive; inert until the rebuild code fills it, since `index.db` is rebuilt from files):

```sql
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
CREATE INDEX idx_prompt_versions_by_prompt
    ON prompt_versions (prompt_id, created_at DESC, id ASC);
CREATE INDEX idx_prompts_reusable
    ON prompts (reusable) WHERE reusable = 1;
```

No `project_id` column (a prompt's project is the store it lives in; the manager stamps ownership on return — cleaner than items, which keep a vacuous `project_id`). No `updated_at` column (derived from the current version, so it can never drift). No FTS in v1. `source` is added to the database-architect's base DDL so history can label AI-enhanced versions (reconciles architect + frontend). `ON DELETE CASCADE` keeps the in-cache child rows consistent within the rebuild transaction (`foreign_keys` is already on).

**Backend module wiring:**
- `SqliteRepository` implements **both** `ItemRepository` and `PromptRepository` over one shared pool; add a `prompts_dir: Option<PathBuf>` seam beside `items_dir`. `open_store` builds one `Arc<SqliteRepository>` and coerces two clones into `Arc<dyn ItemRepository>` + `Arc<dyn PromptRepository>` held in `LoadedProject`. One pool, one `close()`.
- `ProjectManager` gains prompt routing/stamping (mirror `create`/`owner`) and, if the Prompts page shows an "All projects" view, prompt fan-out reads (mirror `list_all`).

**Data model (Rust `models.rs` ↔ TS `types.ts`, serde camelCase):**
- `Prompt { id, title, body, reusable, createdAt, updatedAt, versionCount, projectId }` — `title`/`body` are the current version's; `updatedAt` = current version `createdAt` (derived); `projectId` stamped by manager, not persisted in-file; `versionCount` lets the list row show a `vN` badge without a full history fetch.
- `PromptVersion { id, promptId, title, body, source, createdAt }` — `source: "manual" | "aiEnhanced"`. (`promptId` is derived from the directory on scan, not persisted in the version file — same principle as items not storing `project_id`.)
- `NewPrompt { projectId (required), title, body?, reusable? }`
- `UpdatePrompt { title?, body?, reusable?, source? }` — omitted fields mean "unchanged"; `source` defaults to `"manual"` and is set to `"aiEnhanced"` by the accept-proposal path.
- `PromptListFilter { projectId?, reusableOnly? }`

### Key Decisions

1. **`update_prompt` implicitly appends a version on any content change; there is no separate `add_prompt_version` command** (reconciles the architect's explicit-command proposal with the frontend's simpler `updateItem`-style patch). Rationale: matches how Pin/Archive/tags all go through `updateItem` patches (no bespoke commands); keeps version creation entirely backend-owned (satisfies H2); one mutation entry point. A title or body change appends a new version file (with `source` from the patch); a `reusable`-only change rewrites `prompt.md` and appends **no** version and does **not** move `updatedAt`. The architect's explicit `add_prompt_version` remains a documented alternative if a caller ever needs to add a version without a diff.
2. **Every content edit is versioned** (the literal reading of "full history including edits and previous versions"), not only AI-enhanced saves. Saves are already discrete deliberate actions (Save button / Ctrl+S / accept), never per-keystroke, so this is cheap. If the intent were "only AI versions tracked," the model is unchanged — `source` simply never takes `"manual"` on non-first versions. Flagged as an open question (§10) but built for the literal reading.
3. **No `parentVersionId` / linear history only.** History is a flat per-prompt sequence ordered by `(created_at DESC, id ASC)`; the previous version is the next-older. Omitted per "minimum code, nothing speculative"; noted as a trivial future addition.
4. **Router-free navigation.** A `page: "worknotes" | "prompts"` `useState` in `App.tsx` renders one of two views. A router is an unwarranted dependency (no deep-linking, no URL bar in the Tauri webview). Trade-off: no browser history/deep-links — not needed.
5. **Active-tab indicator is an ink underline, not the signature yellow.** DESIGN.md reserves `--mark` yellow for the one signature element (the AI review card); `.chip-on` already uses solid-ink fill for in-rail filters. A top-level nav uses an **ink bottom-border underline** (ink already means "current/focused" via `:focus-visible`), keeping yellow AI-exclusive and distinguishing page-nav from rail-filter selection.
6. **AI enhance reuses `ai_rewrite_stream` verbatim — no new AI command.** The prompt editor's `Replace text` calls `update_prompt(id, { body: proposal, source: "aiEnhanced" })`; a manual save calls `update_prompt(id, { ... })` with default `source`. Backend appends the version either way.
7. **Reuse the AI review-card UI and `AiBar` unchanged** for the enhance proposal (same soft-yellow card, same `Replace text`/`Discard` verbs) — introducing a second AI-proposal UI would violate DESIGN.md's "yellow is the one signature element."

**Command contract:**

| Command | Params | Returns |
|---|---|---|
| `list_prompts` | `filter?: PromptListFilter` | `Prompt[]` (current view) |
| `get_prompt` | `id: string` | `Prompt` (current) |
| `create_prompt` | `input: NewPrompt` | `Prompt` (mints prompt + first version) |
| `update_prompt` | `id: string, patch: UpdatePrompt` | `Prompt` (appends a version iff content changed) |
| `list_prompt_versions` | `promptId: string` | `PromptVersion[]` (newest-first) |
| `delete_prompt` | `id: string` | `void` |

AI enhance reuses `ai_rewrite_stream` (no new command). Toggle-reusable reuses `update_prompt` (no dedicated command). No `search_prompts` in v1 (reusable filter only).

## 6. Implementation Steps

Work top-to-bottom; each step is independently verifiable with `cd notes-app/src-tauri && cargo test`, `cd notes-app && npx tsc --noEmit`, and `npm run build`.

**Step 1 — Storage layer + allowlist (backend, no UI yet).**
1. Refactor: make `itemfile` primitives `pub(crate)` (`is_uuid`, `quote`/`unquote`, `has_conflict_markers`, `read_capped`) so `promptfile` shares them (small, flagged refactor — no behavior change, no new dep). Prompt and version files reuse the same 4 MB `MAX_ITEM_FILE_BYTES` cap intentionally (no separate limit — prompts are not expected to exceed items).
2. Create `src-tauri/src/store/promptfile.rs`: `serialize`/`parse`/`write`/`remove` for `prompt.md` (frontmatter: id, reusable, created_at) and version files (frontmatter: id, source, created_at, title; content: body), plus a **two-level `scan(prompts_dir)`** — this is the one place that is materially harder than `itemfile::scan` (which is flat), so specify it explicitly:
   - Iterate the immediate subdirectories of `prompts/`. A subdirectory name that is not a valid UUID (`is_uuid`) is skipped and reported (do not recurse into it).
   - Within each `<prompt-uuid>/` dir, read `prompt.md` if present (parse id/reusable/created_at); if it is missing **or** fails to parse, **synthesize** the prompt row (`reusable = false`, `created_at = min(version created_at)`) so versions are never orphaned (H2/§5).
   - Read each `<version-uuid>.md`: skip+report files whose stem is not a UUID, that exceed the cap, or that contain git conflict markers (reuse `has_conflict_markers`); parse id/source/created_at/title/body; derive `prompt_id` from the parent directory name (never persisted in-file, mirroring items not storing `project_id`).
   - Return a per-prompt / per-version partial-success outcome mirroring `itemfile`'s `ScanOutcome`/`ItemFileError` — a `(name, reason)` list of skipped entries plus the successfully parsed prompts+versions — so the manager can report conflict/parse failures the same way it does for items today.
   - Register `pub mod promptfile;` in `store/mod.rs`.
3. Create migration `src-tauri/migrations/0006_prompts.sql` (DDL in §5).
4. **Extend `KNOWN_TABLES` in `db/sqlite.rs:31-38` with `"prompts"` and `"prompt_versions"`** (H1). Do not touch the FTS prefix or triggers (no prompt FTS in v1).
5. Tests: `promptfile` round-trip is byte-stable; conflict-marker rejection; no-secret-material serialization (mirror `itemfile.rs` tests); and a `tests/project_manager.rs` test that a store created + migrated with `0006` **reopens cleanly** (guards H1).

**Step 2 — `PromptRepository` + manager wiring.**
6. Add `PromptRepository` trait (`db/mod.rs` or a sibling module): `list(&PromptListFilter) -> Vec<Prompt>`, `get(id) -> Prompt`, `create(NewPrompt) -> Prompt`, `update(id, UpdatePrompt) -> Prompt`, `versions(prompt_id) -> Vec<PromptVersion>`, `delete(id)`. Add `Prompt`/`PromptVersion`/`NewPrompt`/`UpdatePrompt`/`PromptListFilter` to `models.rs` (serde camelCase).
7. Implement the trait on `SqliteRepository` (file-then-index, like items): `create` mints prompt dir + `prompt.md` + first version file, then inserts index rows; `update` appends a new version file iff `title`/`body` changed (server-minted id + `now_rfc3339`), rewrites `prompt.md` on `reusable` change, never mutates existing version files (H2); `list`/`get` derive current via `ORDER BY created_at DESC, id ASC LIMIT 1`; `versions` returns newest-first; `delete` removes the prompt dir + all index rows; validate non-empty title, strict-bool reusable (L3). Add the `prompts_dir` seam.
8. Extend `rebuild_from_dir` (`sqlite.rs:291-338`, currently `fn rebuild_from_dir(&self, items_dir: &Path)`) to also clear + repopulate `prompts`/`prompt_versions` from `promptfile::scan` in the same transaction, parent rows before child rows (H3). Give it a second explicit `prompts_dir: &Path` parameter for symmetry with the existing `items_dir` arg (the call site at `projects/mod.rs:697-698` passes the dir explicitly). Missing `prompts/` → empty scan (no error), mirroring `itemfile::scan`.
9. `LoadedProject` holds both `Arc<dyn ItemRepository>` and `Arc<dyn PromptRepository>` from one `Arc<SqliteRepository>`; `open_store` attaches `prompts_dir` and rebuilds prompts alongside items. Add prompt routing/stamping in `ProjectManager` (mirror `create`/`owner`), plus fan-out for an all-projects view if used.
10. **Extend `remove_store_files` (`projects/mod.rs:811-831`) to sweep `prompts/`** (H3).
11. Tests in `tests/repo.rs`: create → update(body) appends exactly one version, original byte-intact → history ordering stable on equal timestamps → reusable toggle appends no version + no `updatedAt` bump → delete; AI-enhanced update sets `source:"aiEnhanced"` and preserves the prior version; reusable filter returns only reusables (empty, not error, when none). Tests in `tests/project_manager.rs`: prompt lands only in its target store; reload rebuilds prompts + full history from files out-of-band; Delete-files removes `prompts/`. Add an `export_import.rs` fixture: two branches each add a version → two disjoint files rebuild without conflict (the acceptance test for Option B).

**Step 3 — Commands + IPC surface.**
12. Add `create_prompt`/`list_prompts`/`get_prompt`/`update_prompt`/`list_prompt_versions`/`delete_prompt` in `commands.rs`; register in `lib.rs` `invoke_handler![...]`. Factor testable logic into free functions where the enhance/version logic warrants it (commands themselves stay thin, per the codebase's untested-wrapper convention).
13. Mirror the contract in `src/lib/api.ts` (thin `invoke` wrappers) and `src/types.ts` (camelCase DTOs). Frontend calls only `api.ts`.

**Step 4 — Frontend page + navigation.**
14. Add `page: "worknotes" | "prompts"` state in `App.tsx`; extract the current two-pane body into `WorknotesPage.tsx`; render one page or the other. Hoist global dialogs/toasts above the branch.
15. Add the header tab pair (WAI-ARIA `role="tablist"`/`tab`, `aria-selected`, `aria-controls`, roving `tabIndex`, Left/Right arrow activation) after the wordmark; ink-underline active style in `styles.css` (`.page-tabs`/`.page-tab`/`.page-tab-on`). Pass the existing shared `knownProjects`/`loaded` state to both pages (no second project fetch).
16. Build `PromptsPage.tsx` (own list/selection/draft/filter state + token-guarded load, copying `App.tsx:66-83`), `PromptList.tsx` (reuse `.rail`/`.chips`/`.list`/`.row` CSS; row = title + `REUSABLE` `.pill` badge (not yellow) + preview + mono `updated` + `vN` badge; `All`/`Reusable only` chips reusing the `KINDS` tablist pattern, AND-combined with project filter), `PromptEditor.tsx` (reuse `.editor-head`/`.meta`/`.body`, the review card, and `AiBar` verbatim; drop status/priority/due/pin/archive/tags; add a `Mark reusable`/`Unmark reusable` `aria-pressed` verb-button, a `History` button, and a **`Delete` button** that calls `api.confirmDialog()` then `deletePrompt(id)` — mirroring the Item Delete path at `Editor.tsx:476-494`/`App.tsx:331-344`; `Replace text` on an AI proposal calls `updatePrompt(id, { body: proposal, source: "aiEnhanced" })`), and `PromptHistoryDialog.tsx` (`.scrim`/`.dialog role="dialog"`, newest-first versions with origin tag + timestamp + text; add initial-focus + Escape-to-close). For the AI bar, **decision: add a second prompt-oriented `PRESETS` constant** rather than threading a preset prop through `AiBar` — `PRESETS` is a private module constant today (`AiBar.tsx:18-23`) with no props seam, so a sibling constant is the smaller change and avoids a speculative parameterization (Global Rules "minimum code").
17. Add pure helpers in `src/lib/prompts.ts` (reusable-filter predicate, version-history formatting) tested in `src/lib/prompts.test.ts` (node-only vitest, pure functions — no DOM/RTL, matching repo convention).
18. Update `docs/DESIGN.md` with a "Page switching (new)" and "Prompts page (new)" subsection (markup, ink-underline tokens, reusable pill, history dialog) — mirroring how "Due dates (new)"/"JIRA (new)" were added. DESIGN.md wins over the prototype.

**Step 5 — AI error scrubbing (security M2).**
19. Add a small shared scrubbing helper in `ai/mod.rs` (a `scrub_provider_error`-style free function, or reuse/extract the exact mapping `generate_title` already applies at `ai/mod.rs:190-196`) that maps any non-`MissingKey` provider/HTTP error to a single generic message. **Call it from both** `ai_rewrite` (`commands.rs:170`) and the `ai_rewrite_stream` terminal (`commands.rs:281-284`) so neither propagates the raw upstream body, preserving only the distinct `MissingKey` case. This is why `ai/mod.rs` is a definite (not conditional) modify in §7. Add/extend a test asserting a provider error collapses to generic copy without the raw body (mirror the title-path test). Note in the commit that this also fixes the pre-existing rewrite leak.

**Step 6 — Verification.**
20. Run the full gate: `cargo test`, `npx tsc --noEmit`, `npm run build`, and `npm run tauri dev` manual smoke (see §9). Fix regressions before finishing.

## 7. Files to Create or Modify

| File | Action | Purpose |
|---|---|---|
| `notes-app/src-tauri/migrations/0006_prompts.sql` | Create | `prompts` + `prompt_versions` tables + indexes (§5) |
| `notes-app/src-tauri/src/store/promptfile.rs` | Create | Canonical prompt/version file serialize/parse/scan/write/remove |
| `notes-app/src-tauri/src/store/itemfile.rs` | Modify | Expose `is_uuid`, `quote`/`unquote`, `has_conflict_markers`, `read_capped` as `pub(crate)` |
| `notes-app/src-tauri/src/store/mod.rs` | Modify | `pub mod promptfile;` |
| `notes-app/src-tauri/src/db/mod.rs` | Modify | `PromptRepository` trait |
| `notes-app/src-tauri/src/db/sqlite.rs` | Modify | Impl `PromptRepository`; extend `KNOWN_TABLES` (H1); extend `rebuild_from_dir` (H3); `prompts_dir` seam |
| `notes-app/src-tauri/src/models.rs` | Modify | `Prompt`/`PromptVersion`/`NewPrompt`/`UpdatePrompt`/`PromptListFilter` DTOs |
| `notes-app/src-tauri/src/projects/mod.rs` | Modify | `LoadedProject` dual-trait; prompt routing/stamping/fan-out; `open_store` prompt rebuild; `remove_store_files` sweeps `prompts/` (H3) |
| `notes-app/src-tauri/src/commands.rs` | Modify | Six prompt commands; scrub AI rewrite/stream errors (M2) |
| `notes-app/src-tauri/src/lib.rs` | Modify | Register prompt commands in `invoke_handler!` |
| `notes-app/src-tauri/src/ai/mod.rs` | Modify (M2) | Add/extract a shared `scrub_provider_error` helper (generic-error mapping) called by both rewrite commands |
| `notes-app/src/lib/api.ts` | Modify | Prompt IPC wrappers |
| `notes-app/src/types.ts` | Modify | Prompt DTOs (camelCase mirror) |
| `notes-app/src/App.tsx` | Modify | `page` state; header tablist; render Worknotes/Prompts; pass shared project state |
| `notes-app/src/components/WorknotesPage.tsx` | Create | Extracted current two-pane body |
| `notes-app/src/components/PromptsPage.tsx` | Create | Prompts two-pane container + state |
| `notes-app/src/components/PromptList.tsx` | Create | Rail: rows, reusable pill/filter, project label |
| `notes-app/src/components/PromptEditor.tsx` | Create | Detail pane: title/body, reusable toggle, History button, AI enhance (reuses AiBar + review card) |
| `notes-app/src/components/PromptHistoryDialog.tsx` | Create | Version history modal (newest-first) |
| `notes-app/src/lib/prompts.ts` | Create | Pure helpers (reusable filter, history formatting) |
| `notes-app/src/styles.css` | Modify | `.page-tabs`/`.page-tab`/`.page-tab-on` ink underline; any prompt-specific classes |
| `notes-app/docs/DESIGN.md` | Modify | "Page switching (new)" + "Prompts page (new)" spec |
| `notes-app/src-tauri/tests/repo.rs` | Modify | Prompt repository invariant tests |
| `notes-app/src-tauri/tests/project_manager.rs` | Modify | Reopen-after-migrate (H1); reload rebuild; Delete-files sweep (H3) |
| `notes-app/src-tauri/tests/export_import.rs` | Modify | Two-branch version-merge fixture |
| `notes-app/src/lib/prompts.test.ts` | Create | Pure-helper unit tests |

## 8. Test Strategy

*(Source: test-writer, mapped to existing conventions — `tests/repo.rs` in-memory `SqliteRepository::connect_in_memory`; `tests/project_manager.rs` `tempfile::tempdir` real stores; hand-rolled `FakeProvider`/`MockSink` AI mocks — no mocking framework; node-only vitest pure helpers — no jsdom/RTL/component tests; `#[tauri::command]` wrappers are never unit-tested — logic goes in free functions.)*

- [ ] **Unit Tests (Rust, `tests/repo.rs`):**
  - `create` returns a prompt with backend-owned `id`/`createdAt`/`updatedAt` and a first version; empty/whitespace title is rejected.
  - `update` with an empty/whitespace title patch is rejected (mirror the item `update` check `sqlite.rs:551-554`).
  - `get`/`update`/`delete` round-trip; second `delete` is `NotFound`.
  - Toggling `reusable` true→false→true creates **no** version and does **not** bump `updatedAt`.
  - A title or body edit **does** append exactly one version and **does** bump `updatedAt` (= new current version `createdAt`).
  - Version history: each edit appends one version; `versions()` is monotonic newest-first and does not flap on equal timestamps (force equal timestamps + fixed ids via test hooks, assert stable across 3 reads — mirror `sort_equal_timestamps_tiebreak_by_id_asc`).
  - AI-enhance: `update(..., source:"aiEnhanced")` saves a new version; the immediately-prior version is byte-for-byte unchanged and still retrievable (assert both in one test).
  - `source` persists (`"manual"` default, `"aiEnhanced"` when set) and survives a rebuild.
  - Reusable filter returns only reusables; empty (not error) when none match.
  - camelCase serde shape: `reusable`, `createdAt`, `updatedAt`, `projectId`, `versionCount`; `NewPrompt` deserializes from camelCase with required `projectId`, optional fields omittable.
- [ ] **Integration Tests (Rust, `tests/project_manager.rs` + `tests/export_import.rs`):**
  - A store created + migrated with `0006` **reopens cleanly** (guards H1 — the highest-value test).
  - Prompt created under project A never appears when scoped to project B.
  - Reload/`rebuild_from_dir` reconstructs prompts **and full version history** from files added out-of-band (mirror `reload_picks_up_files_added_and_removed_out_of_band` and `a_git_clone_with_only_item_files_builds_a_fresh_index_on_open`).
  - Missing/corrupt `prompt.md`: a `<prompt-uuid>/` dir with version files but no (or an unparseable) `prompt.md` is **synthesized** into a prompt row (`reusable=false`, `created_at = min(version created_at)`) with all versions intact — guards the §5 "versions are never orphaned" guarantee.
  - Version-filename safety: `promptfile` rejects a version/prompt id that is not a valid UUID (path traversal `../escape`, reserved names `CON`, separators `a/b`, ADS `a:b`) — a named negative test mirroring `file_name_is_derived_from_the_uuid_and_rejects_unsafe_ids` (`itemfile.rs:707-715`) (guards H2's filename-safety half).
  - Byte-deterministic round-trip for prompt + version files (mirror `idempotent_export_is_byte_stable`); conflict-marker files skipped and reported (mirror `reload_reports_conflict_marker_files_and_imports_the_rest`).
  - Two branches each `add version` to the same prompt → two disjoint version files rebuild with no conflict (acceptance test for the versioning choice).
  - Delete-files removes `prompts/` (guards H3); no-secret-material serialization test (M3).
- [ ] **Frontend Unit Tests (vitest, `src/lib/prompts.test.ts`, pure helpers only):**
  - Reusable-filter predicate: filtered subset; empty list → `[]`; toggle off → passthrough.
  - Version-history formatting helper: pure input→output, fixed injected timestamp (no `Date.now()` flakiness).
  - (Header page-switch and component behavior get **no** automated coverage under the repo's node-only vitest convention — this matches the existing deliberate choice, no new test infra; they become manual-smoke items.)
- [ ] **AI mock/stub requirements (Rust):**
  - Reuse the hand-rolled `FakeProvider` + `Outcome` enum + `AtomicBool` `was_called()` from `tests/ai_title.rs`; assert enhancing empty text short-circuits before calling the provider; provider error collapses to generic copy without raw body (M2); whitespace-only output is a failure, not empty success. No `mockall` (would be a flagged new dependency).
- [ ] **E2E / Manual smoke (`npm run tauri dev`):**
  - Header Worknotes↔Prompts toggle shows the right pane with correct active state; switching does not lose the other pane's in-progress edit.
  - Create a prompt while a project is the active filter → scoped to that project.
  - Mark reusable → appears under `Reusable only`; unmark → disappears; toggling shows no version bump.
  - AI enhance → `Replace text` → new version appears in History with the original intact and viewable.
  - AI enhance with no API key → the same `MissingKey` "add one in Settings" copy path as rewrite/title.
  - Delete a single prompt from the editor → `confirmDialog` fires, the prompt disappears from the list, and its `prompts/<uuid>/` directory (all versions) is removed from disk.
  - Delete a project that has prompts → prompt files are gone (cascade).

## 9. Success Criteria

- [ ] **Functional:** Header shows Worknotes + Prompts with a clear active indicator; both pages share one project catalog; users can create/view/manage per-project prompts; a prompt can be marked reusable and filtered; full version history is viewable with the original always preserved; AI enhance produces a saveable version added to history without destroying the original.
- [ ] **Tests:** All tests in §8 pass (`cd notes-app/src-tauri && cargo test`, plus vitest).
- [ ] **Security:** H1 (allowlist widened + reopen test), H2 (backend-owned append-only versions, UUID filenames), H3 (Delete-files sweeps `prompts/`, rebuild includes prompts), M2 (rewrite/enhance errors scrubbed), M3 (no-secret test, no body logging), M4 (no HTML rendering) all implemented and verified.
- [ ] **Quality:** `npx tsc --noEmit` clean (strict, `noUnusedLocals`), `npm run build` clean, existing `cargo test` suite still green, no new dependencies added without a flag.

## 10. Risks & Open Questions

- **Adversarial-verifier verdicts (both CONFIRMED, high confidence):** H1 (allowlist runs before migrate; new tables brick reopen unless `KNOWN_TABLES` widened; FTS allowance is exact `starts_with("items_fts")`) and M2 (raw provider body leaks on *both* rewrite and stream paths; `generate_title` scrubs). No REFUTED/UNVERIFIABLE claims. These drive Steps 1(4), 2(11), and 5.
- **Open question — versioning granularity (Key Decision 2):** built for "every content edit is a version." If the user wants *only* AI-enhanced saves tracked, the model is unchanged — `source` simply never takes `"manual"` on later versions and manual edits overwrite the current version in place. **Recommend confirming with the user before Step 2.**
- **Open question — "restore a previous version":** the requirement says *display* history, not restore. Not built (per "nothing speculative"). A restore = `update_prompt` with an old version's body (creating a new version) — a cheap follow-on if wanted.
- **Open question — prompts on the "All projects" view:** if the Prompts page offers an all-projects aggregate like Worknotes, prompt fan-out + k-way merge are needed (Step 2(9)); if prompts are always viewed one project at a time, that code is unnecessary. Defaulting to mirroring Worknotes (fan-out included); confirm if simpler is preferred.
- **Risk — dual-trait `SqliteRepository` seam:** implementing two traits over one pool and coercing two `Arc`s is the one non-obvious backend seam; get it right in Step 2(9) or `open_store` wiring breaks. Covered by the reopen + reload integration tests.
- **Risk — bundling the M2 fix touches existing rewrite behavior.** Scrubbing changes what the existing rewrite error toast shows. It is in-scope (enhance rides the same path) and an improvement, but call it out in the commit so it is not a surprise regression in rewrite error copy.
- **Risk — DESIGN.md has no Prompts slot.** Adding the spec (Step 4(18)) is required so DESIGN.md stays authoritative; skipping it leaves the prototype and spec disagreeing.
- **Stale-doc note:** the root `CLAUDE.md` "removal guard" and "rowid tiebreak" invariants describe the pre-plan.6 row-based model and are stale for this feature; do not implement a project-removal guard, and order versions on `(created_at DESC, id ASC)`.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced
- [ ] Error handling covers failure modes (missing key, provider error scrubbed, corrupt/missing `prompt.md` synthesizes from versions, conflict-marker files skipped+reported)
- [ ] No security vulnerabilities: `KNOWN_TABLES` widened (H1); version filenames derive only from backend UUIDs, no user text in paths (H2); `remove_store_files` sweeps `prompts/` and rebuild includes prompts (H3); rewrite/enhance errors scrubbed (M2); no prompt-body logging and no secrets in files (M3); prompt/model text rendered only as text nodes/`<textarea>`/`<pre>` (M4)
- [ ] Security considerations from §4 addressed (H1–H3, M1–M4, L1–L3)
- [ ] Follows conventions: sqlx runtime API only; additive migration only (`0006`, never edit existing); RFC3339 fixed-ms timestamps via `now_rfc3339`; serde camelCase mirror between `models.rs` and `types.ts`; frontend calls only `api.ts`; DESIGN.md tokens (yellow stays AI-exclusive)
- [ ] Tests cover happy path, edge cases (empty title, equal timestamps, no-match filter), and error scenarios; each new invariant has a test in the same commit
- [ ] No performance regressions (append-only writes are O(1); current-version is an indexed `LIMIT 1`; reusable filter uses the partial index; no N+1 across the version list)
- [ ] Changes are minimal — no unrelated refactoring beyond the flagged `pub(crate)` exposure of itemfile primitives; no new dependencies

## 12. Post-Review Improvements

*(Filled after implementation. Two read-only reviews ran against the full diff: a **code-reviewer** against the §11 checklist and a **security-auditor** against §4. Both found **no critical or security defects** — H1/H2/H3/M2/M3/M4 are all implemented and each has a meaningfully-failing regression test, and versioning correctness was verified by reading the assertions. The findings below were surfaced and resolved.)*

### Implemented

1. **AI-enhance-on-a-draft dropped provenance (code-review Warning 1 — real bug).** Accepting an AI proposal on a brand-new draft *before* any manual save created the prompt via `create_prompt`, whose first version was hardcoded `source = "manual"` — so a 100%-AI first version showed a "manual" pill in history, contradicting the feature's provenance guarantee. **Fix:** added an optional `source` to `NewPrompt` (`models.rs` + `types.ts`), normalized it server-side via a shared `normalize_prompt_source` helper (used by both `create` and `update`, so the index and files can never disagree), and threaded `overrides?.source` through `PromptEditor`'s draft-save path. New test `prompt_create_with_ai_enhanced_source_labels_the_first_version` (`repo_prompts.rs`) covers it. Ids/timestamps remain backend-owned (H2 unaffected — only the closed-set `source` label is client-influenced, and it is normalized).
2. **`list()` reusable filter ignored the partial index (code-review Warning 2).** The `ranked` CTE ranked *every* version of *every* prompt before the outer `WHERE p.reusable = 1`, so "Reusable only" cost O(all versions). **Fix:** when `reusable_only`, the CTE now filters `pv.prompt_id IN (SELECT id FROM prompts WHERE reusable = 1)` before ranking, so `idx_prompts_reusable` drives the scan; the outer filter became redundant (a non-reusable prompt has no `ranked` row to join) and was removed. Still a static literal — no user text in SQL (M1). Covered by the existing `prompt_reusable_filter_returns_only_reusables_empty_when_none` test.
3. **`rebuild_from_dir` could leave a childless parent row (security-audit low/informational).** If a hand-copied tree gave a prompt directory only version files whose UUIDs were already seen (cross-prompt duplicate), the parent `prompts` row was inserted with zero surviving children (invisible via the current-version `JOIN`, but an index inconsistency). **Fix:** the rebuild now computes the surviving (de-duplicated) versions first and skips the parent insert entirely when none survive, reporting it as a warning. Reachable only via manually duplicated UUID-named files (ids are server-minted), so it was cosmetic, but the fix makes the index self-consistent.
4. **Redundant client-side reusable filter (code-review nit).** `PromptsPage` re-filtered with `filterReusable` on top of the already server-filtered `listPrompts({ reusableOnly })`. **Fix:** made the server filter authoritative (matching how `ItemList`'s filters work) and removed the client re-filter; the now-unused `filterReusable` helper and its unit tests were deleted to avoid dead code. `prompts.test.ts` retains `sourceLabel`/`formatWhen` coverage.

### Accepted with rationale (no change)

5. **`WorknotesPage.tsx` not extracted (§6 step 14 / §7 file list).** The existing two-pane Worknotes body was kept inline in `App.tsx` behind a `page === "worknotes"` branch (wrapped in a `.page-body[hidden]` container using `display: contents`, so `.panes`' `flex: 1` sizing is untouched and both pages stay mounted → switching preserves in-progress edits). Extracting it would force the `onSave`/`onDelete`/etc. handlers (which close over `selected.id`/`selected.title`) outside the `{selected ? …}` narrowing, adding null-guards for zero behavioral benefit and real regression risk. The "both pages mounted, state survives switching" requirement (§8/§9) is met without the extraction.
6. **No "all projects" prompt fan-out (§10 open question / code-review nit).** The plan's *default* was to mirror Worknotes with fan-out, but the execution prompt asked to **confirm this with the user before Step 2** — and the user chose **"one project at a time."** So `list_prompts` requires a `projectId` and there is no k-way merge for prompts. This is the confirmed decision, not a silent deviation (see `list_prompts_without_a_project_id_is_invalid`).
7. **`update()` dual file-write is not transactional across both files (code-review nit).** When a single `update` changed *both* content and `reusable`, `write_version` then `write_prompt` run as two fallible ops before the DB transaction; a failure between them could leave a new version file with no index row. This is **unreachable through the shipped UI** (the reusable toggle and content Save never combine in one call) and **self-healing** — files are the source of truth, so the next Reload rebuilds the index from the on-disk files (the same file-then-index contract items already rely on). Left as-is per "minimum code."

## 13. Execution Prompt

```
Implement Plan 7 (Prompts page) for the worknotes app. The app source is under the notes-app/ subdirectory.

1. READ the plan first, in full: notes-app/plans/plan.7.md. Also read notes-app/CLAUDE.md (architecture invariants) before writing any code.

2. Before starting Step 2, confirm ONE open question with the user (see §10): should EVERY content edit create a version, or only AI-enhanced saves? Default to "every content edit" if no answer. Also confirm whether the Prompts page needs an "all projects" aggregate view (default: yes, mirror Worknotes).

3. Implement the plan step by step, following Section 6 exactly (Step 1 storage+allowlist → Step 2 repository+manager → Step 3 commands+IPC → Step 4 frontend+nav → Step 5 AI error scrubbing → Step 6 verification). Honor every architecture invariant in notes-app/CLAUDE.md: sqlx runtime API only; additive migration 0006 only (never edit an existing migration); RFC3339 fixed-ms timestamps via now_rfc3339; serde camelCase DTOs mirrored between models.rs and types.ts; the frontend calls storage/AI only through src/lib/api.ts; the two swap-point traits (ItemRepository, AiProvider) must not leak concrete impls to commands; DESIGN.md is authoritative and yellow stays reserved for the AI signature element.

4. CRITICAL security items from Section 4 (do not skip): extend KNOWN_TABLES with "prompts" and "prompt_versions" in db/sqlite.rs IN THE SAME CHANGE as migration 0006, or every existing project bricks on second open (H1 — CONFIRMED); teach remove_store_files to sweep prompts/ and rebuild_from_dir to rebuild prompts+versions (H3); mint version ids/timestamps server-side and never mutate an existing version file, and derive version filenames only from backend UUIDs via itemfile::is_uuid (H2); scrub provider/HTTP errors in the shared ai_rewrite_stream terminal and ai_rewrite so the enhance path does not leak raw upstream bodies (M2 — CONFIRMED), preserving the distinct MissingKey case; add a no-secret-material test for the prompt file serializer and never log prompt bodies (M3); render all prompt and model text only as text nodes / <textarea> / <pre> — no dangerouslySetInnerHTML or markdown-to-HTML (M4); do not add any new crate or npm dependency without flagging it first (L1).

5. Use subagents during implementation (fallback clause: if a named agent type is unavailable, fall back to a generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise — with the role stated in the prompt):
   - Spawn a database-architect (or fallback) to write migration 0006 and the promptfile.rs canonical store, since it touches the file-per-item + rebuildable-index model.
   - Spawn a frontend-specialist (or fallback) for the App.tsx page toggle, header tablist, and the Prompts page components, matching DESIGN.md tokens.
   - Spawn a test-writer (or fallback) to write the tests per Section 8 (extend tests/repo.rs, tests/project_manager.rs, tests/export_import.rs, and add src/lib/prompts.test.ts), proving each new test can fail.
   - After implementation, spawn a code-reviewer agent (read-only: Read, Grep, Glob; fallback general-purpose read-only) to review the diff against Section 11.
   - After implementation, spawn a security-auditor agent (read-only: Read, Grep, Glob; fallback Explore) to verify every mitigation in Section 4 (especially H1, H3, M2) is actually present.
   - Do NOT spawn api-designer/devops/performance agents — this feature does not touch their domains (the IPC surface is Tauri commands, covered by the plan).

6. Run the Section 11 code review checklist after implementation and address every item.

7. Document any improvements found in review in Section 12 of the plan file, then implement them.

8. Before finishing, run the full verification gate and fix any regressions: `cd notes-app/src-tauri && cargo test`, then `cd notes-app && npx tsc --noEmit`, then `npm run build`, then a `npm run tauri dev` manual smoke of the Section 9 criteria. Report results plainly — failing tests or skipped smoke steps are results, not things to smooth over. (Note the project-memory caveats: a leftover notes-app.exe can lock target/debug during cargo test — kill it first; and cargo test link can fail LNK1318 on a near-full C: — clean target / disable debuginfo if so.)
```
