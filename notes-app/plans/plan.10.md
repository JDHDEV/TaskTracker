# Plan 10: Per-item `schemaVersion` marker + 1.0.0 release

**Created:** 2026-07-20
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Two loosely-coupled deliverables under one request:

1. **Schema-version marker.** Stamp a `schemaVersion` field (value `"1.0.0"`) on every note, task, and prompt when it is created, persisted in the canonical Markdown files (the source of truth) and mirrored into the rebuildable SQLite index. It is a *format* marker so a future migration can identify records written under the 1.0.0 shape and upgrade them.
2. **1.0.0 release.** Bump the app version to `1.0.0` across the three version files, create long-lived `dev` and `release` branches, build the Windows installer, and publish it as a public GitHub Release.

The chosen field name is **`schemaVersion`** (`schema_version` in Rust/SQL), not the literally-requested `version` — every research agent flagged that `version` collides with the prompt version-*history* concept (`prompt_versions`, `versionCount`, the `vN` badge). The user confirmed `schemaVersion`.

The release deliverable is planned exactly as requested but marked a **hard STOP gated on explicit user authorization**, because it publishes company IP (`com.vendnovation.worknotes`, publisher `VendNovation`) as an unsigned installer from what is currently a private repo.

## 2. Strategic Assessment

*(tech-lead)*

The two halves have very different risk profiles and should be executed and reviewed as separate commits/decisions, not one "feature."

- **The version bump is trivial, legitimate housekeeping.** The tech-lead correctly identified all three files that must move in lockstep.
- **The tech-lead pushed back hard on the per-item marker mechanism**, and the concern is recorded honestly here even though the user has confirmed the feature:
  - A hardcoded constant carries no information that `createdAt` + git history don't already carry; the *real* "old record" signal is the **absence** of the field.
  - This codebase already has a per-store DB marker (`meta.schema_version`) and sqlx migration versioning; a per-*row* marker is only justified because the git-syncable file model lets records authored by **different app versions coexist in one store** (two machines syncing `items/` over git). That scenario is real, which is what makes a per-record/per-file marker defensible rather than redundant.
  - The word `version` was a naming landmine on prompts — resolved by choosing `schemaVersion`.
- **The riskiest part is the public GitHub Release, and it is a policy decision, not an engineering one.** Publishing VendNovation IP publicly needs a human owner's sign-off; the installer is unsigned (SmartScreen), there is no auto-updater (so 1.0.0 users are stranded — ironic given the migration justification), and the installer story was previously Phase 4 backlog. The plan therefore gates it.
- **`dev`/`release` long-lived branches are process for a solo local-first tool.** Cheap and reversible, so low risk, but trunk-based + release *tags* would be simpler. Included as requested.

**Highest-level approach:** Implement the marker end-to-end in the canonical files first (the index follows), keeping it backend-owned and create-only so it never touches `updatedAt`; ship the version bump and branch/release as a separate, explicitly-authorized sequence with a pre-release safety checklist.

## 3. Research Findings

*(architect + database-architect + devops-engineer)*

### 3.1 The load-bearing fact: files are the source of truth, `index.db` is disposable

`index.db` is **git-ignored and rebuilt from disk on every open** (`ProjectManager::open_store` → `SqliteRepository::rebuild_from_dir`, which does `DELETE FROM items`/`DELETE FROM prompts` then re-`INSERT`s from parsed files). The canonical records are:

- **Items** (notes and tasks share one shape, discriminated by `kind`): one row in table `items`, one file `items/<uuid>.md` (`store/itemfile.rs`).
- **Prompts** (separate entity): head file `prompts/<uuid>/prompt.md` (`id`, `reusable`, `created_at`) in table `prompts`, plus N immutable version files `prompts/<uuid>/<version-uuid>.md` in table `prompt_versions`. The `Prompt` DTO's `title`/`body`/`updatedAt`/`versionCount` are **derived** from the current version via a `ROW_NUMBER()` CTE; only `reusable` is mutable on the head.

**Consequence:** a `schemaVersion` that lives only in the SQLite column is re-stamped with its SQL `DEFAULT` on every rebuild and never reaches git. The durable marker MUST be written to the canonical files; the migration/column only keeps the index faithful and covers freshly-minted stores.

### 3.2 Relevant files (absolute paths under `notes-app/`)

- `src-tauri/src/models.rs` — `Item`, `NewItem`, `UpdateItem`, `Prompt`, `PromptVersion`, `NewPrompt`, `UpdatePrompt`.
- `src-tauri/src/db/mod.rs` — `ItemRepository` + `PromptRepository` traits; `KNOWN_TABLES`/`KNOWN_TRIGGERS` allowlists.
- `src-tauri/src/db/sqlite.rs` — all SQL: `create`, `update`, `fetch`, `list`, `search`, `all_items`, `rebuild_from_dir`, `insert_item_verbatim`, `fetch_prompt`, `PromptRepository::list`, `versions`, `import_prompt_committed`.
- `src-tauri/src/store/itemfile.rs` — item file `serialize`/`parse` (byte-deterministic; panic-free restricted reader).
- `src-tauri/src/store/promptfile.rs` — `serialize_prompt`/`parse_prompt` (head) and `serialize_version`/`parse_version`.
- `src-tauri/src/projects/mod.rs` — `ProjectManager`, k-way git merge, `merge_tests` fixtures.
- `src-tauri/src/commands.rs` — thin Tauri commands (no change needed — the field rides existing DTOs).
- `src/types.ts`, `src/lib/api.ts` — TS DTO mirror + IPC surface (only `types.ts` changes).
- `src-tauri/migrations/` — `0001`…`0006`; next is **`0007`**. (Catalog store uses a separate migrator `migrations_catalog/` holding `projects`/`app_settings` — out of scope.)
- Version files: `src-tauri/tauri.conf.json:4`, `package.json:4`, `src-tauri/Cargo.toml:3` — all `0.1.0`.

### 3.3 Conventions confirmed

- IPC DTOs are serde camelCase; `src/types.ts` mirrors `src-tauri/src/models.rs` ("change both or neither").
- Migrations are additive numbered files applied by sqlx at startup; **never edit an existing migration** (stale-checksum panic). Adding a *new* numbered file is safe.
- `Item` is read via `SELECT *`/`SELECT i.*` → `sqlx::FromRow` maps a new column by name automatically. **Prompts are read via explicit-column CTE queries**, so a new prompt column must be added to those SELECT lists explicitly or `FromRow` fails at runtime.
- Timestamps are RFC 3339 TEXT end to end.
- `[profile.release]` sets `lto = true` and `codegen-units = 1` (heavier link step — relevant to the disk risk in §10).

### 3.4 Release environment (devops)

- Repo root = `C:\Projects\TaskTracker\TaskTracker`; app is in `notes-app/`. All `git` commands run at root; all `npm`/`tauri` from `notes-app/`.
- `origin` = `https://github.com/JDHDEV/TaskTracker.git`, tracking `main` only. No `dev`/`release` branch, no tags.
- `bundle.targets = ["nsis"]` only → single NSIS installer, expected at `src-tauri/target/release/bundle/nsis/worknotes_1.0.0_x64-setup.exe`. `webviewInstallMode = downloadBootstrapper`.
- **No code-signing config** → unsigned installer (expected, not a bug). **No `tauri-plugin-updater`** → no in-app update path. No `.github/` CI exists.
- Blocking constraints (verified — see §10): C: disk is near-full vs a 7.4 GB debug target; `gh` CLI is not installed.

## 4. Security Considerations

*(security-auditor — overall posture rated "strong"; no current Critical/High in code)*

Build these in from the start:

- **`schemaVersion` MUST be backend-forced, never a client-writable DTO field.** Do not add it to `NewItem`/`UpdateItem`/`NewPrompt`/`UpdatePrompt`. Mint it server-side from a constant in `create`, exactly as `id`/`createdAt` are minted and `project_id` is forced NULL. Otherwise `invoke("create_item", { input: { …, schemaVersion: "99.9.9-evil" }})` would let a compromised webview poison the marker a future migration keys off. (OWASP A08 — Software/Data Integrity.)
- **No SQL-injection surface** if the value is bound like every other column (`push_bind`/`?N`); the `ORDER BY` path uses only static enum-derived literals, so the new column can't reach a dynamic SQL sink.
- **Frontmatter-injection guard.** `itemfile.rs` writes bareword scalars via `line()` (no escaping) and quoted values via `quoted_line()`. Because the value is a backend constant literal `"1.0.0"` (no newline), `line()` is safe. If it were ever client-controlled, a `\n` could inject a fake frontmatter key into the git-mergeable `.md`. Keep it a constant; update `serialize` **and** `parse` in lockstep and keep the round-trip byte-identical.
- **Version-string consistency** across `tauri.conf.json` + `Cargo.toml` + `package.json` is a release-integrity control — bump all three together.
- **Low:** raw sqlx error text can reach the webview on the generic `AppError::Db`/`Keyring` paths (`error.rs`). Low impact for a single-user desktop app; optionally scrub before a public release.

**Pre-release gate checklist (must pass before any public publish):**

- [ ] Sign the installer with an Authenticode cert **or** publish (and document) a SHA-256 checksum of the installer alongside the Release.
- [ ] Run a full **git-history** secret scan across all refs (`gitleaks`/`trufflehog` over `--all`) — this audit covered only the working tree. Working tree is clean (no `.env`, no hardcoded keys; the only matches are UI placeholders in `SettingsDialog.tsx`).
- [ ] Decide `.claude/` inclusion explicitly — currently untracked; `.gitignore` only ignores `.claude/settings.local.json`, so a stray `git add .` would stage the rest.
- [ ] Attach **only** the generated installer as a Release asset — never a working-tree zip or any developer `index.db`/project directory (may hold real notes/PII).
- [ ] Build the public artifact with the **default feature set** (never `--features test-support`, which exposes SQL-executing test seams) and confirm no source maps ship (`build.sourcemap` stays false; current `dist/` has no `.map`).
- [ ] Run `cargo audit` + `npm audit` against the pinned lockfiles.
- [ ] Confirm the repo-visibility / IP-authorization decision (public repo exposes all source + full history) — VendNovation sign-off required.

## 5. Design

### Approach

Persist `schemaVersion` in the canonical files first (index follows), backend-owned and **create-only**, so it never participates in the `edited` flag and can never move `updatedAt`. Mirror the field over IPC via the existing `Item`/`Prompt` DTOs (no new commands). Handle legacy records by defaulting an absent frontmatter key to `"1.0.0"` in the parsers, matching the SQL `DEFAULT '1.0.0'`.

### Architecture

- **Constant:** `pub const CURRENT_SCHEMA_VERSION: &str = "1.0.0";` in `models.rs`, documented "bump only on a file-format change." Referenced by both the create paths and the parser defaults so index and files can never disagree. Kept **separate** from the app version (`1.0.0` today, but different axes).
- **Migration `0007_schema_version.sql`** (additive, index-store migrator only): adds the column to `items` and `prompts` with `TEXT NOT NULL DEFAULT '1.0.0'`. FTS/triggers/allowlists untouched (FTS indexes only `title,body`; triggers name columns explicitly, not `new.*`). No new index.
- **Item marker** lives on the `items` row + `items/<uuid>.md` frontmatter.
- **Prompt marker** lives on the **prompt head** (`prompts` row + `prompt.md`), surfaced on the `Prompt` DTO as `schemaVersion` — the same place `reusable` lives. This is the minimal v1 placement (see Key Decisions for the alternative).
- **No frontend logic change** — `schemaVersion` is a passthrough field; `api.ts` and components are untouched.

### Key Decisions

1. **Name `schemaVersion` (`schema_version`), not `version`.** Avoids collision with prompt version history. *(user-confirmed)*
2. **Backend-owned, create-only, never in input DTOs.** Security requirement + sidesteps the `updatedAt` invariant entirely: written only when `createdAt == updatedAt`; `update()` never lists the column, so it is preserved untouched and cannot flip the `edited` flag. This is simpler and safer than the architect's "re-stamp on every write" option (which required carefully assigning outside the `edited` gate to avoid a pin/archive flip bumping `updatedAt`). At 1.0.0 the two are behaviorally identical, so we take the minimal one.
3. **Back-fill to `1.0.0`, not a `0.0.0`/NULL sentinel.** Every existing record already conforms byte-for-byte to the shape this column *names*; tagging them `0.0.0` would assert an older, differently-shaped format that does not exist and burden every future migration with a spurious case. The distinguishing power is forward-looking (`1.0.0` today vs a future `1.1.0`/`2.0.0`). Parsers default an absent key to `"1.0.0"` to match. *(This is the deliberate counter to the tech-lead's "absence is the signal" argument — recorded in §10 as an open question the user may override with a sentinel.)*
4. **`schemaVersion` tracks record *format*, not app version.** It bumps only on a format change via a future migration — not on every app release. This is a small but deliberate divergence from the request's "created with older *versions of the app*" wording; the format axis is the correct one for a migration to key on.
5. **Prompt marker on the head, not the version files.** Minimal churn; every prompt entity carries the marker. *Alternative (architect):* put it on `PromptVersion`/`prompt_versions` + version files so it advances on every content "save" (a save appends a version file; the head is only rewritten on a `reusable` toggle). Recorded in §10 for the user to override if per-version format marking is wanted.
6. **TEXT NOT NULL.** Dotted semver string, matching the "TEXT end to end" ethos. Forward caveat for a future migration: lexical compare is wrong for semver (`'1.10.0' < '1.9.0'`) — parse components.

## 6. Implementation Steps

**Part A — schemaVersion marker (single commit; verify with the full gate before committing).**

1. Add `pub const CURRENT_SCHEMA_VERSION: &str = "1.0.0";` to `src-tauri/src/models.rs`; add `pub schema_version: String` to `Item` and `Prompt`. Do **not** touch `NewItem`/`UpdateItem`/`NewPrompt`/`UpdatePrompt`.
2. Create `src-tauri/migrations/0007_schema_version.sql` (DDL in §7 note). Never edit `0001`–`0006`.
3. `src-tauri/src/store/itemfile.rs`: `serialize` emits a `schema_version:` line at a fixed position (recommend immediately after `updated_at`) via the bareword `line()` helper; `parse` reads it and **defaults to `CURRENT_SCHEMA_VERSION` when absent**; set it on the returned `Item`.
4. `src-tauri/src/store/promptfile.rs`: add `pub schema_version: String` to the `PromptRecord` struct; `serialize_prompt` emits a `schema_version:` line at a fixed position (recommend immediately after `created_at`) and `parse_prompt` reads it, defaulting absent → `CURRENT_SCHEMA_VERSION`. Version files (`serialize_version`/`parse_version`, `PromptVersion`) unchanged.
5. `src-tauri/src/db/sqlite.rs` — item paths: `create` sets `schema_version: CURRENT_SCHEMA_VERSION.into()` on the `Item` and adds the column+bind to the `INSERT INTO items`; `rebuild_from_dir` and `insert_item_verbatim` add the column+bind, preserving the file's value verbatim (do **not** re-stamp on rebuild). `update`, `fetch`, `list`, `search`, `all_items` need no change (`SELECT *`/`SELECT i.*` + name-matched `FromRow`; `update`'s SET list omits the column and re-fetches the item then rewrites the file, so the create-only value survives a later edit — verified in review).
6. `src-tauri/src/db/sqlite.rs` — prompt paths: `create` sets the constant on the head `PromptRecord` and adds the column+bind to `INSERT INTO prompts`; add `p.schema_version` to the SELECT lists in **both** `fetch_prompt` and `PromptRepository::list` (explicit-column CTEs). **Preserve (never re-stamp) the value on every non-create path:**
   - `import_prompt_committed` (`sqlite.rs` ~873) builds a fresh `PromptRecord` literal — must set `schema_version` from the **source** value, not the constant. This requires threading it through the trait (see step 6a).
   - The `reusable`-only branch of `PromptRepository::update` (`sqlite.rs` ~1094) also builds a fresh `PromptRecord` literal to rewrite `prompt.md` — set `schema_version: current.schema_version.clone()`, **not** the constant, so a metadata-only toggle never re-stamps the marker (the pin/archive analogue for prompts).
   - The prompt branch of `rebuild_from_dir` binds the file's value verbatim.
   6a. `src-tauri/src/db/mod.rs`: the `PromptRepository::import_prompt` trait signature has no channel for `schema_version` (Section 7 previously and wrongly said "no change needed"). Add a `schema_version: &str` parameter (or pass the full head `Prompt`), and update `ProjectManager::move_prompt` (`src-tauri/src/projects/mod.rs` ~575-582) to pass `head.schema_version` through. Without this, a cross-project move silently re-stamps a moved prompt to the current constant — defeating the cross-store scenario in §3.1 and inconsistent with the id-preserving move (`plan8-move-preserves-uuids`). Alternatively, if "always re-stamp on move" is intentionally chosen, document it here and add a test asserting it. **Recommended: preserve.**
7. `src/types.ts`: add `schemaVersion: string;` to `Item` and `Prompt`. Do **not** add to `NewItem`/`UpdateItem`/`NewPrompt`/`UpdatePrompt` or `PromptVersion`.
8. Update every struct literal / comparison helper touching `Item`/`Prompt`/`PromptRecord`: the `task()`/`note()` fixtures **and the hand-rolled `assert_item_eq` helper** in `itemfile.rs` (`Item` does not derive `PartialEq`, so the round-trip test will not check `schema_version` unless the helper adds the field — otherwise a dropped field ships green); `PromptRecord` round-trip tests in `promptfile.rs` (it *does* derive `PartialEq`, so `assert_eq!` covers it automatically once the fixture has the field); fixture literals in `tests/repo.rs`, `tests/export_import.rs`, `tests/project_manager.rs`, and the `merge_tests` builders in `projects/mod.rs`; new **assertions** (not fixtures — it builds no `Prompt`/`PromptRecord` literals) in `tests/repo_prompts.rs`. Fix any `src/lib/*.test.ts` item-shaped literals surfaced by `tsc`.
9. Add the new tests in §8 (same commit, per CLAUDE.md).
10. Verify: `cd src-tauri && cargo test` · `npx tsc --noEmit` · `npm run build`.

**Part B — app version bump (separate commit).**

11. Edit `package.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4` from `0.1.0` → `1.0.0`. Run any build once so `Cargo.lock` picks up the new crate version. Grep `notes-app/` for stray `0.1.0`.

**Part C — branches + release (each step is an explicit user-authorized gate — see §10).**

12. **Disk prerequisite:** from `notes-app/src-tauri`, `cargo clean` (frees the 7.4 GB debug target) or set `CARGO_TARGET_DIR` to a drive with space. Re-check free space.
13. **Branches:** `git branch dev main` and `git branch release main` from the post-bump tip; `git push -u origin dev release`. *(push gated)*
14. **Build:** `git checkout release`; from `notes-app/`: `npm ci`; `npm run tauri build`. Confirm `worknotes_1.0.0_x64-setup.exe` under `src-tauri/target/release/bundle/nsis/`; install + launch once.
15. **Pre-release checklist (§4):** complete every box.
16. **GitHub Release:** install + `gh auth login`; `git tag -a v1.0.0 -m "v1.0.0"`; `git push origin v1.0.0`; `gh release create v1.0.0 "<installer path>" --title "v1.0.0" --notes "…" --target release --latest`. *(hard STOP — publish gated on §4 + explicit go-ahead)*

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/migrations/0007_schema_version.sql` | Create | `ALTER TABLE items ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1.0.0';` and same for `prompts`. Additive; FTS/triggers/index untouched. |
| `src-tauri/src/models.rs` | Modify | Add `CURRENT_SCHEMA_VERSION` const; add `schema_version: String` to `Item` and `Prompt`. |
| `src-tauri/src/store/itemfile.rs` | Modify | `serialize`/`parse` the field; default-absent → const; update round-trip tests + fixtures. |
| `src-tauri/src/store/promptfile.rs` | Modify | `serialize_prompt`/`parse_prompt` (head) the field; default-absent → const; fixtures. |
| `src-tauri/src/db/sqlite.rs` | Modify | Item `create`/`rebuild_from_dir`/`insert_item_verbatim` binds; prompt `create` binds; add `p.schema_version` to `fetch_prompt` + `list` SELECTs; preserve value in `import_prompt_committed` + the reusable-only `update` branch (not re-stamp). |
| `src-tauri/src/db/mod.rs` | Modify | Add `schema_version` channel to the `PromptRepository::import_prompt` trait signature (see Step 6a). |
| `src-tauri/src/projects/mod.rs` | Modify | `move_prompt` passes `head.schema_version` through import; `merge_tests` `item()`/`prompt()` builder literal updates. |
| `src/types.ts` | Modify | Mirror `schemaVersion: string` on `Item` and `Prompt` only. |
| `src-tauri/tests/repo.rs` | Modify | New invariant tests + fixture updates. |
| `src-tauri/tests/repo_prompts.rs` | Modify | New prompt create/round-trip **assertions** (builds no `Prompt`/`PromptRecord` literals). |
| `src-tauri/tests/export_import.rs` | Modify | Byte-exact frontmatter fixture updates + a legacy-file (no marker) parse test. |
| `src-tauri/tests/project_manager.rs` | Modify | Fixture literal updates; cross-project `move_prompt` marker-preservation test. |
| `package.json` | Modify | `version` 0.1.0 → 1.0.0. |
| `src-tauri/Cargo.toml` | Modify | `version` 0.1.0 → 1.0.0. |
| `src-tauri/tauri.conf.json` | Modify | `version` 0.1.0 → 1.0.0 (authoritative for the installer). |

*No change needed:* `commands.rs`, `src/lib/api.ts`, the `KNOWN_TABLES`/`KNOWN_TRIGGERS` allowlists (column, not table), FTS migrations/triggers. *(Note: `db/mod.rs` DOES change — the `import_prompt` trait signature — per Step 6a; it is not in the no-change set.)*

## 8. Test Strategy

*(test-writer — no new dependency; `tempfile` + the `test-support` feature already cover everything)*

- [ ] **Unit / repository tests (Rust):**
  - `create()` sets `schema_version == "1.0.0"` for a `Kind::Note`, a `Kind::Task`, and a prompt.
  - Round-trip: `get`/`list`/`search` all return the field for items; `get`/`list` for prompts.
  - **Not client-settable:** deserialize `NewItem`/`NewPrompt` JSON that *includes* `"schemaVersion":"9.9.9"`, create, assert the persisted value is still `"1.0.0"`; same for `UpdateItem`/`UpdatePrompt` patches (new invariant, analogue of the existing `id`/`createdAt` immunity — lands in the same commit).
  - **Does not bump `updatedAt`:** patch an unrelated field (e.g. title) on an item; assert `schema_version` unchanged and `updated_at` moved only because of the title edit. Mirror `pin_and_archive_do_not_bump_updated_at`.
- [ ] **Migration / back-fill (the highest-value tests):**
  - **File-parser default is the durable back-fill path** (prioritize these — the index is rebuilt from files anyway): `itemfile::parse` on legacy frontmatter with **no** `schema_version:` line → `Ok` with `schema_version == "1.0.0"` (not `Err(Malformed)`). This single test prevents every pre-upgrade file from becoming unreadable. Same for `promptfile::parse_prompt`.
  - `rebuild_from_dir` is read-only against disk: write a legacy no-marker `.md` into a tempdir, rebuild, `get` → index reports `"1.0.0"` while the on-disk bytes are unchanged (assert byte-identical).
  - Forward stamping: `update()` an unrelated field on a legacy item → the rewritten file now contains `schema_version: 1.0.0`.
  - SQLite `DEFAULT` clause (optional, lower priority): the standard harness applies all migrations at once via `sqlx::migrate!`, so it never exercises a pre-existing row, and there is **no existing helper to replay a migration prefix** — implementing this test means `include_str!`-ing `0001`–`0006` and executing them as raw SQL before `0007`, which is brittle (breaks if numbering shifts). Since `index.db` is disposable and rebuilt from files, the file-parser tests above cover the real durability contract; treat the DEFAULT-clause test as a nice-to-have, not a gate.
  - `export_is_byte_identical_after_a_round_trip` still holds with the new field in the fixtures. **Also update the hand-rolled `assert_item_eq` helper in `itemfile.rs` to assert `schema_version`** — `Item` has no `PartialEq`, so without this the round-trip test passes even if `parse` drops the field (a green-but-broken hole; the execution prompt requires every test be proven able to fail).
  - Cross-project move: create a prompt, `move_prompt` it to a second loaded store, assert the moved prompt's `schema_version` equals the source's (preservation), not a re-stamp. Guards Step 6a.
- [ ] **Regression (must stay green untouched):** kind-gating, list order/tiebreak, archive exclusion, FTS search. Confirm all three INSERT column-list sites (`create`, `rebuild_from_dir`, `insert_item_verbatim`) include the column — a missed site fails these.
- [ ] **TS:** `tsc --noEmit` clean is the only meaningful TS check (vitest is node-only, no DOM/Tauri; `schemaVersion` is a passthrough with no helper logic — do **not** invent a vacuous component test). Fixture literals in `src/lib/*.test.ts` that build item/prompt shapes get the field.
- [ ] **Manual / E2E smoke (release build — not unit-testable):**
  - Version bump: `git diff` shows only the three version strings; grep confirms no stray `0.1.0`.
  - `npm run build` + `cargo test` clean before tagging (kill any running `notes-app.exe` first; apply the LNK1318 workaround if link fails).
  - Installer builds, installs, and launches on a clean Windows 11 profile.
  - Create a note, task, and prompt in the installed app → inspect on-disk `.md` files show `schema_version: 1.0.0`.
  - **Migration on an existing DB:** open a pre-1.0.0 project directory (grab a copy **now**, before the schema change lands) → app starts, existing pinned/archived/tagged items still list/search/filter, legacy files without the marker display correctly, and editing one writes the marker into its file.
  - `dev`/`release` branches point at the post-bump commit; Release is tagged `v1.0.0`, marked latest/public, correct asset attached, notes non-empty.

## 9. Success Criteria

- [ ] **Functional:** Every newly created note, task, and prompt carries `schemaVersion == "1.0.0"` in its canonical file and in the index; pre-existing records read as `"1.0.0"` via the parser default; the field is not client-settable and does not move `updatedAt`.
- [ ] **Tests:** All §8 unit/repository/migration tests pass; `cargo test`, `npx tsc --noEmit`, `npm run build` all clean.
- [ ] **Security:** `schemaVersion` is backend-forced (absent from input DTOs); no injection surface; the §4 pre-release checklist is completed before any public publish.
- [ ] **Release:** All three version files read `1.0.0`; `dev` + `release` branches exist (and are pushed with authorization); the installer builds and launches; the public GitHub Release exists with the signed-or-checksummed installer attached — **only after explicit sign-off**.
- [ ] **Quality:** Passes existing suite; minimal diff; no unrelated refactoring.

## 10. Risks & Open Questions

**Verified blocking constraints (adversarial-verifier — verdicts in §10.1):**

- **Disk space (CONFIRMED):** the release build risks LNK1318 disk-full. Mitigation is mandatory Step 12 (`cargo clean` or relocate `CARGO_TARGET_DIR`). Matches project memory `cargo-test-disk-full-workaround`.
- **`gh` CLI absent (CONFIRMED):** Step 16 cannot run until `gh` is installed and `gh auth login` completed. `origin` confirmed at `github.com/JDHDEV/TaskTracker.git`.

**Design open questions (surfaced, not silently decided):**

- **Second naming collision: `schema_version` ↔ `meta.schema_version`.** The chosen name dodges the prompt version-history collision, but code review found the `meta` table already has a key literally named `schema_version` (`sqlite.rs:129-144`) holding the *migration level* (e.g. `"7"`) — a different axis from the per-record format marker (`"1.0.0"`). Different tables, so no SQL bug, but a readability trap for a future migration author. `formatVersion`/`format_version` would dodge both collisions. Chosen: keep `schemaVersion` (user-selected); flag `formatVersion` as the clean alternative. **Override here if the double-collision bothers you.**
- **Cross-project `move_prompt` — preserve vs re-stamp (code-review Critical).** Plan preserves the source marker through the `import_prompt` trait (Step 6a), consistent with the id-preserving move (`plan8-move-preserves-uuids`). Alternative: always re-stamp to the current constant on move. Chosen: preserve. **Confirm or override.**
- **Back-fill value — `1.0.0` vs a sentinel.** The plan back-fills legacy records to `1.0.0` (they are 1.0.0-shaped). The tech-lead argues the true "old record" signal is field *absence*; if you want to distinguish records physically written by pre-1.0.0 code from 1.0.0-era ones, use a `0.0.0` sentinel for the parser default and the SQL default instead. Chosen default: `1.0.0` (minimal, truthful about format). **Override here if you disagree.**
- **Prompt marker placement — head vs version files.** Plan puts it on the prompt head (minimal). Architect's alternative puts it on `PromptVersion`/version files so it advances on every content save. Pick head unless per-version format marking is a real near-term need.
- **`dev` vs `release` version divergence.** Plan bumps `1.0.0` once on `main` and forks both branches identically. Alternative: keep `dev` on a pre-release version (e.g. `1.1.0-dev`). No ongoing versioning policy was requested — flagging, not deciding.

**Release policy risks (require a human owner, not an agent):**

- Public distribution of VendNovation IP (licensing/ownership); unsigned installer (SmartScreen); no auto-updater (1.0.0 users stranded); public repo exposes all source + full git history. All gated behind the §4 checklist and explicit authorization.

**Unverified / out-of-scope:** full git-history secret scan (this review covered only the working tree); `cargo audit`/`npm audit` CVE results; confirmation the actual build command excludes `--features test-support` and source maps.

### 10.1 Adversarial-verifier verdicts

- **CLAIM 1 — disk-space blocker: CONFIRMED.** C: has **6.61 GiB free** (measured via both `df` and `Get-PSDrive`); `target/debug` alone is **7.39 GiB** (no `target/release` yet); `Cargo.toml:73-75` confirms `[profile.release]` `lto = true`, `codegen-units = 1`. The full-LTO link with < 6.6 GiB free is well-supported to hit LNK1318. Step 12 (`cargo clean` / relocate `CARGO_TARGET_DIR`) is mandatory. (Predictive clause verified as premises, not a reproduced failure — the verifier did not run a build.)
- **CLAIM 2 — `gh` CLI absent: CONFIRMED.** `gh` resolves on neither the Git Bash PATH, the Windows PATH, nor the standard install dir / scoop shims. `origin` = `https://github.com/JDHDEV/TaskTracker.git` (github.com), so `gh release create` is the right tool but is unrunnable until `gh` is installed + `gh auth login` is done (Step 16 prerequisite).

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` is strict).
- [ ] Error handling covers failure modes (parse of legacy files never panics).
- [ ] No security vulnerabilities — `schemaVersion` is backend-forced, absent from input DTOs; written via the safe `line()` path with a constant value; bound (not interpolated) in SQL.
- [ ] §4 security considerations addressed; §4 pre-release checklist completed before any publish.
- [ ] Follows conventions — camelCase DTO mirror kept in sync; migration additive; TEXT-end-to-end.
- [ ] Tests cover create, round-trip, client-immunity, no-`updatedAt`-bump, back-fill/legacy-parse, and rebuild.
- [ ] No performance regressions — no new index needed; `ADD COLUMN` with constant default is metadata-only; reads gain one short column.
- [ ] Changes minimal — marker and version bump are separate commits; no unrelated refactoring.
- [ ] Item `update()` does **not** list the column (preserves value; no `updatedAt` movement); all three item INSERT sites include it.
- [ ] Prompt non-create paths **preserve** the marker, never re-stamp: `import_prompt_committed` uses the source value (threaded via the `import_prompt` trait), the reusable-only `update` branch uses `current.schema_version.clone()`, and `move_prompt` carries it across stores (test asserts equality).

## 12. Post-Review Improvements

Implemented during Part A/B and folded into the two commits (schemaVersion marker; version bump). All four review agents (code-reviewer, security-auditor, database-architect) returned CLEAN on the final diff; the items below are the deltas from the plan-as-written that the implementation had to add.

1. **`projects/legacy.rs` explicit-column read (plan gap — §3.3 was wrong for this one site).** §3.3 asserted every `Item` read uses `SELECT *`/`SELECT i.*`, so `FromRow` picks up the new column by name. That holds everywhere EXCEPT the one-time legacy `notes.db` migration, which reads items with an **explicit column list** from a DB that predates the column (migration 0007 is never run against `notes.db` — it is read-only there). Adding `schema_version` to `Item` therefore broke that `query_as::<_, Item>` at runtime (missing column). **Fix:** project the marker as a **bound constant** — `… , ?1 AS schema_version FROM items` with `.bind(CURRENT_SCHEMA_VERSION)` — which works whether or not the source has the physical column and stamps every migrated legacy item as the 1.0.0-shaped format it already is. Caught at compile/first-run; not in the plan's §7 file-change list.

2. **Synthesized prompt head in `promptfile::scan` (plan step 4 omission).** When `prompt.md` is missing/unreadable, `scan` synthesizes a head record; that struct literal also needed the new field. Defaulted to `CURRENT_SCHEMA_VERSION`, consistent with `parse_prompt`'s absent-key default. Step 4 named `serialize_prompt`/`parse_prompt` but not the synthesize branch.

3. **`package-lock.json` version sync (Part B, surfaced by the stray-`0.1.0` grep).** The plan listed three version files; the grep flagged `package-lock.json`'s own package version (root + the `""` package entry) as a fourth. Synced to `1.0.0` for version-hygiene consistency (it is tracked). The three remaining `0.1.0` entries in `Cargo.lock` are unrelated third-party crates (`vswhom`, `wasite`, `windows-threading`) — correctly left untouched.

4. **Tests that actually distinguish preserve-vs-re-stamp (test-writer, beyond the literal §8 ask).** The index-only prompt tests cannot tell "preserve the source marker" apart from "re-stamp to a constant that happens to equal the source's" (both yield `"1.0.0"`). So the file-store tests in `tests/project_manager.rs` construct a source whose marker is `"0.9.0"` (differs from the constant) for BOTH the cross-project `move_prompt` test and a new reusable-toggle test — a silent re-stamp then fails the assertion. This is what makes Step 6a's preservation guarantee genuinely testable. Each of the 15 new tests was fail-proved (edit→red→revert→green).

**Verification:** `cargo test` = 259 passing (+3 pre-existing unrelated `#[ignore]`), `npx tsc --noEmit` clean, `npm run build` clean, `cargo check` clean at 1.0.0. Migration 0007 empirically validated by applying 0001→0007 to a throwaway SQLite DB (columns present as `TEXT NOT NULL DEFAULT '1.0.0'`, back-fill confirmed, FTS/triggers intact).

**Accepted, not changed (per §10):** the `schema_version` ↔ `meta.schema_version` name collision is kept (user-selected `schemaVersion`); reviewers confirmed it is a documented readability caveat, not a bug (different tables). The pre-existing raw-sqlx-error-to-webview Low (`error.rs`) is unchanged by this work and remains a §4 pre-release-checklist item.

**Part C (branches + release) is NOT done** — it is gated on explicit user authorization per §10 and was not started.

## 13. Execution Prompt

```
Implement the plan at notes-app/plans/plan.10.md. Read that file in full first — it is the
authoritative spec, produced with subagent research. The app lives in the notes-app/ subdirectory;
run all cargo/npm commands from there (git commands run from the repo root C:\Projects\TaskTracker\TaskTracker).

CONTEXT YOU MUST NOT VIOLATE (from notes-app/CLAUDE.md):
- The canonical source of truth is the git-tracked Markdown files (items/<uuid>.md,
  prompts/<uuid>/prompt.md). index.db is git-ignored and REBUILT from those files, so the
  schemaVersion marker MUST be written to the files, not only the SQLite column.
- schemaVersion is BACKEND-OWNED. Do NOT add it to NewItem/UpdateItem/NewPrompt/UpdatePrompt.
  Force the constant CURRENT_SCHEMA_VERSION server-side in create(); update() must not list the
  column (so it is preserved and never moves updatedAt).
- Migrations are additive numbered files; never edit an existing one. New file is 0007.
- src/types.ts mirrors src-tauri/src/models.rs (camelCase) — change both or neither.

WORK PART A FIRST (the schemaVersion marker), as a single commit:
1. Follow Implementation Steps 1–10 in Section 6 exactly. Use the field name schemaVersion
   (schema_version in Rust/SQL), NOT `version`. Back-fill/parse-default absent → "1.0.0".
   Put the prompt marker on the prompt head (Section 5, Key Decision 5) unless Section 10 says otherwise.
2. Spawn a test-writer agent to implement the Section 8 test strategy (create, round-trip,
   client-immunity, no-updatedAt-bump, the legacy-parse and DEFAULT-clause back-fill tests, and the
   rebuild_from_dir read-only test). Every test must be proven able to fail.
3. Verify the mandated gates: `cd src-tauri && cargo test`, then `npx tsc --noEmit`, then `npm run build`.
   If cargo test link-fails with LNK1318, apply the disk-full workaround (clean target / disable
   debuginfo) noted in project memory. Kill any running notes-app.exe first.
4. Spawn a code-reviewer agent (read-only: Read, Grep, Glob) to review the diff against Section 11.
5. Spawn a security-auditor agent (read-only: Read, Grep, Glob) to confirm the Section 4 mitigations —
   specifically that schemaVersion is absent from every input DTO, is written via the safe (non-escaping-
   unsafe) frontmatter path with a constant value, and is bound (not interpolated) in SQL.
6. Spawn a database-architect agent to sanity-check migration 0007 (additive, index-store migrator only,
   FTS/triggers/allowlists untouched) before it lands.
   Fallback for any unavailable agent: use Explore for read-only analysis, Plan for strategy,
   general-purpose otherwise, stating the role in the prompt.

THEN PART B (app version bump), as a SEPARATE commit:
7. Follow Step 11: set version 1.0.0 in package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.
   Run a build so Cargo.lock updates; grep notes-app/ for stray 0.1.0.

THEN PART C (branches + release) — each step is a GATED action requiring the user's explicit go-ahead
before it runs, per Section 10. Do NOT push, tag, build-and-publish, or flip repo visibility without it.
8. Spawn a devops-engineer agent to drive Steps 12–16: free disk (cargo clean / relocate CARGO_TARGET_DIR),
   create dev + release branches, build the NSIS installer, then STOP.
9. Before any public publish, complete the Section 4 pre-release checklist (git-history secret scan,
   signing-or-checksum decision, .claude/ inclusion decision, attach only the installer, default features
   only, cargo audit + npm audit, repo-visibility/IP sign-off). Present it to the user and wait.
10. Only after explicit authorization: install/auth gh, tag v1.0.0, push the tag, and
    `gh release create v1.0.0 <installer> --target release --latest`.

FINALLY:
11. Run the full existing test suite and fix any regressions before finishing.
12. Run the Section 11 code-review checklist and record any fixes.
13. Document improvements made in Section 12 of the plan and implement them.
```
