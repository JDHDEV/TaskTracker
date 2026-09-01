# Plan 15: Unsaved-Edit Recovery Across Restarts (Draft Backup)

**Created:** 2026-08-31
**Status:** Implemented (all six phases; reviewed — see §12; manual smoke: see §12 note)
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Preserve unsaved editor edits through an app restart or crash, in the style of Notepad++: while a buffer is dirty, its content is periodically snapshotted to an app-private draft store on disk; on the next launch the same tab reopens with the unsaved content restored and still marked dirty; the canonical item file is never touched until the user explicitly saves. Snapshots are deleted the moment the user saves, discards, or deletes the underlying item.

This is the direct answer to plan.14's own risk register: **R5** ("F4 session restore will create the expectation that unsaved text also survives a restart. It does not — drafts and dirty buffers are memory-only", `plans/plan.14.md:275`) and it folds in the valuable half of **R6** (the missing window-close guard, `plans/plan.14.md:276`) as a flush-on-close.

Two loss paths exist today and this plan covers both:
- **Ungraceful exit** (crash, `taskkill`, OS shutdown, power loss): covered by the periodic snapshot (Phases 1–4).
- **Graceful window close** (Alt+F4 / X): the app currently prompts on tab close but loses every dirty buffer silently on window close — covered by a Rust-side `CloseRequested` flush (Phase 6).

## 2. Strategic Assessment

*(Source: tech-lead agent.)*

- **Right feature, anticipated by the project's own plans.** Plan 14 F4 deliberately persisted tab *identity* only and named this exact expectation gap as R5. This plan is follow-through, not a new idea — but it consciously reverses plan 14's S-4 decision ("never persist content"), and that reversal must be recorded, not incidental (see §5 Key Decisions).
- **Three of five needed pieces already exist:** per-tab dirty tracking decoupled from keystrokes (`src/lib/openTabs.ts` `setDirty`, `Editor.tsx:229-235`), session restore choreography (`src/lib/session.ts`, `App.tsx:276-314`), and a hardened atomic single-file writer to copy (`src-tauri/src/store/scratchfile.rs`). Missing: (a) a content channel out of the editors, (b) somewhere safe to put snapshots, (c) reconciliation on restore. (c) is the risky part.
- **Riskiest part is reconciliation, not the write.** Notepad++ restores silently because backups belong to files it owns exclusively. Here `items/<uuid>.md` can change under a draft (git pull, OneDrive/Syncthing, Reload, plan-14 status auto-save bumping `updatedAt`). The app has **no undo and no item version history**, so a stale restored buffer followed by Save silently clobbers real content. Every restore therefore validates a recorded `baseUpdatedAt` fingerprint, and restore is always **visible, never silent** — the one Notepad++ behavior we explicitly do not copy is the silence.
- **Two features in one ticket, kept distinguishable:** unsaved edits to *saved items* (partial loss) and unsaved *new drafts* (total loss — higher value, but requires new persistent draft identity, Phase 2). Both ride the same mechanism here; phases keep them separately verifiable.
- **Do not bundle the R7 editor-unification refactor** (`Editor.tsx`/`PromptEditor.tsx`/`ScratchEditor.tsx` are ~85% duplicated, a named plan-14 residual). The capture mechanism is one shared pure module + one shared hook so it does not compound that debt; the refactor itself stays out of scope.
- **Disk churn is a real constraint on this machine** (C: is chronically near-full per project memory): snapshot on idle-debounce with a max-wait, write only changed buffers, cap per-draft and total store size, and use per-buffer files so one torn write can never invalidate every draft.

## 3. Research Findings

*(Sources: architect agent; frontend-specialist agent; corroborated by tech-lead.)*

### Where the dirty buffer lives

All buffer state is component-local `useState`; App and the pages only ever see a dirty **boolean**:

| File | Buffered fields | Dirty flag |
|---|---|---|
| `src/components/Editor.tsx` | `title, body, status, priority, dueAt, tags, projectId, jiraUrl` (:125-133) | `dirty` (:134), seeded true for a fresh draft |
| `src/components/PromptEditor.tsx` | `title, body` (:102-103); `reusable` is immediate-persist, not buffered | `dirty` (:104) |
| `src/components/ScratchEditor.tsx` | `body` (:67) | `dirty` (:68) |

- `Editor.tsx:550-555` — `edit<T>(setter)` is the single chokepoint every buffered field goes through (`setter(value); setDirty(true)`). The snapshot signal hooks here.
- `Editor.tsx:229-235` — `onDirtyChange` fires on dirty↔clean transitions only; `App.tsx:357-370` builds tab descriptors from primitives so a keystroke never re-renders App. The design must not lift buffer content into App state.
- `EditorHandle { save(): Promise<boolean> }` (`Editor.tsx:40-42`, and equivalents in the other two editors) is the existing imperative escape hatch into a mounted-hidden background tab — precedent for a `flushDraft()` handle method.
- **Status on a saved task is never buffered**: `changeStatus()` (`Editor.tsx:562-576`, plan-14 F1/D1) is an immediate field-scoped patch that never touches `dirty`. Only a *draft's* status routes through `edit()`. Pin/Archive are immediate and outside the buffer entirely.
- Save is explicit only: Ctrl+S gated on `active` (`Editor.tsx:394-404`) or the AiBar button; `save()` (`Editor.tsx:295-388`) sends the whole buffer as `NewItem` (draft) or `UpdateItem`; `setDirty(false)` fires only on confirmed success (:368, :382).

### Session restore and draft identity (plan 14 F4/D10)

- `src/lib/session.ts` — versioned (`v:1`), whitelist-validated localStorage blob persisting **identifiers only** (page, tab keys, active key, filters). Its header (:1-16) records S-4 verbatim: body/title text, drafts, and dirty flags are deliberately NOT persisted because WebView2 localStorage is unencrypted, lives outside any project directory, and is not swept by `Delete files`.
- Restore wiring: `App.tsx:276-314` — gated on first `loadMeta`, StrictMode-guarded, `Promise.all` of `api.getItem`, misses dropped silently, and restored tabs open **clean** (comment at :274-275: "the D2 frame never lights on boot" — this plan carves a deliberate, narrow exception for recovered drafts only).
- **New-item drafts have no persistable identity**: `App.tsx:435-442` mints `draft-${seq}` from `draftSeq` `useState(0)` (:96) which resets every boot; `PromptsPage.tsx:165-168` same for prompts; `session.ts:190-196` `tabKeyId()` returns null for draft keys so session restore skips them; `openTabs.ts:67` treats an already-open key as a no-op activation, so colliding keys silently drop a buffer. Stable `draft-<uuid>` keys are a prerequisite (Phase 2). *(Adversarially verified CONFIRMED — §10.)*

### The store layer and prior art

- `src-tauri/src/store/scratchfile.rs` is the hardened template to copy: symlink refusal on target AND temp path (:99-101), write-side size cap before touching disk (:94), atomic temp+rename with temp cleanup on rename failure (:106-113), non-lossy UTF-8, one on-disk representation of "empty", error enum carrying kinds only — never paths (:30-40), full `#[cfg(test)]` suite in-module.
- `src-tauri/src/store/itemfile.rs` must NOT be the template — `write_item` (:305-315) has no symlink checks and leaks its temp file on failed rename (security-auditor finding). Reuse only `is_uuid` (:78-86) and the bounded `read_capped` pattern (:290-296), and `MAX_ITEM_FILE_BYTES = 4 MiB` (:34).
- **There is no content autosave anywhere in the app today.** The scratch pad is explicit-Save (plan.13 D3, a contested decision with recorded dissent). The only debounced writers persist identifiers (session, 300 ms) or the search query (200 ms). This feature is the app's first periodic automatic content write, and must be framed as *backup, not autosave* — nothing ever touches `items/<uuid>.md` or `scratch.md`; the Save button and dirty frame behave exactly as today.
- Command surface: `src-tauri/src/commands.rs` (thin wrappers over `state.manager`), registered in `src-tauri/src/lib.rs:54-95`, mirrored 1:1 in `src/lib/api.ts` (components never call `invoke()` directly). `get_scratch`/`set_scratch` (`commands.rs:262-277`) show the shape: gate on loaded project, resolve paths server-side, fixed generic error copy.
- App-level state precedent: `catalog.db` in `app_data_dir` (`%APPDATA%\io.github.jdhdev.worknotes\`). Per-project non-item state: `project.json`, `scratch.md` + `.scratch.md.tmp`, generated `.gitignore` (byte-compared constant, `projects/mod.rs:76`), rebuildable `index.db`.
- **Not affected:** the `ItemRepository` trait, `index.db` schema/migrations, the canonical item file format. Drafts touch no compatibility surface.
- Naming hazard: `src/lib/draft.ts` already exists and means "blank new-item template" (`newDraft`, `duplicateDraft`). The new module is `src/lib/drafts.ts` (snapshot/recovery concern) — distinct on purpose; a doc comment in each cross-references the other.

### Everything that must clear a draft (architect's dependency map — misses here are correctness bugs)

1. Successful save/create: `Editor.save()` both branches (:368, :382), `App.createFromDraft` (`App.tsx:491-509`), and the prompt/scratch equivalents in later phases.
2. Explicit Discard in the close-dirty flow: `App.requestCloseTab` (:523-551) — only the **second** chained dialog is the discard-vs-save choice.
3. Item delete: `App.requestDeleteItem` (:553-562).
4. Project Unload/Reload: `App.unloadProject` (:568-605) and `App.reloadProject` (:612-656) both confirm "any unsaved edits are discarded" then close tabs — with drafts on disk both must sweep that project's drafts or the app contradicts its own dialog.
5. Project destruction: `ProjectManager::delete_files` (`projects/mod.rs:422-436`) and `forget_project` sweep server-side by projectId.
6. Startup GC: orphaned drafts (owning item/project gone), TTL, and store-size cap.

## 4. Security Considerations

*(Source: security-auditor agent. No critical findings — no remote surface: CSP `default-src 'self'` in `tauri.conf.json:23`, no HTML sinks. The following are binding requirements, priority-ordered.)*

1. **Never localStorage; never the session blob.** Drafts contain the user's most-private content (text they chose not to save yet). WebView2 localStorage is unencrypted, outside every sweep, and quota-limited (~5-10 MB vs 4 MiB/buffer). Drafts go through typed Tauri commands to a Rust-owned store. This plan **explicitly reverses plan-14 S-4 for content-at-rest location** — the reversal is deliberate and the compensating control is the mandatory sweep set (item 3).
2. **UUID-only filenames.** Draft filenames derive ONLY from a v4 UUID validated with `itemfile::is_uuid` before any path join. Never from tab keys: `itemKey()` embeds `:` (NTFS alternate-data-stream marker, already rejected by `projects/paths.rs:73-76`), and `draft-<seq>` is an unvalidated frontend string. IPC `draftId` that is not UUID-shaped is rejected before touching the filesystem.
3. **Mandatory sweep set** (without these, the feature reinvents the localStorage remanence problem in a new location): delete draft on item delete (`sqlite.rs:818-835` path), on project `delete_files` and `forget_project` (precedent: prompt bodies were explicitly added to `remove_store_files` for remanence, `projects/mod.rs:1236-1238`), on Unload/Reload (frontend-triggered sweep), plus startup orphan GC + TTL. A deleted item's draft can contain MORE than the last saved version — "delete means gone" must hold.
4. **Copy `scratchfile.rs`, not `itemfile.rs`** (see §3). Additionally call `File::sync_all()` before the rename: every existing writer skips fsync and documents "protects against process crash, not OS crash" — acceptable for explicitly-saved content, not for a feature whose whole promise is crash survival. `std` only, no new dependency.
5. **Restore re-validation.** A draft binds `{projectId, entityId, baseUpdatedAt}`. On restore: refuse to bind if the item is absent or in a different project; on `baseUpdatedAt` mismatch surface a conflict, never silently overwrite (the app has no undo — `CLAUDE.md` cites this as why task→note is forbidden).
6. **Corruption-proof, fail-soft, non-lossy parsing.** Bounded read (`read_capped`, cap +1 to close the TOCTOU window like `itemfile.rs:366-379`); zero-byte/truncated/garbage/oversize draft ⇒ per-file skip with a warning, never a boot failure; invalid UTF-8 is a hard per-file error, never a lossy read (a lossy restore + Save would pepper the real note with U+FFFD).
7. **Keep drafts out of `items/` and out of FTS.** A draft dropped into `items/` would be imported as a real item by the index rebuild (`itemfile.rs:344-357`), resurrecting content the user never saved. Drafts are never indexed, never searchable.
8. **Command discipline.** Draft commands take a project UUID, never a path; unloaded-project writes are refused (model: `set_scratch`, `projects/mod.rs:476-487`); every failure maps to a fixed generic message — no paths, no `io::Error` (note `AppError::Invalid` serializes straight to the frontend, `error.rs:32-46`).
9. **Bound the store.** 4 MiB per draft enforced on write before touching disk AND on read; ~50-record directory cap (evict oldest); TTL sweep (drop >90 days) at startup. Write only when content actually changed.
10. **No new dependencies.** `std::fs` + existing `uuid`/`serde` cover everything. A new crate (e.g. `atomicwrites`, promoting `tempfile` to runtime) is a finding, not a convenience.

## 5. Design

### Approach

App-private per-buffer draft files under `<app_data_dir>\drafts\<draftId>.md`, written by a new hardened `store/draftfile.rs` (modeled byte-for-byte on `scratchfile.rs` + fsync), captured by one shared frontend hook on a 1 s-idle / 5 s-max-wait cadence for every dirty open tab (background tabs included), restored at boot after session restore with `baseUpdatedAt` validation, always visibly, with a two-button conflict bar when the item changed underneath. Snapshots are deleted on save/discard/delete/unload/destroy, plus startup GC. A Rust-side `CloseRequested` flush covers graceful window close (R6).

**Storage location rationale** (tech-lead, security-auditor, and architect converged independently): the project directory is ruled out because `.gitignore` protection cannot be retrofitted — `refresh_gitignore` leaves user-edited files alone (`projects/mod.rs:1205`) and changing the byte-compared `GITIGNORE` constant orphans every existing project's file from both the upgrade path and the `delete_files` cleanup (:1240-1244) *(adversarially verified CONFIRMED — §10)* — and project dirs are expected to be whole-folder-synced (OneDrive/Syncthing), which would replicate half-typed buffers to the cloud. `app_data_dir` also uniformly handles project-less drafts (`newDraft(kind, "")` when the rail filter is "All projects"). Its one weakness — outside the `delete_files` sweep — is closable with explicit sweep hooks (§4 item 3); the git/sync exposure is not. Alternatives rejected: localStorage (S-4, quota), item frontmatter (compat surface, non-scalar), `index.db` (rebuilt from files — drafts would evaporate), `catalog.db` (a bad migration there bricks startup, plan.14 D5), single `drafts.json` (one torn write loses every draft; N×4 MiB rewritten per tick), `items/<uuid>.md.draft` (unsaved content inside the git-tracked canonical dir).

### Architecture

```
Editor.tsx / PromptEditor.tsx / ScratchEditor.tsx        (Phase 3/5: emit snapshots via shared hook)
        │  useDraftBackup(key, snapshotRef, dirty)        (Phase 3: timing only — 1s idle / 5s max-wait,
        │                                                  flush on blur/tab switch/page switch/AI call)
        ▼
src/lib/drafts.ts (pure: DraftSnapshot shape, buffer==base test, conflict classification,
        │          schedule logic w/ injectable clock — vitest-covered)
        ▼
src/lib/api.ts  ── saveDraft / listDrafts / deleteDraft / sweepProjectDrafts ──▶  commands.rs
                                                                                     │
                                                    DraftStore (app-level, on AppState/ProjectManager)
                                                                                     │
                                                    store/draftfile.rs  ──▶  <app_data_dir>\drafts\<uuid>.md
App.tsx boot: session restore (existing) ─then─ listDrafts() union ─▶ openTab(initialDirty=true) / conflict bar
src-tauri/src/lib.rs: on_window_event(CloseRequested) → prevent → emit flush → ack/timeout → close   (Phase 6)
```

Draft file format: restricted `key: value` frontmatter + **verbatim body** (the `itemfile.rs` reading pattern in a separate module — never extend `itemfile`'s field set). Rationale for md-over-JSON: the body is the one irreplaceable thing and stays human-readable in Notepad if the app ever fails to parse its own draft.

Record shape (v1):
`{ v: 1, draftId, surface: "item" | "prompt" | "scratch", projectId (may be ""), entityId (may be "" for a new draft), kind (items only), baseUpdatedAt, savedAt, title, status, priority, dueAt, tags, jiraUrl, body }`
`baseUpdatedAt` is the item's `updatedAt` the buffer was seeded from — using it (not `savedAt`) avoids a false conflict from a plan-14 status auto-save, which bumps `updatedAt` without dirtying the buffer.

### Key Decisions

- **D1 — `app_data_dir\drafts\`, one file per buffer, explicitly NOT a compatibility surface.** Amend `notes-app/CLAUDE.md` in the same commit as Phase 1: the drafts dir is app-private and disposable, same status as `index.db`; the S-4 content-at-rest boundary moves deliberately, with the sweep set as the compensating control. Without this line the next author freezes the draft format forever.
- **D2 — Backup, not autosave (plan-13 D3 stands).** Nothing ever writes `items/<uuid>.md` or `scratch.md` except explicit Save. The dirty frame, Save button, and every save path behave exactly as today. This paragraph exists so the change is not reviewed as a reversal of the contested D3 decision.
- **D3 — Restore is visible, never silent.** Restored tabs open dirty (a narrow, code-commented exception to "restored tabs open CLEAN", `App.tsx:274-275`) plus one keyed toast: "Restored unsaved edits to N item(s)." — via `showNotice` (`role="status"` for free, `Toasts.tsx:27`).
- **D4 — Conflict policy: open clean + explicit two-button choice.** When `baseUpdatedAt != item.updatedAt`, the tab opens CLEAN on current disk content, the draft file is kept, and a small inline conflict bar (styled like `JiraRow` — hairline, no icons, sentence case) offers: *"Keep saved version"* (deletes the draft) / *"Restore unsaved edits"* (seeds the buffer, marks dirty — via the new imperative `EditorHandle.applyDraft(snapshot)` method added in step 11; nothing else can push content into an already-mounted clean editor, since the reseed effect fires only on `[item.id, isDraft]` changes). Chosen because the app's strongest principles are "nothing replaces content without explicit action" and "no undo"; this reuses the proposal mental model without reusing the AI review card (which is wired to the streaming/splice pipeline — conflating them was rejected). **Recorded dissent (architect):** restore-and-warn (seed the buffer + persistent warning toast) is friendlier to the "never lose typed text" goal; rejected here because a missed warning + Ctrl+S silently clobbers newer content with no undo. The draft is not lost either way — the bar keeps it until the user chooses.
- **D5 — Restore matrix** (boot, after `api.getItem` resolves so the overlay lands on the correct base):
  - buffer == saved content → delete draft, open clean (self-heals crash-between-save-and-delete, and type-then-revert);
  - `baseUpdatedAt == updatedAt` → seed buffer, `openTab(..., initialDirty=true)` — primary path;
  - mismatch → D4 conflict bar;
  - item gone → reopen as a new draft tab (id `""`, same project, buffer intact) + notice — honest trade-off: can resurrect content whose item was deleted elsewhere;
  - project not loaded → don't restore the tab, keep the draft file (a later Load brings it back), subject to TTL/cap.
- **D6 — Cadence: periodic tick, not trailing debounce.** A keystroke-reset debounce starves during continuous typing — the exact case crash recovery exists for. 1 s idle + 5 s max-wait, reading content via refs at the `edit()` chokepoint (mirror of the `titleRef` pattern, `Editor.tsx:162-168`) so no new render-triggering state enters an already-heavy component. Flush additionally on textarea blur, tab/page switch, window blur, and before each AI entry point — specifically `rework()` and `suggestTitle()` in `Editor.tsx` (and the Phase-5 equivalents); the R4 title-generation branch inside `save()` needs no pre-flush because a failed save leaves the tab dirty (prior draft intact, next tick re-flushes) and a successful save clears the draft anyway. Skip the write when buffer == base (and delete any existing draft in that case). Fire-and-forget (`void`), never blocking a keystroke.
- **D7 — Every open dirty tab snapshots, not just the active one.** Background tabs keep mounted editors (`hidden` prop, `Editor.tsx:51-54`); the `active` gate that Ctrl+S correctly uses would silently drop background-tab recovery here.
- **D8 — Stable draft identity, and the draftId ≠ tab key.** The on-disk `draftId` is always a **bare** UUID validated by `is_uuid` (which requires the exact 8-4-4-4-12 shape — a prefixed string fails it, and because writes are fire-and-forget that failure would be silent). Derivation: for a saved item's draft, `draftId` = the item's UUID (one draft per item; makes delete-on-item-delete and lookup trivial); for a prompt, the prompt's UUID; for scratch, the project's UUID; for a new never-saved draft, a freshly minted `crypto.randomUUID()`. The frontend **tab key** for new drafts is the *prefixed* form `draft-${draftId}` (prompts: `prompt-draft-${draftId}`) so `session.ts` `tabKeyId` keeps skipping draft keys; `src/lib/drafts.ts` provides the strip/derive helper, and the editor components receive the bare `draftId` as a prop — never the prefixed key.
- **D9 — fsync on the draft writer only.** `File::sync_all()` before rename in `draftfile.rs` — diverges from `scratchfile.rs`/`itemfile.rs` deliberately (crash survival is the product promise); those writers are unchanged.
- **D10 — R6 fold-in, Rust-side.** `on_window_event(WindowEvent::CloseRequested)` in `src-tauri/src/lib.rs`: prevent close, emit a flush event, close on the frontend's ack or a ~1.5 s timeout. Rust-side avoids the `core:window:allow-close`/`allow-destroy` capability grant a JS-side guard would need (`capabilities/default.json` grants only `core:default` + opener + dialog — *adversarially verified CONFIRMED, §10*). The confirm dialog R6 originally envisioned becomes unnecessary; the flush is the valuable half. Mechanism: Rust emits a `flush-drafts` event; the frontend listener (wrapped in `api.ts` as `onFlushDrafts(handler)` — components still never touch `listen`/`invoke` directly) flushes every dirty tab via the new `EditorHandle.flushDraft()` (NEVER `save()` — a real save would write `items/<uuid>.md` on every window close, violating D2, and can fire an AI call inside the close window), then acks via a new app command `ack_close` (wrapped `api.ackClose()`), on which Rust destroys the window; a `closing` flag makes a repeated `CloseRequested` during an in-flight flush a no-op, and the ~1.5 s timeout guarantees close even if the webview never acks. App-defined commands are not gated by the core ACL (the app's 39 existing commands run under `core:default` today), so still no capability change.
- **D11 — Exclusions.** AI proposal state (`proposal`, `selectionRework`, streaming flags) is never snapshotted — unreviewed suggestions, cheap to regenerate, and resurrecting one as durable content violates the proposals invariant. Saved-item status is never snapshotted (never buffered). API-key/JIRA-token inputs are permanently out of scope. Archive does NOT clear a draft (the item still exists).

## 6. Implementation Steps

**Phase 1 — Backend draft store (independently shippable)**
1. Create `src-tauri/src/store/draftfile.rs`: restricted frontmatter + verbatim body; `write_draft` (symlink refusal on target+temp, 4 MiB cap pre-write, temp+`sync_all`+rename, temp cleanup on rename failure), `read_draft` (bounded `read_capped`-style read, non-lossy UTF-8, per-file error kinds), `list_drafts` (dir scan, per-file fail-soft), `remove_draft` (idempotent), filename derived only from an `is_uuid`-validated draftId. Error enum carries kinds, never paths. In-module `#[cfg(test)]` suite mirroring `scratchfile.rs`'s tests one-for-one (§8).
2. Add `Draft` DTO to `src-tauri/src/models.rs` + mirror in `src/types.ts` (serde camelCase; record shape from §5). Both files in the same commit, per convention.
3. Add a `DraftStore` (drafts root = `app_data_dir\drafts`) as a field on `ProjectManager` — definitively there, not `AppState`: `ProjectManager` already carries `app_data_dir` (`projects/mod.rs:112`), step 5's sweeps are called from `ProjectManager`'s own inherent methods (`AppState` holds `Arc<ProjectManager>`, not the reverse, so an `AppState` field would be unreachable from them), and `tests/project_manager.rs` constructs a bare `ProjectManager` with no `AppState`. NOT on the `ItemRepository` trait (drafts are app-level).
4. Add commands `save_draft(draft)`, `list_drafts() -> Vec<Draft>`, `delete_draft(draftId)`, `sweep_project_drafts(projectId)` in `commands.rs`, register in `lib.rs`, wrap in `src/lib/api.ts` (`saveDraft`, `listDrafts`, `deleteDraft`, `sweepProjectDrafts`). Fixed generic error copy; `save_draft`/`sweep` for a project refuse unloaded projects like `set_scratch`; project-less drafts (`projectId: ""`) are accepted.
5. Call the sweep from `ProjectManager::delete_files` and `forget_project` (server-side, by projectId). Startup GC in `DraftStore::new`/first `list_drafts`: drop records >90 days old; evict oldest beyond ~50 records.
6. Amend `notes-app/CLAUDE.md` § on-disk backward compatibility in the same commit: `app_data_dir\drafts\` is app-private, disposable, NOT a compatibility surface (same status as `index.db`); note the deliberate S-4 boundary move + compensating sweeps.
7. Extend `src-tauri/tests/project_manager.rs`: `delete_files` and `forget_project` sweep that project's drafts; drafts of other projects untouched. Gate: `cargo test`.

**Phase 2 — Stable draft identity (small, isolated)**
8. Replace `draft-${seq}` with `draft-${crypto.randomUUID()}` in `App.tsx:435-442` (both mint sites, :485-488 too) and the prompt equivalent in `PromptsPage.tsx:165-168`/`:362-364`; remove the now-unused `draftSeq`/`promptDraftSeq` counters. The bare UUID inside the key is the future on-disk `draftId` (D8); the prefixed form is only ever a tab key. Verify `session.ts` `tabKeyId` still skips draft keys and `openTabs.promoteTab` still renames draft→saved keys. Gate: `npx tsc --noEmit`, `npm test`, `npm run build`.

**Phase 3 — Capture**
9. Create pure `src/lib/drafts.ts` (+ `drafts.test.ts`, node-env vitest, `session.test.ts` validation style): `DraftSnapshot` type; `buildDraft(...)` from an editor buffer; `buffersEqual(buffer, base)`; `classifyRestore(draft, item)` → `clean | restore | conflict | orphan`; `shouldFlush(lastEditAt, lastFlushAt, now)` schedule logic with injectable clock. Doc comment cross-referencing `src/lib/draft.ts` (blank-template concern) to prevent confusion.
10. Create `src/hooks/useDraftBackup.ts`: timing only (1 s idle / 5 s max-wait interval gated on `dirty`, flush on blur/window blur/unmount/before-AI), reads the buffer via a snapshot ref, calls `api.saveDraft` fire-and-forget, calls `api.deleteDraft` when buffer==base. No `active`/`hidden` gate (D7).
11. Wire `Editor.tsx`: bump a `lastEditRef` inside `edit()` (:550-555); maintain a snapshot ref alongside the existing `titleRef` mirror; mount `useDraftBackup`; call draft-clear exactly where `setDirty(false)` fires on save success (:368, :382). Editor receives the **bare** `draftId` as a prop (never the prefixed tab key — D8). Three further mandatory changes in this file:
    - **Guard the item-reseed effect** (:255-289): it fires unconditionally on first mount (React runs `[item.id, isDraft]` effects on mount, not just change), so without a ref-guard it overwrites a `restoredDraft`-seeded buffer back to saved content and resets `dirty` on the very frame the tab mounts — defeating the entire restore path. Skip the reseed once on the mount that consumed a `restoredDraft`.
    - **Extend `EditorHandle` with `applyDraft(snapshot): void`** — imperatively seeds the buffered fields and sets dirty on an already-mounted editor; the conflict bar's "Restore unsaved edits" (step 15) has no other path in.
    - **Extend `EditorHandle` with `flushDraft(): Promise<void>`** — snapshots + `api.saveDraft` if dirty, without any of `save()`'s behavior (no item write, no R4 AI title). Phase 6 (step 18) depends on it.
12. Wire `App.tsx` cleanup: delete draft in the Discard branch of `requestCloseTab` (:523-551, second dialog), in `requestDeleteItem` (:553-562), and call `sweepProjectDrafts` in `unloadProject` (:568-605) / `reloadProject` (:612-656). **The sweep is unconditional on every unload/reload of that project — NOT gated on `affectsOpen`/`affectsOpenItem`** (`App.tsx:574`, :624-630, which only control whether the confirm dialog shows): drafts can exist on disk for a project with no currently open tab (e.g. from an earlier crash, never reopened this session), and §4 item 3 requires they go too. Gate: full verify suite.

**Phase 4 — Restore (items page)**
13. In `App.tsx`, after the existing session-restore fetch (:276-314): `api.listDrafts()`, union with the session tab set (a draft whose tab wasn't in the session still restores — the Notepad++ guarantee), branch per D5 restore matrix using `classifyRestore`. Seed restored buffers via a `restoredDraft` prop consumed once at mount, relying on the step-11 reseed-effect guard (without it the `[item.id, isDraft]` effect wipes the restored buffer on the mount frame), `openTab(..., initialDirty=true)`, no focus stealing (the restore effect makes no `.focus()` calls today — keep it that way). Orphan branch identity: the dead item's draft file is kept until the new draft tab's **first successful flush** under its freshly minted draftId, then deleted — deleting eagerly would lose the content if the app dies before that first flush.
14. Add the restore toast ("Restored unsaved edits to N item(s)." via `showNotice`) and the orphan-notice path (item gone → new pre-filled dirty draft tab, reusing the `sendSelectionToItem`-style seeding at `App.tsx:449-458`).
15. Create `src/components/DraftConflictBar.tsx` (+ styles in `src/styles.css` per DESIGN.md voice — hairline, no icons, sentence case): "'{title}' changed on disk since your unsaved edits." with buttons **Keep saved version** (delete draft, dismiss) / **Restore unsaved edits** (calls the editor's `applyDraft` handle from step 11 — seed buffer, mark dirty, keep draft until next save/discard). Keyboard-reachable, focusable, two named actions (not `api.confirmDialog` — it is binary Yes/No). Gate: full verify suite + manual smoke (§8 E2E script).

**Phase 5 — Prompts + scratch surfaces (same mechanism; may ship separately)**
16. Wire `useDraftBackup` into `PromptEditor.tsx` (surface `"prompt"`, baseUpdatedAt from the prompt meta — and guard its reseed effect at :187-210 exactly like step 11's Editor guard) and `ScratchEditor.tsx` (surface `"scratch"`, one draft per project). For scratch there is no `updatedAt`: record the base content hash in the draft (`baseHash` field, additive) and conflict-classify by comparing against the current `getScratch` content at restore.
17. Restore wiring in `PromptsPage.tsx` / `ScratchPage.tsx` mirroring Phase 4, including their close/discard/unload clears. Gate: full verify suite.

**Phase 6 — Flush-on-close (R6)**
18. `src-tauri/src/lib.rs`: `on_window_event(WindowEvent::CloseRequested)` — prevent close, set a `closing` flag (repeat CloseRequested during an in-flight flush is a no-op), emit `flush-drafts` to the webview. Frontend: register the listener through a new `api.ts` wrapper `onFlushDrafts(handler)` (the IPC-only-through-api.ts rule covers events too); the handler flushes every dirty tab via `EditorHandle.flushDraft()` from step 11 — **never `save()`**, which would write `items/<uuid>.md` on every window close (violating D2) and can fire an AI call — then calls the new app command `ack_close` (wrapper `api.ackClose()`); Rust destroys the window on ack or a ~1.5 s timeout (never hang the close). App commands are not ACL-gated, so no capability change (D10). Manual smoke: type, Alt+F4 immediately, relaunch, content restored.
19. Final pass: full verify suite, complete §8 manual smoke script, update `docs/IMPLEMENTATION_PLAN.md` status, record residuals in §12.

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/src/store/draftfile.rs` | Create | Hardened atomic draft reader/writer + in-module tests (Phase 1) |
| `src-tauri/src/store/mod.rs` | Modify | Export `draftfile` |
| `src-tauri/src/models.rs` | Modify | `Draft` DTO (serde camelCase) |
| `src/types.ts` | Modify | Mirror `Draft` DTO |
| `src-tauri/src/commands.rs` | Modify | `save_draft` / `list_drafts` / `delete_draft` / `sweep_project_drafts`; `ack_close` (Phase 6) |
| `src-tauri/src/lib.rs` | Modify | Register commands; DraftStore in setup; Phase 6 `CloseRequested` handler |
| `src-tauri/src/projects/mod.rs` | Modify | `DraftStore` field on `ProjectManager` (step 3); sweep from `delete_files` / `forget_project` |
| `src/lib/api.ts` | Modify | Typed wrappers for the four commands; `onFlushDrafts` event wrapper + `ackClose` (Phase 6) |
| `src/lib/drafts.ts` | Create | Pure snapshot/classification/schedule logic |
| `src/lib/drafts.test.ts` | Create | Vitest for the above |
| `src/hooks/useDraftBackup.ts` | Create | Shared capture-timing hook |
| `src/components/Editor.tsx` | Modify | Snapshot ref at `edit()`; hook; clear-on-save; `restoredDraft` seed; reseed-effect mount guard; `EditorHandle.applyDraft`/`flushDraft` |
| `src/App.tsx` | Modify | Draft-uuid keys; boot restore union; cleanup wiring; conflict-bar state; Phase 6 flush listener |
| `src/components/DraftConflictBar.tsx` | Create | Two-button conflict UI (Phase 4) |
| `src/styles.css` | Modify | Conflict-bar styles per DESIGN.md tokens |
| `src/components/PromptsPage.tsx` | Modify | Draft-uuid keys (Phase 2); restore/clear wiring (Phase 5) |
| `src/components/PromptEditor.tsx` | Modify | Hook wiring + reseed-effect guard at :187-210 (Phase 5) |
| `src/components/ScratchPage.tsx` | Modify | Restore/clear wiring (Phase 5) |
| `src/components/ScratchEditor.tsx` | Modify | Hook wiring (Phase 5) |
| `src/lib/openTabs.test.ts` | Modify | Restored-tab-opens-dirty coverage |
| `src-tauri/tests/project_manager.rs` | Modify | Sweep-on-delete-files/forget tests |
| `src-tauri/tests/drafts.rs` | Create | Command/manager-level draft lifecycle integration tests |
| `notes-app/CLAUDE.md` | Modify | Drafts dir = NOT a compatibility surface; S-4 boundary note |
| `docs/IMPLEMENTATION_PLAN.md` | Modify | Status update on completion |

## 8. Test Strategy

*(Source: test-writer agent. Rust tests use `tempfile::tempdir()`, never the repo dir; each new test must fail against un-implemented code before it passes. Frontend tests are node-env vitest on pure modules only — no jsdom/RTL; adding those would be a new dependency requiring approval.)*

- [ ] **Unit tests — `draftfile.rs` (in-module, mirroring `scratchfile.rs` one-for-one):**
  - Round-trips exact bytes (CRLF, multibyte) for a given draftId; atomic write leaves no temp on success; second write fully overwrites; remove is idempotent; list returns exactly the ids with drafts.
  - Records `baseUpdatedAt` alongside content; two ids never collide; deleting one leaves the other.
  - Empty-buffer convention pinned explicitly (delete-on-empty, matching scratch).
  - Zero-byte file (crash at create) ⇒ "no usable draft", never a panic or an empty restore; truncated/mid-multibyte file ⇒ distinct corrupt outcome; invalid UTF-8 ⇒ hard per-file error, never lossy; over-cap file rejected on bounded read; over-cap body rejected pre-write leaving prior file byte-identical.
  - Leftover `.tmp` (simulated crash — built with `set_len`/`Seek`, never a real kill) doesn't affect fresh writes or listing; rename-failure cleans up its temp (dir-occupies-target trick from `scratchfile.rs:313-320`).
  - Non-UUID draftId rejected before any path join. Symlink refusal on target+temp — **green-by-skip on this host** (no `SeCreateSymbolicLinkPrivilege`); do not claim verified refusal coverage without an elevated shell.
  - Missing drafts root: pinned as created-on-demand (never silently "zero drafts" if the dir exists but is unreadable).
  - GC: >90-day records dropped; >50-record store evicts oldest.
- [ ] **Unit tests — frontend pure modules (vitest):**
  - `drafts.test.ts`: `classifyRestore` all five D5 branches; `buffersEqual` field-by-field; `shouldFlush` with fake clock — fires ≤1/interval, max-wait fires during continuous typing, nothing fires when clean; corrupt/unknown-version record ⇒ safe discard (session.test.ts style).
  - `openTabs.test.ts` extension: restored draft opens through existing `openTab(state, key, item, initialDirty=true)` with `isDirty === true` immediately — no bespoke path.
- [ ] **Integration tests (`src-tauri/tests/drafts.rs` + `project_manager.rs` extensions):**
  - save→list→delete round-trip through the manager/command layer, attributed to the right project+item; two projects' drafts both listed and correctly attributed.
  - **Core safety property: `items/<uuid>.md` bytes and mtime unchanged across N draft saves; changes only on real Save.**
  - Draft deleted on the real save path; a snapshot must never land after the delete and resurrect (test the async ordering).
  - Draft for a `delete_item`-ed item is swept/orphan-filtered; Unload keeps files? — no: unload sweeps (matches the confirm dialog); `delete_files`/`forget` sweep; other projects' drafts survive.
  - Conflict surfaces: item saved elsewhere (bumping `updatedAt`) while an older draft exists ⇒ classified conflict, never auto-restored.
  - `save_draft`/`sweep_project_drafts` refuse an unloaded project (parallel to the existing `set_scratch` behavior); project-less drafts (`projectId:""`) are the exception and are accepted.
  - Unload sweeps a project's on-disk drafts even when NO tab for that project is open (the sweep must not be gated on the confirm-dialog condition — step 12).
  - Orphan-restore identity pinned: the dead item's draft file survives until the replacement draft tab's first successful flush, then is deleted (step 13).
- [ ] **Edge cases & error scenarios:** project-less draft (`projectId:""`) round-trips and restores as an orphan draft tab; draft for an unloaded project is kept and not restored; store at the 50-cap evicts oldest not newest; startup with a garbage file in `drafts/` boots normally with a warning.
- [ ] **E2E — manual smoke script (no E2E harness; this is the required pre-merge pass):**
  1. Type into a note without saving → dirty frame lights. 2. Wait >5 s. 3. Task-Manager-kill the process. 4. Relaunch → same tab, unsaved content, dirty immediately, restore toast shown. 5. `items/<uuid>.md` on disk still shows last-saved content. 6. Save → clean; relaunch → no re-offer. 7. Repeat with Discard → revert, no re-offer. 8. Repeated kills near the flush boundary → app always launches; worst case one lost draft, never a corrupt item or boot failure. 9. Two dirty tabs (one backgrounded) → both restore independently, no cross-contamination. 10. Brand-new never-saved draft → restores as a draft tab. 11. Edit item externally between kill and relaunch → conflict bar, both buttons behave. 12. Alt+F4 while dirty (Phase 6) → instant close, relaunch restores. 13. Unload a project with a dirty tab → confirm dialog → drafts gone on relaunch.
- [ ] **Mocks/stubs:** `tempfile::tempdir()` everywhere; `connect_in_memory()` only where a live `updatedAt` is needed; injectable `now()` for schedule tests; simulated partial writes via `std::fs` truncation. No AI/network mocking — the feature is pure local I/O. Operational notes: kill any running `notes-app.exe` first (locks the binary); LNK1318 on link = the known disk-space issue, not a test failure.

## 9. Success Criteria

- [ ] **Functional:** killing the app with dirty buffers (foreground and background tabs) and relaunching restores every buffer into its tab, marked dirty, with a visible notice; the canonical `items/<uuid>.md` is byte-identical until a real Save; save/discard/delete/unload/delete-files/forget all remove the corresponding drafts; a conflicting draft is never applied without the user pressing "Restore unsaved edits"; Alt+F4 loses at most nothing (flush-on-close) and a hard kill loses at most the last ≤5 s of typing.
- [ ] **Tests:** All tests from Section 8 pass (`cd notes-app/src-tauri && cargo test`, `npm test`, plus the manual smoke script executed and recorded).
- [ ] **Security:** All ten requirements from Section 4 implemented (UUID-only filenames, sweep set, fsync writer copied from `scratchfile.rs`, fail-soft parsing, no FTS/`items/` leakage, generic errors, size caps, no new deps).
- [ ] **Quality:** `npx tsc --noEmit` and `npm run build` clean; no edits to `ItemRepository`, migrations, or the canonical item format; `notes-app/CLAUDE.md` compat-surface note landed with Phase 1.

## 10. Risks & Open Questions

- **Adversarial-verifier verdicts: all four plan-shaping claims CONFIRMED** (high confidence, file:line evidence traced):
  1. *No window-close guard exists* — the only textual hit for one in the whole repo is `plans/plan.14.md:276` (R6); `src-tauri/src/lib.rs:19-98` has no `on_window_event`; the tab-close confirm at `App.tsx:523-551` guards tabs only. → D10/Phase 6 stand.
  2. *Project-dir drafts can't be reliably git-ignored* — `projects/mod.rs:1198-1206` leaves user-edited `.gitignore` files alone; `:1241` deletes only byte-exact known constants; stronger than claimed, `refresh_gitignore`'s only caller is the legacy Stage-1→2 upgrade path (`:1188`), so ordinary loads never refresh anyone's `.gitignore`. → D1 (`app_data_dir`) stands.
  3. *Capability file lacks window close/destroy* — `capabilities/default.json:6-14` grants exactly `core:default` + `opener:allow-open-url` + `dialog:allow-open/ask`; the build's generated ACL manifest shows `core:window:default` is getters-only (`allow-close`/`allow-destroy` false); Rust-side `on_window_event` never traverses the ACL (verified against local tauri-2.11.5 sources). → Rust-side flush in D10 stands, no capability edit needed.
  4. *`draft-<seq>` keys reset per boot and would collide* — `App.tsx:96` `useState(0)` never persisted; `openTabs.ts:67` activate-only on an existing key would silently drop the new buffer; `session.ts:191-196` already skips draft keys. → Phase 2 (draft UUIDs) stands.
- **Conflict-policy dissent (product call):** D4 chose open-clean + two-button bar; the architect preferred restore-and-warn. If the user prefers the friendlier default, D4 flips without structural change — the draft file is retained either way.
- **Scope of surfaces:** Phases 1–4 (items) deliver the core promise; Phase 5 (prompts + scratch) and Phase 6 (close flush) are separable. Recommend shipping 1–4 first. Scratch conflict detection needs an additive `baseHash` field (no `updatedAt` exists for scratch).
- **Unloaded-project drafts:** kept on disk (a later Load restores them), subject to TTL/cap — means unsaved content for an unloaded project persists in `app_data_dir` up to 90 days. Accepted; the alternative (sweep on unload of *not-loaded* projects) contradicts the restore promise.
- **Resurrection trade-off:** an item deleted on another machine while a local draft exists reopens as a new draft tab (D5) — content the user may believe deleted reappears. Deliberate: silently discarding typed text is the failure this feature exists to prevent. Mitigated by the visible notice.
- **fsync cost:** one `sync_all` per flush (≥1 s apart, changed buffers only) — negligible, but this machine's near-full C: drive makes any write amplification worth watching; the 50-record/4 MiB caps bound it.
- **Interleaving risk flagged by security-auditor (unverified):** a periodic flush racing `reconcileTabs` (`App.tsx:383-409`) or the in-flight `statusPatchPending` guard (`Editor.tsx:154-157`) could theoretically snapshot mid-transition. The capture reads refs synchronously and never mutates editor state, so the exposure is a stale-by-one-tick draft, not corruption — noted for the implementer to re-check.
- **No automated UI regression coverage for the two riskiest new behaviors** (named residual, like the symlink green-by-skip): D3's "restore is visible / tab mounts dirty" and the conflict bar's keyboard/focus behavior cannot be tested under the repo's no-jsdom/no-RTL policy — the §8 manual smoke script is the only regression gate for them. Adding jsdom+RTL would be a new dependency requiring explicit approval and is not part of this plan.
- **R7 duplication residual stands:** the shared hook avoids three copies of the timing logic, but the three editors still each wire it — the unification refactor remains explicitly out of scope.

## 11. Code Review Checklist

After implementation, verify:
- [x] No dead code or unused imports introduced (cargo + tsc `noUnusedLocals` clean)
- [x] Error handling covers failure modes (fail-soft scan/boot; fire-and-forget writes never surface; generic error copy)
- [x] No security vulnerabilities (injection, XSS, credential exposure) — security-auditor: no critical/high findings
- [x] Security considerations from Section 4 addressed (audited item-by-item; gaps fixed as §12 F5–F8)
- [x] Code follows existing project conventions (serde camelCase mirrors, api.ts-only IPC, scratchfile hardening template, async file-touching commands)
- [x] Tests cover happy path, edge cases, and error scenarios (37 draftfile unit, 14 drafts.rs + 2 project_manager.rs integration, 110 drafts.ts vitest, 2 openTabs pins)
- [x] No performance regressions (frontend review: no per-keystroke re-renders added; fsync moved off the main thread — §12 F8)
- [x] Changes are minimal — no unrelated refactoring bundled in (R7 editor unification explicitly untouched)
- [x] `updatedAt` never moves from a draft snapshot; pin/archive semantics untouched (core safety test: `items/<uuid>.md` bytes+mtime unchanged across N draft saves)
- [x] Drafts never enter `items/`, FTS, or any search result (root is `app_data_dir\drafts`, which `paths.rs` bars from ever being a project dir; nothing indexes it)
- [x] Every path that discards a buffer (save, discard, delete, unload, reload, delete-files, forget) also clears its draft (audit table in §12/security report; delete path hardened server-side, §12 F7)

## 12. Post-Review Improvements

*(Implementation 2026-08-31. Review process: tests were written RED-first by test-writer agents (34 draftfile unit tests, 12 manager-level integration tests, 110 vitest tests for `src/lib/drafts.ts` — every one shown failing against `todo!()`/throwing stubs before the implementation landed, then green with zero test edits). After implementation, three read-only reviewers ran in parallel — code-reviewer against the full diff + §11, security-auditor against §4 items 1–10, frontend-specialist against the Phase 3/4 wiring. Each fixed finding below was verified against the code by desk-check before acting (every one was mechanism-unambiguous: a missing branch, a wrong operator, a documented React lifecycle); none needed refuting.)*

### Findings fixed

- **F1 (frontend HIGH — StrictMode killed every dev-mode save).** `useDraftBackup`'s unmount cleanup called `queue.close()`; StrictMode's dev double-invoke runs that cleanup between two setups on the SAME queue instance (refs survive the probe), and `close()` is permanent — so in every `npm run tauri dev` session every editor's saves were silent no-ops from mount, invisible to `cargo test`/vitest/`npm run build` and fatal to the §8 manual smoke. Fixed: the cleanup only unregisters the flushable; `close()` belongs to `discard()`. The straggler-resurrection cases the unmount seal covered are already handled by the queue-ordered delete in `clearAfterSave` and the explicit `discardDraft()` on every buffer-discarding path.
- **F2 (code-review CRITICAL — status-only task drafts never backed up).** `write_draft`'s delete-on-empty gate checked only the text fields, so a never-saved task draft whose sole edit was the status/priority dropdown was silently dropped (the frontend correctly considered it dirty; the backend deleted it) — a crash lost the whole tab. Fixed: "empty" now also requires DEFAULT status/priority (todo/normal, mirroring the editor's seeds). The unit test that had pinned the buggy behavior was corrected and two new tests pin the fix.
- **F3 (code-review WARNING — an emptied scratch pad was unrecoverable).** Scratch drafts always carry `entityId ""`, so select-all-delete on a non-empty pad hit the same delete-on-empty gate. Fixed: scratch is excluded from the convention entirely (an emptied pad is a genuine edit; `buffersEqual` on the frontend already prevents no-op writes).
- **F4 (code-review CRITICAL — `delete_files` could leave a dangling catalog row).** The new draft sweep in `delete_files` used `?` AFTER `remove_store_files` had irreversibly deleted the project's files, so a sweep I/O error aborted before `catalog.remove` — catalog row intact, files gone, verb reported failed. Fixed: best-effort (`let _ =`), matching the `scratchfile::remove` beside it; leftovers fall to the TTL/cap GC.
- **F5 (security M1 — crash-leftover `.tmp` files escaped every sweep).** A kill between temp-create and rename left `.<uuid>.md.tmp` holding buffer text, invisible to the `.md`-only scan, sweeps, TTL, and cap — indefinite remanence. Fixed: startup `gc` (whose only caller runs before any writer exists) reaps every `.*.md.tmp`; worst case the reaped temp was one flush tick newer than its `.md` sibling — within the stated ≤5 s crash-loss bound. Unit test added.
- **F6 (security M2 — `ack_close` was an unauthenticated destroy-without-flush primitive).** Any renderer code could `invoke("ack_close")` and destroy the window with dirty buffers unflushed. Fixed: honored only while `CloseState.closing` is set (i.e., a real close is in flight); a spurious ack is a no-op.
- **F7 (security M3 — item/prompt delete swept drafts frontend-only).** `ProjectManager::delete`/`delete_prompt` now delete the entity's draft server-side (draftId = entity UUID per D8), atomic with the delete; the frontend call remains as belt-and-braces. Two integration tests added.
- **F8 (security M4 — sync commands fsynced on the main thread).** The four draft commands were `fn`, not `async fn`; Tauri runs sync commands on the main thread and `save_draft` fsyncs (D9) once per dirty tab per tick. Fixed: all four are `async fn`, matching every other file-touching command.
- **F9 (frontend MED — conflicts were the one silent D5 outcome).** Restores and orphans toasted; conflicts only rendered a bar that a background tab hides. Fixed: a keyed boot notice per surface ("N … changed on disk since your unsaved edits — open the tab to choose.").
- **F10 (code-review WARNING — prompt orphans were folded into the restore count).** PromptsPage now counts and announces orphans separately, mirroring the item surface's honest notice.
- **F11 (self-found while fixing F1 — post-save straggler tick).** Unflushed pre-save edits could let a tick enqueue a snapshot after `clearAfterSave`'s delete (dirty flips false only at the next commit), resurrecting a just-cleared draft. Fixed: `clearAfterSave` bumps `lastFlushRef`, so the schedule sees nothing-new; any post-save edit re-arms normally. (Boot's `clean` branch would have self-healed the residue — this closes it at the source.)
- **F12 (nits).** Stale RED-phase header comment in `tests/drafts.rs` rewritten as history; `draftfile::parse`'s doc no longer overstates the version-check ordering.
- **F13 (manual smoke, step 8/§8-11 — hand-edited files never triggered the conflict bar).** The user's smoke pass found it: editing an item's `.md` in Notepad changes the content but NOT its `updated_at:` frontmatter line, and the index rebuild faithfully reports the unchanged timestamp — so `baseUpdatedAt === item.updatedAt` held and the draft auto-restored over externally changed content (a subsequent Save would have clobbered the hand-edit, the exact no-undo hazard D4 exists for). Timestamp-keyed detection only ever covered app-written changes (git pull/sync files carry a bumped `updated_at` because another app instance saved them). Fixed: item and prompt drafts now also record `baseHash` (the `Draft` field scratch already used) — a fingerprint of the BASE title+body the buffer was seeded from — and `classifyRestore`/`classifyPromptRestore` treat a fingerprint mismatch as a conflict even when the timestamp matches; a record without a fingerprint (`baseHash ""`) degrades to the timestamp-only rule. Metadata-only hand-edits (tags/due/status changed in Notepad with title+body and `updated_at` untouched) remain undetected — accepted: the fingerprint guards the irreplaceable text, and such an edit still surfaces via the timestamp whenever it was made by any app instance. Four RED-first vitest cases pin the fix; smoke steps 1–7 and 9 passed as implemented before this change, step 8 after it.

### Deliberate deviations from the plan text

- **No unmount flush** (step 10 listed "unmount" among the flush triggers). Every unmount is preceded by a path that already settled the draft (save cleared it, discard deleted it, unload/reload swept it, window close flushes via Phase 6 before React ever unmounts), so an unmount flush could only resurrect a draft those paths just removed — the F1 analysis made this concrete. Blur/tab-switch/AI/tick/close flushes stand.
- **`EditorHandle.discardDraft()`** (all three editors) is an addition beyond step 11's two methods: the buffer-discarding paths need an ordered "seal the queue, then delete" verb to make the §8 "a snapshot must never land after the delete" rule hold; App calling `api.deleteDraft` directly could race an in-flight write.
- **Unload/Reload sweep BEFORE the backend call** (step 12): `sweep_project_drafts` requires a loaded project, so the frontend sweeps first. If the unload then fails, editors keep backing up normally (nothing is suppressed) — self-healing, at the cost of a sweep that preceded a failed unload.
- **`useDraftBackup` mirrors `dirty` (and the flush closures) into refs during render**, not via the `titleRef`-style effect: an effect-assigned mirror lags until after paint, and a timer can fire in that window — the render-body write is what makes the F11 fix airtight. Deviation from the local convention is commented in the hook.
- **Restored never-saved drafts open over an EMPTY base template** (step 13): the tab's `item` is `newDraft(kind, projectId)` and the buffer seeds from the snapshot, so buffer ≠ base and the backup keeps maintaining itself until a real save; seeding the base from the snapshot would have made the first tick classify the buffer as clean and delete the backup.

### Manual smoke (§8 E2E) — executed 2026-08-31

Headless portion (no GUI input driver in the implementation environment):
- App boots under `npm run tauri dev` with the full plan.15 code: window appears, real projects load, zero panics/errors in the dev log; the startup GC over a missing `drafts/` root is a clean no-op (the dir is created on demand, none existed).
- **Phase 6 close pipeline:** a real `WM_CLOSE` (graceful close, `CloseMainWindow()`) exits the app in **102 ms** — `CloseRequested → flush-drafts → flushAllDrafts → ack_close → destroy` completes via the ACK path (not the 1.5 s timeout) and never hangs the close.
- The full draft lifecycle (write/fsync/read/list/GC/sweeps, canonical-file untouchability) is exercised by the automated suites against the identical code paths (temp dirs).

Interactive portion — run by the user in the live app, 2026-08-31:
- **PASSED:** §8 steps 1–7 (type → dirty frame; >5 s wait; hard kill; relaunch restores the tab dirty with the unsaved text plus the restore toast; `items/<uuid>.md` untouched until real Save; Save → clean → no re-offer; Discard → no re-offer), step 9 (two dirty tabs, one backgrounded, restore independently), step 10 (a brand-new never-saved draft restores as a draft tab — including the F2 status-only-task case), step 12 (Alt+F4 while dirty → instant close, relaunch restores).
- **FAILED then FIXED then PASSED:** step 11 (external hand-edit → conflict bar) — the failure became finding F13 above; after the base-content-fingerprint fix the bar appears and both buttons behave.
- Step 8 (repeated kills near the flush boundary) was not run as a dedicated exercise, but the many kills across the other steps always relaunched cleanly with no corrupt item or boot failure.
- **Not explicitly confirmed:** step 13 (unload a project with a dirty tab → drafts gone on relaunch — the sweep itself is integration-tested server-side) and the prompt/scratch-surface spot-checks (same shared mechanism as items).

### Accepted residuals (recorded, not fixed)

- **Startup orphan-by-catalog GC** (§3 map item 6's "owning item/project gone"): step 5 scoped startup GC to TTL+cap, and that is what ships. A draft whose project vanished outside the app's verbs (e.g. catalog rebuilt) is never restored (`classifyRestore` → skip) and falls to the 90-day TTL. Remanence-bounded, not incorrect-restore.
- **The 50-record cap is enforced at startup GC, not on write** (per step 5's scoping). Within one long session the store is bounded by 4 MiB × open-buffer count in practice; a hostile renderer is not in the threat model (it could delete the canonical files directly).
- **Unload/Reload sweep failures are swallowed** (`.catch(() => {})`) — the confirm dialog's "edits will be lost" can then be violated by a draft that survives to a later Load; deliberate (documented in code): a failed sweep must not block the unload, and D5's unloaded-project rule plus TTL bound it.
- **Unload bulk-close straggler window**: between the sweep and the tabs unmounting, a tick could theoretically re-write a draft for the unloading project. In practice the confirm dialog's own window-blur already flushed all edits (so the schedule sees nothing new), and a survivor is restored on a later Load rather than lost. §10's interleaving risk, re-checked and accepted.
- **Orphan-supersede handoff has no automated coverage** (the dead entity's file deleted after the replacement's first flush/save/discard): it lives in the hook, untestable under the no-jsdom/no-RTL policy — joins §10's named residuals; exercised by the §8 manual smoke (step 10 variant).
- **`move_prompt` with a dirty buffer**: the tab closes without a discard, leaving a draft bound to the old project; next boot classifies it cross-project → orphan → the unsaved text reopens as a new draft in the source project. Content-preserving, slightly surprising; predates plan.15's concern (a move already silently dropped dirty buffers).
- **Symlink refusal is green-by-skip on this host** (no `SeCreateSymbolicLinkPrivilege`) — as §8 warned; the code paths mirror `scratchfile.rs`'s vetted ones.
- **No directory fsync after the rename** — matches every other writer; `File::sync_all()` on the temp is what D9 specified.
- **Conflict bar is a sibling of, not a child inside, its tabpanel** — visually and in tab order it reads correctly and carries its own `aria-label`; nesting it inside the editor would couple conflict state into three editors for an AT-structural nicety.
- **Non-UUID junk `.md` files in `drafts/`** are warned about on scan and left alone (never ours to delete).

## 13. Execution Prompt

Copy everything inside the fence into a fresh Claude Code session started at the repo root (`c:\Projects\TaskTracker\TaskTracker`):

```
Implement plan 15 for the worknotes app.

1. Read `notes-app/plans/plan.15.md` in full before writing any code. Also read `notes-app/CLAUDE.md` (hard architectural rules and the on-disk backward-compatibility section) — the plan depends on both.

2. Implement Section 6 step by step, phase by phase, in order (Phase 1 backend store → Phase 2 stable draft identity → Phase 3 capture → Phase 4 restore → Phase 5 prompts/scratch → Phase 6 flush-on-close). Do not start a phase until the previous phase's gate is green. The gates are:
   - `cd notes-app/src-tauri && cargo test` (kill any running `notes-app.exe` first — it locks the target binary; an LNK1318 link error means low disk space: clean `target/` and retry, it is not a test failure)
   - `cd notes-app && npx tsc --noEmit`
   - `cd notes-app && npm test`
   - `cd notes-app && npm run build`

3. Honor the plan's design decisions (Section 5) exactly, especially: drafts live in `<app_data_dir>\drafts\<uuid>.md` and are NOT a compatibility surface (amend `notes-app/CLAUDE.md` in the same commit as Phase 1); the writer is modeled on `src-tauri/src/store/scratchfile.rs` plus `File::sync_all()` before the rename; filenames derive only from `is_uuid`-validated UUIDs; restore is visible, never silent; a `baseUpdatedAt` mismatch opens the tab CLEAN with the two-button conflict bar — never auto-restore over changed content; every buffer-discarding path (save, discard, delete, unload, reload, delete-files, forget) clears its draft; no new dependencies.

4. Use subagents during implementation:
   - Spawn a `test-writer` agent to write tests per the strategy in Section 8 (Rust draftfile unit tests mirroring scratchfile.rs, integration tests in src-tauri/tests/, vitest for the pure `src/lib/drafts.ts` module) — each new test must be shown to fail before the code that makes it pass.
   - After the code is written, spawn a `code-reviewer` agent (read-only: Read, Grep, Glob) to review the full diff against the plan.
   - Spawn a `security-auditor` agent (read-only: Read, Grep, Glob) to verify every Section 4 mitigation is actually implemented (UUID-only filenames, sweep set, fsync, fail-soft parsing, no FTS/items/ leakage, generic errors, size caps).
   - Spawn a `frontend-specialist` agent only for the Phase 3/4 editor wiring review (re-render safety of the ref-based capture, background-tab flushing, conflict-bar accessibility).
   - Do not spawn database-architect, api-designer, devops-engineer, or performance-optimizer — the feature touches none of their domains (no schema/migration changes, no HTTP API, no CI/deploy changes).
   - Fallback: if a named agent type is unavailable, use a generic type instead (`Explore` for read-only analysis, `Plan` for strategy, `general-purpose` otherwise) with the role stated in the prompt.
   - Any bug or blocking constraint a reviewer claims must be verified (adversarial-verifier agent, or `general-purpose` instructed to refute it) before you act on it.

5. After implementation, run the code review checklist in Section 11 of the plan against the diff and fix anything it catches.

6. Document the review findings and the improvements you made in Section 12 of `notes-app/plans/plan.15.md`, then implement those improvements.

7. Before finishing: run the full gate suite from step 2 one more time and fix any regressions; then run the manual smoke script from Section 8 (E2E) with `npm run tauri dev` and report the results honestly — including any step you could not perform. Do not commit or push unless explicitly asked.
```
