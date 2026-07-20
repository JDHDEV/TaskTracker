# Plan 9: Toast lifecycle (auto-dismiss) + reusable prompts across all projects

**Created:** 2026-07-19
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Two **independent** workstreams, bundled here but separable at execution time:

- **A) Toast lifecycle.** Today `App.tsx` holds two single-message states (`error`, `notice`, each `string | null`) rendered as banners with only a manual **Dismiss**. This adds (1) **resolve-on-condition** auto-dismiss — a validation toast (e.g. "Enter a project name first.") clears the moment the user fixes the underlying condition (types a name, picks a project, enters body text) — and (2) a **30s time-to-live** for toasts that have no resolvable condition.
- **B) Reusable prompts across projects.** The prompt library is per-project and versioned; a `reusable` flag and a `reusableOnly` filter already exist end-to-end. This surfaces reusable prompts across **all loaded projects** via an "All projects" scope, mirroring the item/tag cross-store fan-out `ProjectManager` already performs — so a reusable prompt authored anywhere is browsable everywhere.

These share no code, no invariants, and no data. A is frontend-only (~half a day); B is a backend fan-out + a UI scope (~1–1.5 days). **Recommendation (tech-lead): implement and land them as two separate commits/passes.** They are kept in one plan for review convenience only.

## 2. Strategic Assessment

From the **tech-lead** (feasibility) and confirmed by the **architect**:

- **Split the work.** #1/#2 (toasts) are a small, safe frontend polish; #3 (reusable prompts) is a read-scope change to an existing subsystem. Do not couple their review/test gates.
- **The prompts ask is smaller than it sounds.** The `reusable` boolean and the `reusableOnly` filter *already exist* on both sides (`src/types.ts`, `src-tauri/src/models.rs`, `promptfile.rs`, and a `PromptsPage` toggle). `PromptListFilter.projectId` is **already optional in both the TS and Rust DTOs** — the "must pick a project" rule is enforced only by a *runtime guard* in `ProjectManager::list_prompts`. So the change needs **no DTO/type edit** — just a relaxed guard plus a cross-store merge. The correct architecture is **Option B: fan reusable prompts across loaded stores and k-way merge**, exactly as items/tags already do — *not* a new global store in `catalog.db` (that store is machine-local and un-synced; prompts are deliberately git-mergeable content, so a global store would strip their portability).
- **The toast ask should not become a reactive rules engine.** Attaching a live `() => boolean` predicate re-evaluated against arbitrary app state is over-engineering for two channels. The right mechanism is a **keyed toast** (`key?: string`): a resolvable validation toast is pushed with a stable key, and the component that owns the field clears that key the instant the condition becomes false. No global watcher.
- **Riskiest part (security-auditor, CONFIRMED by adversarial-verifier):** prompt mutations route **by id to the true owning store** (`prompt_owner` probes every loaded store), with **no viewing-project guard**. So once a cross-project reusable prompt is visible, delete/edit/move on it acts on the *owner's* real files and version history. This is contained — not eliminated — by making the cross-project surface a distinct, per-row-labeled "All projects" scope (see §4, §5).

## 3. Research Findings

### 3.1 Toast call-site inventory (architect)

Every site setting `error`/`notice`, classed **(R)esolvable validation** vs **(T)ransient/generic**:

| # | Site | Message | Class |
|---|------|---------|-------|
| 9 | `Editor.tsx:146` | "Choose a project for this item before saving." | **R** — clears when `projectId` set |
| 11 | `Editor.tsx:232` | "There is no text to rework yet." | **R** — clears when `body` non-empty |
| 13 | `Editor.tsx:317` | "There is no text to generate a title from." | **R** — clears when `body` non-empty |
| 16 | `PromptEditor.tsx:171` | "There is no text to rework yet." | **R** — clears when `body` non-empty |
| 24 | `ManageProjectsDialog.tsx:72` | "Enter a project name first." (the canonical example) | **R** — clears when `newName` non-empty |
| 1,2,4,5 | `App.tsx:89,102,162,200` | list/meta/mutate/create failures | T |
| 3 | `App.tsx:121` | startup warnings (`setNotice`, joined) | T — informational (TTL caveat) |
| 6,7 | `App.tsx:220,248` | "Unloaded/Reloaded … open item was closed" | T |
| 8 | `App.tsx:252` | "Reloaded …, but N items couldn't be imported: \<files\>" | T — informational, names files (TTL caveat) |
| 10,12,14 | `Editor.tsx:168,273,335` | AI title/rework/suggest failures | T |
| 15,17 | `PromptEditor.tsx:112,203` | copy / rework failures | T |
| 18,19,20 | `PromptsPage.tsx:71,93,119` | load/mutate/create failures | T |
| 21 | `PromptHistoryDialog.tsx:28` | version-load failure | T |
| 22 | `SettingsDialog.tsx:64/75/86` | save key/config/token failures | T |
| 23 | `ManageProjectsDialog.tsx:51` | generic withBusy failure | T |
| 25 | `JiraChip.tsx:32` | openExternal failure | T |

**Five R cases; the other twenty are T** and satisfy requirement (2) automatically once a default TTL exists. Children receive only `onError: (message: string) => void`; a `useToasts().error(message, opts?)` is assignable to that, so **all 20 transient sites stay `onError={toasts.error}` with zero changes**. Only the 5 R cases + App's own resolvable paths need the keyed API.

### 3.2 Toast structural facts (architect + frontend-specialist)

- Toasts render in **normal document flow** above `.page-body` (`App.tsx:316-332`), so stacking N banners pushes the two-pane view down (CLS-style jump). The existing code already coalesces the multi-warning startup case into one string (`warnings.join(" ")`, `App.tsx:121`); an array model must preserve that via a **stable key** (e.g. `"startup-warnings"`), not render N banners.
- The app has **no shadow/elevation tokens** anywhere; popovers are "flat, hairline, no shadow" (DESIGN.md). A toast stack must stay flat/hairline.
- The exact self-reverting-timer idiom already exists: `PromptEditor.tsx:57-60,95-110` (a `useRef<number|null>` + `setTimeout`/`clearTimeout`, cleared on unmount, for "Copied"). Reuse it. Enter/exit uses the existing `@media (prefers-reduced-motion: no-preference)` transition block (`styles.css:1092-1099`). **No animation or toast library.**
- `.toast` currently hardcodes `#f7e3dd`/`#7c3421`/`#e8c6bb` (`styles.css:143-146`) instead of the `--danger` token — fix only opportunistically if rewriting the toast CSS anyway.
- The Editor project case (#9) already has primary prevention: Save is disabled via `saveBlocked={isDraft && !projectId}` (`Editor.tsx:574`, `AiBar.tsx:119-124`); the toast fires only via the **Ctrl+S** path (`Editor.tsx:220-222`) that bypasses the disabled button. So resolve-on-condition here is a *backstop*, not the primary signal. `ManageProjectsDialog`'s Create button (#24) has **no** such guard (`disabled={busy}` only, `ManageProjectsDialog.tsx:248`) and an Enter-to-submit path (`:241-246`) that bypasses it — so a companion `disabled={busy || !newName.trim()}` is the primary fix, toast the backstop.

### 3.3 Prompts fan-out (architect)

- **Prior art (the template):** items — `ProjectManager::list_all` (`mod.rs:574-586`) → `targets(project_id)` → per-store `repo.list`, stamp `project_id`, `k_way_merge(lists, sort)` with comparator `item_order` (`mod.rs:1151-1166`). Tags — `active_tags_union` (`mod.rs:609-617`) unions via `snapshot()`. Prompts already have `prompt_snapshot()` (`mod.rs:753-760`, currently used only by `prompt_owner`). **Prompt cross-store *search* does not exist** and is out of scope.
- **Per-store order → comparator.** Prompt list SQL orders `r.created_at DESC, p.id ASC`, surfaced as `updated_at` (`db/sqlite.rs:969-975`); fixed-ms RFC 3339 timestamps make lexical = chronological. Cross-store comparator: `b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id))`. No `pinned`/sort-mode dimension — simpler than `item_order`.
- **What changes (backend):** `ProjectManager::list_prompts` (`mod.rs:458-473`) — when `project_id` present → current single-store path (unchanged); when absent/empty → fan out over `prompt_snapshot()`, run `repo.list(filter)` per store, stamp each store's UUID, merge. Add a dedicated `prompt_order` + `k_way_merge_prompts` (lower-risk than generalizing the item merge). **No change** to create/update/version/move/delete — they already route by explicit target or by id.
- **No DTO/type change** — `reusable`, `reusableOnly`, `projectId` already exist on both sides; the camelCase mirror rule is not triggered.
- **Frontend:** `PromptList` `<select>` (`:42-54`) gets `<option value="">All projects</option>` (mirror `ItemList.tsx:130`); `PromptsPage` (`:39,52-56`) stops coercing `""` back to `loaded[0]`; `loadPrompts` (`:58-73`) calls `listPrompts({ reusableOnly: true })` (no projectId) when `""`, keeping the monotonic token guard; the existing `canCreate = projectId !== ""` (`PromptList.tsx:33`) **already disables "New prompt"** in the All scope — only the empty-list microcopy needs an all-projects variant; per-row owner label reuses `.row-project` (`styles.css:293-298`), gated on `projectId === ""`.

### 3.4 Prior-art conventions (architect)

- **State/hooks:** function components, local `useState`, IPC loaders wrapped in `useCallback` guarded by a **monotonic request token** (`nextToken`/`shouldCommit`). `useToasts` should follow this idiom.
- **Error handling:** frontend `String(err)`s a bare `AppError` string; components surface via `onError`. Backend validation lives in the repository/manager layer (`AppError::Invalid`/`NotFound`), never the UI.
- **Tests:** per-store repo tests in `src-tauri/tests/repo_prompts.rs` (in-memory SQLite); manager/fan-out/lifecycle in `src-tauri/tests/project_manager.rs` (tempdirs); frontend pure logic in `src/lib/*.test.ts` (Vitest, node env — **no jsdom/RTL in the project**). `set_prompt_version_timestamp_for_test` already exists for deterministic timestamps.
- **File-then-index discipline:** the reusable-list feature is a **read** served from the index — it does not touch the write path.

## 4. Security Considerations

From the **security-auditor** (read-only), with the linchpin claim **CONFIRMED** by the **adversarial-verifier** (full trace `api.ts` → `commands.rs` → `mod.rs`: mutations route by id via `prompt_owner` across all loaded stores; `list_prompts` stamps the caller's requested project; **no viewing-project guard exists**).

**Critical:** none. No HTML-injection sink exists (`grep` for `dangerouslySetInnerHTML`/`innerHTML`/`marked`/`react-markdown` across `src/` is empty; all prompt/toast text renders as React **text nodes**), no SQL-injection path in the prompt layer (prompt `list` uses `QueryBuilder` with `reusable_only` as a **static literal**; there is **no `MATCH`/FTS for prompts at all**, so `fts_query` is not in play), and the CSP is restrictive (`default-src 'self'`).

**High — project-isolation break (OWASP A01), the design's load-bearing constraint.** Because mutations route by id to the true owner, making a reusable prompt owned by project X visible in a view lets delete/edit/move on it act on **X's real files and full version history**. **Requirement:** stamp each fanned-in prompt with its **true owning-store UUID** (do *not* reuse the single-store `p.project_id = Some(target)` stamp for merged rows), **surface the owner in the row**, and decide the mutability policy (see §5 Key Decisions / §10 Q2). Mitigation baked into the design: the cross-project surface is a **distinct "All projects" scope** (not a fan-in into a single-project view), and every row carries its owner label — so no boundary is crossed silently.

**Medium:**
1. **Gate the fan-out strictly to `reusable = 1`.** Relax the guard only for the reusable case; keep rejecting/scoping a `projectId`-less **non-reusable** list so omitting `projectId` can never dump every prompt in every project. (Enforce `reusableOnly = true` server-side in the empty-`projectId` branch.)
2. **Clone-under-lock.** Implement the fan-out with the `prompt_snapshot()` snapshot-then-release pattern; **never hold the `RwLock` across `.await`**; tolerate a store unloaded mid-list with a clean sqlx error (never a panic), matching `active_tags_union`/`search_all`.
3. **Dedup by prompt id** so a row can never appear twice (defense-in-depth; with the distinct All scope this is unlikely, but the merge should still key by id).

**Low:**
4. **Toast timer hygiene.** Clear every auto-dismiss timer on message change/unmount; key the timer to the current toast so a resolved/replaced toast's stale timer can't fire `setError(null)` against a *newer* toast. Copy the idiom at `PromptEditor.tsx:92-110`.
5. **Don't auto-expire genuine errors.** Error toasts embed `String(err)` (which for `Db`/`Http` variants can name a host/URL or a raw foreign-file line via `promptfile.rs` "bad frontmatter line: {raw}"). Confidentiality impact is low (single-user, local, text-node render, no XSS), but a `role="alert"` error auto-dismissing at 30s can hide a real failure before it's read — see §5.

**Dependency / info:** add **no** npm toast/animation library — the existing markup + a small hook cover it (CLAUDE.md: flag any new dependency). Keep all merged cross-project content as text nodes (never markdown/HTML). No secret/keyring material ever reaches prompt files (a `promptfile.rs` test already asserts the serialized bytes contain no token/key/secret) — the read-only fan-out cannot change that.

## 5. Design

### Approach

**Workstream A — keyed toasts + per-toast TTL (architect Option A, frontend-specialist refinements).**

Introduce a **framework-free store** `src/lib/toasts.ts` (so it is unit-testable with `vi.useFakeTimers()` in the node env — the project has **no jsdom/RTL**, per test-writer) plus a thin `src/hooks/useToasts.ts` wrapper (`useSyncExternalStore`). Model:

```ts
type Toast = { id: string; kind: "error" | "notice"; message: string; key?: string; ttlMs?: number };
```

Store API: `push(toast)`, `dismiss(id)`, `dismissKey(key)`, `subscribe`, `getSnapshot`, `dispose`. Hook exposes `error(message, opts?)`, `notice(message, opts?)`, `dismissKey(key)`. The `error`/`notice` signatures accept an optional `opts` (`{ key?, ttlMs? }`); the `onError` prop threaded to children is widened from `(message: string) => void` to `(message: string, opts?: { key?: string }) => void` (see §6). Behavior:

- **Keyed replace/dedupe:** pushing a toast whose `key` matches an existing one **replaces it in place and resets its timer** (no duplicate, no stack growth). Unkeyed toasts append **but dedupe by identical `(kind, message)`** (a repeated failure replaces rather than stacks), and the store enforces a **hard cap `TOAST_MAX = 4`**, evicting the oldest when exceeded. This bounds the persistent-error stack that Decision §5.1 (errors have no TTL) would otherwise let grow without limit in normal document flow (code-reviewer finding).
- **TTL:** each toast schedules `setTimeout(ttlMs ?? default)`. Default is **`TOAST_TTL_MS = 30_000` for notices (`role="status"`); errors (`role="alert"`) default to no TTL** (persist until dismissed/resolved) — see Key Decisions. Timer cleared on dismiss/replace/`dispose`.
- **Pause-on-interaction (WCAG 2.2.1):** pause a toast's timer on `mouseenter` **and** `focus-within`; resume with the **remaining** time. This also guarantees auto-dismiss never yanks focus from a control inside a toast.
- **Resolve-on-condition:** the 5 R toasts are pushed with a stable key (`"project-name"`, `"item-project"`, `"editor-no-text"`, `"editor-no-title-src"`, `"prompt-no-text"`). The owning component clears the key the **instant the condition becomes false** (a small effect watching `newName` / `projectId` / `body`), not on the next retry.

Render is extracted into `src/components/Toasts.tsx`: a plain (non-live) wrapper containing one `role="alert"` (errors) or `role="status"` (notices) element **per toast** — never a single reused node with a swapped role. Startup warnings keep their coalesced-string behavior under a stable key so they render as one banner.

Companion fix: add `disabled={busy || !newName.trim()}` to `ManageProjectsDialog`'s Create button (primary prevention; the toast stays as the Enter-key-bypass backstop).

**Workstream B — reusable-only cross-store fan-out (architect Option 1 + Option a).**

Relax `ProjectManager::list_prompts`: when `project_id` is empty/absent, **force `reusable_only = true`**, fan out over `prompt_snapshot()`, run `repo.list(filter)` per store, stamp each row with its **true owning UUID**, and merge with a dedicated `prompt_order` + `k_way_merge_prompts`. When `project_id` is present, the path is unchanged. Create/update/version/move/delete are unchanged (they already route correctly). Frontend adds the "All projects" scope to `PromptList`/`PromptsPage` with a per-row owner label and reusable-only forced+disabled in that scope.

### Architecture

- **Toasts:** `toasts.ts` (store, timers, keying) ← `useToasts.ts` (React binding) ← `App.tsx` renders `<Toasts>` and passes `toasts.error` as `onError` to all children. The 3 field-owning children (`Editor`, `PromptEditor`, `ManageProjectsDialog`) additionally receive a keyed-dismiss capability to clear their R key on resolution. No backend involvement.
- **Prompts:** all cross-store logic stays in `ProjectManager` (the trait boundary is preserved — "each repository impl owns its own SQL"); the frontend consumes a single already-merged, already-stamped, already-sorted array via `api.listPrompts`, exactly like `ItemList` never merges client-side.

### Key Decisions

1. **Notices auto-expire (30s); errors persist by default — but the stack is capped and deduped.** (security-auditor + frontend-specialist.) A blanket 30s TTL on `role="alert"` errors would silently drop actionable messages — notably #8 ("Reloaded …, but N items couldn't be imported: \<files\>"). Errors persist until dismissed or resolved; callers may opt into a TTL per-toast. Because persistent errors + the "unkeyed append" model would let a session accumulate an unbounded banner stack (code-reviewer finding), the store **dedupes identical `(kind, message)` and caps the stack at `TOAST_MAX = 4`** (oldest evicted). **This is a decision to confirm — see §10 Q1.**
2. **"All projects" ⇒ reusable-only, cross-store (not all-prompts-everywhere).** (architect + security.) A full union of every private per-project prompt contradicts the deliberate per-project design and has no coherent "All" meaning. The reusable-only branch is the minimal change that delivers the ask. The `reusableOnly` chip is forced on and disabled in the All scope.
3. **Foreign reusable prompts stay editable in the All view, guarded by an owner label + owner-named confirmations** (recommended) — *vs* read-only foreign prompts (stricter). A central reusable library is more useful if edits write back to the owner; the CONFIRMED isolation risk is mitigated by (a) the required per-row owner label, (b) a **persistent owning-project indicator in `PromptEditor`'s header whenever the All scope is active** — the Save and Mark-reusable paths have no confirmation dialog, so the label is the only in-context signal there (code-reviewer finding), and (c) naming the owning project in the destructive Move/Delete confirmation (`api.confirmDialog` already gates those). **Honest caveat (code-reviewer):** the read-only *alternative* is a **client-side convention only** — mutations route by id to the true owner and no viewing-scope argument crosses IPC, so neither policy is enforced in the repository layer. If protocol-level enforcement is ever required, it needs a new backend guard, which is out of scope here. **This is a decision to confirm — see §10 Q2.**
4. **Resolve = condition becomes false immediately, not on retry.** (frontend-specialist.) Clearing the instant `newName`/`projectId`/`body` is fixed avoids a stale error sitting on screen mid-correction, matching the literal ask.
5. **Dedicated `k_way_merge_prompts`, not a generalized item merge.** (architect.) Zero risk to the well-tested item path; trivially unit-testable in isolation.
6. **Extract a framework-free toast store.** (test-writer.) The project has no jsdom/RTL; a pure store is deterministically testable with fake timers, and the hook stays a thin binding.

## 6. Implementation Steps

**Do Workstream A and Workstream B as two separate commits.**

### Workstream A — toasts

1. Create `src/lib/toasts.ts`: the framework-free store — `Toast` type, `TOAST_TTL_MS = 30_000` (named export), `push`/`dismiss`/`dismissKey`/`subscribe`/`getSnapshot`/`dispose`, keyed replace-and-reset-timer, per-toast `setTimeout` (default by kind), pause/resume-with-remaining hooks, all timer handles owned and cleared on dismiss/replace/dispose.
2. Add `src/lib/toasts.test.ts` (Vitest, fake timers) — see §8.
3. Create `src/hooks/useToasts.ts`: `useSyncExternalStore` wrapper exposing `error(msg, opts?)`, `notice(msg, opts?)`, `dismissKey(key)`, and the current `Toast[]`; `dispose` on unmount.
4. Create `src/components/Toasts.tsx`: stacked renderer, one `role="alert"`/`role="status"` element per toast inside a non-live wrapper, Dismiss button per toast, pause-on-hover/focus-within wiring, flat/hairline styling using existing tokens; reduced-motion-aware enter/exit.
5. Modify `App.tsx`: replace `error`/`notice` `useState` + inline JSX (`:48-51,316-332`) with `useToasts()` + `<Toasts>`. Wire App-owned transient sites (`:89,102,121,162,200,220,248,252`) to `toasts.error`/`toasts.notice`; give startup-warnings a stable `"startup-warnings"` key (preserve the join); pass a keyed-capable `onError` to every child. **Widen the `onError` prop type** from `(message: string) => void` to `(message: string, opts?: { key?: string }) => void` in `Editor`, `PromptEditor`, and `ManageProjectsDialog` (the 20 transient sites still call it one-arg — assignable, no change needed), and pass `toasts.dismissKey` (or a keyed-dismiss handle) to those three children so they can clear their R key. **Do not** work around the wider signature by dropping the key — a missing key makes the paired `dismissKey` a silent no-op and breaks A1 with no test catching it (code-reviewer finding).
6. Modify `Editor.tsx`: push #9/#11/#13 with stable keys (two-arg `onError(msg, { key })`); add effects clearing `"item-project"` when `projectId` set and `"editor-no-text"`/`"editor-no-title-src"` when `body` non-empty.
7. Modify `PromptEditor.tsx`: push #16 with key `"prompt-no-text"`; clear it when `body` non-empty. If §10 Q2 = editable (recommended), also render a persistent owning-project name in the editor header/meta row (lines ~246-320) whenever the page scope is `""` (All) — since Save (`:144-155`) and Mark-reusable (`:262`) have no confirmation dialog, this label is the only in-context owner signal.
8. Modify `ManageProjectsDialog.tsx`: push #24 with key `"project-name"` (two-arg `onError`), clear when `newName` non-empty; add `disabled={busy || !newName.trim()}` to the Create button.
9. Modify `styles.css` only as needed for the toast stack (flat, hairline, existing tokens); opportunistically derive `.toast` colors from `--danger` if rewriting that block.
10. Verify: `npx tsc --noEmit`, `npm run build`, `npm run tauri dev` smoke (Ctrl+S with no project; Create with blank name then type; startup warnings; a transient error auto-expiring at 30s; an error persisting).

### Workstream B — reusable prompts across projects

11. Modify `src-tauri/src/projects/mod.rs`: relax `list_prompts` (`:458-473`) — empty/absent `project_id` ⇒ force `reusable_only = true`, fan out over `prompt_snapshot()` (clone Arcs under lock, release, then `await` per-store `repo.list`), stamp each row's **true owning UUID**, merge via a new `prompt_order` + `k_way_merge_prompts`. Keep rejecting an empty-`projectId` **non-reusable** request. Update the doc comment (`:436-440`). Add `merge_tests` cases for the comparator.
12. Modify `src-tauri/tests/project_manager.rs`: **rewrite** `list_prompts_without_a_project_id_is_invalid` (`:1206`) to the new contract; add tests per §8.
13. Modify `PromptsPage.tsx`: allow `projectId === ""`; stop the re-anchor effect (`:52-56`) coercing `""` → `loaded[0]`; `loadPrompts` (`:58-73`) calls `listPrompts({ reusableOnly: true })` when `""` (keep the token guard); update the doc comment (`:10-13`).
14. Modify `PromptList.tsx`: add `<option value="">All projects</option>` (rename the select's `aria-label` to "Filter by project"). **Resolve the value collision** with the existing `loaded.length === 0 && <option value="">No projects loaded</option>` (`:48`): render exactly one `value=""` option — "No projects loaded" when `loaded.length === 0` (select effectively inert), else "All projects". Force+disable the `reusableOnly` chip pair when `""` (reuse `.chip:disabled`); add `.row-project` owner label after `row-version`, gated on `projectId === ""`. **Make the empty-state a three-way branch** (`:73-75`): (a) `loaded.length === 0` → "No projects loaded…"; (b) `projectId === "" && loaded.length > 0` → an all-projects "No reusable prompts yet" variant; (c) a specific project with an empty list → the existing per-project copy. Extend `canCreate` (`:33`) so `""` (All) is falsy (New prompt already disables when `canCreate` is false).
15. Owner-mutation guard per §10 Q2. If Q2 = read-only foreign prompts: gate Delete/Save/Move/Mark-reusable on `prompt.projectId === projectId` in `PromptsPage.tsx`/`PromptEditor.tsx` (**note: UI convention only — not backend-enforced**, per §5.3). If Q2 = editable (recommended): add the owning-project name to the Move **and** Delete confirmation text in `PromptsPage.tsx` (`:158-174`), and render the persistent owner label in `PromptEditor`'s header (step 7) so the confirmation-less Save/Mark-reusable paths still show the owner.
16. Update docs/comments in the SAME commit: `models.rs:251-254`, `types.ts:121-122`, `api.ts:126-130` (relax "no cross-store fan-out / one project at a time" wording; no signature change). **`docs/DESIGN.md`** (authoritative spec) needs more than the one-line relaxation at `:118` — add proper entries for the new "All projects" rail option, the forced+disabled reusable-chip pair in that scope, the owner-label presentation, and the new all-projects empty-state microcopy.
17. Verify: `cd src-tauri && cargo test`; `npx tsc --noEmit`; `npm run build`; `npm run tauri dev` smoke (All-projects shows reusable prompts from ≥2 loaded projects with owner labels; New prompt disabled in All; non-reusable never appears in All; unload a project and confirm its reusable prompts drop from All).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/toasts.ts` | Create | Framework-free toast store: keyed replace, per-toast TTL, pause/resume, timer ownership |
| `src/lib/toasts.test.ts` | Create | Vitest fake-timer coverage of the store |
| `src/hooks/useToasts.ts` | Create | `useSyncExternalStore` binding exposing `error`/`notice`/`dismissKey` |
| `src/components/Toasts.tsx` | Create | Stacked renderer, per-toast `role="alert"`/`role="status"`, pause-on-hover/focus |
| `src/App.tsx` | Modify | Replace `error`/`notice` state + JSX; wire transient + resolvable sites; key startup warnings |
| `src/components/Editor.tsx` | Modify | Keyed R toasts #9/#11/#13 + clear-on-resolution effects |
| `src/components/PromptEditor.tsx` | Modify | Keyed R toast #16 + clear-on-resolution |
| `src/components/ManageProjectsDialog.tsx` | Modify | Keyed R toast #24 + `disabled` guard on Create |
| `src/styles.css` | Modify | Toast-stack styling (flat/hairline, existing tokens) |
| `src-tauri/src/projects/mod.rs` | Modify | Relax `list_prompts`; add `prompt_order`/`k_way_merge_prompts`; doc comment; merge tests |
| `src-tauri/tests/project_manager.rs` | Modify | Rewrite the "invalid without projectId" test; add fan-out/leak/unload/order/zero/dupe tests |
| `src/components/PromptsPage.tsx` | Modify | Allow `""` scope; fan-out load call; doc comment; owner-named confirmations (if Q2=editable) |
| `src/components/PromptList.tsx` | Modify | "All projects" option; force+disable reusableOnly; owner label; empty-state copy |
| `src/lib/api.ts` | Modify | Doc comment only (relax "requires projectId") |
| `src/types.ts` | Modify | Doc comment only |
| `docs/DESIGN.md` | Modify | Relax line 118 + add entries for the All-projects rail option, forced/disabled reusable chip, owner label, and all-projects empty-state copy |
| `src-tauri/src/models.rs` | Modify | Doc comment only (`:251-254`) |

## 8. Test Strategy

From the **test-writer**. Extract pure logic so it is testable without a DOM; use `vi.useFakeTimers()` (Vitest built-in, node env — **no new dependency**). Rust fan-out tests reuse the `project_manager.rs` tempdir fixtures (`new_manager`/`create_project`/`new_prompt`/`set_prompt_version_timestamp_for_test`).

- [ ] **Unit Tests — `src/lib/toasts.test.ts`:**
  - `push` adds a toast visible via `getSnapshot()`.
  - Push with an **existing key replaces** (length unchanged, message/kind updated) **and resets the TTL** (advance to just-before original expiry, re-push same key, advance to original expiry → still present).
  - `dismiss`/`dismissKey` removes exactly the target, leaves others.
  - **TTL boundary:** advance `TTL_MS - 1` → present; +1ms → gone.
  - **`TOAST_TTL_MS` equals the literal `30_000`** (assert against the literal, not the self-import).
  - **Manual dismiss cancels the pending timer** (assert via `vi.getTimerCount()`/`clearTimeout` spy, not just empty array).
  - **Resolve-path:** push keyed validation toast, `dismissKey` before TTL → gone immediately, advancing timers after must not throw.
  - **Independent per-toast timers:** two keys started a few ms apart; expire only the older.
  - **`dispose` clears all pending timers** (`vi.getTimerCount() === 0`).
  - **Errors default to no TTL, notices to 30s** (push each kind; advance past 30s; error present, notice gone).
  - **Pause/resume-with-remaining:** push a toast, advance part of its TTL, pause; advance well past the original TTL while paused → still present; resume, advance only the *remaining* time → gone (proves resume continues the remaining time, not a full re-arm).
  - **Dedup + cap:** pushing the same `(kind, message)` twice keeps one entry; pushing 5 distinct unkeyed toasts leaves `TOAST_MAX = 4` (oldest evicted).
  - `subscribe`/`getSnapshot` notify on push/dismiss/expiry.
- [ ] **Unit Tests — `src/lib/prompts.test.ts` (extend, if a helper is introduced):** view-state → `PromptListFilter` mapping (specific id passes through; `""` → omit projectId / force `reusableOnly`).
- [ ] **Integration Tests — `src-tauri/tests/project_manager.rs`:**
  - **Rewrite** `list_prompts_without_a_project_id_is_invalid` to the new contract (breaking change — old assertion must not coexist).
  - Omitted `projectId`, two loaded projects each with one `reusable` prompt → both returned, each stamped with its **owning** UUID.
  - Set `projectId` still returns only that project's prompts (regression).
  - **Non-reusable never leaks:** project with one reusable + one non-reusable; omitted-`projectId` union includes only the reusable one, though the non-reusable one *is* returned when scoped to that project.
  - **Merge order across stores:** pin timestamps (A-old, B-mid, A-new) → union orders `[a-new, b-mid, a-old]` (proves a real k-way merge, not concatenation).
  - **Tiebreak:** identical `updated_at` in two stores → deterministic `id ASC`, stable across calls.
  - **Duplicate titles across projects** are both returned (assert on `id`, not title).
  - **Dedup-by-id:** if two loaded stores pathologically return the same prompt `id`, the merge collapses to one row (the §4 Medium #3 / §9 Security mitigation — distinct from the duplicate-titles case).
  - **Owning project unloaded** → its reusable prompt drops from the union; others remain.
  - **Zero loaded projects** → `Ok(vec![])`, not an error.
  - **Ambiguity #3 branch:** omitted `projectId` + `reusableOnly: false/omitted` → assert the chosen behavior (coerced to reusable-only, per Decision §5.2).
  - **Regression (unchanged routing):** re-run `create_prompt_lands_only_in_target_store` and `move_prompt_*` (in `project_manager.rs`), and `prompt_content_edit_appends_one_version_bumps_updated_at_and_preserves_original` (in `repo_prompts.rs`) — none should need edits.
  - **Fixture note:** `set_prompt_version_timestamp_for_test` is an inherent method on the concrete `SqliteRepository`, **not** on the `PromptRepository` trait — so the merge-order test pins timestamps via the existing "side connection to the same DB file the manager already has open" idiom (precedent: `project_manager.rs:615-622`), not through `Arc<dyn PromptRepository>`.
- [ ] **Edge Cases & Error Scenarios:**
  - Two different keys expiring on the same tick — both clear, no throw.
  - `dismissKey` on an absent/already-expired key is a no-op.
  - Single loaded project with omitted `projectId` degenerates to that project's reusable prompts, same order as scoping to it.
  - Reload mid-session reflects reloaded prompts in the union (not stale).
- [ ] **Static / code-review checks (not automatable — no jsdom/RTL):** prompt bodies/messages stay text nodes (no markdown/HTML) even in the merged view — verified by grep for `dangerouslySetInnerHTML`/`innerHTML`/`marked` (per §4), not a runtime test.
- [ ] **Manual-smoke gaps (no automated DOM test under current tooling — flagged, not assumed covered):** the rendered toast stacking/fade, pause-on-hover/focus, and the `ManageProjectsDialog`/startup `notice` paths; the "All projects" option/owner-row/empty-state and the `PromptEditor` owner label in `PromptsPage`. Covered by `npm run tauri dev` per CLAUDE.md.

## 9. Success Criteria

- [ ] **Functional A1:** a resolvable validation toast (e.g. "Enter a project name first.") disappears the instant its condition is fixed (name typed / project chosen / body entered), without waiting for a retry.
- [ ] **Functional A2:** a transient notice with no resolvable condition auto-dismisses after 30s; error toasts persist until dismissed/resolved (Decision §10 Q1).
- [ ] **Functional A3:** a hovered/focused toast does not disappear (timer paused; WCAG 2.2.1) and auto-dismiss never steals focus.
- [ ] **Functional B1:** an "All projects" scope in PromptsPage lists reusable prompts from every loaded project, each labeled with its owning project, ordered by recency.
- [ ] **Functional B2:** non-reusable prompts never appear in the All scope; New prompt is disabled there; unloading a project drops its reusable prompts from the union.
- [ ] **Tests:** all §8 tests pass; existing prompt-routing regression tests unchanged and green.
- [ ] **Security:** §4 High mitigated (true-owner stamp + per-row label + Q2 policy); fan-out is reusable-only, snapshot-under-lock, dedup-by-id; no error auto-expiry that hides failures; no new dependency; all content rendered as text.
- [ ] **Quality:** `cargo test`, `npx tsc --noEmit`, `npm run build` all clean.

## 10. Risks & Open Questions

**Verification-gate outcome:** the security-auditor's isolation claim was run through the **adversarial-verifier** and returned **CONFIRMED** (High confidence; full path traced, though `cargo test` was not executed due to a known machine-specific link issue). It therefore **drives** the §4 High requirement and Decision §5.3. No claim was REFUTED or UNVERIFIABLE.

**Decisions (confirmed by the user 2026-07-19 — implement these, not the alternatives):**

- **Q1 — Error-toast TTL → DECIDED: notices auto-expire at 30s, errors persist** until dismissed/resolved (so #8's "N items couldn't be imported: \<files\>" isn't silently lost). Stack is capped at `TOAST_MAX = 4` and deduped by `(kind, message)` so persistent errors can't grow unbounded.
- **Q2 — Foreign reusable prompts in the All view → DECIDED: editable, owner-labeled.** Edits write back to the owning store; a required owner label per row + a persistent owner label in `PromptEditor`'s header (covers the confirmation-less Save/Mark-reusable paths) + the owning project named in Move/Delete confirmations. (Not the read-only alternative. Note: neither policy is repository-enforced — the owner label is the isolation signal.)
- **Q3 — Split → DECIDED: two separate commits/passes** (A toasts, B prompts). The plan is structured for that.

**Code-review pass:** this plan was reviewed by a `code-reviewer` agent, which confirmed the file/line citations are accurate and the core design sound, and surfaced gaps now folded in: the persistent-error stack cap + dedup (§5.1, §5 store model), the widened keyed `onError` prop (§6 step 5), the `<option value="">` collision + three-way empty-state (§6 step 14), the `PromptEditor` owner indicator for the confirmation-less Save/Mark-reusable paths (§6 steps 7/15), the "read-only is UI-only" caveat (§5.3, §10 Q2), the dedup-by-id and pause/resume tests (§8), and the broader DESIGN.md scope (§6 step 16, §7).

**Other risks:**
- Moving from a single-slot model to a stacked array is genuine new behavior (dedupe policy, cap, timers) — mitigated by the pure-store unit tests.
- Doc drift: `DESIGN.md:118`, the `PromptsPage`/`list_prompts` doc-comments, and `types.ts`/`api.ts` comments all assert the old "one project at a time" behavior and **must** be updated in the same commit as B.
- `move_prompt`'s pre-existing rollback/verify-failure test is an empty stub — unrelated to this feature, noted but not in scope.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` is on)
- [ ] Error handling covers failure modes (fan-out tolerates a store unloaded mid-list with a clean error)
- [ ] No security vulnerabilities: merged prompts stamped with **true owner**, per-row owner label present, Q2 policy enforced, fan-out is reusable-only, content rendered as text (no HTML)
- [ ] Toast timers cleared on dismiss/replace/unmount; no stale `setState` on a superseded toast
- [ ] Security considerations from §4 addressed
- [ ] Code follows existing conventions (monotonic token guard, `onError` contract, trait boundary — no client-side merge)
- [ ] Tests cover happy path, edge cases, and error scenarios (fan-out order, leak, unload, TTL boundary, resolve-path)
- [ ] No performance regressions (fan-out clones Arcs under lock, never holds the lock across `.await`)
- [ ] No new npm/cargo dependency added
- [ ] Changes are minimal — no unrelated refactoring; `.toast` color-token cleanup only if the block was already being rewritten
- [ ] Docs/comments updated to match the new prompt behavior

## 12. Post-Review Improvements

Implemented 2026-07-19, after the §11 checklist and the code-reviewer / security-auditor / frontend-specialist / test-writer passes on both workstreams.

### Workstream A (toasts)
- **Pause-on-replace WCAG 2.2.1 fix (code-reviewer WARNING).** A keyed (or unkeyed-dedup) `replaceInPlace` re-armed a fresh full-TTL timer with `paused: false`, so a toast the user was hovering/focusing when its key was re-pushed would silently tick down under the pointer (the component keeps the same `id`, so no new mouseenter/focus fires to re-pause). Fixed store-side: `replaceInPlace` reads the prior timer's `paused` flag and `armTimer(toast, startPaused)` re-arms the reset TTL but stays paused; `resume` re-arms it on mouseleave/blur (`src/lib/toasts.ts`). Added a regression test (`a keyed replace while paused stays paused`) and proved it red without the fix.
- **Deliberately NOT done (frontend-specialist notes, both non-blocking):** (a) the enter-only fade (`toast-in`) has no matching exit animation — a true exit transition needs deferred-unmount state with no library, out of proportion to the benefit; removal stays immediate. (b) `.toast` keeps its hardcoded error tint (`#f7e3dd`/`#7c3421`/`#e8c6bb`) rather than deriving from `--danger` — the values are already theme-constant (matching the "danger red is constant" invariant) and measured at ~7.17:1 contrast (AAA); re-deriving risked changing a validated appearance for no functional gain. The plan marked this cleanup "opportunistic" only.

### Workstream B (reusable prompts across projects)
- **Empty-projectId non-reusable = REJECT, not coerce (reconciliation).** §4 M1 / §6 step 11 and the execution prompt's non-negotiable constraint ("keep rejecting an empty-projectId NON-reusable list") were followed over §8's parenthetical "coerced to reusable-only": `list_prompts` returns `AppError::Invalid` for a projectId-less request that is not `reusable_only`, and forces `reusable_only = true` on the per-store fan-out calls (defense-in-depth). The obsolete `list_prompts_without_a_project_id_is_invalid` test was rewritten to this contract (`list_prompts_without_a_project_id_requires_reusable_only`).
- **Stale doc comment in `commands.rs` (code-reviewer + security-auditor).** The doc-drift pass missed `src-tauri/src/commands.rs:76-80`, which still asserted "prompts are viewed one project at a time … the manager rejects an empty/absent one." Updated to describe the All-projects reusable fan-out alongside `models.rs`/`types.ts`/`api.ts`/`DESIGN.md`.
- **`ownerLabel`-on-draft edge case (code-reviewer nit).** The persistent editor owner label was computed from `selected` even when `selected` is an unsaved draft (reachable by opening a single-project draft, then flipping the rail to All). Guarded with `draft === null` so a draft — which no store owns yet — never shows an owner label (`src/components/PromptsPage.tsx`).

### Smoke-test fixes (manual §9 pass, 2026-07-20)
Found and fixed during the interactive `npm run tauri dev` smoke; all frontend-only.
- **Prompt "needs a title or text" now resolves.** The both-empty rejection surfaced as the backend's unkeyed, persistent error, which lingered after the user fixed the field or saved. `PromptEditor` now guards the case itself with a KEYED, resolvable toast ("Add a title or some text before saving.", key `"prompt-empty"`) that clears the instant a title or body exists and can never outlive a successful save; the repository still enforces the rule as the backstop (`src/components/PromptEditor.tsx`).
- **Every unload confirms with a notice.** The unload notice previously fired only when it closed an OPEN item; a later unload (nothing open) was silent. `unloadProject` now shows a plain "Unloaded 'X'." when nothing was open, and the item/prompt-closed variant otherwise (`src/App.tsx`).
- **Toast dedup narrowed to errors only.** Repeated identical NOTICES were being collapsed in place by the unkeyed `(kind, message)` dedup, so a second unload gave no visible feedback ("only happened the first time"). Dedup is now errors-only (they are persistent and must not stack); notices append and give per-action feedback, still bounded by `TOAST_MAX` + auto-expiry (`src/lib/toasts.ts`). A test was added (notices append / errors dedup) and proven red under the old behavior. This refines Decision §5.1 / §10 Q1: the cap+dedup bounds the persistent-error stack; notices self-bound via their TTL and are not deduped.
- **Toast pause-on-replace fix** — already logged above (Workstream A); surfaced by the A code review and verified during smoke.
- **Unload confirm covers an open prompt.** The confirm only knew App's Worknotes selection, so unloading silently closed a prompt open on the Prompts page (losing unsaved edits). `PromptsPage` now reports its open prompt's owning project up to App (and drops a draft whose target project is unloaded); `unloadProject` warns for an open item OR prompt, with wording that adapts ("item"/"prompt") (`src/App.tsx`, `src/components/PromptsPage.tsx`).

### Known gap (deferred, not addressed)
- **Reload with an open prompt.** The Reload confirm still considers only Worknotes items, and the prompt list does not auto-refresh after a reload — deferred rather than half-fixed (flagged to the user).

### Verification
`cargo test` (all binaries, 0 failures), `npx tsc --noEmit` (clean), `npm run build` (clean), `npm test` (105 pass). The interactive `npm run tauri dev` GUI smoke of §9 **passed** a manual run across both workstreams — resolve-on-condition (incl. the new prompt-empty case), notice auto-expiry, pause-on-hover/focus, All-projects owner labels, non-reusable exclusion, New-prompt disabled in All, unload dropping a project's reusable prompts, and the unload confirm for an open item and an open prompt.

## 13. Execution Prompt

Paste the block below into a fresh Claude Code session (working directory `notes-app/`) to implement this plan.

```
Implement the plan at plans/plan.9.md. Read it in full first (all 13 sections), then work Section 6 top to bottom.

CONTEXT: This is a local-first Tauri 2 + React 19/TypeScript (Vite) + Rust/SQLite app. The plan covers TWO independent workstreams — (A) toast auto-dismiss lifecycle, frontend-only; (B) reusable prompts across all loaded projects, backend fan-out + UI scope. Land A and B as TWO SEPARATE COMMITS (per Section 10 Q3). Do NOT bundle them.

The three Section 10 decisions are already made (confirmed by the user): Q1 = notices auto-expire at 30s, errors persist; Q2 = foreign reusable prompts stay EDITABLE with an owner label per row + a persistent owner label in PromptEditor's header + owner-named Move/Delete confirmations; Q3 = land A and B as TWO separate commits. Implement these; do not re-ask.

HARD CONSTRAINTS (from Sections 4 and 5, non-negotiable):
- Add NO new npm or cargo dependency (no toast/animation library; the app has no jsdom/RTL — use a framework-free store tested with vi.useFakeTimers() in the node env).
- The frontend never calls invoke() directly — only through src/lib/api.ts. Cross-store merges live in ProjectManager (Rust), never in React (trait boundary; "each repository impl owns its own SQL").
- Prompt fan-out MUST be reusable-only, MUST stamp each merged row with its TRUE owning-project UUID (not the requested target), MUST clone Arcs under the RwLock and release before .await (never hold the lock across await), and MUST keep rejecting an empty-projectId NON-reusable list. All prompt/toast text stays a React text node (no HTML/markdown).
- IPC DTOs mirror src-tauri/src/models.rs <-> src/types.ts (camelCase). No DTO change is needed here (projectId is already optional) — do not add one.
- Additive numbered migrations only; but note this feature needs NO migration (the reusable flag and index already exist).

IMPLEMENTATION:
- Follow Section 6 exactly; create/modify the files in Section 7.
- Update the doc-drift sites in the SAME commit as Workstream B (Section 6 step 16): docs/DESIGN.md:118, the PromptsPage/list_prompts doc-comments, models.rs, types.ts, api.ts.

USE SUBAGENTS during implementation (fallbacks: if a named agent type is unavailable, use `Explore` for read-only analysis, `Plan` for strategy, `general-purpose` otherwise, stating the role in the prompt):
- After each workstream's code is written, spawn a `code-reviewer` agent (read-only: Read, Grep, Glob) to review the diff against Section 11.
- Spawn a `test-writer` agent to write the tests in Section 8: src/lib/toasts.test.ts (Vitest fake timers) for A, and the src-tauri/tests/project_manager.rs cases for B (including REWRITING the now-obsolete `list_prompts_without_a_project_id_is_invalid` test). Prove each test can fail.
- Spawn a `security-auditor` agent (read-only: Read, Grep, Glob) to verify the Section 4 mitigations — especially the true-owner stamp, reusable-only gating, snapshot-under-lock, and text-node rendering.
- Spawn a `frontend-specialist` agent for the toast a11y (per-toast role=alert/status, pause-on-hover/focus-within, no focus theft) and the "All projects" PromptsPage UX.
- Do NOT spawn database-architect/api-designer/devops/performance agents — no schema, REST API, infra, or hot-path work is involved.

AFTER IMPLEMENTATION:
- Run the Section 11 code-review checklist and fix anything it surfaces.
- Document what you did in Section 12 (Post-Review Improvements) and implement any improvements found.
- Run the full verification gate and fix regressions before finishing: `cd src-tauri && cargo test`, then `npx tsc --noEmit`, then `npm run build`. Confirm each is clean and report the results plainly (failing tests/skipped steps are results, not things to smooth over). Then do a `npm run tauri dev` manual smoke of the Section 9 functional criteria.
- Do NOT commit or push unless I explicitly ask.
```

