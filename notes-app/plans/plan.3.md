# Plan 3: Phase 3 — UI (Projects, Tag Filter & Lifecycle, Status/Sort Filters, JIRA Link, Manage Projects, Duplicate Metadata, Save Relocation)

**Created:** 2026-07-14
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Phase 3 of `docs/IMPLEMENTATION_PLAN.md` (lines 69–78) is the **frontend-only** phase that surfaces the Phase 1–2 backend/IPC through the two-pane UI, matching `docs/DESIGN.md` **exactly** (it specifies microcopy verbatim). No schema, no repository logic, no new IPC commands — every backend capability Phase 3 needs already exists and is tested.

Concretely, Phase 3 delivers:
- **Top bar:** a `Manage projects` quiet button between the theme toggle and `API keys`.
- **Left rail:** a `FILTER BY TAG` widget (soft-yellow badges + `+ tag` popup listing active tags, `All tags selected.` empty state), a full-width project select, and a half-width status-filter / sort pair. All filters AND-combined; the tag filter is OR within itself. Released-tag styling (~55% opacity) on done-task rows.
- **Editor:** a `Duplicate metadata` button; a project select; a tags **badge widget** (neutral badges + `EXISTING TAGS` popup + `new tag` input — lowercase, strip `#`, dedupe); a **JIRA row** (mono input + `KEY ↗` chip opening the default browser); released (dashed + dimmed) badge styling on done tasks; and the `Save` button relocated into the AI bar, right of `Rework`.
- **Manage projects dialog:** inline rename, mono `N ITEM(S)` count, `Remove` disabled at count ≥ 1, add row, `Done`.
- **AI bar:** preset chips now **fill** the instruction input (they no longer fire immediately).
- **Tag lifecycle wiring:** finishing the last carrier of a tag (or archiving it) removes it from both popups and drops any selected filter badge, recomputing the list — all in one user action.

Three user decisions were taken at planning time (see §5 and §10):
- **D1 — Duplicate metadata uses a genuine local-only *draft* item** (title truly empty until first Save), not a placeholder title and not a backend change.
- **D2 — vitest (node environment, no jsdom) is added** as a devDependency to unit-test the pure, DOM-free helpers. *(New dependency, flagged and approved.)*
- **D3 — the opener capability is tightened** from `opener:default` to `opener:allow-open-url` (+ a scheme scope if the installed plugin version supports it), in addition to a mandatory app-level open-time URL guard.

**What Phase 3 does NOT touch:** `src/types.ts` (already mirrors every model), the backend, IPC commands, and migrations. `api.ts` already exposes `listProjects`/`createProject`/`renameProject`/`deleteProject`/`listActiveTags` and `searchItems(query, filter?)`. The only non-component edits are `package.json` (vitest) and `capabilities/default.json` (opener scope).

## 2. Strategic Assessment

*(tech-lead agent — verdict: proceed)*

Phase 3 is correctly scoped and unblocked: backend + IPC + tests landed first, so this is genuinely pure-frontend against a tested, greppable IPC seam. Key points that shaped this plan:

- **Phase 3 must FIX a latent bug in `App.tsx`, not extend it.** Today `refresh()` (`App.tsx:25-37`) calls `searchItems(search)` with **no** filter, then re-filters kind **client-side** (`result.filter(i => i.kind === filter)`). Phases 1–2 moved OR-tag matching, status/project filtering, notes-last, and the four sort modes into the repository and tested them there. Re-implementing any of that in JS duplicates backend invariants in the UI (against the CLAUDE.md "invariants live in the repository" rule) and will drift. **Delete client-side filtering entirely; pass one `ListFilter` through both IPC paths.**
- **Riskiest behavior: the derived-tag recompute + filter-badge drop** (DESIGN.md:70, acceptance line 78). It must, in a single user action, (a) bump the item, (b) drop the tag from both `+ tag` popups, (c) drop the selected filter badge if present, (d) recompute the list. The trap: if dropping a badge doesn't feed back into the filter object driving the query, the list won't recompute. Single source of truth + ordering matter here.
- **Filter state must live in `App`, not `ItemList`.** `ItemList` is (correctly) a controlled presentational component; filter state drives the IPC query App owns via `refresh()`. Any filter in `ItemList` local state falls out of sync.
- **Search/list duality: two code paths, one filter.** `searchItems(query, filter?)` and `listItems(filter?)` must receive the *identical* `ListFilter`; route them through one query-builder that chooses list-vs-search only by whether `search.trim()` is non-empty.
- **JIRA open-time safety.** Key extraction is cosmetic; do not trust it for safety. Before invoking the opener, assert the URL parses and is `http`/`https` (and has a non-empty host). Render the chip as a **button** that calls the opener, not an `<a href>` the webview could follow.
- **Editor contract grows.** Tags become a `string[]` (not a comma-string), and `onSave` must carry `projectId`/`jiraUrl`; all new fields join the `useEffect([item.id])` reset and the `edit()` dirty-tracking. Empty-string-clears semantics (`jiraUrl: ""` clears, omitted = unchanged) are where this silently breaks.

Recommendations adopted: refactor App state first (land + smoke it before feature UI so regressions are attributable); reuse the `SettingsDialog` scrim/dialog pattern for Manage projects; no state library or router (prop-drilling from App is the right amount of structure).

## 3. Research Findings

*(architect + frontend-specialist agents, grounded against the actual code)*

### Gap analysis (requirement → today → to build)

| Requirement (DESIGN.md / plan) | Today | To build |
|---|---|---|
| Top bar `Dark/Light` + `Manage projects` + `API keys` | toggle + API keys (`App.tsx:79-87`) | insert `Manage projects` quiet button; `showProjects` state; render dialog |
| Rail `FILTER BY TAG` (soft-yellow badges + `×`, `+ tag` 220px popup of active tags minus selected, `All tags selected.`, **no creation**) | nothing | `TagFilter.tsx` + CSS + click-outside popup |
| Rail project select (`All projects` + names) | nothing | full-width `<select>` in `ItemList`; projects from App |
| Rail status filter (`All statuses`, todo/doing/done) | nothing | half-width `<select>` |
| Rail sort select (`Sort: updated/created/priority/status`) | nothing | half-width `<select>` |
| All filters AND-combined, tag OR-within | backend does it; FE sends only `kind`, client-filters | build real `ListFilter` in `refresh()`; pass to **both** `listItems` and `searchItems`; delete client-side `.filter` (`App.tsx:31-33`) |
| Rail rows: released tag line (~55% opacity) on done tasks | tags always same (`ItemList:107-111`) | `.row-tags-released` when `kind==='task' && status==='done'` |
| Editor `Duplicate metadata` button | nothing | header button → App draft flow (D1) |
| Editor project select | nothing | `<select>` in meta row (incl. an "unassigned" option) |
| Editor tags widget (neutral badges + `×`, `EXISTING TAGS` popup of active tags not on item, `new tag` input lowercase/strip-#/dedupe, Enter adds) | comma-string `<input className="meta-tags">` (`Editor:142-148`) | `EditorTags.tsx` managing `string[]` |
| Editor JIRA row (mono input, `KEY ↗` chip via opener, key = last path segment matching `ABC-123` else `Open ticket ↗`, full URL tooltip) | nothing | `JiraRow.tsx` + `api.openExternal` + `lib/jira.ts` |
| Editor released badge styling on done tasks (dashed + dimmed) | nothing | `released` prop on `EditorTags` |
| Editor Save moves into AI bar, right of `Rework` | Save in header (`Editor:107-109`) | remove from header; render in `AiBar` via `dirty`/`onSave` props |
| Manage projects dialog (inline rename, mono `N ITEM(S)`, `Remove` disabled ≥1, add row, `Done`, `No projects yet.`) | only `SettingsDialog` (pattern) | `ManageProjectsDialog.tsx` mirroring `SettingsDialog` |
| Preset chips FILL instruction input | chips fire immediately (`AiBar:55-64`) | `setCustom(preset)` |

### State architecture (all lifted to `App.tsx`)

`ItemList` and `Editor` stay presentational. New App state:
- `projects: ProjectWithCount[]`, `activeTags: string[]` — single source of truth, fetched once and after every content/project mutation; passed to rail (project select, tag filter), editor (project select, tag vocabulary), and the dialog.
- Filter set replacing the single `filter`: keep `kind: KindFilter`; add `tagFilter: string[]`, `projectFilter: string` (`""` = All), `statusFilter: Status | "all"`, `sort: Sort` (default `"updated"`).
- `draft: Item | null` (D1), `showProjects: boolean`.

`refresh()` builds one `ListFilter` and routes both paths:
```ts
const f: ListFilter = {
  kind: kind === "all" ? undefined : kind,
  projectId: projectFilter || undefined,   // "" (All projects) → undefined
  status: statusFilter === "all" ? undefined : statusFilter,
  tags: tagFilter.length ? tagFilter : undefined,
  sort,
};
const result = search.trim() ? await api.searchItems(search, f) : await api.listItems(f);
setItems(result);
```
The client-side kind re-filter (`App.tsx:31-33`) is deleted.

**Dropped-badge recompute** is declarative, not imperative, and calls the same `recomputeTagFilter` helper that §8 unit-tests (so the tested logic is provably the wired one, not a hand-duplicated copy). Guard the `setTagFilter` so it only fires when the set actually shrank — `activeTags` is a fresh array reference every refresh, so an unconditional `setTagFilter(new array)` would trigger an avoidable extra `refresh()` each cycle:
```ts
useEffect(() => {
  setTagFilter(tf => {
    const next = recomputeTagFilter(tf, activeTags);
    return next.length === tf.length ? tf : next; // same reference when nothing pruned → no extra refresh
  });
}, [activeTags]);
```
Because `tagFilter` is a dependency of `refresh()`, pruning it re-fires the query with the corrected filter — no manual second fetch. This reproduces the whole DESIGN.md:70 lifecycle and the line-78 `#admin` acceptance walk.

**Refresh cascade:** every mutation (`create`, the existing `mutate()` wrapper at `App.tsx:65-72`, project CRUD, duplicate) refreshes `items` + `activeTags` + `projects` together (`Promise.all`). All are cheap local-SQLite round trips; correctness (vocabulary/counts update in the same tick) wins over shaving IPC calls.

**Debounce stays search-only** (`App.tsx:40-43`, 200 ms only when `search` is non-empty). Selects/tag toggles are discrete low-frequency actions — fire immediately (0 ms). Depend on a **stable** derivation of `tagFilter` (e.g. `tagFilter.join(",")`) or a `useMemo`'d filter object, never a fresh object literal in the dep array (infinite-loop footgun).

### Popup / dropdown pattern (dependency-free)

Both popups (`TagFilter` `TAGS`, `EditorTags` `EXISTING TAGS`) share one minimal pattern: `position: absolute` panel under the trigger, conditional render, close on click-outside (single `document` `mousedown` listener checking a wrapping `ref`), `Escape`, and re-toggle. Optional shared `usePopover(ref, onClose)` hook (`src/hooks/usePopover.ts`) since both need byte-identical mechanics — this is the one justified deviation from "no new files"; the alternative is two ~15-line duplicated effects. **Popup stays open after selecting a pill** (so multiple tags can be added in one pass) unless DESIGN's reference prototype says otherwise; closes only on outside-click/Escape/re-toggle. Accessibility: `+ tag` is `aria-haspopup`/`aria-expanded`; each `×` is its own `<button aria-label="Remove tag …">`; pills are `<button>`; the global `:focus-visible { outline: 2px solid var(--ink) }` already covers new controls. On open, move focus into the popover; on Escape, return focus to the trigger.

### The JIRA chip

`openExternal` lives in `api.ts` as the **single sanctioned non-`invoke` exception** (the opener plugin invokes internally; routing it through `api.ts` keeps the IPC/OS surface greppable per CLAUDE.md). The scheme+host re-check lives inside it (§4). Key extraction is a pure function in `src/lib/jira.ts`: parse `new URL(url)`, take the last non-empty `pathname` segment (query/hash already excluded by `pathname`), test an anchored linear pattern `/^[A-Za-z][A-Za-z0-9]*-\d+$/`; match → uppercased segment + ` ↗`; else / parse-throw → `Open ticket ↗`. The chip is a `<button>` (never `<a href>`); its `title` attribute is the full URL.

### Prior art to imitate
- **`SettingsDialog.tsx`** (scrim + `.dialog` + `stopPropagation` + `.dialog-foot` Done; maps rows inline with no per-row sub-component; calls `api.*` directly then a callback) — the template for `ManageProjectsDialog.tsx`. Do not extract a `ProjectRow.tsx` (SettingsDialog doesn't extract `KeyRow.tsx`).
- **`AiBar.tsx`** was already extracted from the editor — precedent for extracting `EditorTags`/`JiraRow`.
- **`Editor.tsx` `edit()`/dirty/`useEffect([item.id])` reset** — every new editable field must join both the initial `useState` and the reset effect.
- **`AiBar.tsx` `onKeyDown Enter`** — the `new tag` "Enter adds" precedent.
- **Existing `.select`, `.chip`, `.pill`, `.dialog*`, `.btn-save`, `--mark*` tokens** — compose, don't reinvent.

### Files (create / modify / verify-only) — see §7.

## 4. Security Considerations

*(security-auditor agent; single-user local desktop app — injection, unsafe-URL, and data-integrity dominate; classic web auth is N/A)*

**No Critical findings.** Backend write-path protections are confirmed present (parameterized SQL, `fts_query()` sanitizer, `jira_url` http(s) allowlist on write, no command returns key material). Phase 3's only genuinely new surface is the **JIRA chip's browser-opener sink**.

- **[High] Open-time scheme re-check is REQUIRED (defense-in-depth), inside the `api.ts` opener wrapper.** The write-path validator (`sqlite.rs` `validate_jira_url`) has a documented empty-authority gap — it accepts `https:///browse/PLAT-1` (recorded in `plan.2.md:223` §12) and admits whitespace/control chars after `://`. It also cannot vouch for data persisted by Phase 0/1 dev builds before the validator existed, or future direct-DB/import/sync writes. **Requirement:** `openExternal(url)` must parse via the browser `URL` constructor, require `url.protocol` ∈ {`http:`,`https:`} **and** a non-empty `url.host` (the host check is what closes the `https:///` gap the Rust side misses), and reject on parse-throw — refusing to call the opener otherwise. The chip's `onClick` also guards on `jiraUrl != null` (the chip only renders while a URL is present).
- **[Medium] React rendering rule for all user-controlled strings** (project names, tags, titles/previews, `jira_url` as value and tooltip, derived ticket key): render only as React text nodes / controlled input `value` / the `title` attribute (React escapes all three). **No `dangerouslySetInnerHTML` anywhere** — grep confirms the codebase has zero today (`notes-app/src` clean). State the rule so the posture doesn't regress. There is no HTML-bearing field in the model.
- **[Low] Ticket-key regex hygiene (ReDoS + correctness):** extract via `new URL(...).pathname` last segment and match an **anchored linear** pattern (`/^[A-Za-z][A-Za-z0-9]*-\d+$/`) — no nested/adjacent unbounded quantifiers, bounded to the (short) last segment. A pathological multi-KB URL cannot drive quadratic matching.
- **[Low] Tooltip shows the full URL** (DESIGN.md:51) via `title` — single-user machine, user's own data, attribute escaped by React. No action beyond the Medium rule (recorded so the verifier doesn't flag it as data exposure).
- **[D3 — tighten] Opener capability scope.** `opener:default` bundles more than URL opening (it includes `allow-default-urls`, which itself restricts opening to `mailto`/`tel`/`https`/`http`, plus open-path / reveal-in-dir style commands); Phase 3 only opens an http(s) URL. The checked-in schema (`src-tauri/gen/schemas/desktop-schema.json`) confirms `opener:allow-open-url` exists and supports the **object form with explicit `allow`/`deny` url-scope entries** — and that the bare identifier enables `open_url` **with no pre-configured scope** (i.e. any scheme). So the swap must be the **scoped object form, not the bare string**, or it would be *broader* than today (any scheme) or fail closed. **Commit to** replacing `opener:default` with the scoped entry:
  ```json
  { "identifier": "opener:allow-open-url", "allow": [{ "url": "https://*" }, { "url": "http://*" }] }
  ```
  Verify the exact object/key syntax against `desktop-schema.json` before writing (the `OpenerScopeEntry` shape), then smoke-test the chip still opens. If — and only if — the installed `@tauri-apps/plugin-opener@^2` turns out to reject scoped entries, fall back to keeping `opener:default` (which already restricts to http/https/mailto/tel) rather than shipping an unscoped `opener:allow-open-url`. The app-level `URL`+host guard (High) remains the stronger control regardless. This is the ONLY capability change — the new commands need no capability entry.
- **[Info] No new *runtime* dependency.** `@tauri-apps/plugin-opener` and React 19 are already present; the popups/dialogs use plain DOM. The only added dependency is **vitest (devDependency, D2)** — a build-time test tool, flagged and approved. Assert "no new runtime dependency" as a success criterion.
- **[Info] Popups introduce no new sink** — they render derived strings as text and call already-validated commands (`create_project`/`rename_project`/`list_active_tags`). Backend guards stay authoritative (the disabled `Remove` button is presentation; the repository refuses regardless — DESIGN.md:74). Tag normalization is cosmetic, not a security control.

## 5. Design

### Approach
Lift all filter/projects/vocabulary/draft state to `App.tsx`; keep `ItemList`/`Editor` presentational. Build one `ListFilter` in `refresh()` for both IPC paths and delete client-side filtering. Reproduce the tag lifecycle with a declarative prune effect on `activeTags`. Extract four small components (`TagFilter`, `EditorTags`, `JiraRow`, `ManageProjectsDialog`) plus pure helpers in `src/lib` (unit-tested with vitest). Route the opener through `api.ts` with an open-time guard. Match DESIGN.md microcopy verbatim. Compose CSS from existing tokens only; never re-theme a constant accent.

### Architecture
- **`App.tsx`** — expanded state, rewritten `refresh()`, prune effect, cascade refresh, `draft` + duplicate/new handlers, top-bar `Manage projects` button, `ManageProjectsDialog` render.
- **`ItemList.tsx`** — `<TagFilter>`, project/status/sort selects, released row-tag class; props widen.
- **`Editor.tsx`** — draft-aware save/create, `Duplicate metadata`, project select, `<EditorTags>` replacing the comma input, `<JiraRow>`, Save relocated into `AiBar`; `onSave` patch widens to `projectId`/`jiraUrl`; reset effect + `edit()` gain the new fields.
- **`AiBar.tsx`** — presets fill the instruction input; renders the yellow Save button (`dirty`/`onSave` props) right of `Rework`.
- **New components:** `TagFilter.tsx`, `EditorTags.tsx`, `JiraRow.tsx`, `ManageProjectsDialog.tsx`.
- **New pure libs (vitest-covered):** `src/lib/tags.ts` (`normalizeTag`, `addTag`, `recomputeTagFilter`), `src/lib/jira.ts` (`ticketLabel`, `isHttpUrl`), `src/lib/draft.ts` (`newDraft`, `duplicateDraft`). Plus `src/hooks/usePopover.ts` (shared; see §3 — both popups need identical dismiss mechanics, so extract rather than duplicate).
- **`api.ts`** — `openExternal`.
- **`styles.css`** — new classes (below).
- **`package.json`** — vitest devDep + `"test": "vitest run"`; **`capabilities/default.json`** — opener scope.

### Key Decisions

**D1 — Duplicate metadata uses a genuine local-only *draft* item (user decision).** A draft is an `Item`-shaped object held in `App.draft` with an empty `id` sentinel (`""`), empty `title`/`body`, copied `kind`/`status`/`priority`/`projectId`/`tags`, `jiraUrl: null`, `pinned: false`, `archived: false`, and placeholder timestamps (unused by the editor). `selected = draft ?? items.find(i => i.id === selectedId)`. The editor learns it is editing a draft (via an `isDraft`/`onCreate` prop) and on Save calls `createItem(payload)` instead of `updateItem`; on success App clears `draft`, selects the returned real id, and refreshes.
- **D1b — drafts need a per-instance React key (fixes a reset-effect collision).** Because every draft shares `id === ""`, keying `<Editor>` on the id (`key={draft ? "draft" : selected.id}`) would give *all* drafts the same key `"draft"` — so switching from one draft to another (e.g. Duplicate A, then without saving click New task or Duplicate B) would NOT remount `Editor`, and the `useEffect([item.id])` reset (`Editor.tsx:35-43`) would not re-fire, leaving the first draft's stale title/body/status/priority/tags on screen. **Fix:** App holds a monotonically increasing `draftSeq` counter, incremented on every `newDraft`/`duplicateDraft`; render `key={draft ? \`draft-${draftSeq}\` : selected.id}` so each draft remounts cleanly. (The counter also serves as the reset trigger — no reliance on `id`.)
- **D1c — draft ↔ rail interaction (resolve explicitly).** Selecting any rail row **clears** `draft` (so `selected` resolves to the clicked persisted item — otherwise `draft ?? …` would swallow the click and appear to do nothing). Clicking `New note`/`New task`/`Duplicate metadata` while a draft is already open **replaces** the draft (and bumps `draftSeq`); an unsaved draft is discarded silently (it was never persisted). Wire this in the row-select handler and the create/duplicate handlers. This satisfies DESIGN's literal "empty title and body … then selects it, dirty" without weakening the backend `title must not be empty` invariant (`sqlite.rs:174-177`, CONFIRMED) — Save is simply blocked until a title is typed (matching the existing `Editor.tsx:46-49` guard). `Duplicate metadata` explicitly copies from the **persisted `item`**, never the dirty draft, and never the JIRA link (DESIGN.md:65).
- *Recommended sub-decision (D1a): route `New note`/`New task` through the same draft mechanism.* This removes the current "Untitled note" placeholder hack (`App.tsx:50-63`), unifies the create path (one code path, no special-casing), avoids junk placeholder rows when a user creates then navigates away, and matches DESIGN's "create a note to start." It is a small behavior change to an existing flow; if the reviewer/user prefers to minimize churn, keep `New note`/`New task` as-is (immediate create with placeholder) and use the draft **only** for `Duplicate metadata`. Either is internally consistent; the plan implements D1a (unified) and calls it out so it can be reverted cheaply.

**D2 — vitest (node env, no jsdom) for pure helpers (user decision).** `vitest.config.ts` with `test.environment: "node"`; `"test": "vitest run"` in `package.json`. Unit tests cover `recomputeTagFilter`, `normalizeTag`/`addTag`, `ticketLabel`, `isHttpUrl`, `newDraft`/`duplicateDraft` — all pure, no DOM, no Tauri mocks. **No jsdom, no @testing-library, no component rendering** (out of scope; would be a larger infra adoption). The manual smoke walk (§8) remains the acceptance mechanism for UI behavior.

**D3 — tighten opener capability + open-time guard (user decision).** See §4. Verify the identifier against the shipped schema before editing; smoke-test after.

**D4 — `openExternal` in `api.ts` is the sole non-`invoke` exception**, with the scheme+host guard inside it. Preserves the greppable-surface convention and gives one choke point for the security re-check.

**D5 — two tag components, not one shared `TagPicker`.** They share a "badges + popup" shape but differ in badge color (soft-yellow filter vs neutral editor), popup label (`TAGS` vs `EXISTING TAGS`), empty state, and creation (filter has none; editor has the `new tag` input). One component would need ~5 behavior/label props and become a config blob (against "minimum code"). Share only the `usePopover` mechanics.

**D6 — `create_project` returns `Project` (no count); a new project is count 0.** `ManageProjectsDialog` refetches `listProjects()` after add (or synthesizes `itemCount: 0`) — no contract change (matches `plan.2.md` D5).

**D7 — `ListFilter.projectId` vs `UpdateItem.projectId` have OPPOSITE empty-string semantics.** On `UpdateItem`, `""` clears the assignment; on `ListFilter`, `""` must **never** be sent (`""` → omit the field = "no filter"). The rail select uses `""` as its "All projects" sentinel, so the `projectFilter || undefined` coercion at the `refresh()` call site is load-bearing. Do **not** reuse a shared "empty clears" helper across both contexts.

**D8 — released styling has two distinct renderings; do not conflate.** Rows: the whole `.row-tags` mono line drops to ~55% opacity, **no** dashed border (rows have no badge borders). Editor: individual badges get **both** dashed border **and** ~55% opacity. `.row-tags-released` (opacity only) vs `.tag-badge-released` (dashed + dimmed). The released style is **presentation only** — done-task tags must still be removable via `×` (DESIGN.md:70).
- **D8a — the visual `released` trigger is `kind==='task' && status==='done'` ONLY (deliberate, documented simplification vs the lifecycle definition).** DESIGN.md:70 defines an *active reference* as one whose item is "neither a done task **nor archived**," so the tag **vocabulary/filter-badge** lifecycle (§Overview, prune effect) correctly releases on done **and** archive. But the *visual* released style is only ever reachable for done tasks: archived items are excluded from the default list (CLAUDE.md) — so they never render a row — and archiving the currently-open item drops it from `items`, making `selected` resolve to `null` and the editor revert to its empty state, so an archived item's editor badges are never on screen either. Extending the visual condition to `item.archived` would therefore be dead code. Keep the visual trigger to done-tasks; keep the vocabulary/badge-drop logic on both done and archive.

**D9 — tag normalization is 100% frontend-owned.** `sqlite.rs create`/`update` store `tags` verbatim (no lowercasing/`#`-strip/dedupe); `list_active_tags` does `SELECT DISTINCT`, so `Platform` and `platform` become two vocabulary entries. `EditorTags`'s `new tag` input is the **only** place normalization can happen (`normalizeTag`: trim → lowercase → strip leading `#` → reject empty; `addTag`: dedupe against current tags). The rail `TagFilter` never normalizes (it only picks from already-clean `activeTags`).

**D10 — notes carry project/tags/JIRA too.** The project select, tags widget, and JIRA row render for **both** kinds. Only status/priority stay behind the existing `item.kind === 'task'` guard. (Guarding the new controls by kind is a likely copy-paste bug — call it out.)

## 6. Implementation Steps

Land steps 1–4 (state refactor + tooling + guards) and smoke them **before** the feature UI, so any regression is attributable (tech-lead recommendation).

1. **Add vitest (D2).** `npm i -D vitest` (flag the dependency — approved). Add `vitest.config.ts` (`test: { environment: "node" }`) and `"test": "vitest run"` to `package.json` scripts. Confirm `npm test` runs (zero tests initially is fine).
2. **Pure helpers + their unit tests (`src/lib`).**
   - `tags.ts`: `normalizeTag(raw): string`, `addTag(tags: string[], raw: string): string[]` (normalize + dedupe, ignore empty), `recomputeTagFilter(selected: string[], vocab: string[]): string[]`.
   - `jira.ts`: `isHttpUrl(url: string): boolean` (URL parse, protocol ∈ {http,https}, non-empty host), `ticketLabel(url: string): string` (anchored regex, `KEY ↗` / `Open ticket ↗`, try/catch fallback).
   - `draft.ts`: `newDraft(kind): Item`, `duplicateDraft(source: Item): Item` (copies kind/status/priority/projectId/tags; empty title/body; `jiraUrl: null`; unpinned; id `""`).
   - Write `*.test.ts` alongside each per §8; run `npm test` green.
3. **`api.ts` — `openExternal(url)` (D4).** `import { openUrl } from "@tauri-apps/plugin-opener";` with a one-line comment marking it the sanctioned non-`invoke` touchpoint. Reject via `isHttpUrl` before calling `openUrl`; return a rejected promise otherwise. (`types.ts` unchanged — verify only.)
4. **Tighten opener capability (D3).** Replace `opener:default` in `capabilities/default.json` with the **scoped** `opener:allow-open-url` object form (`allow` = `https://*`, `http://*`) — verify the exact `OpenerScopeEntry` syntax against `src-tauri/gen/schemas/desktop-schema.json` first. Rebuild; smoke that the chip still opens (§8). Fallback only if the installed plugin rejects scoped entries: keep `opener:default` (already http/https/mailto/tel-restricted) rather than an unscoped `allow-open-url`. Keep the change minimal and reversible.
5. **`App.tsx` state refactor.** Replace the single `filter` with `kind` + `tagFilter` + `projectFilter` + `statusFilter` + `sort`; add `projects`, `activeTags`, `draft`, `showProjects`. Rewrite `refresh()` to build one `ListFilter` (D7 coercion) and route both `listItems`/`searchItems`; delete the client-side kind filter. Add the prune effect (`recomputeTagFilter` on `activeTags` change). Make `create`/`mutate`/project-CRUD/duplicate refresh `items`+`activeTags`+`projects` together. Fix the debounce dep array to use a stable `tagFilter` derivation. Add `newDraft`/`duplicateDraft` handlers and `selected = draft ?? …`. Smoke: existing list/search/kind-filter still work through the new path.
6. **Top bar (`App.tsx`).** Insert the `Manage projects` quiet button between the theme toggle and `API keys`; render `<ManageProjectsDialog>` when `showProjects`, wiring an `onChanged` callback to the cascade refresh.
7. **`ManageProjectsDialog.tsx`** (mirror `SettingsDialog`): heading `Manage projects`; the verbatim muted note (DESIGN.md:80) `Rename a project inline. A project can be removed only when no notes or tasks are assigned to it.`; load `listProjects()` on mount; per-row inline rename input + mono `N ITEM(S)` count (singular/plural branch: `1 ITEM` / `3 ITEMS`) + danger-outline `Remove` disabled at `itemCount >= 1`; add row (`New project name` placeholder + `Add project`, Enter adds); right-aligned `Done`; `No projects yet.` empty state. On any mutation call `api.*` then `onChanged()`. Surface backend errors (duplicate/blocked-remove) via `onError` (the repository refuses regardless — DESIGN.md:74).
8. **`ItemList.tsx`.** Widen `Props`. Match DESIGN.md:38-44 header-block order exactly: New note/task → search → **`FILTER BY TAG` (`<TagFilter>`)** → kind chips (`All`/`Notes`/`Tasks`) → full-width project `<select>` (`All projects` + names) → half-width status/sort pair. (Note: `TagFilter` sits **before** the kind chips, not after — the current file renders search then chips.) Add `.row-tags-released` on done-task rows (D8). Keep the component presentational (all state via props/handlers).
9. **`TagFilter.tsx`** (D5): mono `FILTER BY TAG` label, soft-yellow selected badges each with a `×` button, dashed `+ tag` button opening a 220px `TAGS` popup listing `activeTags` minus selected; `All tags selected.` empty state; **no creation**. `usePopover` for dismiss.
10. **`Editor.tsx`.** Add draft-awareness (`isDraft` → `onCreate` vs `onSave`); add `Duplicate metadata` button in the header; add a project `<select>` in the meta row whose first option is `No project` (value `""` → sends `projectId: ""` to clear the assignment), then all project names; replace `.meta-tags` with `<EditorTags>`; add `<JiraRow>` directly under the meta row; **remove Save from the header** and pass `dirty`/`save` to `<AiBar>`. Widen the `onSave` patch type to include `projectId`/`jiraUrl` and send them (empty string clears `jiraUrl`; `projectId: ""` clears assignment). Add `projectId`/`jiraUrl` (and `EditorTags` state) to the initial `useState` **and** the `useEffect([item.id])` reset, each routed through `edit()`. Render project/tags/JIRA for both kinds (D10); keep status/priority task-only.
11. **`EditorTags.tsx`** (D5, D9): neutral badges each with `×`; `+ tag` opens an `EXISTING TAGS` popup listing active tags **not already on the item**; a bottom `new tag` input + `Add` (Enter adds; `normalizeTag` + `addTag` dedupe). `released` prop → dashed + dimmed badges (still removable). `usePopover` for dismiss.
12. **`JiraRow.tsx`.** Mono `JIRA` label + bg-field mono input (placeholder `Paste JIRA ticket URL (empty removes)`, max-width ~420px); while a URL is present, a `<button className="jira-chip">` labeled via `ticketLabel(url)`, `title={url}`, `onClick={() => void api.openExternal(url).catch(onError)}`. Typing/clearing marks dirty via the editor's `edit()`.
13. **`AiBar.tsx`.** Change presets to `setCustom(preset)` (fill, do not fire); re-check `busy`-disabling (presets need not be disabled while merely filling text). Add `dirty`/`onSave` props and render the yellow `.btn-save` button (`Save` when dirty, `Saved` half-opacity disabled otherwise) right of `Rework`.
14. **`usePopover.ts`** (shared hook): `(ref, onClose)` wiring a single `document` `mousedown` outside-click + `Escape` listener, and the focus management (§3: move focus into the popover on open, return focus to the trigger on Escape). Used by `TagFilter` and `EditorTags` — extract it so both popups share identical mechanics rather than duplicating the effect.
15. **`styles.css`.** Add classes composing existing tokens only (no re-theming yellow/danger/status dots): `.tagfilter`, `.tag-badge-filter` (soft-yellow), `.tag-add` (dashed `+ tag`), `.tag-badge` (neutral editor) + `.tag-badge-released` (dashed + `.55` opacity), `.row-tags-released` (`.55` opacity, no border), `.popover` + `.popover-tagfilter{width:220px}`, `.popover-label` (reuse `.meta-kind` if identical), `.popover-empty`, `.popover-new-tag`, `.jira-row`/`.jira-input`/`.jira-chip`, `.rail-select{width:100%}` + `.rail-select-pair{display:flex;gap:8px}` (children `flex:1`), `.project-row`/`.project-add-row` (mirror `.keyrow`/`.keyrow-form`). Reuse `.btn-save` as-is for the relocated Save. Verify the dashed released-badge border uses `var(--line)` (neutral, theme-swapped) — the dark-mode invariant is about the **yellow review card**, not neutral elements.
16. **Run the full verification block (§9)** and fix failures; perform the manual smoke walk (§8).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/App.tsx` | Modify | Lifted filter/projects/activeTags/draft state; `refresh()` single-`ListFilter`; prune effect; cascade refresh; `Manage projects` button + dialog; new/duplicate draft handlers |
| `src/components/ItemList.tsx` | Modify | `TagFilter`, project/status/sort selects, released row-tag class; props widen |
| `src/components/Editor.tsx` | Modify | Draft-aware save/create, `Duplicate metadata`, project select, `EditorTags`, `JiraRow`, Save relocation, `onSave` widened, reset effect + `edit()` gain new fields |
| `src/components/AiBar.tsx` | Modify | Presets fill input; render relocated Save (`dirty`/`onSave` props) |
| `src/components/TagFilter.tsx` | Create | Rail `FILTER BY TAG` widget + `TAGS` popup |
| `src/components/EditorTags.tsx` | Create | Editor tags badge widget + `EXISTING TAGS` popup + `new tag` input |
| `src/components/JiraRow.tsx` | Create | JIRA input + link chip |
| `src/components/ManageProjectsDialog.tsx` | Create | Manage projects dialog (rename, count, guarded Remove, add) |
| `src/lib/api.ts` | Modify | `openExternal(url)` with open-time http(s)+host guard |
| `src/lib/tags.ts` | Create | `normalizeTag`, `addTag`, `recomputeTagFilter` (pure) |
| `src/lib/jira.ts` | Create | `isHttpUrl`, `ticketLabel` (pure) |
| `src/lib/draft.ts` | Create | `newDraft`, `duplicateDraft` (pure) |
| `src/lib/*.test.ts` | Create | vitest unit tests for the pure helpers |
| `src/hooks/usePopover.ts` | Create | Shared click-outside/Escape dismiss + focus management for both popups |
| `src/styles.css` | Modify | New classes (tokens only; both themes) |
| `vitest.config.ts` | Create | vitest node-env config |
| `package.json` | Modify | vitest devDep + `test` script |
| `src-tauri/capabilities/default.json` | Modify | Tighten `opener:default` → `opener:allow-open-url` (+ scope if supported) |
| `src/types.ts` | Verify only | Already mirrors every model — no change |

## 8. Test Strategy

*(test-writer agent. Confirmed: no frontend test infra exists today — `package.json` had no vitest/jest/testing-library; Phase 1/2 deliberately declined it. Backend invariants are already covered by `src-tauri/tests/repo.rs`. D2 adds vitest for PURE HELPERS ONLY.)*

- [ ] **Unit (vitest, node env) — pure helpers:**
  - `recomputeTagFilter`: all-dropped → `[]`; none-dropped → unchanged set; partial drop keeps only survivors; re-added tag reappears; order/stability sane. *(This is the acceptance-line-78 logic — highest value.)*
  - `ticketLabel`: `…/browse/PLAT-142` → `PLAT-142 ↗`; trailing slash; query/hash after key; lowercase key → uppercased; no path segment → `Open ticket ↗`; key-like-but-invalid segment → fallback; unparseable string → fallback (no throw).
  - `isHttpUrl`: `http`/`https` with host → true; `javascript:`/`file:`/`data:` → false; `https:///path` (empty host) → **false** (closes the write-path gap); uppercase scheme `HTTPS://h/x` → true; unparseable → false.
  - `normalizeTag`/`addTag`: `#Foo` → `foo`; whitespace trimmed; empty rejected; adding an existing tag (case/hash variant) is a no-op (dedupe).
  - `newDraft`/`duplicateDraft`: duplicate copies kind/status/priority/projectId/tags, empties title/body, drops jiraUrl, unpins; tags array is a copy (not shared reference).
  - **Non-vacuous check:** temporarily break one branch (e.g. make `isHttpUrl` always-true) and confirm the relevant test goes red, then revert.
- [ ] **Type/build (must stay green):** `npx tsc --noEmit` (strict, `noUnusedLocals`); `npm run build`; `npm test`.
- [ ] **Manual smoke (`npm run tauri dev`) — Phase-3 acceptance (line 78), walking DESIGN.md "Reference sample state" §82–97.** Run against a fresh DB.
  - **Setup:** Manage projects → add `Platform Migration`, `Q3 Planning`, `Admin`, `Sandbox`. Create the 5 reference items (item 5 `File expense report`/Admin/`#admin` initially **todo**; item 2 with JIRA `https://acme.atlassian.net/browse/PLAT-142`, doing, high; item 1 pinned). Verify list order, pin diamond, status dots, `high` in danger, previews, hairlines.
  - **Tag lifecycle (the named criterion, exercised live):** open FILTER BY TAG `+ tag` → pills `platform, migration, planning, work, admin`; select `admin` → list narrows to item 5. Set item 5 → `done`, Save. Verify **all four** fire together: (a) item 5 editor badge released (dashed+dim) but still `×`-removable; (b) item 5 row tag line at ~55% opacity; (c) the `admin` filter badge is **gone** and the list recomputes to the full set (not zero results); (d) `admin` absent from both popups. Reopen (→ todo) → `admin` reappears in both popups. Repeat once with **archive** instead of done (archive also releases).
  - **Project guard:** counts exactly `Platform Migration 2 ITEMS`, `Q3 Planning 2 ITEMS`, `Admin 1 ITEM`, `Sandbox 0 ITEMS`; `Remove` disabled on the first three, enabled on Sandbox; remove Sandbox succeeds. **Backend-refuses check:** in devtools, `window.__TAURI__.core.invoke('delete_project', { id: '<platform-migration-id>' })` → rejected with a readable "project still has N items assigned", not raw sqlx, not silent success.
  - **JIRA chip:** item 2 chip reads `PLAT-142 ↗`; hover tooltip = full URL; click opens the OS default browser to that URL. Change URL to a non-key last segment → `Open ticket ↗`, still opens. Clear the input, Save → chip disappears; reselect the item → field persists cleared.
  - **Filters:** `Tasks` + project `Platform Migration` + status `doing` → only item 2 (3-way AND). Clear; select tag badges `platform` **and** `planning` → items 1,2,3,4 (OR-within-tag), item 5 excluded.
  - **Sort (all four modes reorder the list):** with the reference set, switch `Sort: updated` → `created` → `priority` → `status` and confirm the order changes correctly each time — pinned item 1 stays first under every mode; `priority` orders high→normal→low with notes last; `status` orders doing→todo→done with notes last (DESIGN.md:44,61).
  - **Draft ↔ rail (D1b/D1c):** `Duplicate metadata` on item 5, then WITHOUT saving click `Duplicate metadata` on item 2 (or `New task`) → the editor shows the **second** draft's copied values, not item 5's stale ones (proves the per-`draftSeq` key remounts). Then click a persisted rail row → the draft is discarded and the clicked item loads.
  - **Presets / Duplicate / draft / dark:** clicking a preset **fills** the instruction input and fires nothing (no busy). `Duplicate metadata` on item 5 → a **draft** selected in the editor, dirty, empty title/body, kind/status/priority/project/tags copied, JIRA empty; Save is blocked until a title is typed; duplicating pinned item 1 → the draft is **unpinned**. New note/task (D1a) → empty-title draft that persists on first Save and does **not** leave a junk row if abandoned. **Ctrl+S** saves from anywhere in the editor after Save relocated into the AI bar (window listener, `Editor.tsx:64-73`). Toggle dark mode → review card yellow, Save yellow, pin diamond, status dots pixel-identical; all new widgets render in dark neutrals.
  - **Popover focus (a11y):** opening a `+ tag` popup moves focus into the popover (first pill / `new tag` input); pressing `Escape` closes it and returns focus to the `+ tag` trigger (not `<body>`). Check both the rail and editor popups.
  - **Project rename happy-path (live propagation):** in Manage projects, rename a project that has items assigned → the rail project select, the editor project select, and any visible row/label reflect the new name immediately (the cascade refresh ran), with no reload.
- [ ] **Edge cases & error scenarios (manual):**
  - Empty states: `All tags selected.` (select every remaining active tag); list `Nothing here yet — create your first note.`; `No projects yet.` on a fresh DB.
  - Duplicate/rename project name (exact + after-trim) → clean `AppError::Invalid` via toast, no duplicate row, no silent no-op.
  - **Dirty-state on EVERY field:** title, body, status, priority, tag add/remove, **project select**, **JIRA input** — each flips `Saved`→`Save`. Extra scrutiny on the two wholly-new controls.
  - Tag input: `#Foo` stored `foo`; adding `Platform` when `platform` exists → no dup; Enter adds.
  - JIRA scheme reject reaching the UI: paste `javascript:`/`file:` and Save → Phase-2 backend `AppError::Invalid` surfaces via toast (not unhandled rejection); and the open-time guard refuses to open a bad stored URL.
  - Notes carry project/tags/JIRA (D10); status/priority still hidden for notes (regression check).
  - Sandbox (0-item) project selectable in the editor's project dropdown.
- [ ] **Regression:** `cd src-tauri && cargo test` still green (Phase 3 is frontend-only; confirm nothing regressed).

**Not runnable headless:** the `npm run tauri dev` walk (default-browser open, pixel/dark-mode checks) must be run by a human interactively — consistent with `plan.2.md`'s note.

## 9. Success Criteria

- [ ] **Functional:** rail tag filter (OR), project/status filters, and sort all drive the list via one `ListFilter` on both list and search paths; the tag lifecycle drop/restore (done + archive) removes the tag from both popups and drops the filter badge in one action; released styling on done tasks (row line dimmed; editor badges dashed+dimmed, still removable); Manage projects rename/count/guarded-Remove/add work and the backend refuses removal regardless; JIRA chip extracts the key and opens the default browser; `Duplicate metadata` (and New note/task per D1a) open an empty-title draft that persists on first Save without a placeholder row; presets fill the instruction input; Save lives in the AI bar; notes carry project/tags/JIRA.
- [ ] **Tests:** all §8 vitest unit tests pass; the non-vacuous check was verified red; `npm test`, `tsc --noEmit`, `npm run build` clean; `cargo test` unregressed.
- [ ] **Security:** open-time `URL`+scheme+**host** guard in `openExternal`; no `dangerouslySetInnerHTML`; anchored linear ticket-key regex; `opener:default` tightened to `opener:allow-open-url` (+scope if supported) and verified against the schema; no new runtime dependency.
- [ ] **Quality:** DESIGN.md microcopy matched verbatim; CSS composes from existing tokens, both themes correct, no constant accent re-themed; `ItemList`/`Editor` stay presentational; every new `invoke`/opener call confined to `api.ts`; `types.ts` unchanged.

Verification block:
```
cd notes-app
npm test                    # vitest — pure helpers
npx tsc --noEmit            # strict, noUnusedLocals
npm run build               # production bundle clean
cd src-tauri && cargo test  # confirm frontend-only change didn't regress backend
npm run tauri dev           # manual walk of DESIGN.md §82–97 (human, interactive)
```

## 10. Risks & Open Questions

**Verified claim driving a plan decision:**
- **CONFIRMED — "Duplicate metadata's DESIGN.md 'empty title' conflicts with the backend `title must not be empty` invariant, and the frontend has no draft-item concept."** Verified by direct read: `sqlite.rs:174-177` (`AppError::Invalid("title must not be empty")`), `Editor.tsx:46-49` (client-side block), and `App.tsx` holds only API-returned `Item[]`. **User decision (D1): build a genuine local-only draft item** so title is truly empty until first Save (Save blocked until typed) — no backend change, no placeholder.
- The security-auditor's "`validate_jira_url` accepts `https:///`" claim is not disputed — it is already documented as accepted in `plan.2.md:223` (§12 item 2), which explicitly named the Phase-3 open-time re-check as the backstop. The `isHttpUrl` host check (§4/§8) closes it at the sink.

**Risks:**
- **Tag-lifecycle recompute timing** — the one acceptance-critical, easy-to-break piece. Mitigated by the declarative prune effect (single source of truth), the `recomputeTagFilter` unit test, and the live step-by-step smoke of the `#admin` transition (done **and** archive).
- **D7 projectId semantics collision** — `""` clears on `UpdateItem` but must be omitted on `ListFilter`. Mitigated by the `projectFilter || undefined` coercion and an explicit no-shared-helper note.
- **Save relocation regressing dirty semantics / Ctrl+S** — move the `Save`/`Saved`/disabled logic intact into `AiBar`; Ctrl+S is a `window` listener (`Editor.tsx:64-73`) independent of button location — verify it still fires.
- **Draft mechanism scope (D1a)** — unifying New note/task with drafts changes an existing flow; called out as reversible if the reviewer prefers minimal churn (use draft only for Duplicate).
- **Opener capability identifier (D3)** — the exact `opener:allow-open-url` id and scheme-scope support must be verified against `src-tauri/gen/schemas/desktop-schema.json` for the installed `^2` version **before** editing; smoke that the chip still opens after tightening (a wrong id breaks opening at runtime, not compile time).
- **Popup positioning/clipping** — popups live in non-scrolling regions (rail header, editor meta row), so `.list`'s `overflow-y` shouldn't clip them; confirm visually once built. DESIGN.md is authoritative, but the reference prototype (`docs/reference/Worknotes_dc.html`) may clarify exact popup spacing/close-on-select behavior if a pixel question arises.

**Open questions (decide at implementation, non-blocking):**
- **Q1 — Does selecting a pill close the popup?** DESIGN.md doesn't specify. Default: stay open (multi-add), close on outside-click/Escape/re-toggle. Confirm against the prototype.
- **Q2 — Editor `EXISTING TAGS` popup width** isn't specified (only the rail's 220px is). Default: size to content or a modest fixed width; don't hardcode 220px.
- **Q3 — D1a (unify New note/task with drafts)** vs. keeping them as immediate-create. Plan implements the unified draft; reviewer may opt to scope drafts to Duplicate only.

## 11. Code Review Checklist
After implementation, verify:
- [ ] No dead code or unused imports (`noUnusedLocals` is on); no leftover client-side kind filter in `App.tsx`
- [ ] Error handling covers failure modes (duplicate/rename project name, blocked Remove, JIRA scheme reject, empty-title Save block) — surfaced via the existing toast, never a raw rejection
- [ ] No security issues: `openExternal` guards scheme **and** host; chip is a `<button>` not `<a href>`; no `dangerouslySetInnerHTML`; anchored linear ticket-key regex; opener capability tightened + verified
- [ ] Security considerations from §4 addressed (open-time guard, rendering rule, capability scope, no new runtime dep)
- [ ] Follows conventions: presentational `ItemList`/`Editor`; every `invoke`/opener call only in `api.ts`; function components + inline `interface Props`; CSS classes (no inline styles); sentence-case copy except mono UPPERCASE labels; `SettingsDialog` pattern reused for the dialog
- [ ] Tests cover the pure helpers (esp. `recomputeTagFilter`, `isHttpUrl` host case); non-vacuous check done; `types.ts` confirmed unchanged
- [ ] No performance regressions: filter-state lift has the same blast radius as today's `filter`/`search`; debounce stays search-only; `useMemo` for per-popup derived vocabulary; stable dep arrays (no object-literal loop)
- [ ] Minimal changes — no unrelated refactoring; released styling is presentation-only (tags still removable); constant accents (yellow/danger/status dots) not re-themed; dark-mode review card unchanged
- [ ] DESIGN.md microcopy matched verbatim (button labels, empty states, `N ITEM`/`N ITEMS` plural, `Open ticket ↗` fallback, `All tags selected.`, `Save`/`Saved`)

## 12. Post-Review Improvements

Implemented after the code-review, security-audit, and test-writer passes.

1. **[Critical — fixed] A rejected save no longer falsely reports `Saved`.** `App.mutate()` swallowed backend errors (toast only) and always resolved, so `Editor.save()`'s unconditional `setDirty(false)` cleared dirty even when the update rejected — most reachable via the new JIRA field (backend `validate_jira_url` rejects non-http(s) schemes). Fix: `mutate()` and `createFromDraft()` now return a success `boolean`; `Editor.save()` clears dirty only on a confirmed persist, so a rejected save stays `Save` (dirty) for retry. This makes §8's JIRA-scheme-reject edge case and §11's "dirty-state on every field" check pass on the *outcome*, not merely "the call was made." (Pre-existing behavior the JIRA field newly exposed; fixing it was in-scope for the Phase-3 acceptance criteria.)

2. **[Warning — fixed] A fresh draft starts dirty.** DESIGN.md:65 ("then selects it, dirty") and §8's Duplicate acceptance require the draft's Save button to read `Save` (enabled) immediately. `Editor` now initializes `dirty` to `isDraft` and the `[item.id, isDraft]` reset effect sets `setDirty(isDraft)`, so Duplicate/New note/New task shows the enabled yellow `Save` at once. Save is still blocked until a title is typed via the existing `title.trim()` guard (toast), so the backend `title must not be empty` invariant is untouched.

3. **[Decision record] The `isHttpUrl` host check is documented defense-in-depth, not the `https:///` gap-closer §4 claimed.** Empirically (WHATWG `URL`, verified in Node and applicable to WebView2), for the allowed `http`/`https` special schemes `new URL()` never yields an empty host: `https:///browse/PLAT-1` parses to host `browse` (a harmless bogus-host https URL, which the OS browser simply fails to resolve — never a dangerous scheme), while a genuinely empty authority like `https://` *throws* and is rejected. So the `host !== ""` branch does not reject any parseable http(s) URL and does not close the write-path `https:///` gap the way §4 stated. **Decision: keep the host check** — it satisfies the §9 "URL+scheme+host guard" success criterion, is harmless, and stays robust if the webview's URL parser ever differs from Node's. The **load-bearing** control is the protocol allow-list (`{http:,https:}`), which rejects `javascript:`/`file:`/`data:`. The `jira.ts` comment and the `isHttpUrl` unit test were corrected to assert the actual behavior (`https:///path` → `true`) rather than the spec's mistaken assumption.

4. **[Note] Editor `EXISTING TAGS` empty-state copy.** DESIGN.md specifies only the rail's `All tags selected.` verbatim; the editor popup's empty state was unspecified (plan §10 Q2). Chose `No other tags yet.` (sentence case, consistent voice). Intentional new copy, flagged for the record.

Verification after these changes: `npx tsc --noEmit` clean, `npm run build` clean, `npm test` 32/32, `cargo test` 47/47.

## 13. Execution Prompt

```
Implement Phase 3 (UI) of the worknotes app, following the plan at
notes-app/plans/plan.3.md. Read that plan file in full first — it is the authoritative
spec for this work, together with docs/DESIGN.md (which wins on all UI/microcopy) and
docs/IMPLEMENTATION_PLAN.md lines 69–78. Note the design decisions D1–D10 and the resolved
user decisions: D1 (Duplicate metadata uses a genuine local-only DRAFT item — title truly
empty until first Save, no backend change, no placeholder; D1a: New note/New task are
unified onto the same draft mechanism, reversible if you prefer minimal churn), D2 (vitest
node-env is added as a devDependency for pure-helper unit tests), and D3 (tighten the opener
capability to opener:allow-open-url + scope if supported, AND add an app-level open-time
URL guard).

Project root: notes-app/. Standard verification lives in notes-app/CLAUDE.md.

CONTEXT: Phases 0–2 are already implemented. The backend, all IPC commands, src/lib/api.ts
(listProjects/createProject/renameProject/deleteProject/listActiveTags and
searchItems(query, filter?)), and src/types.ts are complete. Phase 3 is PURELY frontend
(React components + CSS), with two non-component edits: package.json (vitest) and
src-tauri/capabilities/default.json (opener scope). Do NOT touch src/types.ts, the
repository, IPC commands, or migrations. Every invoke/opener call must stay inside
src/lib/api.ts (CLAUDE.md invariant).

Implement the plan step by step, following Section 6 (Implementation Steps) in order. Land
steps 1–4 (vitest tooling, pure helpers + tests, api.ts openExternal guard, capability
tightening) and step 5 (App.tsx state refactor) and smoke them BEFORE building the feature
UI, so any regression is attributable. Key correctness points to honor:
  - Build ONE ListFilter in refresh() and pass it to BOTH listItems and searchItems; delete
    the client-side kind filter (App.tsx:31-33). Respect D7: ListFilter.projectId "" means
    "no filter" (omit), while UpdateItem.projectId "" means "clear assignment" — do NOT share
    an "empty clears" helper across the two.
  - Reproduce the tag lifecycle declaratively: a useEffect prunes tagFilter against the fresh
    activeTags (recomputeTagFilter); because tagFilter drives refresh(), pruning re-fires the
    query. Refresh items + activeTags + projects together after every content/project
    mutation and on done/archive.
  - openExternal(url) must URL-parse and require scheme ∈ {http,https} AND a non-empty host
    (the host check closes the https:/// gap the Rust validator misses); the chip is a
    <button>, never <a href>. Verify the opener permission identifier and scope support
    against src-tauri/gen/schemas/desktop-schema.json BEFORE editing default.json, then smoke
    that the chip still opens.
  - Tag normalization is 100% frontend-owned (D9): normalizeTag lowercases, strips a leading
    #, trims, rejects empty; addTag dedupes. The rail filter never normalizes.
  - Released styling is presentation only (D8): rows dim the whole tag line (opacity, no
    border); editor badges get dashed border + dim; both stay removable. Do not conflate.
  - Project/tags/JIRA render for BOTH kinds (D10); only status/priority stay task-gated.
  - Match DESIGN.md microcopy verbatim (Save/Saved, Open ticket ↗, All tags selected.,
    1 ITEM/3 ITEMS plural, empty states). Presets FILL the instruction input, do not fire.
  - Save relocates into the AI bar with its dirty/Saved logic intact; verify Ctrl+S still
    works (window listener, Editor.tsx:64-73).

Use subagents during implementation (if a named agent type is unavailable, fall back to a
generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise
— with the role stated in the prompt):
  - Spawn a frontend-specialist agent to build/review the component tree, the popup pattern
    (click-outside/Escape/focus), and the CSS (token-only, both themes, no re-themed accent),
    per Sections 3 and 5.
  - Spawn a test-writer agent to write the vitest unit tests for the pure helpers per
    Section 8 (recomputeTagFilter, ticketLabel, isHttpUrl incl. the https:/// host case,
    normalizeTag/addTag, newDraft/duplicateDraft) and prove one test red against a broken
    branch before trusting it. Do NOT add jsdom/@testing-library or component-rendering tests.
  - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify Section 4 in the
    actual diff: the open-time scheme+host guard, no dangerouslySetInnerHTML, the anchored
    linear ticket-key regex, the tightened opener capability, and "no new runtime dependency."
  - Spawn a code-reviewer agent (read-only: Read, Grep, Glob) on the full diff against the
    Section 11 checklist — especially "no client-side filtering left," "every invoke/opener
    only in api.ts," "types.ts unchanged," and verbatim microcopy.
  - No database-architect / api-designer / devops agent needed (no schema, no IPC, no infra).

After implementation:
  - Run the Section 11 Code Review Checklist and address every item.
  - Document any improvements in Section 12 of the plan file and implement them.
  - Run the full verification block and fix regressions before finishing:
        cd notes-app
        npm test                     # vitest pure helpers
        npx tsc --noEmit
        npm run build
        cd src-tauri && cargo test   # confirm frontend-only change didn't regress backend
    then a manual `npm run tauri dev` walk of DESIGN.md §82–97 per Section 8: the #admin
    tag-lifecycle transition (done AND archive), the project removal guard (incl. the
    devtools delete_project refusal), the JIRA chip opening the default browser, filters
    AND-combining with tag-OR, presets filling, the Duplicate/New draft flow, and dark mode.

Do not start Phase 4. Stop when Phase 3's Section 9 success criteria are met and all
tests/builds pass.
```
