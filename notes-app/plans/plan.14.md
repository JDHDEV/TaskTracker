# Plan 14: Editor UX batch — status auto-save, Testing status, unsaved indicator, session restore, toast dismissal, line clipboard, note conversion

**Created:** 2026-08-30
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Seven user-requested features, planned together and implemented as six ordered phases:

| # | Feature | Phase |
|---|---------|-------|
| F5 | Auto-dismiss the "no API key" toast when a key is saved | 1 |
| F1 | Task status changes persist immediately (no manual Save) | 2 |
| F3 | Visible page-level highlight while there are unsaved changes | 2 |
| F2 | New `testing` task status | 3 |
| F7 | Convert a note into a task or a prompt | 4 |
| F4 | Restore open tabs / page / filters across app restarts | 5 |
| F6 | Ctrl+X/C/V act on the whole current line when nothing is selected | 6 |

Why it matters: F1/F3/F5 remove daily friction in the save flow; F2 models the user's actual workflow (work that is in test); F7 honors "this note turned out to be a task"; F4 makes the app resume where it left off; F6 brings a VS Code habit into the editors.

This plan was produced with six research subagents (tech-lead, architect, security-auditor, test-writer, frontend-specialist, database-architect) plus an adversarial verifier for the three load-bearing claims. All three claims were CONFIRMED (Section 10).

## 2. Strategic Assessment

*(Source: tech-lead agent, corroborated by the others.)*

- **This is not one feature — it is four unrelated features plus paper cuts.** Implement in the phase order above; each phase is independently shippable and verifiable. Do not let the compat decision in F2 get waved through under batch momentum.
- **F1 is not a reversal of Plan 13's "explicit Save, not autosave" decision** (plan.13.md D3 — that was about a *text buffer*). Status is a discrete control, and the app already has immediate-persist discrete controls: Pin and Archive call `mutate()` directly with no Save (`src/App.tsx:682-687`). F1 moves status from the buffered-field category into that existing metadata-action category. State this framing in code review or it will be flagged as contradicting D3.
- **F2 is the riskiest item.** It widens the *value domain* of an existing frontmatter key, which the on-disk compatibility rules in `notes-app/CLAUDE.md` do not cover (they cover unknown *keys*, not unknown *values*). An older build opening a directory containing `status: testing` silently skips the file — the task vanishes from the list with at most a warning (verifier-CONFIRMED). It also requires a table-rebuild migration with two traps (Section 5, D4/D5).
- **F7 is two different features.** Note→prompt is not a kind change at all (a Prompt is a separate entity) and is ~90% built — Plan 13's `promptSeed` / `sendSelectionToPrompt` plumbing (`src/App.tsx:144-146, 353-357`). Note→task is a real one-way kind mutation that requires narrowing (not deleting) the "kind is fixed at creation" invariant.
- **F6 has the worst value-to-risk ratio.** Cut/copy are cheap and safe via selection expansion (no clipboard API, native undo preserved). Line-aware paste needs an in-process "last copy was a line" sentinel and a programmatic insert that breaks native undo for that one action. No new dependency is needed or permitted (Section 4, S-7). It is last in the phase order and the easiest phase to defer.
- **Riskiest parts overall:** migration `0008` (can brick or silently empty stores if written naively — D4/D5) and the F2 old-build data invisibility (D6).

## 3. Research Findings

*(Sources: architect, frontend-specialist, database-architect agents. All line numbers verified against branch `plan-13-scratch-pad-selection`, HEAD `da65361`.)*

### Codebase shape (load-bearing facts)

- Three pages, all mounted simultaneously, toggled by `hidden`: Worknotes (`src/App.tsx`), Prompts (`src/components/PromptsPage.tsx`), Scratch (`src/components/ScratchPage.tsx`). Each owns an independent `OpenTabsState<T>` (pure reducer, `src/lib/openTabs.ts`) with per-tab `isDirty`.
- Three near-identical editors — `Editor.tsx`, `PromptEditor.tsx`, `ScratchEditor.tsx` — each with its own `save()`, `savingRef` guard, selection tracking (`bodyRef`/`selRef`/`trackSelection`), and `pendingCaretRef` + `useLayoutEffect` caret restoration. Features touching "the editor" must land in all three or be explicitly scoped.
- Frontend tests are node-env vitest, **pure `src/lib/*.ts` modules only** — no jsdom, no RTL (a deliberate Plan 11/13 decision). Any new logic that wants coverage must be a pure module. Backend tests live in `src-tauri/tests/` (`repo.rs`, `project_manager.rs`, `on_disk_compat.rs` with append-only golden fixtures in `tests/fixtures/v1_0_0/`).
- Only two localStorage keys exist (`palette` in `src/lib/palettes.ts:36-60`, `provider` in `src/lib/aiProvider.ts:8-19`) — both whitelist-validated with deterministic fallback; their tests install an in-memory localStorage shim (copy it verbatim).

### F1 — status auto-save

- Status is dirty-tracked today: the `<select>` at `Editor.tsx:553-566` calls `edit(setStatus)` (`edit()` = setter + `setDirty(true)`, `Editor.tsx:509-514`); persistence only happens in `save()` (`Editor.tsx:268-349`), which sends the **whole buffer**.
- Prior art: `onPin`/`onArchive` → `App.tsx:682-687` → `mutate(() => api.updateItem(id, { pinned/archived }))`; `mutate` (`App.tsx:312-322`) does action → `refreshAll()` → `reconcileTabs()`; the editor's re-seed effect keys on `[item.id, isDraft]` (`Editor.tsx:262`) so the local buffer is not disturbed.
- Backend already supports a status-only patch: `UpdateItem` is all-`Option` (`models.rs:124-147`); the status branch (`sqlite.rs:709-717`) is task-gated and sets `edited = true` → `updated_at` bumps (`sqlite.rs:747-749`). Status IS a content edit — the row will jump to the top under the default `updated` sort. **Test gap:** no repo test pins a strict `updated_at` bump for a status-only patch.
- Verifier-CONFIRMED: routing auto-save through `save()` would call `resolveTitleForSave` → `aiGenerateTitle(provider, body)` whenever `title.trim()===""` and `body.trim()!==""` — a network POST of the note body on a dropdown flip. Auto-save must be a field-scoped patch (Section 4, S-1).

### F2 — `testing` status: every place the enum lives

**Rust (must change):** `models.rs:22-29` (`enum Status`, serde/sqlx `rename_all="lowercase"`); `store/itemfile.rs:499-505` (`status_str`, exhaustive match — compiler-enforced); `store/itemfile.rs:507-514` (`parse_status` — **str match with catch-all Err; the compiler will NOT catch a missed arm — the single highest-risk line**); `db/sqlite.rs:582-588` (`Sort::Status` CASE); `projects/mod.rs:1287-1294` (`status_rank`, the cross-store k-way-merge comparator — **must mirror the SQL CASE exactly** or multi-project order diverges from single-project order); `migrations/0001_init.sql:9` (CHECK constraint — applied, immutable → new migration `0008`).

**Rust (verify, no change expected):** filter predicates bind the enum (`sqlite.rs:536-553`); create default `Todo` (`sqlite.rs:632-636`); `list_active_tags` excludes only `done` tasks (`sqlite.rs:829-833`) — a `testing` task's tags correctly stay alive; FTS indexes only title/body — status never touches it; `KNOWN_TABLES`/`KNOWN_TRIGGERS` allowlist (`sqlite.rs:40-52`) — the hardening gate runs **before** migrations and rejects unknown trigger/table names as a foreign DB.

**TypeScript/CSS:** `types.ts:4` (Status union — change with `models.rs` or neither); `Editor.tsx:78` (`STATUSES` array — an array literal, NOT compiler-caught); `ItemList.tsx:36-41` (`STATUS_FILTERS`), `:193-194` (dot); `App.tsx:264-265` (tab dot); `Editor.tsx:516` + `ItemList.tsx:176` (`released = status==="done"` — `testing` is NOT released); `draft.ts:22` (default); `styles.css:27-29` base `--todo/--doing/--done` tokens + the four `data-palette` blocks (`:75-77, 92-94, 109-111, 126-128`) + `.dot-*` rules (`:517-534`). `JiraChip.tsx:15-17` maps JIRA's separate three-value category enum onto the dot classes — do not touch.

**Compat (verifier-CONFIRMED):** older builds skip a task file with `status: testing` — warning-only on startup/reload, and **no warning at all** on the `load_project` command path (`projects/mod.rs:300` discards warnings). The `.md` survives on disk; re-upgrading restores it. This is a one-way on-disk change.

### F3 — unsaved highlight

- Dirty already exists per tab (`openTabs.ts:98-108`) fed by each editor's `onDirtyChange` (`Editor.tsx:203-209` and equivalents). Existing signals: tab dot `.etab-unsaved` (uses `--mark`, `styles.css:639-642`) and the Save/Saved button label (`AiBar.tsx:143`).
- `.page-body` is `display: contents` (`styles.css:301-307`) — it cannot paint a border. A whole-window frame would require new dirty-reporting props from PromptsPage/ScratchPage up to App. Framing the active editor `<section class="editor">` needs **no new props** — each editor already knows its own `dirty`.
- `outline` does not participate in layout — zero reflow on dirty↔clean flips (a `border` would shift content).

### F4 — session restore

- State inventory: `page` (`App.tsx:126`); item tabs (`App.tsx:93`); worknotes filters `kind/tagFilter/projectFilter/statusFilter/sort/search` (`App.tsx:74-79`); prompt tabs + scope (`PromptsPage.tsx:93-101`); scratch tabs (`ScratchPage.tsx:59`). Tab keys are already serializable strings (`<projectId>:<itemId>`, `prompt-…`, `scratch-<projectId>`; `src/lib/projects.ts:19-21`).
- Restore machinery exists: `reconcileTabs` (`App.tsx:282-308`) fetches by id and silently drops missing items; `ScratchPage.selectProject` already fetches by id. `selectRow` paths look up the *filtered* list — unusable for restore; use `api.getItem`/`api.getPrompt` directly.
- WebView2 localStorage **persists across restarts on this machine** (database-architect verified on disk: `%LOCALAPPDATA%\io.github.jdhdev.worknotes\EBWebView\Default\Local Storage\leveldb\` holds the existing `palette` key). Nothing in the app clears it; dev (`localhost:1420`) and prod (`tauri.localhost`) are different origins, so state does not carry between them. The catalog alternative (`app_settings` + a `migrations_catalog` migration) was rejected: a bad catalog migration is fatal-at-startup and irrevocable — a poor trade for ephemeral view state.
- Drafts (`draft-<seq>`) have no persistable identity; unsaved buffers live only in mounted editor instances. There is **no window-close guard** anywhere today — quitting with dirty tabs loses them silently. Session restore will raise expectations it cannot meet; the close guard is a named follow-up, not in scope (Section 10, R6).

### F5 — toast auto-dismiss

- The toast store already has everything: keyed replace-in-place (`toasts.ts:140-163`), `dismissKey` (`toasts.ts:173-176`), threaded to editors as `onResolve` (`App.tsx:690,720,738`). The resolve-on-condition pattern is in use (`Editor.tsx:214-222`).
- The blocker: the "no API key" toast is **unkeyed**. Its text is the backend `AppError::MissingKey` display string (`error.rs:20-21`), surfaced as `onError(String(err))` at `Editor.tsx:302/416/486`, `PromptEditor.tsx` enhance path, `ScratchEditor.tsx:217`. `AppError` serializes to a bare string — the frontend cannot discriminate error kinds.
- `SettingsDialog.saveKey()` (`SettingsDialog.tsx:58-66`) has no upward "key saved" report; `api.hasApiKey` (`api.ts:263-269`) returns a boolean only. `commands.rs:512` reuses `MissingKey` for the JIRA token with provider id `"atlassian"`.

### F6 — line clipboard

- Surfaces: exactly the three body textareas (`Editor.tsx:757-772`, `PromptEditor.tsx:~535-550`, `ScratchEditor.tsx:343-356`). All controlled; all wired to `trackSelection`; programmatic edits must go through `edit()` and clear tracked selection or a pending AI proposal splice presents as "Replace text disabled for no reason" (the `isSelectionStale` guard catches the actual mis-splice).
- Clipboard constraints: capabilities grant no clipboard permission (`capabilities/default.json`); `navigator.clipboard.readText()` triggers a WebView2 permission prompt; the clipboard-manager plugin would be a new npm dep + Rust crate + capability grant — all avoidable (Section 4, S-7). `api.copyToClipboard` (`api.ts:328-333`, writeText) is the sanctioned write path.
- Undo: programmatic `setState` mutation of a controlled textarea breaks the native undo stack for that edit. Precedent exists — `spliceProposal` already has this characteristic — but VS Code users expect line-cut to be undoable, so the design below keeps cut/copy on the native path (D9).
- `ScratchEditor.tsx:242-252` documents that the native WebView2 context menu is the field's only right-click Cut/Copy/Paste path; this feature only changes keyboard behavior — the context-menu path stays native.

### F7 — conversion

- `UpdateItem` has **no `kind` field** (`models.rs:124-147`) — the invariant's strongest form; keep it that way. Kind gates exist at create (`sqlite.rs:632-640`), update (`sqlite.rs:709-723`), and file import (`itemfile.rs:217-233`).
- A Prompt is a separate entity: directory `prompts/<uuid>/` with head + immutable version chain; no tags/status/priority/dueAt/pinned/jiraUrl (`models.rs:185-268`, `promptfile.rs`); migration `0006_prompts.sql` states "a prompt is a NEW entity, not a third item kind". Note→prompt therefore can only be "create a prompt whose first version is this note's title+body".
- Note→task is structurally trivial: same table, same file, same id — only `status`/`priority`/`due_at` presence differs, and `kind: task` with defaults is a shape every existing build already parses. **On-disk compat: non-issue.**
- Reusable plumbing: `promptSeed` one-shot signal (`App.tsx:144-146`), `sendSelectionToPrompt` (`App.tsx:353-357`), `PromptsPage.newDraft(projectId, body)` (`PromptsPage.tsx:57-73`), seed-consuming effect (`PromptsPage.tsx:152-158`). Cross-store discipline precedent: `move_prompt` (`projects/mod.rs:625-700`) — write new → verify → delete source last.
- Task→note would silently destroy `status`/`priority`/`dueAt` (serializer omits them for notes, `itemfile.rs:98-115`) in an app with no undo — refuse it (D8).

## 4. Security Considerations

*(Source: security-auditor agent; H/M/L designations preserved. Current posture assessed as strong — closed enums at trust boundaries, parameterized SQL, boolean-only key API, minimal capabilities. The batch's risk is invariant erosion and silent data loss, not classic AppSec.)*

Requirements the implementation MUST satisfy:

- **S-1 (H3/H4) — F1 auto-save is a field-scoped patch.** `api.updateItem(id, { status })` only; it must never enter `save()`/`resolveTitleForSave` (verifier-CONFIRMED: that path POSTs the note body to the AI vendor when the title is empty). It must not commit the rest of the buffer, must leave `dirty` untouched, must be a no-op for drafts, and must not run while a title generation or save is in flight.
- **S-2 (H1) — F2 parser degrades, never rejects.** `parse_status` maps a genuinely unknown status value to `Status::Todo` + a scan warning instead of `Err(Malformed)` (the value-level analogue of the existing "never add a strict unknown-key check" rule, `notes-app/CLAUDE.md:46`). Golden fixture + test in the same commit. This protects *future* additions only; already-installed builds still skip `testing` files — an accepted, documented one-way break (R1).
- **S-3 (H2) — migration `0008` must not brick or empty stores.** Copy rows (never truncate — the Stage-1 `migrate_db_to_files` path runs migrations on `project.db` **before** exporting rows, `projects/mod.rs:1108-1176`, verifier-CONFIRMED including the detail that the pre-stage2 backup is taken *after* migration, making the damage unrecoverable). Recreate the three triggers with the exact `KNOWN_TRIGGERS` names, leave zero transient tables, and re-run the FTS rebuild. Note the verifier's refinement: the allowlist rejects *wrong-named* triggers but does not detect *missing* ones — omitting them silently breaks FTS sync, so the test in Section 8 must cover search-after-migration.
- **S-4 (M1) — F4 persists identifiers only.** `{ v, page, tabs: keys, activeKey, filters }` — never `body`, `title`, draft buffers, search text, `ProjectInfo.path` (an absolute path), or anything key-shaped. WebView2 localStorage is unencrypted, outside the project dir, and not swept by `Delete files` — content there would outlive project deletion.
- **S-5 (M2) — F4 restore is corruption-proof.** `try/catch` around read, parse, and write (`QuotaExceededError`); version field `v: 1`, unknown versions discarded; every field independently validated before use (a garbage `sort`/`statusFilter` reaching `ListFilter` over IPC fails serde and wedges the list until localStorage is hand-cleared); every restored id re-validated via `api.getItem`/`api.getPrompt` before entering state; cap tab count. Follow the `palettes.ts` whitelist-fallback pattern.
- **S-6 (M3) — F5 never handles key material.** Toast key derived from the provider id only (`missing-key:<providerId>`); dismissal driven by `api.hasApiKey(provider)` returning `true` after save — never by inspecting the draft key string; no logging on this path; the key draft is never lifted into App state or a callback payload. Empty-key save (= delete, per invariant) must NOT dismiss.
- **S-7 (M4) — F6 adds no clipboard read capability and no dependency.** Cut/copy ride the native handlers (selection expansion, no `preventDefault`); paste reads `e.clipboardData.getData("text/plain")` inside the user-gesture-scoped `onPaste` event. `navigator.clipboard.readText()` and `tauri-plugin-clipboard-manager` are forbidden. Scope to the three body textareas only — a no-selection Ctrl+C in the masked API-key input would otherwise copy the secret to the OS clipboard.
- **S-8 (M5) — F7 conversion is one Rust command with server-side defaults.** `convert_note_to_task(id)` takes an id only; status/priority defaulted server-side exactly as `create()` does; never accepts `id`/`createdAt`/`updatedAt`/`schemaVersion` from the client; exposed only through `src/lib/api.ts`; the UI confirm uses `api.confirmDialog` (never `window.confirm` — silently suppressed in this webview). Note→prompt (frontend seed, D8) writes nothing until the user explicitly saves the prompt draft.
- **S-9 (L1) — map new failure modes to `AppError::Invalid` with fixed copy** rather than letting raw sqlx text fall through `AppError::Db` to a toast.
- **S-10 (L4) — zero new packages.** All seven features are implementable with the existing dependency set. Any proposed dep must be flagged for explicit approval.

## 5. Design

### Approach

Six phases in dependency-and-risk order (smallest/independent first; the migration-bearing phase isolated; the deferrable phase last). Every phase ends green on the full verification suite (Section 9). Decisions below are numbered D1–D10 and referenced from the steps.

### Architecture

No new architectural surfaces: one new per-project migration (`0008`), one new Tauri command (`convert_note_to_task`) plus one repository-trait method, three new pure frontend modules (`session.ts`, `lineEdit.ts`, `aiErrors.ts`), and prop-level wiring in the existing component tree. The repository trait boundary, the `api.ts`-only IPC rule, and the DTO mirroring rule all hold unchanged.

### Key Decisions

- **D1 — F1 follows the pin/archive pattern, not autosave.** `Editor` gains `onStatusChange?: (s: Status) => Promise<boolean>`; the `<select>` handler for a saved item does optimistic `setStatus(next)` (NOT `edit()` — no `setDirty`), then `await onStatusChange(next)`, reverting on `false`. `App.tsx` wires `onStatusChange={(status) => mutate(() => api.updateItem(t.item.id, { status }))}` — one line beside `onArchive`. Drafts keep the buffered path. The select is disabled while `saving || generatingTitle` (shared-guard avoidance) AND while its own auto-save patch is in flight (a local pending flag), so rapid flips cannot fire overlapping IPC calls with undefined resolution order against `reconcileTabs`. **Scope: status only.** "All discrete metadata persists immediately" (priority, dueAt) is recorded as the coherent future direction but is out of scope — it changes `Duplicate metadata` semantics and dialog copy (tech-lead recommendation (a)-now-(b)-later).
- **D2 — F3 frames the active editor pane, not the whole window** (architect option 3A). One CSS rule — `.editor.is-dirty { outline: 2px solid var(--mark); outline-offset: -2px; }` — plus a conditional class on the `<section>` in each of the three editors from their own `dirty` state. No new props, no cross-page dirty aggregation. `--mark` is reused deliberately: it is already the unsaved signal (`.etab-unsaved`) and varies per palette. Non-color signals already exist (Save/Saved label, tab-dot title) and are kept — the frame is supplementary, satisfying WCAG 1.4.1 without a new chip. A status auto-save (D1) never sets `dirty`, so the frame stays honest.
- **D3 — F2 sort position: `doing=0, testing=1, todo=2, done=3, NULL(note)=4`** ("active work first"), applied character-for-character in BOTH `push_sort` (`sqlite.rs:582-588`) and `status_rank` (`projects/mod.rs:1287-1294`), with both tests extended in the same commit. `testing` is not "released" (tag editing stays enabled); `testing` tasks keep their tags alive in the vocabulary (no change to `list_active_tags`).
- **D4 — migration `0008` drops the status CHECK entirely** rather than widening it (tech-lead + security concur; the closed Rust `Status` enum and `itemfile::parse` are the real gate; `index.db` is not a compat surface). The next status addition then needs no migration at all. The rebuild: drop the three triggers → create `items_new` (all current columns; kind/priority CHECKs AND the `project_id TEXT REFERENCES projects(id)` clause from `0003_projects_jira.sql` kept — connections open with `foreign_keys(true)`, so silently dropping it would be an unenforced-integrity regression no test catches; no status CHECK) → `INSERT … SELECT` **including `rowid`** (keeps the external-content FTS aligned) → drop/rename → recreate `idx_items_kind`, `idx_items_list`, `idx_items_project` and the three triggers byte-for-byte under their `KNOWN_TRIGGERS` names → `INSERT INTO items_fts(items_fts) VALUES('rebuild')`. The database-architect's draft SQL in the research notes is the starting point. If `ALTER TABLE … RENAME TO` fails re-parsing the FTS5 content-table reference, the documented fallback is drop/recreate `items_fts` too (its shadow tables are already prefix-allowlisted).
- **D5 — migration `0008` is a per-project migration (`migrations/`), never a catalog one.** Recovery from a botched index migration is "delete `index.db` and reopen" (it is rebuilt from files); a botched catalog migration is fatal at startup. A new `project_manager.rs` test must exercise the 0007→0008 upgrade of a pre-existing store — no current test applies a migration to an existing DB.
- **D6 — the F2 old-build break is accepted and documented, not engineered around.** The additive-encoding alternative (keep `status: doing` on disk + a `status_ext` scalar) is rejected: two sources of truth for one field, permanent serializer seam, git-merge divergence risk. Instead: (a) `parse_status` becomes degrade-on-unknown in the same release (S-2), making the *next* status addition non-breaking; (b) `notes-app/CLAUDE.md` gains a value-domain sub-rule under "On-disk backward compatibility" recording that enum-value widening is a one-way change and how it degrades; (c) the caveat is stated honestly — degrade-on-read prevents disappearance, not value loss: a build carrying the degrade-on-unknown parser that *saves* an item whose status value it did not recognize rewrites it as `status: todo`. (That applies to statuses added *after* this release; pre-Plan-14 builds skip the file entirely, per R1 — two different "old build" senses.)
- **D7 — F5 uses the post-hoc presence check** (architect option 5B; satisfies S-6): a shared helper `reportAiError(provider, err, onError)` in a new `src/lib/aiErrors.ts` — on any AI failure it awaits `api.hasApiKey(provider)`; if `false`, pushes the error with `key: missingKeyToastKey(provider)` (= `missing-key:<provider>`); else pushes unkeyed. No Rust display-string duplicated in TS, no error-contract change (option 5C recorded as the long-term direction if a second discriminable error appears). `SettingsDialog` gains `onKeySaved: (provider) => void`, called from `saveKey` only when the saved key is non-empty; `App.tsx` passes `onKeySaved={(p) => dismissKey(missingKeyToastKey(p))}`. The JIRA token (`"atlassian"`) gets the same two lines — it reuses `MissingKey` and the fix shape is identical.
- **D8 — F7 is two mechanisms.** *Note→task:* a narrow one-way repository operation `convert_note_to_task(id)` — same UUID, same file; preserves `createdAt`, title, body, tags, pinned, archived, jiraUrl, schemaVersion; stamps `status: todo`, `priority: normal`, no dueAt (exactly the `create()`/import defaults); bumps `updatedAt` (a content edit); file-then-index write order like `update`. `UpdateItem` stays free of `kind` — the property "a patch can never change kind" still holds verbatim. Task→note is not implemented; the repository has no path to it, and the plan records why (silent loss of three fields, no undo). Both CLAUDE.md invariant texts are amended to name the single exception. UI: a `Convert to task` button in the Editor header (near `Duplicate metadata`, `Editor.tsx:544-548`), gated to saved non-dirty notes, behind `api.confirmDialog`; the tab key (`projectId:id`) is unchanged so the tab simply re-renders as a task after `mutate` + `reconcileTabs`. *Note→prompt:* frontend-only copy-to-draft (architect option 7D; tech-lead concurs) — extend the `promptSeed` one-shot from `{ projectId, body, n }` to carry an **optional** `title` (default `""`, so the existing `sendSelectionToPrompt` caller is unchanged), add a `Create prompt from note` button that seeds a **dirty, unsaved** prompt draft on the Prompts page with the note's title+body; the note is never mutated or deleted. The atomic backend alternative (`import_prompt` with the note's UUID preserved, `move_prompt` ordering) is recorded as the fallback if one-click atomicity is later wanted — not built now ("nothing is written without an explicit user action").
- **D9 — F6 keeps cut/copy on the native path and confines the undo cost to line-paste.** New pure module `src/lib/lineEdit.ts` (`lineRangeAt`, `cutLine`, `pasteLine` helpers). On `keydown` Ctrl+X/C in a body textarea with a collapsed selection: `setSelectionRange(lineStart, lineEnd)` and do **not** `preventDefault` — the native handler cuts/copies the now-selected range, the cut flows through the normal `onChange` (dirty tracking and native undo intact); after a copy, restore the collapsed caret in a microtask; record the payload in a module-level `lastLineCopy` sentinel. On `paste`: if the caret is collapsed AND `e.clipboardData.getData("text/plain")` equals `lastLineCopy`, `preventDefault()` and insert as a whole line above the caret's line via the existing `edit(setBody)` + `pendingCaretRef` pattern (this one action is not natively undoable — accepted, consistent with the existing `spliceProposal` precedent, and stated in the acceptance criteria); otherwise fall through to native paste. If the clipboard was overwritten by another app, the sentinel mismatch degrades gracefully to normal paste. Scope: the three body textareas only; single-line inputs untouched; Shift+Insert/Ctrl+Insert aliases and IME composition explicitly out of scope.
- **D10 — F4 persists identity only, in localStorage, via a versioned pure module** `src/lib/session.ts`: `{ v: 1, page, worknotes: { tabKeys, activeKey, filters: { kind, statusFilter, sort, projectFilter, tags } }, prompts: { tabKeys, activeKey, projectId, reusableOnly }, scratch: { projectIds, activeProjectId } }`. Not persisted: `search` (a restored filter box is confusing and fires an FTS query at boot), drafts, dirty flags, any content. Restore runs once after the first successful `loadMeta` (a `restoredRef` guards StrictMode double-invoke), fetches ids via `Promise.all` of `api.getItem`/`api.getPrompt`/`api.getScratch`, silently drops misses (the `reconcileTabs` rule), opens tabs in persisted order, then activates; `activeKey` falls back to the neighbor rule if its tab was dropped. Writes are debounced ~300 ms. A restored session comes back clean — the D2 frame must not light on boot.

## 6. Implementation Steps

### Phase 1 — F5: toast auto-dismiss

1. Create `src/lib/aiErrors.ts`: `missingKeyToastKey(provider: string): string` and `reportAiError(provider, err, onError)` implementing D7 (post-hoc `api.hasApiKey` check; keyed push on `false`). Unit-test the key helper and, with an injected fake `hasApiKey`, both branches of `reportAiError`.
2. Replace the unkeyed AI-failure call sites with `reportAiError(...)`: `Editor.tsx:415` and `:486` (`onError(String(err))` in `rework()`/`suggestTitle()`), the `PromptEditor.tsx` enhance path, `ScratchEditor.tsx:217` — and `Editor.tsx:301`, which is `onError(resolved.error)`: an **already-stringified** message produced inside `resolveTitleForSave` (`titleForSave.ts:26-28`), so `reportAiError` must accept a pre-stringified message as well as a raw error.
3. Add `onKeySaved?: (provider: string) => void` to `SettingsDialog`; call it from `saveKey` only on a successful save of a **non-empty** key (the `SettingsDialog.tsx:61` boolean already exists); same two lines in `saveJiraToken` with `"atlassian"`. Type the prop `string`, NOT `ProviderId` — it must carry `"atlassian"`, and `"atlassian"` must NOT be added to the `ProviderId` union (it is not an AI provider).
4. Wire in `App.tsx`: `onKeySaved={(p) => dismissKey(missingKeyToastKey(p))}` (dismissKey already destructured at `App.tsx:112-118`).
5. Extend `src/lib/toasts.test.ts`: two provider-keyed toasts are distinct; dismissing one leaves the other.

### Phase 2 — F1 + F3: status auto-save + unsaved frame (designed together)

6. Backend tests first: add `status_change_bumps_updated_at` to `src-tauri/tests/repo.rs` (create task, capture `updated_at`, status-only patch, assert strictly greater) — closes an existing coverage gap. Also ADD an update-time note-gate test — a status-only (and priority-only) patch on a note is silently ignored — mirroring `due_at_patch_on_a_note_is_silently_ignored` (`repo.rs:815-827`); no such update-time test exists today (only a create-time priority check at `repo.rs:77-82`).
7. `Editor.tsx`: add the `onStatusChange` prop and split the `<select>` handler per D1 (draft → `edit(setStatus)`; saved → optimistic set without `setDirty`, await, revert on `false`); disable the select while `saving || generatingTitle` or while a previous status patch is still in flight (D1).
8. `App.tsx`: wire `onStatusChange` through `mutate` beside `onArchive` (`App.tsx:682-687`).
9. F3: add `.editor.is-dirty` outline rule to `styles.css`; add the conditional class to the `<section>` root of `Editor.tsx`, `PromptEditor.tsx`, `ScratchEditor.tsx` from each one's own `dirty`.
10. Manual smoke per Section 8 (status persists without Save; body edit stays dirty; frame lights/clears; auto-saved status never lights the frame; row jumps to top under `updated` sort — expected, per invariant).

### Phase 3 — F2: `testing` status

11. Write `src-tauri/migrations/0008_status_testing.sql` per D4 (drop CHECK, copy rows with rowid, recreate indexes + the three triggers byte-for-byte, FTS rebuild). Verify trigger DDL against `0001_init.sql:28-43` character-for-character.
12. Add a `project_manager.rs` test that creates a store, closes it, reopens it (exercising 0007→0008 on an existing DB), asserts items survive AND FTS search still finds them (covers the missing-trigger failure mode, S-3) — then closes and reopens it a SECOND time and asserts the store is not rejected as foreign. The `KNOWN_TABLES`/`KNOWN_TRIGGERS` hardening gate runs BEFORE migrations on every open, so a wrong-named recreated trigger passes the first reopen (the migration hasn't run yet when the gate checks) and only rejects on the open after it.
13. `models.rs`: add `Testing` to `Status`. Fix every non-compiler-caught site in the same commit: `itemfile.rs` `status_str` + `parse_status` (add `"testing"`, AND change the catch-all to degrade-to-`Todo`-with-warning per S-2/D6 — concretely: have `parse` return the item plus an optional degradation warning, e.g. `Result<(Item, Option<String>), ItemFileError>`, have `scan` append it to `ScanOutcome`'s warnings, and fix `projects/mod.rs:300` where `load_from_catalog`'s warnings are currently discarded (`let (info, _warnings) = …`) so degraded-status warnings also surface on the `load_project` path); `sqlite.rs:582-588` CASE per D3; `projects/mod.rs:1287-1294` `status_rank` per D3.
14. Extend Rust tests: `itemfile.rs` round-trip for `testing`; unknown-status degrades (not skips) with a warning; `repo.rs` sort test extended with `testing` in position 1; status filter round-trip with `Status::Testing`; k-way merge order test extended.
15. Add a golden fixture: new task file with `status: testing` under `src-tauri/tests/fixtures/v1_0_0/items/` (append-only) + assertions in `on_disk_compat.rs` (parses, zero skipped files, byte-identical re-export). Do not touch existing fixtures.
16. Frontend sweep: `types.ts:4`; `Editor.tsx:78` `STATUSES`; `ItemList.tsx:36-41` `STATUS_FILTERS`; confirm `released` stays `done`-only (`Editor.tsx:516`, `ItemList.tsx:176`); `styles.css` — `--testing` token in `:root` AND all four `data-palette` blocks + `.dot-testing` rule; update the palette-policy comment at `styles.css:19-22`.
17. Amend `notes-app/CLAUDE.md` (value-domain compat sub-rule per D6) and the status vocabulary in both CLAUDE.md files; note `docs/DESIGN.md` lag.

### Phase 4 — F7: conversion

18. Rust: add `convert_note_to_task(&self, id: &str) -> Result<Item>` to the `ItemRepository` trait (`db/mod.rs`), implement in `sqlite.rs` per D8 (errors: unknown id → the `get()` not-found shape; already a task → `AppError::Invalid` with fixed copy; file-then-index write; `updated_at` bump), route through `ProjectManager::owner(id)` in `projects/mod.rs`, add the `commands.rs` wrapper, register in `lib.rs`, expose in `src/lib/api.ts`.
19. Rust tests (`repo.rs`): defaults stamped (`todo`/`normal`/no dueAt); `id`/`createdAt`/tags/pinned/archived/jiraUrl/schemaVersion preserved; `updatedAt` strictly bumped; the on-disk `.md` gains `status:`/`priority:` and round-trips; converting a task errors; unknown id errors; tag vocabulary unchanged by conversion.
20. Frontend note→task: `Convert to task` button in the Editor header (saved, non-dirty notes only), `api.confirmDialog` confirm, then `mutate(() => api.convertNoteToTask(id))`; `reconcileTabs` refreshes the tab in place.
21. Frontend note→prompt: extend the `promptSeed` shape with an optional `title` defaulting to `""` — the existing `sendSelectionToPrompt` caller (`App.tsx:353-357`) passes none and is unchanged (`App.tsx:144-146`, `PromptsPage.tsx:57-73, 152-158` — `newDraft` seeds title as well as body); add a `Create prompt from note` button in the Editor header that calls the seed path with the note's title+body and switches to the Prompts page. The note is untouched.
22. Amend the `kind` invariant wording in both CLAUDE.md files per D8, in the same commit as the repository change and its tests.

### Phase 5 — F4: session restore

23. Create `src/lib/session.ts` per D10 (`readSession`/`writeSession`, `v: 1`, full shape validation with per-field whitelists, deterministic `null` on any failure) + `session.test.ts` using the `palettes.test.ts` localStorage shim: round-trip; garbage/corrupt JSON → null; unknown version → null; bad enum values → dropped; activeKey not in tabKeys → nulled; duplicate keys de-duplicated; tab-count cap.
24. Wire persistence: debounced (~300 ms) `useEffect` writers in `App.tsx` (page, item tab keys + activeKey, filters minus `search`), `PromptsPage.tsx`, `ScratchPage.tsx` — depending only on the memoized primitives so no per-keystroke work is added (tab state is already keystroke-decoupled).
25. Wire restore in `App.tsx`: once after first `loadMeta` success (`restoredRef` guard), validate projects against `loaded`, `Promise.all` fetch by id, drop misses silently, open in order, activate (neighbor fallback); Prompts/Scratch pages receive their slices via props and run the same fetch-drop.
26. Manual smoke per Section 8, including the stale-reference cases (item deleted, project unloaded while closed) and a hand-corrupted localStorage blob (app boots to defaults, no wedge).

### Phase 6 — F6: line clipboard

27. Create `src/lib/lineEdit.ts` (`lineRangeAt`, `cutLine`, `pasteLine` per D9) + `lineEdit.test.ts` pinning: caret mid-line/at 0/at end; last line without trailing `\n`; empty line between `\n\n`; caret on a `\n` boundary (belongs to the preceding line, VS Code convention); single-line body; `\r` handling decision.
28. Add the keyboard/paste wiring per D9 to the three body textareas — a small shared handler-factory (not a large hook extraction; the editor-unification refactor is explicitly out of scope, Section 10 R7): keydown expansion for Ctrl+X/C (no preventDefault, caret restore after copy, `lastLineCopy` sentinel), `onPaste` line-mode with sentinel match, always via `edit()` + `clearSelection()` + `pendingCaretRef`.
29. Manual smoke per Section 8, with emphasis on: any real selection leaves all three shortcuts exactly native; native undo works after a line-cut; line-paste inserts above the line; external-clipboard content degrades to normal paste.

### Every phase

30. Run the full verification suite (Section 9) before moving on. Kill any running `notes-app.exe` before `cargo test` (it locks `target/debug/notes-app.exe`); if linking fails with LNK1318, clean the target and disable debuginfo (known machine issue).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/aiErrors.ts` (+ `.test.ts`) | Create | F5 keyed-toast helper + post-hoc key check (D7) |
| `src/lib/session.ts` (+ `.test.ts`) | Create | F4 versioned, validated session blob (D10) |
| `src/lib/lineEdit.ts` (+ `.test.ts`) | Create | F6 pure line-range/cut/paste math (D9) |
| `src-tauri/migrations/0008_status_testing.sql` | Create | F2 table rebuild dropping the status CHECK (D4) |
| `src-tauri/tests/fixtures/v1_0_0/items/<new>.md` | Create | F2 golden fixture with `status: testing` (append-only) |
| `src/components/Editor.tsx` | Modify | F1 `onStatusChange` split; F2 `STATUSES` array + `released` check; F3 dirty class; F5 `reportAiError`; F6 handlers; F7 two header buttons |
| `src/components/PromptEditor.tsx` | Modify | F3 dirty class; F5 `reportAiError`; F6 handlers |
| `src/components/ScratchEditor.tsx` | Modify | F3 dirty class; F5 `reportAiError`; F6 handlers |
| `src/components/SettingsDialog.tsx` | Modify | F5 `onKeySaved` prop (API key + JIRA token) |
| `src/components/ItemList.tsx` | Modify | F2 `STATUS_FILTERS` + dot |
| `src/components/PromptsPage.tsx` | Modify | F4 persistence/restore slice; F7 title-carrying seed |
| `src/components/ScratchPage.tsx` | Modify | F4 persistence/restore slice |
| `src/App.tsx` | Modify | F1 wiring; F4 persist/restore orchestration; F5 `onKeySaved`; F7 confirm + seed + api call |
| `src/lib/api.ts` | Modify | F7 `convertNoteToTask` |
| `src/types.ts` | Modify | F2 `Status` union (with `models.rs`, or neither) |
| `src/styles.css` | Modify | F3 `.editor.is-dirty`; F2 `--testing` in `:root` + 4 palette blocks + `.dot-testing` |
| `src/lib/toasts.test.ts` | Modify | F5 per-provider key isolation tests |
| `src-tauri/src/models.rs` | Modify | F2 `Status::Testing` |
| `src-tauri/src/store/itemfile.rs` | Modify | F2 serializer + degrade-on-unknown parser (S-2) |
| `src-tauri/src/db/mod.rs` | Modify | F7 trait method |
| `src-tauri/src/db/sqlite.rs` | Modify | F2 sort CASE; F7 `convert_note_to_task` impl |
| `src-tauri/src/projects/mod.rs` | Modify | F2 `status_rank`; F7 routing via `owner(id)` |
| `src-tauri/src/commands.rs` + `src-tauri/src/lib.rs` | Modify | F7 command + registration |
| `src-tauri/tests/repo.rs` | Modify | F1 bump test; F2 sort/filter tests; F7 conversion tests |
| `src-tauri/tests/project_manager.rs` | Modify | F2 migration-upgrade-on-existing-store test |
| `src-tauri/tests/on_disk_compat.rs` | Modify | F2 new-fixture + degrade-not-skip assertions |
| `CLAUDE.md` + `notes-app/CLAUDE.md` | Modify | F2 value-domain compat sub-rule; F7 narrowed kind invariant (D6, D8) |

## 8. Test Strategy

*(Source: test-writer agent. Frontend = node-env vitest on pure `src/lib` modules only — no jsdom by standing decision; component wiring is manual smoke, stated as such. Backend = `cargo test` integration tests.)*

- [ ] **Unit Tests (Rust):**
  - `status_change_bumps_updated_at` — strict `>`, status-only patch (closes an existing gap).
  - Note-gate: a status-only patch on a note is silently ignored (verify the existing test targets this specifically).
  - `itemfile`: `testing` round-trips through serialize/parse; a genuinely unknown status **degrades to `todo` with a warning, file not skipped**; a note carrying `status: testing` still imports as a clean note.
  - `repo.rs`: sort order `doing, testing, todo, done, note` in both the SQL CASE test and the k-way-merge test; `ListFilter` JSON round-trip with `"testing"`; status filter with `Status::Testing`.
  - F7: conversion defaults, preserved fields, strict `updatedAt` bump, on-disk shape, task/unknown-id errors, tag vocabulary untouched (Step 19 list).
- [ ] **Unit Tests (vitest, node env):**
  - `aiErrors.test.ts`: key derivation; keyed-vs-unkeyed branches with injected fake `hasApiKey`.
  - `toasts.test.ts`: `missing-key:anthropic` and `missing-key:openai` are distinct; dismissing one leaves the other.
  - `session.test.ts`: full list in Step 23 (round-trip, corruption, versioning, bad enums, dangling activeKey, dedupe, cap) using the `palettes.test.ts` localStorage shim.
  - `lineEdit.test.ts`: full boundary list in Step 27.
- [ ] **Integration Tests:**
  - `project_manager.rs`: 0007→0008 upgrade of an existing store — items survive, FTS search still works, `KNOWN_TRIGGERS` intact; PLUS a second post-migration reopen asserting no foreign-DB rejection (the hardening gate runs before migrations, so wrong trigger names only reject on the open after the one that migrated).
  - `on_disk_compat.rs`: new `status: testing` golden parses with zero skips and re-exports byte-identically; existing four fixtures untouched and still green.
- [ ] **Edge Cases & Error Scenarios:**
  - F1: draft status change stays buffered (no IPC); status change during in-flight save/title-generation is impossible (select disabled); failed patch reverts the select.
  - F5: empty-key save does not dismiss; provider A's save never dismisses provider B's toast.
  - F4: deleted item / unloaded project / corrupt blob / unknown version → silent drop or clean defaults, never a wedge or crash.
  - F6: any non-collapsed selection → fully native behavior (the highest-value regression check); sentinel mismatch → native paste.
- [ ] **Manual smoke (per phase, `npm run tauri dev`):**
  - F5: trigger missing-key toast (rework with no key) → save a key in Settings → toast gone with no extra click; other provider's toast unaffected; close-without-save leaves it.
  - F1/F3: status flip persists without Save and moves the row under `updated` sort; concurrent body edit stays dirty; frame lights on first edit, clears on Save, never lights for auto-saved status or on boot; frame renders acceptably across all five palettes, light + dark.
  - F2: `testing` appears in dropdown position per D3; dot distinct in all five palettes; survives restart; filter + sort behave.
  - F7: convert note→task (confirm dialog; same tab becomes a task; defaults right); `Create prompt from note` opens a dirty prompt draft with title+body, note untouched.
  - F4: open tabs across pages, set filters, relaunch → tabs/order/active/page/filters restored, search box empty, session clean; delete an item while closed → tab silently gone.
  - F6: line copy/cut/paste per Step 29, including Ctrl+Z after a line-cut (native undo intact) and the stated non-undoable line-paste.
- [ ] **Known residual gap (named, not hidden):** S-1 and S-6 are component-wiring properties inside `Editor.tsx`/`SettingsDialog.tsx` that the pure-module-only vitest policy cannot cover. They are verified by the security-audit pass (execution prompt step 4, which checks each S-requirement individually) and by manual smoke — not by automated regression tests. See R9.

## 9. Success Criteria

- [ ] **Functional:** each feature behaves per its D-decision (D1–D3, D6–D10) and the manual smoke list passes.
- [ ] **Tests:** all tests from Section 8 pass; every new invariant landed with its test in the same commit.
- [ ] **Security:** S-1 … S-10 all satisfied (verifiable: no `save()` call from the status path; no clipboard read API; no new deps; no content in localStorage; keyed toast never sees key material).
- [ ] **Compatibility:** the four existing golden fixtures pass unmodified; a pre-0008 store opens with data and search intact; the old-build caveat is documented in `notes-app/CLAUDE.md`.
- [ ] **Quality:** `cd notes-app/src-tauri && cargo test` · `npx tsc --noEmit` · `npm test` (vitest) · `npm run build` all green after every phase; `npm run tauri dev` smoke done.

## 10. Risks & Open Questions

**Adversarial-verifier verdicts (all three claims entered the design):**
- CONFIRMED — old-build silent skip of `status: testing` files (drives S-2/D6). Refinements: notes carrying the value are unaffected (field dropped by the kind gate); the `load_project` command path discards even the warning.
- CONFIRMED — CHECK forces a table rebuild; a truncating migration would silently empty Stage-1 stores and the pre-stage2 backup is taken *after* migration (unrecoverable). Refinement: the trigger allowlist rejects wrong names but does NOT detect missing triggers — hence the search-after-migration test (Step 12).
- CONFIRMED — `save()`-routed auto-save fires `aiGenerateTitle(body)` iff title empty ∧ body non-empty (drives S-1/D1); with no key configured the save aborts pre-network and the status change fails too.

**Risks:**
- **R1 (accepted, one-way):** any older installed build (second machine via git/OneDrive, a rollback) opening a project with `status: testing` hides those tasks until re-upgrade. The `.md` survives; `Delete files` on that project would not spare it. Mitigations D6(a–c) shipped in the same release. **Assumption: this is a single-machine, always-current install — if that is wrong, ship a degrade-only compatibility release first and delay the `testing` value one release.**
- **R2:** migration `0008` failure at open leaves a project unloadable until `index.db` is deleted by hand (it is then rebuilt clean). Mitigated by the Step-12 test; recovery documented in D5.
- **R3:** F1 makes every status flip reorder the default list (updatedAt is a content edit — invariant, not a bug). Surprising the first time; accepted.
- **R4:** F6 line-paste is not natively undoable (D9); line-cut and everything else is. Accepted and stated; if this proves unacceptable in smoke, drop the paste half and keep cut/copy (tech-lead's fallback).
- **R5:** F4 will create the expectation that unsaved *text* also survives a restart. It does not (drafts and dirty buffers are memory-only).
- **R6 (named follow-up, out of scope):** no window-close guard exists; quitting with dirty tabs loses work silently today. Pairing an `onCloseRequested` + `api.confirmDialog` guard with session restore is the recommended next plan.
- **R7 (named follow-up, out of scope):** the three editors are ~85% duplicated; F3/F5/F6 each add three near-identical small changes. A shared editor hook is a separate refactor decision — do not bundle it in.
- **R8:** `docs/DESIGN.md` and the design-system bundle already lag the app and will lag further; noted, not fixed here.
- **R9:** S-1 (auto-save never routes through `save()`) and S-6 (key material never leaves the dialog) have no automated regression coverage — they are wiring-level properties out of reach of the node-env vitest policy (Section 8 residual-gap note). A future regression would only be caught by review or smoke; reviewers of later changes to `Editor.tsx`/`SettingsDialog.tsx` should re-check them.

**Open questions (defaults chosen; user can override before execution):**
- Q1: Should priority/dueAt auto-save alongside status? **Default: no (D1)** — status only; "all discrete metadata" recorded as direction.
- Q2: Where does `testing` sort? **Default: after `doing`, before `todo` (D3).**
- Q3: Is a second machine / older binary ever pointed at this data? **Default assumption: no (R1)** — this is the one answer that would restructure Phase 3 into two releases.
- Q4: Should note→prompt also archive/delete the note? **Default: no (D8)** — copy-to-draft, source untouched.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` is on)
- [ ] Error handling covers failure modes (reverted optimistic status; degraded parse warnings surfaced; conversion errors are `Invalid` with fixed copy, not raw `Db` text)
- [ ] No security vulnerabilities (injection, XSS, credential exposure) — and specifically S-1…S-10 from Section 4 each individually confirmed
- [ ] Code follows existing project conventions (mutations via `mutate()`; IPC only through `api.ts`; DTO mirroring `models.rs` ↔ `types.ts`; sqlx runtime API only; pure-module test pattern)
- [ ] Tests cover happy path, edge cases, and error scenarios (Section 8 complete; each new test proven able to fail)
- [ ] No performance regressions (debounced session writes; no per-keystroke persistence; no new re-render dependencies in `tabDescriptors`-adjacent code)
- [ ] Changes are minimal — no unrelated refactoring bundled in (especially: no editor-unification refactor, R7)
- [ ] Migration `0008` reviewed against D4 line by line (rowid copy, exact trigger names, FTS rebuild, no transient tables)
- [ ] Both CLAUDE.md invariant amendments landed with the code they describe (D6, D8)
- [ ] All five palettes render the new `--testing` dot and the `--mark` dirty frame acceptably in light and dark

## 12. Post-Review Improvements

*(From the four review agents — code-reviewer, security-auditor, database-architect, frontend-specialist — run against the complete diff. All items below are implemented unless marked "declined/accepted".)*

**Implemented:**

1. **F3 contrast fix (frontend must-fix).** `var(--mark)` fails WCAG 1.4.11 non-text contrast against `--bg` in the two light palettes (original ≈ 1.17:1, v2-light ≈ 1.48:1 — an effectively invisible frame). Added per-palette overrides `:root[data-palette="original"] .editor.is-dirty, :root[data-palette="v2-light"] .editor.is-dirty { outline-color: var(--mark-ink); }` (≈ 5.8:1 / 6.6:1); the three dark palettes keep `--mark` (5.7–15.4:1). `styles.css`.
2. **`.editor-head` gained `flex-wrap: wrap`** (frontend should-fix): the header now carries up to four buttons beside the title (F7 added two) and previously had no wrap strategy — a clipping risk below ~900px editor width.
3. **`save()` now refuses to start while a status patch is in flight** (`if (statusPatchPending) return false;`, `Editor.tsx`) — the symmetric half of D1's overlap guard. The select was disabled during a save, but flip-then-immediate-Ctrl+S could still race two `updateItem` calls with undefined resolution order.
4. **Degrade-warning value truncated to 32 chars** (security low): the unknown status value is untrusted file content flowing into a toast; a multi-megabyte `status:` line must not become a multi-megabyte banner. `itemfile.rs::parse_status`.
5. **Migration 0008: `DROP TRIGGER IF EXISTS`** (database should-fix): the `KNOWN_TRIGGERS` gate rejects a wrong-NAMED trigger but cannot detect a MISSING one; an unconditional `DROP TRIGGER` on a tampered store missing one would abort the migration — fatal for a Stage-1 `project.db` (its file IS the data; a Stage-2 `index.db` is just delete-and-reopen). Changed before the migration was ever applied to a real store, so the never-edit-an-applied-migration rule had not engaged.
6. **Softened 0008's column-order comment** (database nit): order is preserved as hygiene, but sqlx `FromRow` resolves by name — nothing is position-sensitive, and the old comment implied otherwise.
7. **`rename_retrying` for the Stage-1 backup rename** (`projects/mod.rs`): both test-writer agents independently hit an intermittent failure of `stage1_project_db_is_upgraded_in_place_preserving_every_item` under parallel `cargo test`. Root cause (pre-existing, not Plan 14): `let _ = std::fs::rename(&legacy_path, …)` had no retry and silently swallowed transient Windows file-lock errors, unlike the file's own `remove_file_retrying`/`remove_dir_retrying`. Added the missing sibling helper in the same style; the rename stays best-effort.
8. **`MAX_SESSION_TAGS` split from `MAX_SESSION_TABS`** (code-review nit): the restored tag-filter cap reused the tab-count constant for a conceptually different bound.
9. **Coupling documented in code** (frontend advisory): after F7 conversion the Editor's re-seed effect (keyed on `[item.id, isDraft]`) does not re-fire, so local `status`/`priority`/`dueAt` keep their note-time fallback seeds — correct only because those equal `convert_note_to_task`'s server-side defaults. Recorded on the `onConvertToTask` prop doc so a future defaults change re-syncs it.

**Accepted / declined (with reasons):**

- **S-9 verdict PARTIAL (security):** `convert_note_to_task`'s index `UPDATE` error propagates as `AppError::Db` (raw sqlx text) exactly like the sibling `create`/`update`/`delete` paths. The genuinely NEW failure modes (non-note → `Invalid` with fixed copy; unknown id → `NotFound`) satisfy S-9's letter. Scrubbing only this one `UPDATE` would diverge from the established pattern; declined in favor of a future cross-cutting `Db`-scrub decision.
- **Shared `lastLineCopy` sentinel content-collision (code-review warning):** a real-selection copy whose text exactly equals a previously line-copied payload (content + trailing `\n`) makes the next collapsed-caret paste behave as a line-paste (inserted above, not natively undoable). Accepted: requires an exact match including the newline, degrades to a well-formed line insert (not data loss), and the module-level sentinel is D9's stated design (it is also what makes cross-editor line-paste work).
- **Line cut/copy leaves the line selected if the native command doesn't fire (security low):** theoretical — a native cut/copy of an existing selection is reliable in WebView2; accepted.
- **D9 deviation, documented:** the post-copy caret restore uses `setTimeout(0)`, not the microtask D9 suggested — a microtask checkpoint can run BEFORE the event's default action, which would collapse the selection before the native copy reads it.
- **Session blob carries tag names** (user vocabulary, the only free text in the blob) and **the tab cap is enforced on read only**: both are D10's stated shape; the read-side cap is the security boundary (bounds restore fan-out). Accepted, recorded.
- **0008 under a non-NULL `project_id` has no dedicated test** (database low): verified inert by inspection — every store writer forces `project_id` NULL (`insert_item_verbatim`, `create`, `rebuild_from_dir`), and pre-Stage-1 `notes.db` never runs migrations. Declined the extra test.
- **`mutate()` returns false when the post-write refresh fails,** which can revert an optimistic status flip whose write actually committed (frontend advisory): pre-existing behavior shared with Pin/Archive; nothing re-syncs until the next refresh. Documented, unchanged.
- **Root `CLAUDE.md` staleness** (pre-Plan-14 text in untouched sections): out of scope.

**Reviewer verdicts, for the record:** code review — full Section 11 checklist PASS, no confirmed must-fix (its one "flicker" flag on `convert_note_to_task` was the Phase-4 test-writer's transient fail-proof mutations, running concurrently; final state re-verified correct). Security — 9 of 10 SATISFIED, S-9 PARTIAL (above). Database — 8/8 PASS, "correct as written and safe to ship"; the D4 fallback (drop/recreate `items_fts`) is NOT needed on the bundled SQLite 3.46. Frontend — D1/D9/F4 correctness PASS; `--testing` dot clears 3:1 against every palette's surface (tightest: neon-noir 3.34:1).

## 13. Execution Prompt

Copy-paste the following into a fresh Claude Code session at the repo root (`c:\Projects\TaskTracker\TaskTracker`):

```
Implement Plan 14 for the worknotes app.

1. Read notes-app/plans/plan.14.md in full, plus CLAUDE.md and notes-app/CLAUDE.md
   (hard invariants, including "On-disk backward compatibility" — read it before touching
   store/, models.rs, or migrations/).

2. Implement the plan phase by phase, following Section 6 (Implementation Steps) in order:
   Phase 1 (F5 toast auto-dismiss), Phase 2 (F1 status auto-save + F3 unsaved frame),
   Phase 3 (F2 testing status + migration 0008), Phase 4 (F7 conversion),
   Phase 5 (F4 session restore), Phase 6 (F6 line clipboard). Honor every design decision
   D1–D10 in Section 5 and every security requirement S-1…S-10 in Section 4 — they are
   acceptance criteria, not suggestions. Defaults for the open questions are in Section 10
   (Q1–Q4); use them unless the user has said otherwise.

3. After EACH phase, run the full verification suite and fix regressions before moving on:
     cd notes-app/src-tauri && cargo test
     cd notes-app && npx tsc --noEmit
     cd notes-app && npm test
     cd notes-app && npm run build
   Machine caveats: kill any running notes-app.exe first (it locks
   target/debug/notes-app.exe); if linking fails with LNK1318, clean the target and
   disable debuginfo (C: disk pressure).

4. Use subagents during implementation:
   - Spawn a test-writer agent to write tests per Section 8 alongside each phase
     (Rust tests in src-tauri/tests/, vitest node-env tests for the pure src/lib modules).
   - After all phases compile and pass, spawn a code-reviewer agent (read-only: Read,
     Grep, Glob) to review the complete diff against Section 11's checklist and the
     invariants in both CLAUDE.md files.
   - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify each of
     S-1…S-10 from Section 4 individually, with file:line evidence.
   - Spawn conditional domain agents only where the implementation touched their domain:
     database-architect to review migration 0008 against D4/D5 (rowid copy, exact
     KNOWN_TRIGGERS names, FTS rebuild, Stage-1 safety), and frontend-specialist to review
     the editor wiring (D1/D2/D9) and palette CSS across all five palettes.
   - Fallback: if a named agent type is unavailable, use a generic type with the role
     stated in the prompt — Explore for read-only analysis, Plan for strategy,
     general-purpose otherwise.

5. Run the Section 11 code-review checklist yourself after the reviewer agents report;
   fix everything actionable.

6. Document the improvements made from review in Section 12 of notes-app/plans/plan.14.md
   and implement them.

7. Finish with the full verification suite green and a manual smoke pass via
   npm run tauri dev covering the checklist in Section 8. Report failures plainly —
   failing tests, skipped steps, and unverified assumptions are results, not things to
   smooth over. Do not commit unless explicitly asked.
```
