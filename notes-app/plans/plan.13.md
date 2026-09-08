# Plan 13: Project scratch pad, "send selection to…", and AI rework on a text selection

**Created:** 2026-08-30
**Status:** Draft
**Planning Mode:** Subagent-Enhanced (tech-lead, architect, security-auditor, test-writer, frontend-specialist, database-architect, adversarial-verifier, code-reviewer)

## 1. Overview

Two user-requested features for `worknotes`, planned together and delivered in three separable phases:

1. **AI rework on a text selection** (Phase 1, frontend only, zero Rust). In any body textarea — item Editor, PromptEditor, and the new scratch pad — a non-empty selection at the moment Rework fires sends **only the selected text** to the existing `ai_rewrite_stream` command. The review card is labelled `Proposed rewrite (selection)`, the R1 title proposal is skipped (a title from a fragment is wrong), and `Replace text` **splices** the proposal into the recorded range — guarded so a body edited under a pending proposal can never be corrupted. The backend prompt is unchanged: `REWRITE_SYSTEM_PROMPT` already reads "You will receive **a piece of** the user's own writing" ([ai/mod.rs:89](../src-tauri/src/ai/mod.rs#L89)).

2. **Project scratch pad** (Phases 2–3). One permanent, title-less, always-present note per project, stored as a new canonical git-tracked file `scratch.md` at the project root (plain UTF-8, no frontmatter, absent == empty), exposed through two Tauri commands and surfaced as a third page tab **Scratch** beside Worknotes/Prompts. Right-clicking a non-empty selection in the pad opens a React-rendered context menu — `New note from selection` / `New task from selection` / `New prompt from selection` — each of which opens a **pre-filled, unsaved draft** targeting the pad's own project (copy, not cut; nothing is created until the user's explicit Save).

Why together: the scratch pad is a body textarea, so it inherits selection-rework for free if Phase 1 lands first on a shared pure module (`src/lib/selection.ts`); shipping the pad first would produce a third bespoke rework surface and a retrofit.

Why it matters: whole-document rework is the wrong granularity for editing a long note, and a per-project capture inbox that can promote fragments into real notes/tasks/prompts closes the loop the app is built around.

## 2. Strategic Assessment

_(tech-lead)_

**Verdict: proceed, ordered Phase 1 → 2 → 3, as separable commits.** The two features share a noun ("selection") but have a ~6:1 complexity ratio and opposite risk profiles; the dependency runs *scratch pad needs selection rework*, not the other way round. Shipping rework-on-selection first (two frontend files + one pure module, verifiable with `git status --short -- src-tauri` empty) means the pad reuses it instead of triplicating it.

Decisions the tech lead drove:

- **Storage:** `scratch.md` at the project root, raw text, no frontmatter, no `schema_version`. Two hard rejections, both data-loss paths, not trade-offs: a field in `project.json` (`write_identity_file` at [projects/mod.rs:962](../src-tauri/src/projects/mod.rs#L962) serializes a fresh two-field `ProjectIdentity` and **overwrites the whole file on every rename** — an older build renaming would silently erase the pad), and a row in `index.db` (git-ignored, so absent in every clone; not a compatibility surface; deleted by Delete files and "at will" per `CLAUDE.md` — see §10 for why "destroyed on Reload" is *not* the reason). **Never add a `kind: scratch`**: `parse_kind` ([itemfile.rs:491](../src-tauri/src/store/itemfile.rs#L491)) is a closed enum, so the file would be `Malformed` and silently skipped on every load — exactly the failure `CLAUDE.md` § "On-disk backward compatibility" warns about.
- **Copy, not cut; draft, not immediate create.** The app has no undo. Cut + a discardable draft is a silent data-loss combination. Immediate create would fire an AI title call on right-click (`resolveTitleForSave`, [Editor.tsx:223](../src/components/Editor.tsx#L223)) and mint a store row without an explicit action.
- **Backend AI prompt: no change.** Branching the system prompt would create a second prompt to maintain with no eval harness. The whole feature is "what text goes into `text`, and where the answer lands."
- **Skip R1 for selection reworks** — a fragment rework is an editing operation, not re-authoring. This amends `docs/DESIGN.md:79` ("A successful rework also proposes a title").
- **Riskiest part:** the splice onto a body edited mid-stream — the only path that silently corrupts an *already-saved* note (no undo, no item version history). Second: `remove_store_files` forgetting `scratch.md` (the plan.7 H3 data-remanence bug again).
- **Explicit Save, not autosave** for the pad (autosave would be the app's only autosaving surface and races Reload/unload).

Strategic question the tech lead asked, recorded for the owner (§10): *what does the scratch pad need that a designated pinned note cannot do?* This plan proceeds on the request as written ("permanent note attached to each project": no title, no list row, always present) — the answer that justifies a dedicated file.

## 3. Research Findings

### 3.1 Codebase facts (architect, verified)

- **Greenfield:** zero matches for `onContextMenu|contextmenu|selectionStart|selectionEnd|getSelection|setSelectionRange` under `src/`. The closest reusable helper is [usePopover.ts](../src/hooks/usePopover.ts) (outside-mousedown + Escape + focus-in + focus-return-to-trigger).
- **Rework flow today:** [Editor.tsx:302-370](../src/components/Editor.tsx#L302) `rework()` streams `text: body` via `api.aiRewriteStream`, accumulates into `proposal`, then runs the R1 title call ([Editor.tsx:349-369](../src/components/Editor.tsx#L349)). `Replace text` ([Editor.tsx:604-608](../src/components/Editor.tsx#L604)) does `edit(setBody)(proposal); save({ body: proposal })` — whole-body assignment. The body `<textarea>` ([Editor.tsx:650-655](../src/components/Editor.tsx#L650)) has **no ref** and is **not disabled while streaming**. [PromptEditor.tsx:238-290](../src/components/PromptEditor.tsx#L238) is a near-verbatim copy minus the title half; its `Replace text` ([PromptEditor.tsx:425-429](../src/components/PromptEditor.tsx#L425)) tags the version `source: "aiEnhanced"`.
- **Empty-text guard + keyed toasts:** `rework()` guards `!body.trim()` with the resolvable key `editor-no-text` ([Editor.tsx:303-306](../src/components/Editor.tsx#L303)); the resolve-on-condition effect watches `body` ([Editor.tsx:157-161](../src/components/Editor.tsx#L157)). Toasts are two-tier via `useToasts` (transient one-arg; keyed + `onResolve(key)`).
- **Drafts:** `newDraft(kind, projectId)` ([draft.ts:14](../src/lib/draft.ts#L14)) has no body seed; `App.openNewDraft(kind)` ([App.tsx:320-327](../src/App.tsx#L320)) seeds the target from the rail filter via `resolveCreateTarget`; `createFromDraft` ([App.tsx:335-353](../src/App.tsx#L335)) promotes the draft tab on first Save. `PromptsPage.tsx` has a **private** `newDraft(projectId)` ([PromptsPage.tsx:55-68](../src/components/PromptsPage.tsx#L55)) and its own `openNewDraft()` ([PromptsPage.tsx:263-268](../src/components/PromptsPage.tsx#L263)).
- **Cross-page one-shot signal:** `promptReloadSignal: { projectId, n } | null` ([App.tsx:133-134](../src/App.tsx#L133)) consumed by a `useEffect` in [PromptsPage.tsx:129-139](../src/components/PromptsPage.tsx#L129). `onOpenPromptsChange` ([App.tsx:128](../src/App.tsx#L128), [App.tsx:674](../src/App.tsx#L674)) reports open prompt tabs up for the unload confirm. These are the exact shapes to copy for the scratch page and the prompt-draft seed.
- **Page tablist:** `type Page = "worknotes" | "prompts"` ([App.tsx:58](../src/App.tsx#L58)); `onPageTabKeyDown` ([App.tsx:499-507](../src/App.tsx#L499)) hardcodes a **two-way toggle** and element ids `tab-worknotes`/`tab-prompts`; page bodies are always mounted with `hidden` ([App.tsx:660-676](../src/App.tsx#L660)).
- **Tabs:** [openTabs.ts](../src/lib/openTabs.ts) is generic over `Tab<T>` and treats keys as opaque; [EditorTabs.tsx](../src/components/EditorTabs.tsx) requires `onNew: () => void` and `newLabel` (line 26); PromptsPage keys prompt tabs `prompt-…` and drafts `prompt-draft-<seq>`.
- **Ctrl+S:** every mounted editor registers a window listener gated on `active` ([PromptEditor.tsx:226-236](../src/components/PromptEditor.tsx#L226)); a third page must fold `pageActive` into `active` the same way or Ctrl+S fires N times.
- **Storage layout:** `IDENTITY_FILE = "project.json"` ([projects/mod.rs:62](../src-tauri/src/projects/mod.rs#L62)); `GITIGNORE` constant ([projects/mod.rs:76](../src-tauri/src/projects/mod.rs#L76)); `project_dir(id)` ([projects/mod.rs:436-444](../src-tauri/src/projects/mod.rs#L436)) resolves from the catalog with **no loaded check**; `is_loaded` (~line 745); `remove_store_files` ([projects/mod.rs:1159-1182](../src-tauri/src/projects/mod.rs#L1159)) sweeps an explicit closed list (`index.db*`, `project.db*`, `.bak`, `project.json`, `items.tmp/`, `items/`, `prompts/`, and the `.gitignore` **only when byte-equal** to `GITIGNORE`/`LEGACY_GITIGNORE`). `store_exists_in` (~914-919) must NOT learn about `scratch.md`. Load scans only `items/` and `prompts/` (`rebuild_from_dir`, [sqlite.rs:336](../src-tauri/src/db/sqlite.rs#L336)), so a root-level file is invisible to every existing build.
- **Atomic writes:** `itemfile::write_item` ([itemfile.rs:290-300](../src-tauri/src/store/itemfile.rs#L290)) is temp-then-rename but derives the filename via `file_name` (UUID-only stem); `promptfile::write_atomic` ([promptfile.rs:282](../src-tauri/src/store/promptfile.rs#L282)) is **private**. Neither is reusable for a root file. `itemfile::read_capped` ([itemfile.rs:272](../src-tauri/src/store/itemfile.rs#L272)) is `pub(crate)`, path-based, TOCTOU-safe, and reusable; `MAX_ITEM_FILE_BYTES = 4 * 1024 * 1024` ([itemfile.rs:34](../src-tauri/src/store/itemfile.rs#L34)).
- **Commands:** [commands.rs](../src-tauri/src/commands.rs) one-line delegations to `state.manager`; registered in `generate_handler!` in [lib.rs:54-92](../src-tauri/src/lib.rs#L54) (last entry `commands::get_jira_ticket`). `AppError` serializes to its `Display` string ([error.rs:39-46](../src-tauri/src/error.rs#L39)); callers do `String(err)`.
- **Tests:** vitest is `environment: "node"`, `include: ["src/**/*.test.ts"]` — **no jsdom, no RTL, no component tests anywhere**. Rust: `tests/project_manager.rs` (`new_manager()`, `create_project()`, `STORE_ENTRIES`/`move_store_files`, `remove_*_retrying`), `tests/on_disk_compat.rs` (append-only goldens in `tests/fixtures/v1_0_0/`, `fixture_files_are_lf_only` walks the whole tree), inline `#[cfg(test)]` in `store/*.rs`. AI is mocked via trait fakes (`ai_title.rs`, `streaming.rs`), never HTTP.

### 3.2 Storage recommendation (database-architect)

Option (a) — **`scratch.md` at the project root** — is the only design that is additive, git-portable, survives an index rebuild, and touches no item invariant.

| Option | Verdict | Rule broken |
|---|---|---|
| (a) `scratch.md`, raw UTF-8, no frontmatter | **Adopt** | none — older builds never enumerate the project root |
| (b) frontmatter + `updated_at` | Reject | speculative field; a third canonical format; `updated_at` line conflicts on every two-branch edit, undercutting git-mergeability |
| (c) reserved item under `items/` | Reject | `kind` fixed; older builds list it as a normal note and drop the marker on save; every list/search/FTS/tag predicate needs a special case |
| (d) field in `project.json` | **Reject — data loss** | `rename` overwrites the file; a merge conflict inside the JSON string breaks `read_identity` → `open_store` mints a fresh UUID |
| (e) `index.db` `meta` row | **Reject** | `CLAUDE.md`: `index.db` is git-ignored (a clone has none), not a compat surface, removed by Delete files and deletable at will. NOT because reload wipes it — `rebuild_from_dir` clears only `items`/`prompts`/`prompt_versions` and `open_store` reuses an existing `index.db` (verifier, §10). Also: `KNOWN_TABLES` ([sqlite.rs:40-49](../src-tauri/src/db/sqlite.rs#L40)) is an exact allowlist, so a new *table* would make older builds reject the store as foreign |

Specifics adopted: verbatim bytes (no newline normalisation, no trailing newline added); strip a leading BOM on read, never write one; **empty body → delete the file** (one on-disk representation of "empty"); temp file `.scratch.md.tmp` beside the target, no fsync (matches items); **cap on write AND read** at `MAX_ITEM_FILE_BYTES` (a divergence from items, because a pad has no skip semantics — an over-cap file that read back as empty would be overwritten by the next save); missing file → `""`; invalid UTF-8 / over cap / other IO → **hard error, never empty**; git conflict markers → surface the raw text (a single always-present document has no siblings to protect; rejecting bricks the pad); `create_project` creates nothing (lazy, like `prompts/`); `reload`/`rename`/`unload`/`forget`/Stage-1 upgrade need no change; **no migration, no `CURRENT_SCHEMA_VERSION` bump, no `GITIGNORE` change**; add `tests/fixtures/v1_0_0/scratch.md` (not a `v1_1_0/` — there is no new format version). Commands: `get_scratch(projectId) -> String`, `set_scratch(projectId, body) -> ()` — no DTO, so `models.rs`/`types.ts` are untouched.

### 3.3 UI recommendation (frontend-specialist, architect)

- **Third page tab "Scratch"**, not a tab in the item strip: App's tab state is `OpenTabsState<Item>`; a scratch tab would need a fake `Item` (colliding with the `id === ""` draft sentinel used in ~5 places) or a discriminated-union rewrite across ~15 call sites of the app's least-tested file. Rejected as an anti-pattern. A collapsible panel has no precedent in the app.
- **Shape the page on `PromptsPage`:** a rail listing loaded projects, the shared `EditorTabs`, `OpenTabsState<ScratchDoc>` keyed `scratch-<projectId>`, N mounted-hidden `ScratchEditor`s so an in-flight rework survives a tab switch, the same `loaded`-driven and `reloadSignal`-driven tab-close effects, and `onOpenScratchChange` for the unload confirm.
- **Context menu:** capture `selectionStart/End` on `onContextMenu` (they persist across blur; the highlight does not); `preventDefault()` **only when the selection is non-empty** — otherwise let WebView2's native Cut/Copy/Paste menu through (it is the field's only paste path). `position: fixed` at clamped `clientX/clientY` via a `useLayoutEffect` measure; `role="menu"`/`menuitem` with roving ArrowUp/Down/Home/End (mirror [EditorTabs.tsx:69-93](../src/components/EditorTabs.tsx#L69), vertical); dismissal via `usePopover` (wrapper = the menu, trigger = the textarea so Escape returns focus there); after an action, `textarea.focus(); setSelectionRange(start, end)`. Shift+F10 / the ContextMenu key fire a native `contextmenu` event in Chromium, so the same handler covers keyboard. Reuse `.popover` surface tokens; flat, hairline, no shadow, no icons. Position via the React `style` prop (CSSOM) so the strict CSP is untouched.
- **Selection-rework UX:** track the range into a **ref** via `onSelect`/`onKeyUp`/`onMouseUp`, derive one same-value-gated `selectionLength` state for the AiBar; AiBar label flips `Rework with` → `Rework selection with` with a muted `N characters selected` and a quiet `Whole text` override button (the tech lead's "make the implicit mode visible and overridable" trap); clear the range on any manual body edit; eagerly disable `Replace text` with a `title` when the range goes stale, and re-validate on click; after the splice, `setSelectionRange` over the inserted text.
- **Send-to:** body pre-filled, **title left empty** (items: R4 auto-title on Save already produces a better title than a truncation heuristic; prompts: `displayTitle` derives a label). Cross-page hop for prompts uses a one-shot `seed: { projectId, body, n } | null` prop on `PromptsPage`, shaped exactly like `reloadSignal`.
- **Dissent recorded:** the frontend specialist preferred debounced autosave and a single project `<select>` instead of tabs. Overruled (2:1, and for consistency with every other editor, dirty/close/unload/reload machinery reuse, and recoverability — the pad has no version history). See §5 Key Decisions D3.

## 4. Security Considerations

_(security-auditor; severity-ranked; no Critical findings; no new dependency, capability grant, CSP change, SQL surface, or HTML sink is introduced)_

**High**

- **H1 — Loaded gate.** `project_dir()` ([projects/mod.rs:436-439](../src-tauri/src/projects/mod.rs#L436)) resolves an UNLOADED project's directory. Both scratch commands must reject with the existing copy `"that project isn't loaded"` via `is_loaded` before touching the path, matching `create`/`create_prompt`/`rename`. (Gate **both** get and set — the user's mental model of an unloaded project is "closed".)
- **H2 — Symlink at a fixed, guessable, git-carried name.** `read_capped` uses bare `File::open`; `fs::write` follows a symlink at the temp path. `scratch.md` is the first canonical file with a constant name, and git carries symlinks (mode 120000) into a cloned project. Mitigation: `symlink_metadata()` on both `scratch.md` and `.scratch.md.tmp`; reject `is_symlink()` with a fixed generic error; add a `project_manager.rs` test that plants a symlink and asserts read AND write refuse.
- **H3 — Data remanence on Delete files.** `remove_store_files` is an explicit closed list; `scratch.md` and `.scratch.md.tmp` at the root have no umbrella directory. Add both to the sweep (ignore-error `let _ =` form, matching `IDENTITY_FILE`/`STAGE1_BACKUP`), with a test asserting both are gone.
- **H4 — Splice only inside `Replace text`, and refuse a stale range.** The textarea is not disabled while streaming; background tabs keep streaming. Capture `{start, end, text}` at request time; on accept require `body.slice(start, end) === text` or refuse; never splice on stream completion. A React-controlled body replacement also destroys the native undo stack, so a wrong splice is not Ctrl+Z-recoverable.

**Medium**

- **M1 — Size cap on the IPC payload.** `set_scratch` is the first command whose whole payload is one unbounded string written verbatim. Enforce `MAX_ITEM_FILE_BYTES` server-side before writing (`AppError::Invalid`, no path echoed); read through `read_capped`.
- **M2 — Conflict-marker policy.** Decided: surface raw text (see §3.2). The plan must state it so the item precedent (reject) is not silently assumed.
- **M3 — Non-UTF-8 / error hygiene.** Map every read failure to one fixed generic message; never `unwrap`; never echo a path, project name, or `io::Error` Display (house rule per [paths.rs:13-17](../src-tauri/src/projects/paths.rs#L13), `save_file_error` in sqlite.rs). A failed read must **lock** the pad (no editor, no Save) — never render an empty textarea that the first Save would persist over the real file.
- **M4 — Temp-file leftover.** A crash between `fs::write` and `rename` leaves `.scratch.md.tmp` holding the full pad text, unlisted in `.gitignore`. Mitigation: sweep it in `remove_store_files`; the next successful write truncates it (self-healing). **Do not** add it to the `GITIGNORE` constant — see D10.
- **M5 — `scratch.md` is committed.** Correct per the canonical-file rule, but the pad is where pasted credentials/PII land. Add one line of UI copy in the Scratch rail: the pad is saved into the project folder and committed with it.
- **M6 — Fourth compatibility-surface file.** Declare "plain UTF-8, no frontmatter, body verbatim, missing == empty" an invariant in `CLAUDE.md`; add the `v1_0_0/scratch.md` golden; never retrofit frontmatter. `scratch.md` must live at the project **root** — inside `items/` it would be parsed as a malformed item on every load.
- **M7 — Vendor egress shrinks, not grows.** Send the selected substring as the only `text`; do not add surrounding context "to help the model"; no webview `fetch`.

**Low**

- **L1** — No new npm package, crate, or `capabilities/default.json` entry; app-defined commands need no capability. A capability-file edit in the diff is a design change.
- **L2** — Menu labels are static strings; any selection preview is a JSX text child; position via the `style` prop; verify the custom menu suppresses the WebView2 menu in a **release** build, and never relax the CSP to make it position.
- **L3** — Send-to must reuse the existing create-target rules: pre-fill `projectId` with the pad's owner; the menu action issues **no** IPC write.
- **L4** — `Forget` deliberately leaves `scratch.md` on disk; Forget copy must not imply otherwise.
- **L5** — Fixed generic messages for the two commands, exactly: read → `"couldn't read the scratch pad"` / `"the scratch pad is too large to open (limit 4 MB)"`; write → `"couldn't save the scratch pad"` / `"the scratch pad is too large to save (limit 4 MB)"`; both → `"that project isn't loaded"`.
- **L6** — Prompt injection via pasted content: same class as plan.5 L; no "apply automatically" affordance.

OWASP mapping: A01 → H1; A03 → none added (filename is a compile-time constant, never derived from input); A04 → H4/M2; A05 → L1/L2; A08 → H4/M4/M6.

## 5. Design

### Approach

Three separable commits, each independently verifiable:

- **Phase 1 — Rework on selection** (frontend only). A pure `src/lib/selection.ts` (captured-range validation, staleness check, guarded splice) with vitest coverage; `Editor.tsx` and `PromptEditor.tsx` consume it; `AiBar.tsx` gains an optional selection indicator + override. Verified by `npx vitest run`, `npx tsc --noEmit`, `npm run build`, and `git status --short -- src-tauri` being empty.
- **Phase 2 — Scratch storage** (Rust only). `store/scratchfile.rs`, two `ProjectManager` methods, two commands, the `remove_store_files` sweep, `project_manager.rs` + `on_disk_compat.rs` tests, and the golden fixture. Verified by `cargo test` alone.
- **Phase 3 — Scratch page + send-to** (frontend). `api.ts` wrappers, `ScratchPage`/`ScratchEditor`/`SelectionMenu`, the third page tab, seeded drafts, the PromptsPage seed prop, CSS, DESIGN.md.

### Architecture

```
Rust
  store/scratchfile.rs      read(dir)->String | write(dir, body) | remove(dir)      (temp+rename, cap, BOM strip, symlink reject)
  projects/mod.rs           get_scratch(id) / set_scratch(id, body)   (is_loaded gate → catalog path → scratchfile)
                            remove_store_files(+ scratch.md, .scratch.md.tmp)
  commands.rs / lib.rs      get_scratch, set_scratch registered

Frontend
  lib/api.ts                getScratch(projectId): Promise<string>; setScratch(projectId, body): Promise<void>
  lib/selection.ts          captureSelection · isSelectionStale · spliceProposal        (pure, vitest)
  lib/draft.ts              newDraft(kind, projectId, body = "")
  components/AiBar.tsx      + selectionLength?, onClearSelection?  → "Rework selection with · N characters selected · [Whole text]"
  components/Editor.tsx     bodyRef · selRef · selectionRework · guarded Replace text · skip R1 on selection
  components/PromptEditor.tsx  same, minus the title half
  components/SelectionMenu.tsx role=menu · fixed+clamped · usePopover dismissal · 3 items
  components/ScratchEditor.tsx AiBar + review card + body textarea + SelectionMenu (title-less)
  components/ScratchPage.tsx   rail of loaded projects · EditorTabs (no "+") · OpenTabsState<ScratchDoc> · N mounted editors
  App.tsx                   Page = "worknotes"|"prompts"|"scratch" · ordered tablist walk · sendSelectionToItem/Prompt
  components/PromptsPage.tsx   + seed: {projectId, body, n} | null → seeded draft tab
```

Data flow for send-to: `ScratchEditor` (right-click, selection) → `SelectionMenu` item → `ScratchPage.onSendTo(dest, projectId, text)` → App: note/task → `openNewDraft(kind, projectId, text)` + `setPage("worknotes")`; prompt → `setPromptSeed({projectId, body: text, n})` + `setPage("prompts")` → `PromptsPage` effect opens a dirty draft tab seeded with `body`. Persistence happens only on the destination's Save through the existing `createItem`/`createPrompt` paths.

### Key Decisions

- **D1 — Storage = `scratch.md` at the project root, raw text.** Rationale in §3.2. New `store/scratchfile.rs` rather than reusing the `itemfile`/`promptfile` writers. Neither is usable *today* for a non-UUID root file (`write_item` requires a UUID stem; `write_atomic` is private) — but `promptfile::write_atomic` ([promptfile.rs:282](../src-tauri/src/store/promptfile.rs#L282)) is already generic over `(dir, name, contents)` and *could* be widened to `pub(crate)`. A dedicated module is **chosen**, not forced, because the scratch write has semantics a raw writer lacks (write-side size cap, delete-on-empty, symlink refusal on target and tmp, BOM strip on read) and its own error type, and because it leaves the two golden-tested modules untouched. Promoting a shared `store::write_atomic` is a separate refactor.
- **D2 — UI = third page "Scratch", `PromptsPage`-shaped.** Zero churn on the item-tab machinery; reuses `openTabs.ts`, `EditorTabs`, dirty dot, close-dirty prompt, unload/reload sweeps. Cost: one extra click from notes, and `onPageTabKeyDown` becomes an ordered walk.
- **D3 — Explicit Save via `AiBar`, not autosave.** Every other editor saves explicitly; the pad has no version history (a bad save is final); the dirty flag feeds the unload/reload confirms; autosave would race the Reload sweep. Frontend-specialist dissent recorded.
- **D4 — Stale-range policy = guarded splice, refuse on mismatch.** No fuzzy re-find (ambiguous on repeated text — silently splices where the user didn't look), no fall-back to whole-body replace (destroys unrelated text). `Replace text` is disabled with a title while stale and re-validated on click.
- **D5 — Copy, not cut; draft, not create; title empty.** §2. An optional "remove from pad on the destination's successful Save" is deferred (couples two tab lifecycles across a page boundary).
- **D6 — Backend AI unchanged; R1 skipped for selection reworks; R4 (empty-title on Save) untouched.** `DESIGN.md:79` amended.
- **D7 — Selection mode is visible and overridable.** Label + count + `Whole text` in the AiBar; the mode is decided at request time from the ref, never from live DOM in the click handler. Whitespace-only selections count as no selection.
- **D8 — Context menu shows only for a non-empty selection**; otherwise the native menu is left alone. `usePopover` is reused unchanged for dismissal/focus (no new hook); clamping and roving keys live in `SelectionMenu`. The "Rework selection…" menu entry in item/prompt editors is **out of scope** (the AiBar path satisfies the request); noted in §10. **Superseded by plan 16 (D8′):** the React menu is gone; the native WebView2 menu always shows and carries the app's items as native additions injected from Rust.
- **D9 — Scratch commands gate on `is_loaded` (both), cap at `MAX_ITEM_FILE_BYTES` on write and read, delete on empty, strip BOM, reject symlinks, surface conflict markers raw, fixed generic errors.** A failed `getScratch` opens **no tab** (toast only) so nothing can be saved over an unreadable file.
- **D10 — Do not modify the `GITIGNORE` constant.** `remove_store_files` and `refresh_gitignore` recognise the app-generated `.gitignore` by exact string equality; changing the constant would make Delete files stop removing `.gitignore` files written by the shipped 1.1.0 (whose constant is byte-identical to HEAD — verifier). `scratch.md` is canonical and must be tracked anyway; `.scratch.md.tmp` is swept in `remove_store_files` instead. (If the constant ever *must* change, the code already models the safe path: add the current string as a second legacy constant beside `LEGACY_GITIGNORE` and compare against all three.)
- **D11 — No migration, no `CURRENT_SCHEMA_VERSION` bump, no `store_exists_in` change, no `models.rs`/`types.ts` change.**
- **D12 — `CLAUDE.md` § compat surface gains `scratch.md`.** It is the project's own instruction file; the list would otherwise go stale the moment this ships. Flagged for the owner.
- **D13 — No jsdom/RTL harness.** UI behaviour is a manual smoke checklist, per the boundary plan.12 §8 established.

## 6. Implementation Steps

### Phase 1 — Rework on a text selection (frontend only; `git status --short -- src-tauri` must stay empty)

1. **Create `src/lib/selection.ts`** (pure; header comment "Pure, unit-testable … No React, no IPC"):
   - `export interface SelectionRange { start: number; end: number }`
   - `export interface CapturedSelection extends SelectionRange { text: string }`
   - `captureSelection(range: SelectionRange | null, body: string): CapturedSelection | null` — null when `range` is null, `start >= end`, out of `[0, body.length]`, or `body.slice(start, end).trim() === ""`; otherwise `{ start, end, text: body.slice(start, end) }`.
   - `isSelectionStale(body: string, sel: CapturedSelection): boolean` — `body.slice(sel.start, sel.end) !== sel.text`.
   - `spliceProposal(body: string, sel: CapturedSelection, proposal: string): { ok: true; body: string; caret: SelectionRange } | { ok: false; reason: "stale" }` — refuses when stale; otherwise `body.slice(0, start) + proposal + body.slice(end)` and `caret = { start, end: start + proposal.length }`.
2. **Create `src/lib/selection.test.ts`** per §8 (including the RED-evidence companion showing an unguarded slice mis-splices on stale input).
3. **`src/components/AiBar.tsx`:** add optional props `selectionLength?: number` and `onClearSelection?: () => void`. When `selectionLength` is a positive number: the label at [AiBar.tsx:73](../src/components/AiBar.tsx#L73) reads `Rework selection with`; after the Rework button render `<span className="aibar-note">{selectionLength} characters selected</span>` and `<button className="btn btn-quiet" onClick={onClearSelection}>Whole text</button>`. All existing callers unchanged (props optional).
4. **`src/components/Editor.tsx`:**
   - Add `const bodyRef = useRef<HTMLTextAreaElement>(null)`, `const selRef = useRef<SelectionRange | null>(null)`, `const [selectionLength, setSelectionLength] = useState(0)`, `const [selectionRework, setSelectionRework] = useState<CapturedSelection | null>(null)`, `const pendingCaretRef = useRef<SelectionRange | null>(null)`.
   - `function trackSelection()` reads `bodyRef.current.selectionStart/End`, stores `{start,end}` (or null when collapsed) in `selRef`, and calls `setSelectionLength` **only when the derived length changed** (`captureSelection(selRef.current, body)?.text.length ?? 0`). Bind to the textarea's `onSelect`, `onKeyUp`, `onMouseUp`. `function clearSelection()` nulls `selRef`, sets length 0, and collapses the visible highlight to the caret: `const ta = bodyRef.current; if (ta) { const pos = ta.selectionEnd; ta.setSelectionRange(pos, pos); }`; pass as `onClearSelection`. (It does not touch `selectionRework` — a proposal already in flight keeps its captured range.)
   - Textarea `onChange`: keep `edit(setBody)(e.target.value)` and additionally call `clearSelection()` (a manual edit invalidates offsets; React's `onChange` does not fire for programmatic `setBody`, so the splice does not clear itself).
   - `rework()`: `const sel = captureSelection(selRef.current, body); const text = sel ? sel.text : body;` guard `!text.trim()` with the existing `editor-no-text` toast; `setSelectionRework(sel)`; send `text` in `aiRewriteStream`. After `finalText` settles: **if `sel` is non-null, skip the R1 block** ([Editor.tsx:349-369](../src/components/Editor.tsx#L349)) — `setStreaming(false); setAiBusy(false); if (stopRef.current === stop) stopRef.current = null; return;`.
   - Review card head ([Editor.tsx:592-599](../src/components/Editor.tsx#L592)): third label `Proposed rewrite (selection)` when `selectionRework !== null`; update `aria-label` and the `sr-only` status text (`Selection rewrite ready`).
   - `Replace text` ([Editor.tsx:604-608](../src/components/Editor.tsx#L604)): `const stale = selectionRework !== null && isSelectionStale(body, selectionRework);` → `disabled={streaming || saving || stale}` `title={stale ? "The selected text changed — discard and rework again." : undefined}`. On click: `const next = selectionRework ? spliceProposal(body, selectionRework, proposal) : { ok: true, body: proposal, caret: null }`; if `!next.ok` return; `edit(setBody)(next.body); pendingCaretRef.current = next.caret; const ok = await save({ body: next.body }); if (ok) { setProposal(null); setSelectionRework(null); }`.
   - `useLayoutEffect(() => { const c = pendingCaretRef.current; if (c && bodyRef.current) { pendingCaretRef.current = null; bodyRef.current.focus(); bodyRef.current.setSelectionRange(c.start, c.end); } }, [body]);`
   - `discardProposal()` and the item re-seed effect ([Editor.tsx:168-197](../src/components/Editor.tsx#L168)) also reset `selectionRework`, `selRef`, `selectionLength`, `pendingCaretRef`.
   - Attach `ref={bodyRef}` to the textarea; pass `selectionLength`/`onClearSelection` to `AiBar`.
5. **`src/components/PromptEditor.tsx`:** the same changes (steps 4's bullets minus the R1 skip, which has no counterpart), on `rework()` ([PromptEditor.tsx:238-280](../src/components/PromptEditor.tsx#L238)) and `discardProposal()` ([PromptEditor.tsx:284-290](../src/components/PromptEditor.tsx#L284)), the card ([PromptEditor.tsx:416-442](../src/components/PromptEditor.tsx#L416)), `Replace text` ([PromptEditor.tsx:425-429](../src/components/PromptEditor.tsx#L425) — keep `source: "aiEnhanced"`; a partially-AI body is still AI-enhanced), and the textarea ([PromptEditor.tsx:444-449](../src/components/PromptEditor.tsx#L444)).
6. **`src/styles.css`:** add `.aibar-note` (muted, mono, `font-size` matching `.aibar-label`).
7. **`docs/DESIGN.md`:** amend the AI bar line (~66: selection label/count/`Whole text`), the review card line (~67: `Proposed rewrite (selection)` variant, splice semantics), and line ~79 (R1 title proposal is skipped for a selection rework).
8. **Verify Phase 1:** `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `git status --short -- src-tauri` (empty), then the Phase 1 smoke list in §8.

### Phase 2 — Scratch storage (Rust only; verified by `cargo test`)

9. **`src-tauri/src/store/itemfile.rs`:** verify-only — `MAX_ITEM_FILE_BYTES` ([itemfile.rs:34](../src-tauri/src/store/itemfile.rs#L34)) is already `pub` and `read_capped` is `pub(crate)` (verifier), so this file needs **no change**. If either has since lost visibility, widen it and nothing else.
10. **Create `src-tauri/src/store/scratchfile.rs`** and add `pub mod scratchfile;` to [store/mod.rs](../src-tauri/src/store/mod.rs):
    - `pub const SCRATCH_FILE: &str = "scratch.md"; const SCRATCH_TMP: &str = ".scratch.md.tmp";`
    - `pub enum ScratchFileError { Symlink, TooLarge, NotUtf8, Io(std::io::ErrorKind) }`
    - `pub fn read(dir: &Path) -> Result<String, ScratchFileError>`: `symlink_metadata(target)` → `NotFound` ⇒ `Ok(String::new())`; `is_symlink()` ⇒ `Symlink`; then `itemfile::read_capped(&path)` (over-cap ⇒ `TooLarge`, `InvalidData` ⇒ `NotUtf8`); strip one leading `'\u{feff}'`; return verbatim otherwise.
    - `pub fn write(dir: &Path, body: &str) -> Result<(), ScratchFileError>`: `body.len() as u64 > MAX_ITEM_FILE_BYTES` ⇒ `TooLarge` (before touching disk; the constant is `u64`, so cast exactly as [itemfile.rs:277](../src-tauri/src/store/itemfile.rs#L277) does); empty body ⇒ `remove(dir)`; reject `is_symlink()` on target or tmp via `symlink_metadata`; `std::fs::write(tmp, body)` then `std::fs::rename(tmp, target)` (mirror [itemfile.rs:290-300](../src-tauri/src/store/itemfile.rs#L290); no fsync).
    - `pub fn remove(dir: &Path)`: idempotent best-effort removal of both `SCRATCH_FILE` and `SCRATCH_TMP` (missing is success).
    - Inline `#[cfg(test)] mod tests` per §8.
11. **`src-tauri/src/projects/mod.rs`:**
    - Add `pub async fn get_scratch(&self, id: &str) -> Result<String>` and `pub async fn set_scratch(&self, id: &str, body: &str) -> Result<()>` next to `project_dir` (~line 444). The loaded gate MUST live here — `is_loaded` (~line 745) is **private** to `ProjectManager`, so it cannot be checked from `commands.rs`. Body: `if !self.is_loaded(id) { return Err(AppError::Invalid("that project isn't loaded".into())); }` — note `is_loaded` is a **synchronous** `fn … -> bool` (see its existing call at ~line 421: no `.await`); the copy is `create`/`create_prompt`'s (`rename` uses a different string, `"load the project before renaming it"`). Then `let dir = self.project_dir(id).await?;` and map `scratchfile` errors to the exact fixed strings in §4 L5 — read: `TooLarge` ⇒ `"the scratch pad is too large to open (limit 4 MB)"`, anything else ⇒ `"couldn't read the scratch pad"`; write: `TooLarge` ⇒ `"the scratch pad is too large to save (limit 4 MB)"`, anything else ⇒ `"couldn't save the scratch pad"`. Never echo a path or the `io::Error`.
    - In `remove_store_files`, immediately after the `IDENTITY_FILE` removal (~line 1169): `scratchfile::remove(dir);` (ignore-error form; a scratch file is never held by our pool).
    - Do **not** touch `GITIGNORE`, `store_exists_in`, `create_project`, `rename`, `reload`, or the Stage-1 upgrade.
12. **`src-tauri/src/commands.rs`:** after `startup_warnings` (~line 243): `#[tauri::command] pub async fn get_scratch(state: State<'_, AppState>, project_id: String) -> Result<String>` and `set_scratch(state, project_id: String, body: String) -> Result<()>`, one-line delegations (serde camelCase ⇒ the frontend passes `projectId`).
13. **`src-tauri/src/lib.rs`:** register `commands::get_scratch, commands::set_scratch` after `commands::startup_warnings` in `generate_handler!`.
14. **Tests:** add the §8 cases to `src-tauri/tests/project_manager.rs` (add `"scratch.md"` to `STORE_ENTRIES`), the fixture `src-tauri/tests/fixtures/v1_0_0/scratch.md` (two lines, one non-ASCII character, no trailing newline — write it **before** `scratchfile.rs` exists and prove the new compat test red first), and the new cases in `src-tauri/tests/on_disk_compat.rs`. Confirm `every_v1_item_fixture_still_scans_without_error` still counts exactly 4 items with no edit.
15. **`CLAUDE.md` (notes-app):** add `scratch.md` to the compatibility-surface list (§ "On-disk backward compatibility"): "`scratch.md` — the per-project scratch pad: plain UTF-8, no frontmatter, body verbatim, missing == empty; never gains frontmatter." Also note the `.scratch.md.tmp` sweep. (Owner-visible change; D12.)
16. **Verify Phase 2:** `cd src-tauri && cargo test` (see the `cargo-test-disk-full-workaround` and `notes-app-exe-locks-target` memories if linking fails).

### Phase 3 — Scratch page + "send selection to…" (frontend)

17. **`src/lib/api.ts`:** after `startupWarnings`: `getScratch(projectId: string): Promise<string>` → `invoke("get_scratch", { projectId })`; `setScratch(projectId: string, body: string): Promise<void>` → `invoke("set_scratch", { projectId, body })`. Doc comment: canonical `scratch.md`, committed with the project.
18. **`src/lib/draft.ts`:** `newDraft(kind: Kind, projectId: string = "", body: string = ""): Item` — `body` seeds `body`; nothing else changes. Extend `draft.test.ts` (§8).
19. **`src/components/EditorTabs.tsx`:** make `onNew` and `newLabel` optional; render the `+` button only when `onNew` is provided (the scratch strip has no "new").
20. **Create `src/components/SelectionMenu.tsx`:** props `{ open: boolean; x: number; y: number; anchor: RefObject<HTMLTextAreaElement | null>; onClose: () => void; onSendTo: (dest: "note" | "task" | "prompt") => void }`. Renders `<div className="popover context-menu" role="menu" aria-label="Selection" style={{ left, top }}>` with three `<button role="menuitem" className="context-menu-item">` — `New note from selection`, `New task from selection`, `New prompt from selection`. Uses `usePopover(open, onClose, { wrapper: menuRef, panel: menuRef, trigger: anchor })` for outside-mousedown/Escape/focus-in/focus-return; a `useLayoutEffect` measures `getBoundingClientRect()` and clamps `left/top` within `window.innerWidth/innerHeight` (never negative); `onKeyDown` handles ArrowUp/ArrowDown/Home/End roving focus (vertical mirror of [EditorTabs.tsx:69-93](../src/components/EditorTabs.tsx#L69)). Labels are static strings; no selection preview.
21. **Create `src/components/ScratchEditor.tsx`** (`forwardRef<ScratchEditorHandle>` with `save()`, mirroring `PromptEditorHandle`): props `{ doc: ScratchDoc; tabKey: string; hidden: boolean; active: boolean; onDirtyChange; onSave: (body: string) => Promise<boolean>; onSendTo: (dest, text: string) => void; onError; onResolve }`. Renders `<section className="editor" role="tabpanel" …>` containing `AiBar` (`variant="item"`, `dirty`, `saveBlocked={false}`, `generatingTitle={false}`, `selectionLength`, `onClearSelection`), the review card (proposal half only — copy PromptEditor's), and `<textarea className="body" ref={bodyRef} placeholder="Scratch space for this project. Select text and right-click to send it somewhere.">`. Rework/Replace text/discard use `src/lib/selection.ts` exactly as in step 4 (no R1). Ctrl+S gated on `active` like [PromptEditor.tsx:226-236](../src/components/PromptEditor.tsx#L226). `onContextMenu`: `const sel = captureSelection({ start: ta.selectionStart, end: ta.selectionEnd }, body)`; if `sel === null` (collapsed **or whitespace-only**, the same rule D7 uses for the AiBar) → return without `preventDefault()` so the native menu shows; else `e.preventDefault()`, store `sel` in a `menuSelRef`, set `{x: e.clientX, y: e.clientY}`, open `SelectionMenu`. Menu action → `onSendTo(dest, sel.text)`, then close. **Every close path** — action, Escape, outside mousedown — goes through one `closeMenu()` that sets `open=false` and restores `bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(sel.start, sel.end)` (`usePopover`'s Escape handler only refocuses the trigger; it does not restore a range, so the restore must live here).
22. **Create `src/components/ScratchPage.tsx`** shaped on `PromptsPage`: props `{ loaded: ProjectInfo[]; pageActive: boolean; reloadSignal: { projectId: string; n: number } | null; onError; onResolve; onOpenScratchChange: (projectIds: string[]) => void; onSendToItem: (kind: Kind, projectId: string, body: string) => void; onSendToPrompt: (projectId: string, body: string) => void }`. `type ScratchDoc = { projectId: string; body: string }`; `OpenTabsState<ScratchDoc>` keyed `scratch-${projectId}`. Rail: one row per loaded project (project name; `aria-current` on the active tab's project) plus the muted note *"Saved as scratch.md in the project folder and committed with it."*; empty state reuses `"No projects loaded — open or create one to start."` Row click → if the tab is open, activate; else if `id` is already in a `loadingIds` set (state), ignore the click; else add it, `await api.getScratch(id)`, remove it, then on success `openTab(s, key, { projectId, body })`, on failure `onError(String(err), { key: "scratch-load-failed" })` and **open no tab**. (The in-flight set is the guard against a double-click racing two fetches; `onResolve("scratch-load-failed")` on the next successful open.) `EditorTabs` with `listLabel="Open scratch pads"`, no `onNew`. Save → `api.setScratch(projectId, body)`; on success `setTabItem` with the new body and clear dirty. Effects copied from PromptsPage: close tabs whose project is no longer in `loaded`; close tabs of `reloadSignal.projectId` (then a re-click re-fetches the pulled file); report open project ids via `onOpenScratchChange`. Close-dirty prompt via `api.confirmDialog` with the same three-way copy PromptsPage uses. Tab title = project name.
23. **`src/App.tsx`:**
    - `type Page = "worknotes" | "prompts" | "scratch"`; `const PAGES: Page[] = ["worknotes", "prompts", "scratch"]`; rewrite `onPageTabKeyDown` ([App.tsx:499-507](../src/App.tsx#L499)) as an ordered walk with wrap (`ArrowLeft`/`ArrowRight`), focusing `` `tab-${next}` ``.
    - Add the third `role="tab"` button (`id="tab-scratch"`, `aria-controls="panel-scratch"`, label `Scratch`) after Prompts ([App.tsx:527-538](../src/App.tsx#L527)) and a third `.page-body` (`id="panel-scratch"`, `hidden={page !== "scratch"}`) after the Prompts panel ([App.tsx:660-676](../src/App.tsx#L660)) mounting `ScratchPage`.
    - State: `openScratchProjectIds` (mirror `openPromptProjectIds`); pass `promptReloadSignal` to `ScratchPage` as its `reloadSignal` too (same event, same shape); `unloadProject` ([App.tsx:411-446](../src/App.tsx#L411)) counts an open scratch pad in its confirm; `reloadProject` ([App.tsx:453-495](../src/App.tsx#L453)) confirm copy mentions it.
    - `openNewDraft(kind: Kind, target?: string, body = "")` — `newDraft(kind, target ?? resolveCreateTarget(projectFilter, loaded), body)`; existing `openNewDraft("note")`/`("task")` call sites unchanged.
    - `const [promptSeed, setPromptSeed] = useState<{ projectId: string; body: string; n: number } | null>(null)`.
    - `sendSelectionToItem(kind, projectId, body)`: `openNewDraft(kind, projectId, body); setPage("worknotes");` `sendSelectionToPrompt(projectId, body)`: `setPromptSeed((s) => ({ projectId, body, n: (s?.n ?? 0) + 1 })); setPage("prompts");` Pass both to `ScratchPage`; pass `seed={promptSeed}` to `PromptsPage`.
24. **`src/components/PromptsPage.tsx`:** `newDraft(projectId: string, body = ""): Prompt`; new prop `seed: { projectId: string; body: string; n: number } | null`; `useEffect` on `[seed]` (mirror [PromptsPage.tsx:129-139](../src/components/PromptsPage.tsx#L129)): **`if (!seed) return;`** first (the prop starts `null`; StrictMode's mount-time double invoke is then a no-op, and a re-render with the same `seed` object does not re-fire because the dep is referentially unchanged — App always creates a fresh object with `n + 1`); then `setProjectId(seed.projectId)`; `const seq = draftSeq + 1; setDraftSeq(seq); setTabs((s) => openTab(s, \`prompt-draft-${seq}\`, newDraft(seed.projectId, seed.body), true))`. (If the test-writer's optional extraction is taken, move `newDraft` to `src/lib/promptDraft.ts` with tests; otherwise leave inline.)
25. **`src/styles.css`:** `.context-menu { position: fixed; min-width: 220px; padding: 4px; z-index: <above .popover>; }` reusing `.popover` surface/border/radius; `.context-menu-item { display: block; width: 100%; text-align: left; }` styled like `.btn-quiet` with `:hover`/`:focus-visible` background `var(--bg)`; scratch rail rows reuse the prompt rail row classes. Tokens only — no palette-specific rules, no shadow, no icons.
26. **`docs/DESIGN.md`:** new `### Scratch page (new)` section (rail, tabs, explicit Save, `scratch.md` note, context menu items and copy-not-cut semantics, keyboard: Shift+F10 opens the menu, Escape returns focus and selection); update "Page switching" to three tabs; add the delete-files confirm mention of `scratch.md` if that copy enumerates files (check [ManageProjectsDialog.tsx](../src/components/ManageProjectsDialog.tsx)); note Forget leaves `scratch.md` on disk.
27. **Verify Phase 3:** `npx tsc --noEmit`, `npm run build`, `npx vitest run`, `cd src-tauri && cargo test`, `npm run tauri dev` + the §8 smoke lists (light + dark, at least two palettes).
28. **Bump `version` in `src-tauri/tauri.conf.json` / `package.json` / `Cargo.toml`** only if the owner asks (plan.12 precedent: version bumps are separate commits).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/selection.ts` | Create | Pure selection capture / staleness / guarded splice (Phase 1) |
| `src/lib/selection.test.ts` | Create | Vitest coverage incl. RED-evidence companion |
| `src/components/AiBar.tsx` | Modify | `selectionLength?` / `onClearSelection?` → selection label, count, `Whole text` |
| `src/components/Editor.tsx` | Modify | `bodyRef`, selection tracking, selection-scoped `rework()`, skip R1, card label, guarded `Replace text`, caret restore |
| `src/components/PromptEditor.tsx` | Modify | Same as Editor minus the title half |
| `src/styles.css` | Modify | `.aibar-note`, `.context-menu`, `.context-menu-item` |
| `docs/DESIGN.md` | Modify | AI bar / review card / R1 amendments; Scratch page section; three page tabs |
| `src-tauri/src/store/itemfile.rs` | Modify (visibility only) | `pub(crate) const MAX_ITEM_FILE_BYTES` if not already |
| `src-tauri/src/store/scratchfile.rs` | Create | `read`/`write`/`remove` for `scratch.md` (cap, BOM, symlink, temp+rename) + inline tests |
| `src-tauri/src/store/mod.rs` | Modify | `pub mod scratchfile;` |
| `src-tauri/src/projects/mod.rs` | Modify | `get_scratch`/`set_scratch` (loaded-gated); `remove_store_files` sweeps `scratch.md` + `.scratch.md.tmp` |
| `src-tauri/src/commands.rs` | Modify | `get_scratch`, `set_scratch` commands |
| `src-tauri/src/lib.rs` | Modify | Register the two commands |
| `src-tauri/tests/project_manager.rs` | Modify | Manager/lifecycle/hardening tests; `STORE_ENTRIES` += `scratch.md` |
| `src-tauri/tests/on_disk_compat.rs` | Modify | Golden read-back; item-fixture count unchanged |
| `src-tauri/tests/fixtures/v1_0_0/scratch.md` | Create | Append-only golden |
| `CLAUDE.md` (notes-app) | Modify | Compat surface list += `scratch.md` (owner-visible) |
| `src/lib/api.ts` | Modify | `getScratch`, `setScratch` |
| `src/lib/draft.ts` + `draft.test.ts` | Modify | `newDraft(kind, projectId, body = "")` |
| `src/components/EditorTabs.tsx` | Modify | `onNew`/`newLabel` optional |
| `src/components/SelectionMenu.tsx` | Create | Fixed, clamped, `role="menu"` context menu |
| `src/components/ScratchEditor.tsx` | Create | Title-less editor with AiBar, review card, body, context menu |
| `src/components/ScratchPage.tsx` | Create | Rail + tabs + mounted editors; load/save/close/reload effects |
| `src/App.tsx` | Modify | Third page, ordered tablist, `openNewDraft` seed, `promptSeed`, send-to callbacks, unload/reload counts |
| `src/components/PromptsPage.tsx` | Modify | `seed` prop → seeded draft tab; `newDraft(projectId, body = "")` |
| `src/lib/promptDraft.ts` + `.test.ts` | Create (optional) | If `newDraft` is extracted for testability |

Not touched, deliberately: `src-tauri/src/models.rs`, `src/types.ts`, `src-tauri/migrations*/`, `GITIGNORE`, `store_exists_in`, `CURRENT_SCHEMA_VERSION`, `src-tauri/capabilities/default.json`, `tauri.conf.json` CSP, `src-tauri/src/ai/*`.

## 8. Test Strategy

_(test-writer; adapted to D1–D13. Vitest is node-only — UI behaviour is manual smoke.)_

- [x] **Unit tests — `src/lib/selection.test.ts`:**
  - `captureSelection` returns null for null range, collapsed range, inverted range, out-of-bounds range, whitespace-only slice; returns `{start,end,text}` otherwise (start of body, end of body, multibyte/emoji boundaries preserved).
  - `isSelectionStale` false when the slice still matches; true after an insertion before the range, a deletion inside it, or a same-length substitution.
  - `spliceProposal` replaces exactly the range (start=0, end=body.length, middle); longer/shorter/empty proposal; surrounding text and newlines verbatim; `caret` = `{start, start+proposal.length}`; returns `{ok:false, reason:"stale"}` when stale and leaves the input untouched.
  - RED-evidence companion: an unguarded `body.slice(0,start)+proposal+body.slice(end)` on a stale body demonstrably corrupts, proving the guard test is not vacuous (mirrors `streaming.rs`'s `non_cooperative_provider_…`).
- [x] **Unit tests — `src/lib/draft.test.ts`:** `newDraft` with a body seeds `body` only; without one still defaults to `""` (existing tests unchanged); seeded body does not alter task `todo/normal` or note `null/null` defaults.
- [x] ~~Unit tests — `src/lib/promptDraft.test.ts`~~ N/A — (only if extracted): seeded / unseeded / `reusable` untouched.
- [x] **Unit tests — `src-tauri/src/store/scratchfile.rs` (`#[cfg(test)]`, `tempfile`):**
  - `read_on_missing_file_returns_empty_string`
  - `read_returns_exact_bytes_written_including_crlf_and_multibyte` (verbatim, no normalisation, no added trailing newline)
  - `read_strips_a_leading_bom_and_write_never_adds_one`
  - `read_rejects_a_file_over_the_cap_without_reading_it_whole` (TooLarge, not empty)
  - `read_rejects_invalid_utf8_as_not_utf8` (never lossy)
  - `write_is_atomic_tmp_then_rename_and_leaves_no_tmp_on_success`
  - `write_overwrites_existing_content_completely`
  - `write_of_empty_string_removes_the_file_and_the_tmp`
  - `write_rejects_a_body_over_the_cap_and_leaves_the_prior_file_byte_for_byte_unchanged`
  - `read_and_write_refuse_when_scratch_md_is_a_symlink` (Windows: `std::os::windows::fs::symlink_file`; skip with a note if the test host lacks the privilege) and `write_refuses_when_the_tmp_path_is_a_symlink`
  - `remove_is_idempotent_on_a_missing_file`
- [x] **Integration tests — `src-tauri/tests/project_manager.rs`:**
  - `get_scratch_on_a_freshly_created_project_is_empty_and_creates_no_file`
  - `set_scratch_then_get_scratch_round_trips_and_writes_scratch_md_at_the_project_root`
  - `get_scratch_and_set_scratch_on_an_unloaded_project_are_rejected_as_invalid` (message contains `isn't loaded`)
  - `get_scratch_and_set_scratch_of_an_unknown_project_id_are_clean_not_found`
  - `set_scratch_rejects_an_oversized_body_and_leaves_prior_content_untouched`
  - `set_scratch_does_not_bump_any_item_updated_at_or_reorder_the_list`
  - `scratch_survives_unload_and_load` (read from disk, not cached)
  - `reload_project_keeps_scratch_content`
  - `rename_project_does_not_touch_scratch_md`
  - `delete_files_removes_scratch_md_and_its_tmp` (extend `delete_files_requires_unload_first_then_removes_store_and_catalog_row`)
  - `forget_project_leaves_scratch_md_on_disk`
  - `scratch_is_isolated_per_project`
  - `open_project_on_a_moved_directory_serves_the_moved_scratch` (after `STORE_ENTRIES += "scratch.md"`)
  - `opening_a_pre_feature_project_directory_with_no_scratch_md_loads_all_items_and_reads_empty_scratch` (older-build direction)
  - `opening_a_directory_with_a_hand_written_scratch_md_next_to_items_loads_items_with_zero_skips_and_reads_the_scratch`
  - `a_scratch_md_containing_git_conflict_markers_is_returned_verbatim` (policy pin)
- [x] **Integration tests — `src-tauri/tests/on_disk_compat.rs`:** `v1_0_0_scratch_fixture_reads_back_byte_identical`; existing `every_v1_item_fixture_still_scans_without_error` still asserts exactly 4 items (no edit); `fixture_files_are_lf_only` covers the new file automatically.
- [x] **Edge cases & error scenarios:** whitespace-only selection → whole-body mode; Ctrl+A selection → behaves as whole body but labelled selection (acceptable; note in smoke); selection spanning the very start/end of the body; body edited above/inside/below the range while streaming; second rework superseding a selection rework; navigating away mid-stream; `Replace text` on a prompt keeps `source: "aiEnhanced"`; getScratch failure opens no tab; over-cap paste surfaces a clear error and no truncation; two loaded projects show no cross-contamination.
- [x] **Mocks/stubs:** none new. AI stays trait-faked in Rust; no HTTP mocking crate; no clipboard plugin; `crypto.randomUUID` untouched; any new pure helper takes ids/clock as arguments.
- [x] **Manual smoke — Phase 1 (item Editor, PromptEditor):** select a sentence → AiBar reads `Rework selection with · N characters selected`; click a chip then Rework → only the sentence streams; card head `Proposed rewrite (selection)`; **no** title row appears; `Replace text` changes only the span (fingerprint text before/after untouched) and leaves the inserted text selected; edit the body while streaming → `Replace text` disabled with the title; `Whole text` clears the mode; collapsed caret → whole-body rework as today; Discard mid-stream leaves the body untouched; multibyte boundary; the selection survives the blur caused by clicking the AiBar in WebView2 (runtime check).
- [x] **Manual smoke — Phase 3 (Scratch page):** Worknotes → Prompts → Scratch → wrap with ArrowLeft/Right; rail lists loaded projects; click opens the pad; type, Save (button and Ctrl+S — fires exactly once with item + prompt + scratch tabs all open); reopen the folder's `scratch.md` in an editor and diff; right-click with no selection or a whitespace-only selection → native menu; with a real selection → custom menu with three items, native menu suppressed (also in a **release** build); Shift+F10 opens it; Escape AND an outside click both return focus to the pad with the same range re-highlighted; near all four screen edges the menu stays on-screen; **selection rework inside the pad itself**: select a phrase → AiBar reads `Rework selection with · N characters selected` → Rework → `Proposed rewrite (selection)` → `Replace text` splices only that span and Save persists it to `scratch.md` (no title row ever appears in the pad); a double-click on a rail row opens exactly one tab and one fetch; each destination opens a dirty draft with the selection as body, empty title, correct project, correct page; the pad text is unchanged (copy); unload confirm names an open dirty pad; reload closes the pad tab and a re-click shows the pulled content; Delete files removes `scratch.md`; Forget leaves it; over-cap paste → clear error; conflict markers show as raw text; light/dark × two palettes.

> **Smoke result (2026-08-30):** both manual lists passed by the owner in `npm run tauri dev`. Two wording caveats: the outside-click item is superseded by §12 item 9 (an outside click dismisses and then acts as an ordinary click — Escape/Tab/menu-action restore the range); the "native menu suppressed **in a release build**" clause still needs one check in a release build if the smoke ran in dev only.

## 9. Success Criteria

- [x] **Functional (Phase 1):** a non-empty selection in the item Editor, PromptEditor, and ScratchEditor reworks only the selection; the card is labelled `Proposed rewrite (selection)`; no R1 title proposal for a selection rework; `Replace text` splices exactly the range and refuses (disabled + title) when the body changed; the AiBar shows the mode and offers `Whole text`; the backend and `src-tauri/` are byte-unchanged in Phase 1.
- [x] **Functional (Phase 2):** `get_scratch`/`set_scratch` round-trip via `scratch.md` at the project root; unloaded/unknown projects rejected cleanly; 4 MiB cap on write and read; empty body deletes the file; symlinks refused; Delete files removes `scratch.md` and `.scratch.md.tmp`; a pre-feature project directory opens with zero skipped items and an empty pad; all existing goldens pass unchanged; no migration, no schema bump.
- [x] **Functional (Phase 3):** a third page tab **Scratch** with a rail of loaded projects and one pad tab per project; explicit Save; right-click on a selection opens the three-item menu; each item opens a pre-filled draft (copy) in the correct project and page; no selection → native menu; unload/reload confirms account for open pads.
- [x] **Tests:** every test in §8 exists and passes (`npx vitest run`, `cd src-tauri && cargo test`).
- [x] **Security:** H1–H4 and M1–M7 mitigations in §4 implemented; L1 confirmed (no new dependency, capability, or CSP change in the diff).
- [x] **Quality:** `npx tsc --noEmit` (noUnusedLocals) clean; `npm run build` clean; `cargo test` green; DESIGN.md and CLAUDE.md updated; no unrelated refactoring.

## 10. Risks & Open Questions

**Risks**

- **Stale-range splice** (tech-lead, security H4): the one path that can silently corrupt a saved note. Mitigated by D4; the RED-evidence test proves the guard is real.
- **Third rework copy.** `ScratchEditor` duplicates the ~60-line streaming block already duplicated between `Editor` and `PromptEditor`. Accepted: a shared streaming hook is untestable in the node-only vitest setup; the *pure* part is shared via `selection.ts`.
- **Caret restore after a controlled-textarea splice** is new plumbing (nothing in the repo does it today; today's whole-body `Replace text` likely resets the caret). Budget for a StrictMode-safe `useLayoutEffect`.
- **WebView2 runtime checks** (architect, unverified in a release build): `preventDefault()` on `contextmenu` suppresses the native menu; textarea `selectionStart/End` survive the blur from clicking the AiBar. Both are documented Chromium behaviour; confirm in the Phase 1/3 smoke.
- **Older builds leave `scratch.md` behind on Delete files** (remanence, not loss — plainly named, human-readable). Documented in CLAUDE.md.
- **`scratch.md` is the most conflict-prone file in a two-machine git workflow**; markers are surfaced raw and the user resolves them in-app (D9). If this bites, a later change can add a soft notice using `itemfile::has_conflict_markers`.
- **`.scratch.md.tmp` can be committed by `git add -A`** after a crash (M4); accepted rather than changing `GITIGNORE` (D10).
- **Whole-file sync (OneDrive) last-writer-wins**, same as items; no optimistic concurrency anywhere in the app, so none is added here.

**Verification gate (adversarial-verifier)** — every claim that drives a design decision was independently re-derived from the code before entering this plan:

| # | Claim | Verdict | Drives | Refinement |
|---|---|---|---|---|
| 1 | `write_identity_file` ([projects/mod.rs:962-968](../src-tauri/src/projects/mod.rs#L962)) overwrites `project.json` with a two-field struct; `rename` (line 407) calls it; `ProjectIdentity` has no `deny_unknown_fields` | **CONFIRMED** | rejecting storage option (d) | write is also non-atomic with a discarded error — further argues against user content there |
| 2 | `project_dir()` ([projects/mod.rs:436-439](../src-tauri/src/projects/mod.rs#L436)) has no loaded check; `create`/`create_prompt`/`rename` do | **CONFIRMED** | H1, D9 | `is_loaded` (line 745) is **private** → the gate lives in `ProjectManager` methods (step 11); `rename`'s copy is `"load the project before renaming it"`, not `"that project isn't loaded"` |
| 3 | No reusable atomic writer for a root-level file; `read_capped` is `pub(crate)`; `MAX_ITEM_FILE_BYTES` = 4 MiB (and already `pub`) | **CONFIRMED** | D1 (`scratchfile.rs`) | `promptfile::write_atomic` is already generic over `(dir, name, contents)` — the new module is a **choice** (own semantics + error type), not forced; D1 now says so. Step 9 is therefore a no-op check |
| 4 | `.gitignore` recognised by exact equality against `GITIGNORE`/`LEGACY_GITIGNORE`; 1.1.0's constant is byte-identical to HEAD | **CONFIRMED** | D10 | the safe alternative (a second legacy constant) is recorded in D10 |
| 5 | `onPageTabKeyDown` ([App.tsx:499-507](../src/App.tsx#L499)) is a hardcoded 2-way toggle for both arrow keys | **CONFIRMED** | step 23 | the per-button `aria-selected`/`tabIndex` ternaries at 514-519 are independent equality checks and need no change — step 23 only adds a mirrored set for `tab-scratch` |
| 6a | (architect) "`index.db` is dropped and rebuilt on every load, so a `meta` row is destroyed on Reload" | **REFUTED** | — | `rebuild_from_dir` ([sqlite.rs:348,396,397](../src-tauri/src/db/sqlite.rs#L348)) deletes only `items`/`prompt_versions`/`prompts`; `open_store` ([projects/mod.rs:1021](../src-tauri/src/projects/mod.rs#L1021)) reuses an existing `index.db`; `read_meta`/`set_project_name` depend on `meta` persisting. `CLAUDE.md`'s "dropped and rebuilt" is shorthand for the row rebuild |
| 6b | (database-architect) a `meta` row survives reload; the correct disqualifier is git-ignored / not a compat surface / removed by Delete files | **CONFIRMED** | §3.2 row (e) wording | plus: `KNOWN_TABLES` is an exact allowlist, so a new *table* would make older builds reject the store as foreign |

No REFUTED claim drove a plan decision — option (e) is rejected on the confirmed grounds, and the plan text was corrected accordingly.

**Open questions for the owner**

1. **Scratch pad searchable?** This plan says **no** (not indexed, not in FTS). Users may report it as a bug — decide and document.
2. **Tech-lead's challenge:** would a designated pinned note per project have satisfied the need? This plan builds the dedicated file as requested; say so if the pinned-note version is preferable.
3. **Explicit Save vs autosave** (D3) — the frontend specialist dissented. Confirm explicit Save.
4. **"Rework selection…" as a context-menu entry in item/prompt editors, and "send selection to…" from ordinary notes** — both out of scope here; the `SelectionMenu` is built scratch-agnostic so either is a prop-level follow-up.
5. **Cut-on-successful-Save** for send-to (remove the fragment from the pad once the destination is created) — deferred (cross-page lifecycle coupling).
6. **`CLAUDE.md` edit** (D12) — the project's own instruction file gains one line; confirm.

## 11. Code Review Checklist

After implementation, verify:
- [x] No dead code or unused imports introduced (`noUnusedLocals` — every new ref/state is wired)
- [x] Error handling covers failure modes (getScratch failure opens no tab; setScratch failure keeps the tab dirty; splice refusal never writes)
- [x] No security vulnerabilities (injection, XSS, credential exposure) — static menu labels, `style` prop only, no `dangerouslySetInnerHTML`, no path/io::Error echoed
- [x] Security considerations from Section 4 addressed (H1 loaded gate on both commands; H2 symlink checks on target and tmp; H3 sweep of both files; H4 guarded splice; M1 write-side cap)
- [x] Code follows existing project conventions (api.ts-only IPC; keyed toasts; `confirmDialog`; serde camelCase; `AppError::Invalid` fixed copy; header comments on pure libs)
- [x] Tests cover happy path, edge cases, and error scenarios (§8), including the RED-evidence companion
- [x] No performance regressions (selection tracking sets state only on a length change; no per-keystroke re-render of sibling editors; no scan of the project root on load)
- [x] Changes are minimal — no unrelated refactoring bundled in (no `GITIGNORE`, `store_exists_in`, `models.rs`, `types.ts`, migration, capability, or CSP edits; `openTabs.ts` untouched)
- [x] Phase 1 diff leaves `src-tauri/` untouched; Phase 2 diff leaves `src/` untouched
- [x] `docs/DESIGN.md` and `CLAUDE.md` updated in the same commits as the behaviour they describe

## 12. Post-Review Improvements

_(Implemented 2026-08-30 after the code-reviewer / security-auditor / frontend-specialist / database-architect passes; every behaviour-changing claim below was CONFIRMED by an adversarial-verifier before it was acted on. Each item names the test that pins it.)_

**Storage (database-architect F1–F5, verified)**

1. **`scratch.md` is swept by `delete_files`, not by `remove_store_files`** — amends step 11. `remove_store_files` is also `create_project`'s unattended rollback (`projects/mod.rs` ~198/214); the pad is created lazily, so a `scratch.md` a user already kept in a not-yet-a-store folder would have been deleted without confirmation when a create failed after the store files were written (e.g. a catalog `UNIQUE(name)` clash — `create_project` accepts non-empty directories and inserts the catalog row LAST). H3 is unchanged: `delete_files` still removes `scratch.md` and `.scratch.md.tmp`. Tests: `delete_files_requires_unload_first_then_removes_store_and_catalog_row` (unchanged), new `create_project_rollback_leaves_a_pre_existing_scratch_md_untouched`. CLAUDE.md wording updated accordingly.
2. **A missing project DIRECTORY reads as an error, not an empty pad** (`scratchfile::read`). `symlink_metadata` reports both a missing file and a missing folder as `NotFound` (Windows `ERROR_PATH_NOT_FOUND` maps to `NotFound`); a drive that dropped offline after load would have opened an empty tab whose first Save overwrote — or, empty, deleted — the real file once the folder returned. `read` now returns `Ok("")` only when `dir.is_dir()`. Test: `read_on_a_missing_project_directory_is_an_error_not_an_empty_pad`.
3. **A failed write/rename removes `.scratch.md.tmp`** (`scratchfile::write`). A rename failure (e.g. a directory named `scratch.md`) left the full pad text in an un-gitignored temp file that `read` never sees. Test: `write_cleans_up_the_tmp_when_the_rename_fails`.
4. **Over-cap files are reported as too large even when the cap cuts a multi-byte char.** `read_capped`'s `take(MAX+1)` could end inside a UTF-8 sequence → `InvalidData` → `"couldn't read the scratch pad"` instead of the size message. `read` now checks the `symlink_metadata` length first (the `promptfile` idiom), keeping `read_capped` as the TOCTOU backstop. Test: `read_reports_too_large_not_not_utf8_when_the_cap_cuts_a_multibyte_char`.
5. **Docs:** `on_disk_compat.rs` header now names `scratch.md` and why it lives under `v1_0_0/`; the CLAUDE.md compat bullet states the no-version-marker consequence ("still plain text" is the only compatible evolution), the read/write cap, the symlink refusal, the BOM strip, and older-build remanence on Delete files.

**Frontend (frontend-specialist 1–3, 5; code-reviewer)**

6. **Keyboard send-to no longer drops focus to `<body>`.** `sendSelectionToItem`/`sendSelectionToPrompt` focus the destination page's tab (`tab-worknotes` / `tab-prompts`) after switching pages — the pad's panel becomes `hidden`, which un-focuses the textarea `closeMenu` had just refocused. (Manual smoke.)
7. **Tab closes the `SelectionMenu`** (returning focus to the pad via `onClose`) instead of walking focus out of a `role="menu"` and leaving it open. (Manual smoke.)
8. **The scratch load-failure toast is keyed per project** (`scratch-load-failed-<id>`), so a later successful open of project B no longer dismisses a still-valid failure toast for project A.
8a. **A pad fetch that resolves after its project was unloaded opens no tab.** The code-reviewer claimed a persistent orphan tab; the adversarial-verifier REFUTED that as stated (a headless-Chromium reproduction of the real component showed the tab closing within one commit) — but only because App's `loaded` is a fresh array every render, which re-fires ScratchPage's `[loaded]` effect by accident. `selectProject` now re-checks a `loadedRef` after the await and returns, so the invariant no longer depends on that incidental re-render (memoizing `loaded` in App would otherwise have made the bug real).
9. **Outside-click copy corrected, not code.** DESIGN.md and the §8 smoke wording claimed an outside click "returns focus to the pad with the same range re-selected". `closeMenu` does restore the range, but the click's own default action then legitimately runs (a click into the pad places the caret; a click on a control focuses it). Blocking that (`preventDefault` on the document mousedown) would make a click into the pad unable to place the caret — worse than the promise. Escape, Tab and choosing an item restore the range; an outside click dismisses and acts as an ordinary click. DESIGN.md now says so.

**Security-auditor notes accepted as-is (no code change):** the check-then-use window on the symlink guards (same shape as `itemfile`, requires write access to the project directory); the 4 MB cap applying after IPC deserialization (local memory only, no write); an empty pad + Save deleting `scratch.md` (D1 semantics); R4 still sending the whole body for an untitled draft after a selection splice (D6). **Environment caveat:** this host has no `SeCreateSymbolicLinkPrivilege`, so the two symlink unit tests took their documented skip branch here — they exercise their assertions only on a host with Developer Mode or elevation; the plan's `project_manager.rs` symlink test was not added (it would skip the same way).

**Deviations from §6/§8 recorded by the test-writer:** `get_scratch_and_set_scratch_of_an_unknown_project_id_are_clean_not_found` is implemented as `…_are_rejected_cleanly_never_panic` — the loaded gate runs first (the security property), so an unknown id yields `Invalid("that project isn't loaded")`, not `NotFound`; the hand-written-`scratch.md` compat test observes "zero skips" via `reload` because `open_project` discards its scan warnings. `ScratchPage` guards the in-flight fetch with a ref rather than state (synchronous check in the click handler); a `.rail-note` CSS class was added for the rail copy; `PromptsPage.newDraft` stays inline.

## 13. Execution Prompt

Paste the following into a fresh Claude Code session opened at `c:\Projects\TaskTracker\TaskTracker` (the repo root; the app lives in `notes-app/`):

```
You are implementing Plan 13 for the `worknotes` app (Tauri 2 + React 19/TypeScript + Rust) in this repo. The app lives in `notes-app/`; run all npm/cargo commands from there.

READ FIRST, in this order, before writing any code:
1. `notes-app/plans/plan.13.md` — the complete plan. Sections 5 (Design / Key Decisions D1–D13), 6 (Implementation Steps), 7 (Files), 8 (Test Strategy) and 4 (Security) are binding.
2. `notes-app/CLAUDE.md` — architecture, invariants, and the NON-NEGOTIABLE "On-disk backward compatibility" section.
3. `notes-app/docs/DESIGN.md` — UI spec and microcopy voice.

IMPLEMENT the plan step by step, following Section 6 exactly and in order, as THREE separable commits (do not commit — leave the work staged/unstaged for the user; never commit or push unless explicitly asked):
- Phase 1 (steps 1–8): AI rework on a text selection. Frontend only. `git status --short -- notes-app/src-tauri` MUST be empty at the end of this phase.
- Phase 2 (steps 9–16): scratch-pad storage. Rust only (`scratch.md` at the project root via `store/scratchfile.rs`, `get_scratch`/`set_scratch` gated on the loaded set inside `ProjectManager`, the `remove_store_files` sweep of `scratch.md` and `.scratch.md.tmp`, the golden fixture, the CLAUDE.md compat-list line). No migration, no `CURRENT_SCHEMA_VERSION` bump, no `GITIGNORE`/`store_exists_in`/`models.rs`/`types.ts` changes.
- Phase 3 (steps 17–27): the Scratch page, `SelectionMenu`, `ScratchEditor`, `ScratchPage`, seeded drafts, the PromptsPage `seed` prop, CSS, DESIGN.md.
After each phase run the plan's verify commands for that phase before moving on. Skip step 28 (version bump) unless the user asks.

HARD RULES while implementing:
- Components never call `invoke()`; only `notes-app/src/lib/api.ts` does. Confirmations go through `api.confirmDialog()`, never `window.confirm`.
- The selection splice happens ONLY inside the `Replace text` click handler, through `spliceProposal` from `src/lib/selection.ts`, and refuses when `body.slice(start,end) !== captured text` (Plan §4 H4, D4). Never fall back to whole-body replace, never fuzzy re-find.
- Skip the R1 title proposal for a selection rework; leave R4 (empty-title-on-Save) untouched (D6).
- `get_scratch`/`set_scratch` both gate on `is_loaded` (private — the check lives in `ProjectManager`), cap at `MAX_ITEM_FILE_BYTES` on write AND read, delete the file on an empty body, strip a leading BOM on read, refuse symlinks on `scratch.md` and `.scratch.md.tmp`, surface git conflict markers as raw text, and return only fixed generic error strings (never a path or io::Error) — Plan §4 H1–H3, M1–M4, D9.
- A failed `getScratch` opens NO tab (toast only) so nothing can be saved over an unreadable file.
- Send-to is copy-not-cut, opens an unsaved draft with the body pre-filled and the title EMPTY, targets the pad's own project, and issues no IPC write (D5, §4 L3).
- The context menu renders only for a non-empty selection (otherwise let the native WebView2 menu through); static labels; position via the React `style` prop; no new npm package, crate, capability grant, or CSP change (§4 L1, L2, D8).
- Match surrounding style and idioms; touch only what the plan names; no unrelated refactoring; comment only non-obvious constraints.

WRITE TESTS per Section 8. Spawn a `test-writer` agent (fallback: `general-purpose` with the test-writer role stated) with Section 8 pasted in, instructed to: add `src/lib/selection.test.ts` (including the RED-evidence companion), extend `src/lib/draft.test.ts`, add the inline `#[cfg(test)]` tests in `src-tauri/src/store/scratchfile.rs`, add the listed cases to `src-tauri/tests/project_manager.rs` (adding `"scratch.md"` to `STORE_ENTRIES`) and `src-tauri/tests/on_disk_compat.rs`, create the append-only golden `src-tauri/tests/fixtures/v1_0_0/scratch.md`, and prove each new test can fail. Do NOT add jsdom or React Testing Library (D13) — UI behaviour is the manual smoke list in Section 8.

REVIEW with subagents after implementation (read-only agents must not edit):
- Spawn a `code-reviewer` agent (read-only: Read, Grep, Glob; fallback: `general-purpose` with the reviewer role and an explicit read-only instruction) to review the full diff against Plan 13 Sections 5, 6, 7 and 11, with file:line findings.
- Spawn a `security-auditor` agent (read-only; fallback: `Explore` with the auditor role) to verify every Section 4 mitigation (H1–H4, M1–M7, L1–L6) is present, with file:line evidence, and to confirm the diff contains no capability, CSP, dependency, or `GITIGNORE` change.
- Spawn conditional domain agents ONLY where the diff touches their domain: `frontend-specialist` (fallback: `Explore` with the role stated) for `SelectionMenu`/`ScratchEditor`/`ScratchPage`/`AiBar`/`Editor`/`PromptEditor` accessibility, focus/selection restore, palette-token compliance and the three-tab tablist keyboard walk; `database-architect` (fallback: `Explore` with the role stated) for `store/scratchfile.rs`, the `remove_store_files` sweep, the fixture, and the CLAUDE.md compat-surface wording. Do not spawn `api-designer`, `devops-engineer` or `performance-optimizer` — the plan touches none of their domains.
- If any review agent reports a claimed bug that would change the implementation, verify it with an `adversarial-verifier` agent (fallback: `general-purpose` instructed to actively refute it) before acting on it.

THEN:
1. Run the Code Review Checklist in Plan 13 Section 11 item by item and fix anything that fails.
2. Document every improvement made after review under Plan 13 Section 12 ("Post-Review Improvements") in `notes-app/plans/plan.13.md`, then implement each one.
3. Run the full verification before finishing and fix any regression: `cd notes-app && npx vitest run && npx tsc --noEmit && npm run build && cd src-tauri && cargo test`. (If `cargo test` fails to link with LNK1318 or "Access is denied" on `notes-app.exe`, see the workarounds in the user's memory: clean `target/`, disable debuginfo, and kill any running `notes-app.exe` first.)
4. Then run `npm run tauri dev` and work through BOTH manual smoke lists in Plan 13 Section 8, reporting each item as passed, failed, or not testable in this environment — never as assumed.
5. Report the outcome plainly: what was built, which tests pass (with output), which smoke items were verified, what was skipped and why, and which Section 10 open questions still need the owner's answer. Do not commit or push.
```
