# Plan 8: Prompt & project-management enhancements

**Created:** 2026-07-18
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Six enhancements layered on top of the just-shipped Prompts feature (plan.7) and the project-management dialog:

1. **Optional prompt title** — the title/name field becomes optional (today it is non-empty-validated).
2. **Copy to clipboard** — a button that copies a prompt's body to the OS clipboard.
3. **Move a prompt between projects** — relocate a prompt (with its full version history) from one loaded project to another.
4. **Project-management view** (`ManageProjectsDialog`):
   - (a) make the project-name input field wider,
   - (b) add a button to open a project's folder in Windows Explorer,
   - (c) display the number of prompts next to each project.

Why it matters: plan.7 built prompts as a per-project, versioned library on the file-per-item store. These six changes remove friction from that library (a prompt is often just a body — a title is ceremony), make prompts portable across projects (the first cross-store move in the app), and surface prompt inventory + folder access in the project manager. Five of the six ride seams plan.7 and earlier phases already built; only the move is genuinely new.

**Two decisions are the spine of this plan and are validated below:** (1) the "open folder" action is a **Rust command keyed by project id**, not a webview opener grant (§4 Finding 1, adversarial-verified); (2) the move **preserves each version's full content/provenance while minting fresh ids** in the target and deletes the source only after the target import is verified — so history is preserved, and a crash leaves two independent, individually-accessible prompts rather than a prompt that is stuck inaccessible in both projects (§5 Decision A, per code review).

## 2. Strategic Assessment

*(Source: tech-lead, corroborated by architect + database-architect + security-auditor.)*

- **Five of six items are cheap changes on existing seams; the move is the one hard, novel piece.** Optional title is validation + display only; copy is a `navigator.clipboard` call; wider input is CSS; open-folder reuses the already-present opener plugin; prompt-count mirrors the existing `item_count` spine end to end. The move is the app's **first cross-store mutation** (items explicitly deferred this — `CLAUDE.md`: "Items do not move between projects in v1").
- **Scoping steer:** the tech lead recommends treating the move as its own design pass rather than bundling it with CSS tweaks. This plan keeps all six together but **sequences the move last** (Step 5), after the smaller items are green, so its diff is isolated for review. Splitting into two commits/PRs (Batch A = items 1,2,4a,4b,4c; Batch B = move) is a reasonable option and is called out in §10.
- **Riskiest part:** the move — specifically (a) preserving full version history across stores, (b) the `prompt_owner` duplicate-id window during copy-then-delete, and (c) cross-volume file operations (projects live on arbitrary drives). Second-riskiest: getting "open folder" right without handing the webview an unscopable OS-open capability (§4 H1).
- **Architectural fit:** none of the six fights the architecture. The move is honestly implementable *because* ownership is physical (a prompt's project is the store its files live in) — "move" is literally "relocate a directory," not a hack over a `projectId` column. That is a good property inherited from plan.6/plan.7.
- **Highest-level approach per item** — see §5.

## 3. Research Findings

*(Sources: architect, database-architect, frontend-specialist. File:line anchors are from those agents; verify during implementation as the branch has uncommitted plan.7 changes.)*

### 3.1 Codebase map (per feature)

- **Prompt storage (plan.7):** canonical `prompts/<prompt-uuid>/prompt.md` (mutable head: `id`, `reusable`, `created_at`) + immutable `<version-uuid>.md` files (frontmatter `id`, `source`, `created_at`, `title`; content = body). Index tables `prompts` + `prompt_versions` (`migrations/0006_prompts.sql`) are rebuildable; current version is DERIVED (`ORDER BY created_at DESC, id ASC LIMIT 1`), never a stored pointer. `prompt_id` is derived from the parent directory, never written into a version file.
- **`SqliteRepository` implements both `ItemRepository` and `PromptRepository`** over one pool; `LoadedProject` (`projects/mod.rs`) holds two trait views of one `Arc`. `ProjectManager` is the only component that can see two stores at once (`prompt_owner` probes all loaded stores; `prompts_for(id)` resolves one loaded store).
- **Prompts are viewed one project at a time** — `list_prompts` requires a `projectId` (confirmed decision from plan.7 §12 item 6); there is no prompt fan-out/k-way merge. This plan does not change that.
- **Frontend is router-free**; `App.tsx` holds shared `knownProjects`/`loaded` and passes `loaded` to `PromptsPage`. Components call the backend only through `src/lib/api.ts`.

### 3.2 Optional title (architect + database-architect)

- **No migration, no file-format change.** `title TEXT NOT NULL` is satisfied by `''`; every insert binds `title` explicitly (create, update, `rebuild_from_dir`), so the missing `DEFAULT` is never exercised. `serialize_version` always writes the `title:` line, and `parse_version` requires the field to be *present* but not non-empty — so `title: ""` already round-trips. **Correction to the task framing:** the `0006` DDL is `title TEXT NOT NULL` with **no** `DEFAULT ''` (only `body` has the default); this does not change the verdict.
- **Guards that reject empty title (the only changes):** `PromptRepository::create` (`db/sqlite.rs` ~896–900) and `update` (~967–976) each `return Err(Invalid("prompt title must not be empty"))`. Keep the `.trim()`, drop the emptiness rejection.
- **`promptfile::parse_version` "missing title" check (~210–215) stays** — a missing title *line* is a malformed file, distinct from an intentional empty title.
- **Display sites that assume a non-empty title:** `PromptList.tsx:85` (`{p.title}` — a blank title makes the row's entire accessible name empty), `PromptHistoryDialog.tsx:73` (`{v.title}`), `PromptsPage.tsx:146` (delete-confirm `Delete "${selected.title}"?` → `Delete ""?`). The editor title `<input>` needs no change — an empty input shows its `placeholder` natively.
- **Frontend save guard:** `PromptEditor.tsx:74-77` blocks save on `!title.trim()`; it is the only title-tied disabled-save condition (`saveBlocked` is always `false` for prompts). Remove it.

### 3.3 Move prompt (architect + database-architect)

- **Placement:** a `ProjectManager::move_prompt(prompt_id, target_project_id) -> Result<Prompt>` orchestration (only the manager sees two stores), plus a new **verbatim, id-preserving** `PromptRepository::import_prompt` (model on `insert_item_verbatim`, `db/sqlite.rs` ~263–290 — the id/timestamp-preserving insert used by the legacy migration). Source read reuses `get(id)` (head) + `versions(id)` (full history); source removal reuses the existing `PromptRepository::delete(id)`.
- **Why not reuse `create`:** `create` mints fresh UUIDs + a single first version, which would sever history. Why not `rebuild_from_dir`: it is whole-store (`DELETE FROM prompt_versions; DELETE FROM prompts;` then repopulate the entire scan) — O(all prompts) and there is no single-dir variant. Explicit-row-move is O(1 prompt).
- **Cross-volume correctness:** the design has **no cross-volume `fs::rename`**. Each target file is written with `promptfile::write_prompt`/`write_version` (same-directory temp-then-rename inside the target `prompts_dir`, same volume). The existing `migrate_db_to_files` rename (`projects/mod.rs` ~898) is intra-volume only and must not be a template for the cross-store transfer.
- **Sequence (load-bearing):** (1) resolve source via `prompt_owner`, target via `prompts_for` (loaded only); reject `target == source` and unloaded/unknown target; (2) export head + all versions from source; (3) `target.import_prompt(head, versions)` — mints a fresh prompt id (Decision A), writes `prompt.md` + version files (temp-then-rename), then inserts the `prompts` + `prompt_versions` rows in one transaction, parent-before-child, and returns the imported `Prompt` (atomic per the create contract: `Ok` ⇒ files + rows both present); (4) **verify** — re-read the imported prompt from the target (`target.versions(new_id)`, an O(1) indexed read) and assert its version count equals the export count; on mismatch, roll back via `target.delete(new_id)` (which removes both the files and the index rows atomically) and abort with the **source untouched**; (5) **only now** `source.delete(source_id)`.
  - **Note this is verify-*after*-publish with atomic rollback**, a deliberately weaker model than the `migrate_db_to_files` stage→verify→publish (verify-*before*-publish) pattern — chosen because `import_prompt` matches the app's files-then-index create contract and `target.delete` gives a clean atomic undo. Do **not** use `promptfile::scan` on the single moved directory to "verify": `scan(prompts_dir)` iterates the *immediate subdirectories* of `prompts_dir`, so pointing it at one prompt's own dir finds zero subdirs and returns empty; verifying via `scan` would require scanning the whole target store (O(all prompts), contradicting the O(1) design). The index re-read is the O(1) check.
- **No shared-id window (Decision A = fresh target id):** because the target gets a freshly-minted prompt id, the source id and target id are always distinct — there is never a moment where one id lives in two loaded stores, so `prompt_owner` never sees an ambiguous duplicate. A crash between (3) and (5) leaves two **independent, individually-accessible** prompts (source under its old id, target under the new id); recovery is simply deleting the stray source copy (fully reachable via the UI). This is the key robustness reason for Decision A over preserving the id — see §5 Decision A and §10.

### 3.4 Prompt count (database-architect + architect)

- **Mirror `item_count` verbatim:** trait `count_active` (`db/mod.rs` ~44) → `SELECT COUNT(*) FROM items WHERE archived=0` (`db/sqlite.rs` ~814–819) → `ProjectInfo.item_count: Option<i64>` with `skip_serializing_if` (`models.rs` ~77) → populated loaded-only in `list_projects` (`projects/mod.rs` ~540–551) and `project_info` (~679–686) → `types.ts` → `ManageProjectsDialog.tsx` ~148–150.
- **Addition:** `PromptRepository::count_prompts() -> Result<i64>` = bound `SELECT COUNT(*) FROM prompts` (count prompts, not versions — every indexed prompt has ≥1 version, and childless/contentless prompts are already skipped by the scan/rebuild). `ProjectInfo.prompt_count: Option<i64>` populated via `prompts_for(id)`, `None` when unloaded. No index needed; no migration.

### 3.5 Copy + open-folder + wider input (frontend-specialist)

- **Copy:** route through `api.ts` (the sanctioned non-invoke OS touchpoint, like `openExternal`) using `navigator.clipboard.writeText(body)` — no new dependency, works in Tauri v2's secure-context webview from a click handler. Button lives in the `PromptEditor` action row (`.meta`, ~199–210), between the `vN` badge and the `meta-spring`, available in draft and persisted states. **Not** per-row in `PromptList` — the entire row is a single `<button>`; nesting a Copy `<button>` is invalid HTML and breaks a11y/keyboard semantics (no per-row action button exists anywhere in the codebase). Feedback = inline label swap `Copy to clipboard` → `Copied` self-reverting ~1.5s (the app's actual success-feedback convention: `Save`→`Saved`, `Suggest title`→`Suggesting…`; there is no transient success toast), plus an `sr-only role="status" aria-live="polite"` announcement (mirroring the existing streaming-status element).
- **Open folder:** the opener plugin is already a dependency (`tauri-plugin-opener` 2.5.4, registered at `lib.rs:21`). See §4 Finding 1 / §5 Decision C for the (security-driven) Rust-command implementation. Button per `.project-row` in `ManageProjectsDialog`, enabled regardless of loaded state (revealing a folder needs no open store), gated only by the shared `busy` flag.
- **Wider input:** `.project-name` (`styles.css` ~941–948) already has `flex: 1; min-width: 0`; the row is tight because `.dialog-projects` caps the dialog at `min(560px, calc(100vw - 32px))` and two full-length buttons eat the space. Add an explicit `min-width` (e.g. `220px`); if that plus the buttons no longer fit, bump the dialog cap (e.g. `600px`). Adding the 5th per-row button (Open folder) risks overflow of the non-wrapping `.project-row` flex — wrap the trailing controls in a `.project-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end }` group (reusing the existing `.rail-actions`/`.chips` idiom, no new tokens).

### 3.6 Prior art to imitate

- **`item_count` end-to-end** — the template for `prompt_count`.
- **`insert_item_verbatim`** (`db/sqlite.rs` ~263–290) — the id/timestamp-preserving insert; the template for `import_prompt`.
- **`migrate_db_to_files`** (`projects/mod.rs` ~846–914) — stage → verify → publish, and the intra-volume rename constraint the move must respect by copying, not renaming, across stores.
- **`openExternal`** (`api.ts` ~257–262) — the "OS touchpoint through api.ts" convention (copy follows it; open-folder follows it on the api.ts side but resolves server-side).
- **`usePopover` + `.popover` CSS** (`EditorTags.tsx` ~63–90, `src/hooks/usePopover.ts`) — the move-target picker reuses this verbatim (outside-click/Escape dismiss, focus management).
- **The existing prompt CRUD command shape** (`commands.rs` prompt block, thin wrappers over `ProjectManager`) — the template for `move_prompt` and `reveal_project_folder`.

## 4. Security Considerations

*(Source: security-auditor. Finding 1 was independently CONFIRMED by an adversarial-verifier against the pinned crate versions tauri-plugin-opener 2.5.4 / open 5.4.0.)*

### High

- **H1 — "Open folder" MUST be a Rust command keyed by project id; do NOT grant the webview an opener path/reveal permission (CONFIRMED).** The current capability grants only `opener:allow-open-url` scoped to `http/https` (`capabilities/default.json:6-14`). The tempting webview route (`openPath(p.path)` / `revealItemInDir(p.path)`) is unsafe:
  - A bare `opener:allow-open-path` grant **denies every path at runtime** (empty scope → `ForbiddenPath`); making it work needs an effectively-unrestricted `**` scope — which lets a compromised webview `openPath("C:\\Windows\\System32\\cmd.exe")`, and `open_path` on a *file* executes it (the plugin builds with `shellexecute-on-windows`; non-dir target → default verb → runs `.exe`/`.bat`/resolves `.lnk`).
  - A bare `opener:allow-reveal-item-in-dir` grant *works* and cannot execute, but has **no scope enforcement at all** in 2.5.4 (arbitrary-path reveal from the webview) and delivers select-in-parent UX, not "show the folder contents."
  - **Requirement:** add a `#[tauri::command] reveal_project_folder(id, app, state)` (takes `app: AppHandle` + `state: State<AppState>`) that (a) resolves the project's directory via a **new** `ProjectManager::project_dir(&self, id: &str) -> Result<PathBuf>` accessor — needed because `AppState` today exposes only `manager: Arc<ProjectManager>` and the `catalog` field is private with no single-project path accessor (the only `pub` option, `list_projects`, fetches every row plus a count per loaded project — wrong for a single lookup); model `project_dir` on the existing `row.path` lookup already used inside `delete_files`/`project_info`; (b) verifies `std::fs::metadata(&dir).is_dir()` (rejects a path that is now a file/missing — closes the execute-a-file gap); (c) calls the opener plugin's **Rust** API server-side (`app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>)`), which is Rust-to-Rust and **not** ACL-gated (app commands aren't ACL-gated — proven by the existing command set). The webview passes only the project **id**, never a path. **Do NOT add any opener path/reveal permission to `capabilities/default.json`** — the webview's OS-open surface stays exactly at http/https. This mirrors the codebase invariant "the OS picker is UX, never a security boundary; all path validation happens server-side in Rust" (`paths.rs`).

- **H2 — Move MUST copy the full version history (preserving each version's `source`, `created_at`, `title`, `body` and the prompt's `reusable`/`created_at`) before deleting the source.** A `Prompt` returned by the repo carries only the *current* version's title/body; full history lives only in the per-version files/rows. A naive "read current → create in target → delete source" **permanently destroys every prior version and its provenance** — violating the repository invariant that the original is always preserved (plan.7 §4 H2). **Requirement:** enumerate ALL versions from the source and write each into the target via `promptfile` primitives, preserving `source`/`created_at`/`title`/`body` (plus the prompt `reusable`/`created_at`), then insert the index rows, and only then delete the source. Prompt and version **ids are freshly minted by the backend** (Decision A — fresh ids avoid the persistent-duplicate failure mode); this does not weaken H2 (history *content* and provenance are preserved) and keeps filename safety intact — filenames still derive **only** from backend-minted UUIDs (`is_uuid`), no user text ever enters a path. Add a test asserting the moved prompt's `versions()` count and per-version `source`/`created_at`/`title`/`body` match the source's, and that the version ordering is stable.

### Medium

- **M1 — Move target resolved by id via `prompts_for` (a loaded catalog store), never a filesystem path.** `move_prompt(prompt_id, target_project_id)` must locate the source via `prompt_owner` (loaded stores only), resolve the target via `prompts_for(target_project_id)` (loaded catalog store only), reject `source == target`, and never accept a path from the caller. Both stores carry `prompts`/`prompt_versions` in `KNOWN_TABLES` from the same `0006` migration, so the move keeps the H1 foreign-DB allowlist satisfied on both. (With Decision A's fresh target id there is no shared-id window, so `prompt_owner` never sees an ambiguous duplicate mid-move — see M2.)
- **M2 — Delete-source is the LAST step; copy via `promptfile` record primitives, never a raw `fs::copy`.** Order = import-all-versions-to-target (files-then-index) → verify (O(1) index re-read) → `source.delete(source_id)` last. A crash after the target import but before the source delete yields a **recoverable duplicate**: because the target id is freshly minted (Decision A), the two prompts have distinct ids in independent DBs — both fully accessible, no `prompt_owner` ambiguity, no PK collision, no corruption, no data loss. Recovery is deleting the stray source copy through the UI. `source.delete` uses `remove_prompt` (a single `remove_dir_all`, all-or-nothing per prompt) — keep it as the sole deletion primitive; do not hand-delete individual version files. Re-serializing through `write_version`/`write_prompt` (backend-owned frontmatter, UUID filenames) cannot introduce a new oversize/conflict-marker file, and the target's `scan` hardening would catch one on the next reload anyway.
- **M3 — Prompt count for LOADED projects only; never transiently open unloaded stores to count.** Opening an unloaded store re-runs the full foreign-DB hardening gate (`open_existing`) and takes a Windows file lock; counting by opening each unloaded store on every `list_projects` render is both an H1-adjacent surface and a self-inflicted file-lock/DoS as project count grows. **Requirement:** populate `prompt_count` only for loaded projects (`None`/omitted when unloaded), exactly like `item_count`. If unloaded counts are ever genuinely required, count `prompts/` subdirectories off disk (a filesystem read, no DB open) rather than opening the store — and flag the per-call cost. Default: loaded-only.

### Low

- **L1 — Copy uses `navigator.clipboard.writeText` (no new dependency); note the OS-clipboard egress.** No clipboard code exists today; the CSP (`default-src 'self'`) does not restrict `navigator.clipboard` (a Web API, not a network surface). Plain-text write only (no rich/HTML format-injection). The one exposure — the prompt body lands on the shared OS clipboard (readable by any process; captured by Windows Clipboard History / Cloud Clipboard) — is user-initiated and expected; document it, don't block it. If `navigator.clipboard` proves unreliable in the packaged WebView2 build, `@tauri-apps/plugin-clipboard-manager` is the fallback and is a **new dependency (crate + npm + capability) that must be flagged** before adding (Global Rules / plan.7 L1).
- **L2 — Optional title relaxes only the two emptiness checks; title never reaches a filename or SQL sink.** Prompt/version filenames derive only from UUIDs; the title is written only as a quoted frontmatter value (escaped by `quote`, recovered by `unquote`) and bound in SQL via `push_bind`/`.bind` (never interpolated). An empty title (even empty title + empty body) is a benign blank record with no injection/filename/SQL risk — it is a UX concern, not a security one. Confirm no downstream code assumes a non-empty title (e.g. no `title.chars().next().unwrap()`, no title used as a map key) once optional. Title stays rendered as a React text node (M4 — no HTML rendering of prompt/model text; unchanged).
- **L3 — New dependencies:** none required for open-folder (opener plugin already present; the change is a Rust command + zero capability change), move, optional-title, or prompt-count. Clipboard is a new dependency only if the plugin fallback is chosen (flag it).

## 5. Design

### Approach

Ship five small, independent changes on existing seams and one new cross-store operation:

- **(1) Optional title:** relax two repository guards + a both-empty guard; add a pure `displayTitle()` helper and apply it at three display sites; remove the frontend save guard.
- **(2) Copy:** an `api.copyToClipboard()` wrapper (`navigator.clipboard`) + an editor-level button with inline "Copied" feedback.
- **(3) Move:** a `ProjectManager::move_prompt` orchestration over a new `PromptRepository::import_prompt` (mints fresh target ids, preserves version content/provenance), with import → verify → delete-source ordering; a `move_prompt` command; a move-target popover in `PromptEditor`.
- **(4a) Wider input:** CSS `min-width` on `.project-name` (+ optional dialog-cap bump + a wrapping `.project-actions` group).
- **(4b) Open folder:** a `reveal_project_folder(id)` Rust command (catalog lookup → `is_dir()` → server-side opener) + an `api.revealProjectFolder(id)` wrapper + a per-row button.
- **(4c) Prompt count:** a `PromptRepository::count_prompts()` + a `ProjectInfo.prompt_count` field mirrored end to end, populated loaded-only.

### Architecture

**Backend**
- `db/mod.rs` — extend `PromptRepository` with `count_prompts(&self) -> Result<i64>` and `import_prompt(&self, reusable: bool, prompt_created_at: &str, versions: &[PromptVersion]) -> Result<Prompt>` (mints a **fresh** prompt id + fresh version ids, preserving each version's `source`/`created_at`/`title`/`body` and the prompt's `reusable`/`created_at`). (An `export_prompt` returning `{head, versions}` is optional sugar; the manager assembles the export from `get` + `versions`.)
- `db/sqlite.rs` — implement both new methods; relax the two title guards; add the both-empty guard.
- `models.rs` — `ProjectInfo.prompt_count: Option<i64>` (`skip_serializing_if = "Option::is_none"`).
- `projects/mod.rs` — `move_prompt` orchestration; a `project_dir(id) -> Result<PathBuf>` accessor (for `reveal_project_folder`, §4 H1); add `prompt_count` to both `ProjectInfo` constructors, computing the item + prompt count together for a loaded project (fetch both loaded views via `repo_for(id)` and `prompts_for(id)` on the same id — e.g. a private `loaded_views(id)` helper — rather than two separate lock acquisitions per project per call).
- `commands.rs` — `move_prompt` and `reveal_project_folder` commands (thin wrappers).
- `lib.rs` — register both commands in the `generate_handler!` list.
- **No migration.** `capabilities/default.json` — **unchanged** (open-folder is a Rust command).

**Frontend**
- `types.ts` — `promptCount?: number` on `ProjectInfo`.
- `src/lib/api.ts` — `copyToClipboard(text)`, `movePrompt(id, targetProjectId)`, `revealProjectFolder(id)`.
- `src/lib/prompts.ts` (+ `prompts.test.ts`) — `displayTitle(title, body)`.
- `PromptEditor.tsx` — remove title guard; add Copy button + Move-to popover; accept a new `loaded: ProjectInfo[]` prop.
- `PromptList.tsx`, `PromptHistoryDialog.tsx`, `PromptsPage.tsx` — `displayTitle` at the three display sites; `PromptsPage` threads `loaded` to `PromptEditor` and adds the move handler (confirm + `mutate` + `setSelectedId(null)`).
- `ManageProjectsDialog.tsx` — Open-folder button per row; prompt count in the state chip.
- `styles.css` — widen `.project-name`; wrap trailing row controls in `.project-actions`; any new button classes reuse existing tokens.
- `docs/DESIGN.md` — amend the "Prompts page (new)" and "Project manager dialog (new)" subsections.

**Command contract (additions):**

| Command | Params | Returns |
|---|---|---|
| `move_prompt` | `promptId: string, targetProjectId: string` | `Prompt` (the moved prompt, stamped with the target project) |
| `reveal_project_folder` | `id: string` | `void` |

`list_projects`/`project_info` gain a `promptCount?` field on each `ProjectInfo`. Copy is frontend-only (no command).

### Key Decisions

1. **Decision A — Move mints a FRESH prompt id (and fresh version ids) in the target, copying all version content/provenance.** The target prompt gets a new backend UUID; every version is re-written with a new UUID but its original `source`/`created_at`/`title`/`body` preserved, plus the prompt's `reusable`/`created_at`. Source is deleted **last**, after the target import is verified. Rationale: (a) **no shared-id window** — source and target ids are always distinct, so `prompt_owner` never sees an ambiguous duplicate, and a crash mid-move leaves two **independent, individually-accessible** prompts (recovery = delete the stray source copy via the UI); (b) preserving the id buys **no** git-merge benefit here — the two projects are separate directories/repos and the target repo has never seen this prompt, so the moved subtree is "new" in the target either way; (c) history *content* and provenance are fully preserved, satisfying H2 (byte-identical filenames are not an H2 requirement). **Rejected alternative — preserve the id (Option A′):** a crash between the target commit and the source delete persists the **same** id in two loaded stores; `prompt_owner` (which errors on any id found in two stores) then permanently fails for that id, making the prompt **inaccessible in both projects** (not merely duplicated) via get/update/delete/move until a human manually unloads a project or deletes files on disk — and "re-run the move" does **not** recover it, because the retry also routes through `prompt_owner` and hits the same error (surfaced by code review against the actual `prompt_owner` implementation). Fresh ids trade byte-identical history and stable identity (ids are never user-visible) for the removal of that trap. **Recommend Decision A (fresh id); confirm with the user before Step 5** (see §10).
2. **Decision B — Both-empty policy: reject a prompt whose *resulting current version* would have empty title AND empty body (trimmed), enforced in the repository `create` and `update`.** Rationale: a fully-blank prompt has nothing for `displayTitle()` to derive, renders a blank row, is un-findable, still mints a version file, and risks a rebuild/scan inconsistency (contentless prompts are skipped on scan). This is the minimum constraint preserving "a prompt always has a showable current version." The check trims only for the guard test; the stored `body` is never mutated. (The frontend-specialist's lighter reading — allow fully-blank — is a considered alternative; the repository-layer reject is chosen for the rebuild-consistency reason.)
3. **Decision C — Open folder is a Rust command keyed by project id (Route B), not a webview opener grant (Route A).** Adversarially verified (§4 H1): Route A via `open_path` is non-functional without an unsafe `**` scope; Route A via `reveal_item_in_dir` is unscoped and gives select-in-parent UX. Route B needs **zero capability changes**, keeps the webview's OS-open surface at http/https, gives the correct "open folder contents" UX via `open_path`, and the server-side `is_dir()` re-check is a cheap TOCTOU guard on the one verb that can execute. Overrides the architect's/frontend-specialist's simpler-but-riskier suggestion on the strength of the verified security analysis.
4. **Decision D — `NewPrompt.title` stays `String` (empty allowed); no DTO change.** Minimal, and the backend already trims. Making it `#[serde(default)] Option<String>` (treat `None` as `""`) is a mirrored `models.rs`/`types.ts` DTO tweak with no migration — noted as an alternative if an omittable key is preferred. No item-style empty-title auto-generation carve-out is added (prompts never had it).
5. **Decision E — Move-to-same-project is rejected** (a clear `Invalid`), mirroring the existing "reject meaningless self-operations" precedent (`double_load_same_folder_is_rejected`), rather than a silent no-op.
6. **Decision F — Copy and Move controls live only in `PromptEditor`, not per-row in `PromptList`.** The list row is a single `<button>`; nesting action buttons is invalid HTML and unreachable for a11y. "Each prompt" is satisfied by the editor showing exactly one prompt. A rail-level quick-copy would require restructuring the row (row → non-button container) — a larger, unrequested change; deferred. (Flagged in §10 as an interpretation to confirm.)
7. **Decision G — Copy feedback is an inline label swap (`Copy to clipboard`→`Copied`, ~1.5s), not a new toast** — the app's actual success-feedback convention; avoids plumbing a new `onNotice` prop. An `sr-only` `aria-live` status covers screen readers.

## 6. Implementation Steps

Work top-to-bottom; each step is independently verifiable with `cd notes-app/src-tauri && cargo test`, `cd notes-app && npx tsc --noEmit`, and `npm run build`. Ordering (per the architect) does the smallest, most isolated items first and the move last.

**Step 1 — Prompt count + wider input (smallest, validates the `ProjectInfo` mirror).**
1. Add `count_prompts(&self) -> Result<i64>` to `PromptRepository` (`db/mod.rs`) and implement it on `SqliteRepository` as a bound `SELECT COUNT(*) FROM prompts` (mirror `count_active`).
2. Add `prompt_count: Option<i64>` (`skip_serializing_if = "Option::is_none"`) to `ProjectInfo` (`models.rs`) and `promptCount?: number` to `types.ts`.
3. Populate `prompt_count` in `list_projects` and `project_info` (`projects/mod.rs`) via `prompts_for(&row.id).ok()` — `Some(count)` when loaded, `None` when unloaded (mirror `item_count`). Compute the item + prompt count together for a loaded project (both loaded views resolve from the same id via `repo_for`/`prompts_for`; a small private `loaded_views(id)` helper avoids two separate lock acquisitions per project per call).
4. Render the count in `ManageProjectsDialog.tsx` (~148–150) by extending the existing state span: `${count} ITEM(S) · ${promptCount} PROMPT(S)` when loaded; leave `UNLOADED` unchanged.
5. Widen `.project-name` in `styles.css` (add `min-width`, e.g. `220px`); bump `.dialog-projects` cap if needed; wrap trailing `.project-row` controls in a `.project-actions` flex-wrap group (pre-emptive, since Step 4 adds a 5th button).
6. Tests: `prompt_count_reflects_creates_and_deletes` and `prompt_count_is_unaffected_by_the_reusable_filter` in `repo_prompts.rs`.

**Step 2 — Optional title (backend guards + display).**
7. Relax the two title guards: `db/sqlite.rs` `create` (~896–900) and `update` (~967–976) — keep `.trim()`, drop the emptiness rejection. Add the **both-empty guard** (Decision B) in both, checking the resulting current-version title+body.
8. **Update the two existing tests that assert the OLD reject behavior** (they will correctly go red otherwise). Each assertion lives *inside* a larger, multi-purpose test — edit the specific assertion, not the whole test body: the empty-title rejection at the tail of `prompt_create_owns_id_timestamps_and_a_first_version` (`repo_prompts.rs`, the `create(new_prompt("   ", "b"))` is-`Invalid` assertion), and the one inside `prompt_get_update_delete_round_trip_and_second_delete_is_not_found` (the `update(..., title: Some("  "))` is-`Invalid` assertion). Flip both to assert success + the stored value.
9. Add `displayTitle(title, body)` to `src/lib/prompts.ts`: `title.trim() || firstNonEmptyBodyLine(body).slice(0, 60) || "Untitled"`.
10. Apply `displayTitle` at `PromptList.tsx:85`, `PromptHistoryDialog.tsx:73`, and `PromptsPage.tsx:146` (delete-confirm). Remove the frontend save guard `PromptEditor.tsx:74-77`.
11. Tests: empty/whitespace-title create+update succeed; both-empty rejected; empty-title round-trips through the file format + index (add an empty-title analog to the existing `empty_body_round_trips`); `displayTitle` unit tests in `prompts.test.ts`.

**Step 3 — Copy to clipboard.**
12. Add `copyToClipboard(text)` to `api.ts` (next to `openExternal`) using `navigator.clipboard.writeText`.
13. Add the Copy button to the `PromptEditor` action row (between the `vN` badge and `meta-spring`), copying `body`; inline `Copied` label swap (`useState` + timeout cleared on unmount/prompt change) with an `sr-only` `aria-live` status; failures route through the existing `onError`.

**Step 4 — Open project folder (security-critical: Rust command).**
14. Add `ProjectManager::project_dir(&self, id: &str) -> Result<PathBuf>` (`projects/mod.rs`) that resolves a project's directory from the catalog row by id (model on the `row.path` lookup already in `delete_files`/`project_info`) — `AppState` today exposes only `manager`, and the `catalog` field is private, so this accessor is required. Then add `reveal_project_folder(id: String, app: AppHandle, state: State<AppState>)` in `commands.rs`: `let dir = state.manager.project_dir(&id).await?;` → verify `std::fs::metadata(&dir).is_dir()` (return a clear `Invalid`/`NotFound` otherwise) → `app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>)` (the opener plugin's Rust API). Register it in `lib.rs`. **Add no opener permission to `capabilities/default.json`.**
15. Add `revealProjectFolder(id)` to `api.ts` (`invoke("reveal_project_folder", { id })`). Add an "Open folder" button to each `.project-row` in `ManageProjectsDialog.tsx`, enabled regardless of loaded state, gated by `busy`, with `aria-label` `Open folder for ${p.name}`.

**Step 5 — Move a prompt between projects (last; the one novel cross-store change).**
16. Add `import_prompt(&self, reusable: bool, prompt_created_at: &str, versions: &[PromptVersion]) -> Result<Prompt>` to `PromptRepository` (`db/mod.rs`) and implement it on `SqliteRepository` (model the verbatim insert on `insert_item_verbatim`, but **mint a fresh prompt id + fresh version ids** — Decision A): write `prompt.md` + one immutable version file per source version into the target `prompts_dir` via `promptfile` primitives, preserving each version's `source`/`created_at`/`title`/`body` and the prompt's `reusable`/`created_at` (only the ids are new), then insert the `prompts` + `prompt_versions` rows in one transaction, parent-before-child. Return the imported `Prompt`.
17. Add `ProjectManager::move_prompt(prompt_id, target_project_id) -> Result<Prompt>` (`projects/mod.rs`): resolve source via `prompt_owner`, target via `prompts_for`; reject unknown/unloaded target and `target == source` (Decision E); export head (`get`) + all versions (`versions`) from the source; call `target.import_prompt(...)` (returns the new `Prompt`); **verify** by re-reading `target.versions(new_id)` (an O(1) indexed read) and asserting its count equals the source version count — on mismatch, roll back via `target.delete(new_id)` (atomically removes the target files **and** index rows) and abort with the **source untouched**; **only then** `source.delete(source_id)`. Return the imported prompt stamped with the target project. (Do **not** verify via `promptfile::scan` of the single moved dir — `scan` iterates *subdirectories* of a `prompts_dir`, so it returns empty for one prompt's own dir; verifying via `scan` would require an O(all-prompts) whole-store scan.)
18. Add the `move_prompt` command in `commands.rs` (thin wrapper) and register it in `lib.rs`. Add `movePrompt(id, targetProjectId)` to `api.ts` and `types.ts` as needed.
19. Frontend UI: thread a `loaded: ProjectInfo[]` prop `PromptsPage → PromptEditor`. In `PromptEditor`, compute `otherLoaded = loaded.filter(p => p.id !== prompt.projectId)`; add a "Move to project…" popover (reuse `usePopover` + `.popover` CSS from `EditorTags.tsx`) in the action row, non-draft only, `disabled` when `otherLoaded.length === 0` (with a `title` tooltip). On select → `confirmDialog` → `mutate(() => api.movePrompt(prompt.id, target.id))` → `setSelectedId(null)` (mirror the delete path; `mutate` already reloads the list).

**Step 6 — Docs + verification.**
20. Update `docs/DESIGN.md`: amend "Prompts page (new)" (optional title + derived display label; the Copy and Move-to action buttons and their placement) and "Project manager dialog (new)" (the Open-folder per-row action, available regardless of loaded state; the `N ITEMS · M PROMPTS` state chip; the widened input). Pin the move confirm-copy verbatim, matching how other destructive confirms are documented. Yellow stays reserved for the AI card throughout.
21. Run the full gate: `cargo test`, `npx tsc --noEmit`, `npm run build`, and a `npm run tauri dev` manual smoke (§8/§9). Fix regressions before finishing.

## 7. Files to Create or Modify

| File | Action | Purpose |
|---|---|---|
| `notes-app/src-tauri/src/db/mod.rs` | Modify | `PromptRepository`: add `count_prompts` + `import_prompt` |
| `notes-app/src-tauri/src/db/sqlite.rs` | Modify | Implement `count_prompts`/`import_prompt`; relax two title guards; add both-empty guard |
| `notes-app/src-tauri/src/models.rs` | Modify | `ProjectInfo.prompt_count: Option<i64>` |
| `notes-app/src-tauri/src/projects/mod.rs` | Modify | `move_prompt` orchestration; `project_dir(id)` accessor (H1); populate `prompt_count` in both `ProjectInfo` constructors |
| `notes-app/src-tauri/src/commands.rs` | Modify | `move_prompt` + `reveal_project_folder` commands |
| `notes-app/src-tauri/src/lib.rs` | Modify | Register `move_prompt` + `reveal_project_folder` |
| `notes-app/src/lib/api.ts` | Modify | `copyToClipboard`, `movePrompt`, `revealProjectFolder` wrappers |
| `notes-app/src/types.ts` | Modify | `ProjectInfo.promptCount?`; move DTO if needed |
| `notes-app/src/lib/prompts.ts` | Modify | `displayTitle(title, body)` helper |
| `notes-app/src/components/PromptEditor.tsx` | Modify | Remove title guard; Copy button; Move-to popover; `loaded` prop |
| `notes-app/src/components/PromptList.tsx` | Modify | `displayTitle` for the row title |
| `notes-app/src/components/PromptHistoryDialog.tsx` | Modify | `displayTitle` for version titles |
| `notes-app/src/components/PromptsPage.tsx` | Modify | `displayTitle` in delete-confirm; thread `loaded`; move handler |
| `notes-app/src/components/ManageProjectsDialog.tsx` | Modify | Open-folder button; prompt count in state chip; wider-input markup |
| `notes-app/src/styles.css` | Modify | Widen `.project-name`; `.project-actions` wrap group; any new button classes |
| `notes-app/docs/DESIGN.md` | Modify | Amend Prompts-page + project-dialog subsections |
| `notes-app/src-tauri/tests/repo_prompts.rs` | Modify | Optional-title (incl. flipping 2 existing tests), both-empty, count, import/verbatim tests |
| `notes-app/src-tauri/tests/project_manager.rs` | Modify | Move integration tests (history preservation, single-owner, reload, requires-loaded, same-project reject, delete-after-move, count-after-move); a capability-guard test asserting `capabilities/default.json` never contains `allow-open-path`/`allow-reveal-item-in-dir` (H1 regression insurance) |
| `notes-app/src-tauri/tests/export_import.rs` | Modify | Format-level relocation fixture (promptfile move preserves every version) |
| `notes-app/src/lib/prompts.test.ts` | Modify | `displayTitle` unit tests (+ move-target helper if added) |

## 8. Test Strategy

*(Source: test-writer, mapped to existing conventions — `repo_prompts.rs`/`repo.rs` in-memory `SqliteRepository::connect_in_memory`; `project_manager.rs` `tempfile::tempdir` real multi-store; `export_import.rs` byte-deterministic format + git-merge fixtures; node-only vitest pure helpers, no jsdom/RTL/component tests; `#[tauri::command]` wrappers are never unit-tested.)*

- [ ] **Unit Tests (Rust, `repo_prompts.rs`):**
  - `create` with empty/whitespace title now **succeeds** (`title == ""`); `update` to empty/whitespace title **succeeds** and (content changed) appends exactly one version.
  - Empty title **round-trips** through the file format + index (add an empty-title analog to `empty_body_round_trips`; assert `parse_version(&serialize_version(v)).title == ""`).
  - **Both-empty rejected** on `create` and on `update` (using the *resolved* new title+body, so clearing title while body is also being cleared is caught); the two non-degenerate combos (empty title + real body, and vice versa) still succeed.
  - **Flip the two existing tests** asserting empty titles are rejected (create + update) to assert acceptance — same commit.
  - `NewPrompt` still requires `projectId`; optional-title does not regress the camelCase-shape test.
  - `count_prompts` reflects creates/deletes (0 on empty store, not an error); is unaffected by the reusable filter (counts all prompts).
- [ ] **Integration Tests (Rust, `project_manager.rs` + `export_import.rs`) — the MOVE, highest value:** *(Decision A = fresh id — the moved prompt gets a NEW id in the target; assert on preserved content/history, not on id equality.)*
  - Move relocates the prompt — the source `prompts/<old-id>/` subtree is gone, and the target has a new `prompts/<new-id>/` with `prompt.md` + one version file per source version; the returned `Prompt` has a **new** id (`!= old id`) and `projectId == target`.
  - **Full version history preserved (content, not filenames)** — the target prompt's `prompt_versions()` has the same count and the same per-version `source`/`created_at`/`title`/`body` as the source had, in the same order (ordering stable on equal timestamps).
  - After a move, `get_prompt(new_id)` succeeds and `get_prompt(old_id)` is `NotFound`; `list_prompts` scoped to source is empty, to target contains exactly the moved prompt. `prompt_owner` never errors (no shared id).
  - Move then **reload both projects** rebuilds correct state from files (source empty, target has full history under the new id) — proves files, not just index, reflect the move.
  - Move **requires the target loaded** → clear `Invalid` (not `NotFound`, not panic); source untouched. Unknown/not-loaded prompt id → `NotFound`.
  - **Move-to-same-project rejected** (`Invalid`); source unchanged (no duplicate created).
  - Move does **not** change the moved prompt's `versionCount`, and the derived `updatedAt` equals the newest source version's `created_at` (preserved, since version `created_at` values travel) — the test most likely to catch a naive delete+recreate that re-stamps timestamps.
  - Move **preserves the `reusable` flag** (the mutable `prompt.md` head travels too).
  - `delete_files` on the SOURCE after a move does not affect the target's copy; on the TARGET removes it (H3 sweep correct post-move).
  - Prompt count reflects the move on both projects (source −1, target +1).
  - **Rollback:** if the target import verify fails (version-count mismatch), `move_prompt` leaves the source untouched and no orphan target row/file remains (rollback via `target.delete`).
  - **Cross-volume / atomicity:** an `#[ignore]`'d placeholder (mirroring `open_existing_rejects_an_oversized_file`) with a code-inspection note that the move never relies on a cross-store `fs::rename` (each target file is a same-dir temp-then-rename); plus, if feasible, a fault-injection assertion that a failed target import never deletes the source (flag as environment-fragile on Windows; code-review fallback acceptable).
  - `export_import.rs`: importing a prompt's exported versions into a second `prompts_dir` via the public API preserves every version's content (structural `assert_eq` on `source`/`created_at`/`title`/`body`), and `remove_prompt` clears the source — the format-level acceptance test.
- [ ] **Security regression test (Rust, `project_manager.rs` or a small dedicated test):**
  - Read `capabilities/default.json` and assert it contains **no** `opener:allow-open-path` / `opener:allow-reveal-item-in-dir` (nor a bare `allow-open-path`/`allow-reveal-item-in-dir`) — durable insurance that a future change can't silently re-open the webview's OS-open surface (H1).
- [ ] **Frontend Unit Tests (vitest, `prompts.test.ts`, pure helpers only):**
  - `displayTitle`: non-empty title passthrough; empty title → first non-blank body line; whitespace-only title → derived (not returned verbatim); body with leading blank lines → first real line (guards a naive `split("\n")[0]`); both empty → `"Untitled"` (pin the literal).
  - If a move-target helper is added, test it excludes the current project and returns `[]` when no other loaded projects exist. (Confirm whether `PromptsPage` passes only-loaded projects before writing this — it does today.)
- [ ] **Edge Cases & Error Scenarios:**
  - Optional title: empty title + real body (allowed) vs both empty (rejected); a version whose title alone is blank renders via `displayTitle` in History.
  - Move: target unloaded between render and click → surfaces via `onError`; `<2` loaded projects → move trigger disabled.
  - Open folder: catalog path is now a file or missing → `reveal_project_folder` returns an error rather than opening/executing.
  - Copy: empty-body prompt copies an empty string without throwing.
- [ ] **Manual smoke (`npm run tauri dev`)** — the UI-only pieces get no automated coverage (repo's node-only vitest convention): copy button feedback + exact body (not title) copied; open-folder opens Explorer at `p.path` for loaded and unloaded projects (and does nothing dangerous if the path is stale); wider input in light + dark without layout break; prompt-count badge (loaded shows `N ITEMS · M PROMPTS`, unloaded shows `UNLOADED`); move end-to-end (target picker excludes current project, prompt vanishes from source and appears in target with full History + provenance intact; single-loaded-project → control absent/disabled); blank-title prompt renders the derived label while the title `<input>` stays visually empty; saving a blank-title, non-blank-body prompt from the UI succeeds.

## 9. Success Criteria

- [ ] **Functional:** a prompt can be created/saved with no title and renders a derived label everywhere (list, history, delete-confirm); a Copy button copies the body with clear feedback; a prompt can be moved to another loaded project, disappearing from the source and appearing in the target with its **full version history and provenance preserved**; the project manager shows a wider name input, a per-row Open-folder button that opens the project directory in Explorer, and a prompt count next to each loaded project.
- [ ] **Tests:** all §8 tests pass (`cd notes-app/src-tauri && cargo test`, plus vitest).
- [ ] **Security:** H1 (open-folder is a Rust command keyed by id, `is_dir()`-verified, no webview opener grant), H2 (move copies full history content — per-version `source`/`created_at`/`title`/`body` — with source deleted last), M1 (target resolved by id via `prompts_for`, same-project rejected), M2 (delete-source last, `promptfile` primitives, fresh target id ⇒ recoverable duplicate not corruption), M3 (prompt count loaded-only), L1 (`navigator.clipboard`, no new dep, OS-clipboard egress documented), L2 (optional title relaxes only the two checks; no filename/SQL sink) all implemented and verified.
- [ ] **Quality:** `npx tsc --noEmit` clean (strict, `noUnusedLocals`), `npm run build` clean, existing `cargo test` suite still green, no new dependencies added without a flag, no new use of `--mark` yellow, DESIGN.md updated so it stays authoritative.

## 10. Risks & Open Questions

- **Adversarial-verifier verdict (CONFIRMED, high confidence):** the "open folder" security claim (H1) — a bare `opener:allow-open-path` grant denies every path (empty scope → `ForbiddenPath`) and needs an unsafe `**` scope to function; `open_path` on a file executes it; `reveal_item_in_dir` is unscoped in 2.5.4; a Rust-side opener call is not ACL-gated, so **Route B (Rust command, no capability change) is justified**. This drives Step 4 and Decision C. No REFUTED/UNVERIFIABLE claims.
- **Open question — move-id strategy (Decision A):** built to **mint a fresh target prompt/version id** (copying all version content/provenance), because code review against the actual `prompt_owner` showed the alternative — preserving the id — turns a crash mid-move into a prompt that is **inaccessible in both projects** (a persisted same-id duplicate makes `prompt_owner` error permanently), not merely duplicated. Fresh ids eliminate that trap (no shared-id window) and buy no git-merge loss (separate project repos). The trade is non-byte-identical history filenames and a changed id (ids are never user-visible). **Recommend fresh id (Decision A); confirm with the user before Step 5** — if they value stable ids/byte-identical history and accept the crash trap, preserve-id (Option A′) with verify-before-delete is the documented alternative.
- **Open question — "wider name input" interpretation:** the only name input in the project dialog is the **create** field ("New project name") — there is no per-project rename field. Built for the literal reading (widen the create field). If the intent is actually "let me rename a project," that is a **separate feature** touching three identity sources (catalog row, `project.json`, DB meta) and should be its own ticket. **Confirm the literal reading.**
- **Open question — copy/move placement (Decision F):** "add a Copy button to each prompt" is built as an **editor-level** button (the list row is a single `<button>`; nesting is invalid HTML). If a rail-level per-row quick-copy is genuinely wanted, the `PromptList` row must be restructured (row → non-button container) — a larger change, deferred. **Confirm the editor-level placement satisfies "each prompt."**
- **Open question — both-empty policy (Decision B):** built to **reject** a prompt with empty title AND empty body (repository layer). The frontend-specialist's lighter reading allows it. Recommend the reject for rebuild-consistency; flip if the team prefers permissive.
- **Risk — the move is the app's first cross-store mutation.** Cross-volume file ops, dual-store index consistency, and the verify-after-publish/rollback ordering are the non-obvious seams; covered by the move integration tests (no-shared-id, reload-rebuilds, history-preserved, rollback, delete-after-move). Consider shipping the move as a separate commit/PR (Batch B) after the other five (Batch A) so its review is isolated (tech-lead's scoping steer).
- **Risk — two existing `repo_prompts.rs` tests assert the old reject-empty-title behavior** and must be flipped in the same commit as Step 2, or the suite is self-contradictory.
- **Risk — clipboard reliability in the packaged WebView2 build is unverified.** `navigator.clipboard` is expected to work from a click handler; the manual smoke step confirms it. The `@tauri-apps/plugin-clipboard-manager` fallback is a new dependency to flag if needed.
- **Stale-doc note:** the root `CLAUDE.md` "Items do not move between projects in v1" is about *items*; this plan adds cross-project moves for *prompts* only. Document "prompts may move; items still may not" so the invariant stays honest.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (e.g. no leftover title-guard helper).
- [ ] Error handling covers failure modes: both-empty prompt rejected; move to unloaded/unknown/same target rejected with clear errors; move verify-then-delete rolls back on mismatch leaving the source untouched; `reveal_project_folder` rejects a non-directory/missing path; copy failure routes through `onError`.
- [ ] Security (§4): open-folder is a Rust command keyed by id with `is_dir()` re-check and **no** opener permission added to `capabilities/default.json` (H1, with the capability-guard regression test); move preserves per-version content/provenance (mints fresh ids) and deletes source last with atomic rollback on verify-fail (H2/M2); move target resolved by id via `prompts_for`, same-project rejected (M1); prompt count loaded-only, no transient store opens (M3); copy via `navigator.clipboard`, no new dep (L1); title never enters a filename/SQL sink and stays a text node (L2/M4).
- [ ] Conventions: sqlx runtime API only; **no new migration** (schema unchanged); RFC3339 fixed-ms timestamps preserved verbatim on move; serde camelCase mirror between `models.rs` and `types.ts`; frontend calls only `api.ts`; DESIGN.md updated; yellow stays AI-exclusive.
- [ ] Tests cover happy path, edge cases (empty title, both-empty, equal timestamps, no-other-projects), and error scenarios; the two flipped tests are updated; each new invariant has a test in the same commit.
- [ ] No performance regressions: `count_prompts` is a small `COUNT(*)`; move is O(1 prompt) with no whole-store rebuild; no N+1 across versions; no unnecessary re-renders from the new props/state.
- [ ] Changes are minimal — no unrelated refactoring; no new dependencies (clipboard plugin only if flagged); the move ships isolated if split into Batch B.

## 12. Post-Review Improvements

*(After implementation, two read-only reviews ran against the full working-tree diff: a **code-reviewer** against the §11 checklist and a **security-auditor** against §4. The security audit found every §4 mitigation (H1, H2, M1, M2, M3, L1, L2) actually implemented and traced end-to-end — no vulnerabilities. The code review found the implementation matches the plan and the one deliberate deviation (id-preserving move, per the user's answer to the §10 open question — see below), with **one substantive gap** plus one informational note and one nit, all resolved below.)*

**Note on the move-id decision:** the user answered the §10 open question by choosing the **id-preserving move (Option A′)**, not the recommended fresh-id Decision A. So `import_prompt` preserves the source prompt/version UUIDs verbatim, and the move tests assert id **equality** (target id == source id) with full content/provenance preservation. The documented, accepted tradeoff stands: a crash between the target import committing and the source delete leaves the same id in two loaded stores, which makes `prompt_owner` error for that id until a human unloads one project (re-running the move does not recover it). Everything else in §5/§6 was built as specified.

### Implemented

1. **Move left an orphan copy in the target when `import_prompt` itself failed (code-review Warning — real gap).** `move_prompt`'s rollback only covered the "`import_prompt` returned `Ok` but the verified version count mismatched" branch. If `import_prompt` returned `Err` — a partial version-file write on a syncing/removable/full volume (files written in a loop *before* the index transaction), or a transient post-commit read failure — the `?` propagated straight out with no cleanup, leaving either a truncated phantom prompt (`scan` resurrects any dir with ≥1 version file on the next reload) or, in the post-commit case, a *complete* duplicate present in both stores in the same session. **Fix:** made `import_prompt` **atomic** — it delegates the write+index work to `import_prompt_committed`, and on ANY error calls `discard_partial_import`, which best-effort removes both the canonical files (`remove_prompt`) AND any committed index rows for that id. So a failed import now leaves nothing behind, `move_prompt`'s `?` returns with the source untouched, and neither a phantom nor a duplicate can survive (`db/sqlite.rs`). This closes both scenarios the reviewer described; the `#[ignore]`d rollback placeholder's rationale was updated to name the atomic-cleanup path (fault injection into `import_prompt` isn't reachable through the public API, so it stays code-inspection-verified).
2. **A verify-time read *error* (not just a count mismatch) skipped rollback (security-audit informational).** `move_prompt`'s verify step originally used `target.versions(id).await?` — if that re-read errored, the `?` returned before the rollback branch, leaving the imported target copy in place alongside the (not-yet-deleted) source. **Fix:** the verify now treats a failed re-read exactly like a count mismatch — `matches!(target.versions(id).await, Ok(v) if v.len() == expected)`; either rolls the target back via `target.delete` and aborts with the source untouched (`projects/mod.rs`). Combined with improvement 1, every failure path of the move now leaves the source intact and the target clean.
3. **Stale doc comment on `write_version` in the import path (code-review nit).** The comment claimed version files are "never overwritten in practice (unique ids)" — true for `create`/`update` (fresh UUIDs) but not for the id-preserving `import_prompt`, where a retry of the crash-recovery path can legitimately rewrite the same version file (harmlessly, since the content is byte-identical). **Fix:** rewrote the `import_prompt_committed` doc comment to state this accurately.

### Accepted with rationale (no change)

4. **Rollback / cross-volume move behavior stays code-inspection-verified (two `#[ignore]`d placeholders).** Forcing an `import_prompt` failure or a verify-count mismatch needs I/O fault injection the public repository API does not expose, and a genuine multi-volume harness isn't available in CI. The atomic-import + verify-or-error rollback paths (improvements 1–2) are covered by reading the assertions; the cross-volume correctness rests on the code never using a cross-store `fs::rename` (every target write is a same-dir temp-then-rename inside the target `prompts_dir`). Documented in the placeholders' `#[ignore]` reasons.

## 13. Execution Prompt

```
Implement Plan 8 (prompt & project-management enhancements) for the worknotes app. The app source is under the notes-app/ subdirectory.

1. READ the plan first, in full: notes-app/plans/plan.8.md. Also read notes-app/CLAUDE.md (architecture invariants) and skim notes-app/plans/plan.7.md (the existing Prompts feature this builds on) before writing any code.

2. Before starting Step 5 (the move), confirm these open questions with the user (see §10); default to the plan's recommendation if no answer:
   - Move-id strategy: mint a fresh target prompt/version id (recommended — no crash-duplicate trap) vs. preserve the prompt/version UUIDs (byte-identical history, but a crash mid-move makes the prompt inaccessible in both projects via prompt_owner). Default: fresh id.
   - "Wider name input": is it literally widening the create field (default), or a request to add project rename (a separate feature)? Default: literal.
   - Copy/Move placement: editor-level buttons satisfy "each prompt" (default), vs. restructuring the list row for per-row buttons. Default: editor-level.
   - Both-empty policy: reject a prompt with empty title AND empty body (default) vs. allow it. Default: reject.

3. Implement the plan step by step, following Section 6 exactly (Step 1 count+wider-input → Step 2 optional title → Step 3 copy → Step 4 open-folder → Step 5 move → Step 6 docs+verify). Honor every architecture invariant in notes-app/CLAUDE.md: sqlx runtime API only; NO new migration (all three backend features reuse the existing 0006 schema — do not add one); RFC3339 fixed-ms timestamps preserved verbatim across a move (never re-minted); serde camelCase DTOs mirrored between models.rs and types.ts; the frontend calls storage/AI only through src/lib/api.ts; the two swap-point traits (ItemRepository, AiProvider) must not leak concrete impls to commands; DESIGN.md is authoritative and yellow stays reserved for the AI signature element.

4. CRITICAL security items from Section 4 (do not skip):
   - OPEN FOLDER (H1 — CONFIRMED): add a new ProjectManager::project_dir(id) -> Result<PathBuf> accessor (AppState exposes only `manager`; the catalog is private — you cannot look a project up from commands.rs without it). Implement it as a Rust #[tauri::command] reveal_project_folder(id, app, state) that resolves the dir via state.manager.project_dir(&id), verifies std::fs::metadata(&dir).is_dir(), and calls the opener plugin's RUST API server-side (app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>)). Do NOT add opener:allow-open-path or opener:allow-reveal-item-in-dir to capabilities/default.json, and do NOT call openPath/revealItemInDir from the webview — a bare path grant is either non-functional or unscoped, and open_path on a file executes it. The webview passes only the project id. Add a test asserting capabilities/default.json never grants those opener path/reveal permissions.
   - MOVE (H2/M1/M2): copy the FULL version history preserving each version's source/created_at/title/body (and the prompt's reusable/created_at) before deleting the source; mint FRESH prompt/version ids in the target (per Decision A — fresh ids avoid a crash leaving a same-id prompt inaccessible in both stores); resolve the target by project id via prompts_for (a loaded catalog store), never a filesystem path; reject same-project and unloaded/unknown targets; import files-then-index (one transaction, parent-before-child), then VERIFY by re-reading target.versions(new_id) count == source count and roll back via target.delete(new_id) on mismatch leaving the source untouched (do NOT verify via promptfile::scan of the single moved dir — scan iterates subdirectories and returns empty for one prompt's own dir); delete the source LAST (a crash yields two independent, individually-accessible prompts, never data loss); copy via the promptfile write primitives (never a raw fs::copy); use no cross-store fs::rename (projects live on arbitrary volumes).
   - PROMPT COUNT (M3): populate prompt_count only for LOADED projects (None when unloaded); never transiently open an unloaded store to count.
   - COPY (L1): use navigator.clipboard.writeText (no new dependency); if a Tauri clipboard plugin turns out to be required, FLAG it before adding.
   - OPTIONAL TITLE (L2/M4): relax only the two title-emptiness guards (create + update) plus add the both-empty guard; keep the title rendered as a React text node; it must never enter a filename or SQL sink.
   Do not add any new crate or npm dependency without flagging it first.

5. Use subagents during implementation (fallback clause: if a named agent type is unavailable, fall back to a generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise — with the role stated in the prompt):
   - Spawn a database-architect (or fallback) for Step 5's cross-store move (import_prompt verbatim insert + the ProjectManager move_prompt orchestration + verify-before-delete), since it touches the file-per-item + rebuildable-index model.
   - Spawn a frontend-specialist (or fallback) for the PromptEditor Copy button + Move-to popover, the displayTitle display sites, and the ManageProjectsDialog changes, matching DESIGN.md tokens.
   - Spawn a test-writer (or fallback) to write the tests per Section 8 (extend tests/repo_prompts.rs — including FLIPPING the two existing tests that assert empty titles are rejected — tests/project_manager.rs, tests/export_import.rs, and src/lib/prompts.test.ts), proving each new test can fail.
   - After implementation, spawn a code-reviewer agent (read-only: Read, Grep, Glob; fallback general-purpose read-only) to review the diff against Section 11.
   - After implementation, spawn a security-auditor agent (read-only: Read, Grep, Glob; fallback Explore) to verify every mitigation in Section 4 (especially H1 no-webview-opener-grant, H2/M2 move ordering + history preservation, M3 loaded-only count) is actually present.
   - Do NOT spawn api-designer/devops/performance agents — this feature does not touch their domains (the IPC surface is Tauri commands, covered by the plan).

6. Run the Section 11 code review checklist after implementation and address every item.

7. Document any improvements found in review in Section 12 of the plan file, then implement them.

8. Before finishing, run the full verification gate and fix any regressions: `cd notes-app/src-tauri && cargo test`, then `cd notes-app && npx tsc --noEmit`, then `npm run build`, then a `npm run tauri dev` manual smoke of the Section 9 criteria (especially: move preserves full history in the target's History dialog; open-folder opens Explorer at the project path and does nothing dangerous on a stale path; a blank-title prompt renders its derived label). Report results plainly — failing tests or skipped smoke steps are results, not things to smooth over. (Project-memory caveats: a leftover notes-app.exe can lock target/debug during cargo test — kill it first; cargo test link can fail LNK1318 on a near-full C: — clean target / disable debuginfo if so.)
```
