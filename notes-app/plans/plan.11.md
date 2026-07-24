# Plan 11: Editor tabs, cosmetic tightening, AI-bar move & 5-palette theme picker

**Created:** 2026-07-22
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Reproduce the design changes handed off in `C:\Temp\worknotes\design_handoff_editor_tabs` (a `README.md` spec plus `screens/*.html` visual references) inside the real React app. The handoff bundles six changes of very different sizes:

1. **Open-item tab bar** in the editor, for both the notes/tasks workbench and the prompt library — keep several items open at once, switch between them, close them, with a per-tab unsaved indicator. *(The big one — new frontend state that does not exist today.)*
2. **Editor title tightening** — `.title` font-size 22→17px, padding `6px 2px`→`2px 2px`. *(Pure CSS.)*
3. **AI ("Rework") bar reposition** — move `.aibar` from below the proposed-rewrite review card to above it. *(DOM-order only.)*
4. **Prompt rail spacing** — `.rail-actions` bottom padding `0`→`12px`. *(One CSS value.)*
5. **Create-buttons softened on the v2-light palette only** — `.rail-actions .btn` from solid ink to a surface fill. *(Palette-scoped CSS.)*
6. **Five color palettes** shipped as a **theme picker** — Original (light), v2-light (gray+teal), v2-dark (gray+teal), neon-noir (dark), claude-terminal (dark). *(New theming infrastructure — these palettes change the accent and danger colors, not just neutrals.)*

**Confirmed product decisions (from the requester):**
- **Ship the full theme picker with all five palettes**, selectable and persisted — this is a real feature, not just CSS.
- **Drop the legacy yellow-accent "Original dark"** theme (it is not among the five handoff palettes). The five palettes are the complete set after this change.

The plan is organized into three **independently shippable phases** in ascending risk order: **A** (cosmetic, no new state), **B** (theme picker + palettes), **C** (tab bar). This matches the tech-lead's strong recommendation not to treat six unequal changes as one monolith. This remains a single plan; each phase can be committed and verified on its own.

**Scope:** frontend-only. The security auditor and both research agents confirmed no Tauri command, migration, DTO, or key-path change is required or permitted. `src-tauri/` and `src/lib/api.ts` must not be touched.

## 2. Strategic Assessment

*(tech-lead — read-only)*

**Verdict: split and sequence.** Changes 2/3/4 are an afternoon of low-risk edits with exact values given. Change 5 is a scoped CSS rule. Change 1 (tabs) rewrites the app's core interaction model, and Change 6 (palettes) deliberately breaks a documented invariant — those two carry all the real weight and were gated on the requester's decisions (now made).

Key strategic points, all incorporated below:

- **The tab bar inverts a load-bearing property of the current design.** Today the app keys `<Editor>` by `draft-${draftSeq}` or `selected.id`, so switching items **fully unmounts and remounts** the editor. That remount is not incidental — it is the mechanism that cancels in-flight AI streams, prevents a late title-generation from writing into the item you just left, and resets every flag. Tabs require the *opposite*: switching must preserve each item's session. This is confirmed fact, not conjecture (see §5, both claims CONFIRMED by adversarial verification).
- **The palettes break a rule written in three places** (`DESIGN.md`, root `CLAUDE.md`, `notes-app/CLAUDE.md`: "themes swap neutrals only; the highlighter yellow, danger red, and status-dot colors are constant"). The requester has chosen to relax it; the plan updates all three docs **in the same change** so they don't become a lie.
- **The palettes are two orthogonal axes**, not one flat enum: *polarity* (light/dark, which the existing dark-only CSS keys on) and *accent family*. Model them so the existing `[data-theme="dark"]` rules keep working.
- **The riskiest single part** is the tab bar's interaction with the editor's carefully-tuned async cancellation/stale-guard logic. The mitigation (keep editors mounted-but-hidden, gate the global Ctrl+S listener on `active`) leaves that logic untouched — the lowest-regression path.

**Highest-level approach:** Land Phase A + the palette CSS first (independently verifiable via typecheck/build), wire the picker, then build tabs last using the app's existing "keep both pages mounted, hide the inactive one" pattern so the fragile streaming Editor is never rewritten.

## 3. Research Findings

*(architect + frontend-specialist — read-only; every path relative to `notes-app/`)*

### 3.1 How the app works today (the baseline the tabs must generalize)

- **Selection is single and list-derived.** `App.tsx` holds one `selectedId` and one `draft`; `selected = draft ?? items.find(i => i.id === selectedId)` (App.tsx:165). `PromptsPage.tsx` keeps its own separate `selectedId`/`draft`/`draftSeq` for prompts (59–61, 109). There is no "open set" concept anywhere.
- **The editor is remounted on every selection change** via `key={draft ? \`draft-${draftSeq}\` : selected.id}` (App.tsx:382; PromptsPage.tsx:188 for `<PromptEditor>`). Remount is the reset mechanism — it discards the previous item's unsaved edits and cancels its in-flight AI stream.
- **All edit state is local to the Editor.** `title/body/status/priority/dueAt/tags/projectId/jiraUrl/dirty` are `useState` inside `Editor.tsx` (61–70), re-seeded from `item` by an effect keyed on `[item.id, isDraft]` (120–149). `dirty` is private to the Editor; App/PromptsPage do not know it.
- **Save routes child→parent.** Editor builds the DTO and calls `onSave`/`onCreate` props; App implements them via `mutate(() => api.updateItem/createItem)` → `refreshAll()`. The child clears its own `dirty` only on a truthy return. App owns all IPC.
- **"Keep mounted, hide inactive" already exists** for the Worknotes/Prompts page switch: both `.page-body`s stay mounted and the inactive one is hidden (`hidden` + `.page-body[hidden]{display:none}` / `display:contents`, styles.css ~129–135; App.tsx comment at 66–68). **This is the exact pattern the tab bar reuses** to preserve per-tab edit state.
- **Theme handling is a binary toggle** written to `<html>`: `theme: "light"|"dark"` state seeded from `localStorage["theme"]` with a whitelist (`=== "dark" ? "dark" : "light"`, App.tsx:62–64), applied in an effect that sets `document.documentElement.dataset.theme` and persists (App.tsx:82–85). There is **no palette concept and no `data-palette`** anywhere. `[data-theme="dark"]` in styles.css overrides **neutrals only**; accents live once in `:root`.
- **Tokens map 1:1.** Every mock CSS var (`--bg --surface --ink --muted --line --surround --outer --mark --mark-soft --mark-ink --danger --todo --doing --done`) has an identically-named real token in `src/styles.css` (6–39). `--surround`/`--outer` are **defined but unused** by any shipped rule (only the mock's preview harness consumes them) — map them for parity; they render nothing (no custom window chrome exists in `tauri.conf.json`).
- **Confirmations must use `api.confirmDialog()`** (the dialog plugin's async `ask()`), never `window.confirm` — the Tauri webview silently suppresses `window.confirm` (notes-app/CLAUDE.md). This governs the close-dirty prompt.
- **Real CSS values confirmed against source** (so the handoff's exact pixels transfer with no recompute): `.editor` padding is `18px 22px` (matches the mock's `-18px -22px 0` full-bleed negative margin); `.rail-actions` is `padding: 12px 12px 0` today (matches the Change 4 "before").

### 3.2 Change-3 nuance (AI-bar reposition)

The current `Editor.tsx` body order is roughly `header → meta → JiraRow → review card → textarea → AiBar`; the handoff's target order (`title → body → JIRA → AiBar → review`) is copied from the mock, which **omits the `.meta` row** (status/priority/tags/pin) entirely. The concrete, unambiguous instruction is: **move `.aibar` to directly above the proposed-rewrite review card.** Keep `.meta` where it is. Treat the mock's full ordering as illustrative, not a directive to delete/relocate `.meta`. Apply the same reposition in `PromptEditor.tsx` (357–401 region). Classes are unchanged; this is DOM order only.

### 3.3 Palette token sets (authoritative — use these exact hexes)

All five, each a full 14-token set. `--doing (#d9a441)` and `--done (#4c8a64)` are **constant across all palettes**; `--todo` tracks each palette's muted gray; `--mark*` and `--danger` now vary (the invariant relaxation). **`v2-dark --mark-soft` is `#14312b`, NOT the `#dcf7f0` printed in the README swatch** — see §5, verified.

| token | Original (light) | v2-light | v2-dark | neon-noir (dark) | claude-terminal (dark) |
|---|---|---|---|---|---|
| polarity | light | light | dark | dark | dark |
| `--bg` | `#f1f0ec` | `#eef0ef` | `#161717` | `#000000` | `#1a1714` |
| `--surface` | `#fbfaf8` | `#ffffff` | `#1f2020` | `#2d2d2d` | `#262019` |
| `--ink` | `#23272a` | `#2b2b2b` | `#e8e8e8` | `#eaeaea` | `#ede4d3` |
| `--muted` | `#6e7378` | `#898989` | `#898989` | `#8a8a8a` | `#8c8377` |
| `--line` | `#e3e1db` | `#d9d9d9` | `#3a3b3b` | `#3a3a3a` | `#38322a` |
| `--surround` | `#dcdad4` | `#d9d9d9` | `#2a2b2b` | `#141414` | `#141110` |
| `--outer` | `#ccc9c1` | `#c6c6c6` | `#3a3b3b` | `#333333` | `#332c24` |
| `--mark` | `#f6e05e` | `#4dddbc` | `#4dddbc` | `#2cff05` | `#d97757` |
| `--mark-soft` | `#fbf3c9` | `#dcf7f0` | **`#14312b`** | `#10240a` | `#3a251d` |
| `--mark-ink` | `#6b5c0e` | `#0f5f50` | `#7ff0d8` | `#a6ff8f` | `#f0b199` |
| `--danger` | `#b4533a` | `#ff4d4d` | `#ff4d4d` | `#bf00ff` | `#c0553a` |
| `--todo` | `#9aa0a6` | `#898989` | `#898989` | `#8a8a8a` | `#8c8377` |
| `--doing` | `#d9a441` | `#d9a441` | `#d9a441` | `#d9a441` | `#d9a441` |
| `--done` | `#4c8a64` | `#4c8a64` | `#4c8a64` | `#4c8a64` | `#4c8a64` |

**Per-palette override rules (literal hexes, not tokens — they differ per palette, so a single shared dark rule cannot serve them):**
- **Dark solid buttons** (`.btn`): v2-dark `#2a2b2b` / hover `#333434`; neon-noir `#333434` / `#3f4040`; claude-terminal `#332b23` / `#3f352b`. (Today's dark theme has no such override — it is new.)
- **Review badge** (`.review-mark` "Proposed rewrite" text): base uses `var(--mark-ink)` (correct for Original & v2-light); dark palettes need literal dark text for contrast on the accent — v2-dark `#063a30`, neon-noir `#06210a`, claude-terminal `#3a1c10`.
- **Change 5** (v2-light only): `.rail-actions .btn { background: var(--surface); border-color: var(--line); color: var(--ink); }`, hover `background: var(--bg)`. Must be scoped to v2-light so it never leaks into Original's solid-ink create buttons.

### 3.4 Tab bar architecture (recommended)

- **One reusable `<EditorTabs>` component**, controlled/presentational, used by both pages (status dot rendered for items, omitted for prompts). Props: `tabs` (key, title, optional dot descriptor, dirty), `activeKey`, `onActivate(key)`, `onClose(key)`, `onNew()`, `listLabel`, `newLabel`.
- **Tab identity must be `itemKey(item)` = `${projectId}:${id}`** (reuse `src/lib/projects.ts`'s existing `itemKey`), **not `item.id`** — item ids are only unique within a project store, and multiple projects can be loaded. Prompt tabs key on the prompt id.
- **Drafts have `id: ""`** (`src/lib/draft.ts`) — assign each open draft a synthetic stable key (`draft-${seq}`, mirroring today's remount-key convention). On save, **promote** the draft's tab key to the created item's real key so the tab stays open.
- **Keep each open tab's `<Editor>`/`<PromptEditor>` mounted, hidden via `hidden={key !== activeKey}`** — mirrors the page-body pattern. Each instance keeps its own local edit buffer, so per-tab unsaved edits and in-flight streams survive a tab switch **for free** — no shared draft store needed.
- **Surface dirty upward with an `onDirtyChange(dirty)` callback** (mirroring the existing `onTargetChange`/`onPromptProjectChange` prop pattern), fired only on dirty↔clean transitions so keystrokes don't re-render the parent. Do **not** lift the whole edit buffer or make `dirty` a controlled prop.
- **Gate the global Ctrl+S listener on an `active` prop** so only the visible editor saves (see §5, confirmed hazard).
- **`openItems`/`activeKey`/`dirtyByKey` live in `App.tsx` for items and `PromptsPage.tsx` for prompts**, mirroring today's split. A small shared hook (`useOpenTabs`) may dedupe the logic but stays plain React state — no new dependency, no global store.
- **Extract pure tab-state transitions into `src/lib/openTabs.ts`** (open/activate/close/setDirty), so the invariant-bearing logic is unit-testable in the node-env vitest setup (the project convention: put invariant logic in a pure `src/lib` module rather than testing through the DOM).

### 3.5 Prior art to reuse

- `page-tabs` in `App.tsx` (308–333) + styles.css (94–135): a working WAI-ARIA tablist with `role="tablist"/tab`, `aria-selected`, roving `tabIndex`, and arrow-key handling (`onPageTabKeyDown`). `EditorTabs` mirrors this rather than re-deriving keyboard behavior from the mock.
- `itemKey()` in `src/lib/projects.ts` — tab identity.
- `aiProvider.ts` (whitelist-validated persisted enum) — the pattern to model the palette registry + persisted-id validation on (its real code is a two-value ternary; the 5-value registry needs a membership check against an id list, not a literal copy).
- `installLocalStorage()` in `aiProvider.test.ts` — clone for palette-persistence tests.

## 4. Security Considerations

*(security-auditor — read-only; overall posture **low risk**, single-user local-first app, no network surface. No critical/high/medium findings.)*

Requirements to build in from the start:

1. **Render `.etab-title` as a React child (`{item.title}`)** — never `dangerouslySetInnerHTML`, never build an HTML `title=` string from it. The codebase has zero `dangerouslySetInnerHTML`/`innerHTML`/`eval` today (title renders in `ItemList.tsx:197` and a controlled input in `Editor.tsx`); tab titles render user-controlled text in a new place, so keep the safe pattern. *This is the single most important thing to verify in the diff.*
2. **Whitelist the palette id against the fixed set of five before persisting and before writing it to the DOM attribute** — mirror the theme whitelist at `App.tsx:63` and `aiProvider.ts:13`. Unknown/stale value → deterministic default (`original`).
3. **Apply palettes only via a data-attribute selecting predefined static CSS blocks** in `styles.css` (like `[data-theme="dark"]`). Never interpolate the palette id into a CSS selector string, `querySelector`, a runtime `<style>`, or `element.style`. (No such dynamic-style code exists today — do not introduce it.)
4. **Do not weaken the CSP** (`tauri.conf.json:23` = `default-src 'self'; connect-src 'self'`). No `'unsafe-inline'`, no runtime stylesheet injection — the static-token approach needs none.
5. **Keep `openItems`/draft/`isDirty` tab state in memory.** If tab state is ever persisted, store only item **ids** (re-fetch bodies), never titles/bodies, and never an unsaved buffer — otherwise plaintext note content lands in the WebView2 profile outside the project store.
6. **Add no new npm/cargo dependency** for tabs, state, or theming. Multi-tab state is plain `useState`; palettes are CSS. A state/tab/color library would be unjustified attack surface.
7. **Do not touch `src/lib/api.ts`, Tauri commands, or keyring paths.** Verify the diff adds no `invoke()` outside `api.ts` and no key/token commands.

## 5. Design

### Verification gate results (§ adversarial-verifier)

Three load-bearing claims were verified before shaping the design; all **CONFIRMED** with file:line evidence:

- **CONFIRMED — remount-on-select.** `<Editor>` (App.tsx:382) and `<PromptEditor>` (PromptsPage.tsx:188) remount on selection. This discards local edits (re-seed effect Editor.tsx:120–149) and cancels the in-flight AI stream (cleanup 144–148 → `stopRef` → backend `ai_rewrite_cancel`, api.ts:230–234). *Consequence:* a single remounting editor cannot back a tab bar that preserves edits/streams → **keep editors mounted-hidden**.
- **CONFIRMED — Ctrl+S multi-fire.** `Editor.tsx:239–248` and `PromptEditor.tsx:185–194` register a **window-level** keydown save listener with no active/focus gate; the only guard (`savingRef`) is per-instance. N mounted editors → N concurrent saves on one Ctrl+S → **must gate on `active`**.
- **CONFIRMED — v2-dark `--mark-soft` = `#14312b`.** The README swatch's `#dcf7f0` is a copy-paste from v2-light; the variant file and the dedicated dark swatch sheet both use `#14312b` (dark teal review-card fill; `#dcf7f0` under dark neutrals with light `--mark-ink` would be unreadable). neon-noir `#10240a` and claude-terminal `#3a251d` agree README↔variant and are correct as written.

### Approach

Three phases, ascending risk, each independently shippable and verifiable:

**Phase A — Cosmetic (Changes 2, 3, 4).** Pure CSS + one DOM reorder. No new state. Verify with typecheck + build + eyeball.

**Phase B — Theme picker + 5 palettes (Change 6 + Change 5).** Add a `data-palette` attribute alongside a polarity `data-theme`; define all five palettes as full-token CSS blocks; add per-palette button/badge overrides and the v2-light create-button softening; build a `palettes.ts` registry with validated persistence; add a picker control to the topbar; apply synchronously on load (no flash); drop legacy Original-dark; update the invariant docs.

**Phase C — Tab bar (Change 1).** New `EditorTabs` component + `openTabs.ts` pure reducer; transform App/PromptsPage from single-selection to `openItems`/`activeKey`/`dirtyByKey`; render one mounted-hidden editor per tab; add `active` (gates Ctrl+S) and `onDirtyChange` props to both editors; wire close/adjacent/dirty-prompt; handle draft keying and refresh reconciliation; generalize unload/reload to sweep all open tabs of a project; add the `.editor-tabs` CSS block.

### Architecture

- **Theming (two orthogonal axes):**
  - `data-theme` stays `"light" | "dark"` = *polarity*, so the existing `[data-theme="dark"]` calendar-invert rule (styles.css ~958–960) and any polarity-conditional rule keep working unchanged.
  - `data-palette` (new) `= "original" | "v2-light" | "v2-dark" | "neon-noir" | "claude-terminal"` = *accent family + neutrals*.
  - Palette blocks are the authoritative token source, written as compound selectors `:root[data-palette="…"] { …all 14 tokens… }` (specificity 0,1,1) so they reliably beat the legacy neutral block regardless of source order. Per-palette overrides use `:root[data-palette="…"] .btn` / `.review-mark` / `.rail-actions .btn`.
  - Selecting a palette sets **both** attributes atomically (the palette declares its polarity), preventing invalid combinations like light-neutrals + neon-noir accent.
  - Apply both attributes on `<html>` only (as today). The handoff's requirement to set `data-theme="dark"` on "both `<body>` and `.app`" is a mock/preview-harness artifact — CSS custom properties defined on `:root`/`<html>` cascade to all descendants, so `<html>` alone is sufficient and correct; do **not** replicate the body+.app duplication.
  - Model the picker as **one control with five named entries**, not two free toggles (only v2 has both a light and a dark variant).
- **Tab bar:** as detailed in §3.4 — `EditorTabs` (presentational) + per-page `openItems`/`activeKey`/`dirtyByKey` state + N mounted-hidden editor instances + `openTabs.ts` pure reducer. Rail-row click and the New/`+` actions all funnel through one "open-or-activate" function so the empty state and the strip can never disagree.

### Key Decisions

1. **Keep-mounted-hidden over single-editor-with-lifted-state.** Rewriting the streaming Editor into a controlled/store-driven form is the highest-blast-radius change in the app and speculative; the mounted-hidden pattern reuses proven code and leaves the async cancellation/stale-guard logic untouched. Accepted costs: N mounted editors (N is small, single user) and the obligation to gate Ctrl+S on `active` and surface dirty via callback.
2. **`data-palette` + polarity `data-theme` over a single 5-value `data-theme`.** Overloading `data-theme` would lose the light/dark signal the calendar-invert and dark-button rules key on and force every polarity rule rewritten per value. The two-axis model keeps "swap neutrals" and "swap accent" separable and lets the palette feature be rolled back (delete `data-palette` support) without touching `data-theme`.
3. **Close-dirty = save prompt via `api.confirmDialog()`** with Cancel / Discard / Save semantics (the manual-smoke script assumes this). "Save on close" of a background tab needs a `useImperativeHandle` on Editor to reach its `save()`; MVP may use confirm-to-discard, but the recommended target is the three-way prompt reusing existing dialog machinery. **Never `window.confirm`.**
4. **Tab title = live-edited title when available, else saved `item.title`.** Because each editor stays mounted, its live title can be surfaced up the same way as `dirty` (via callback) so a renamed-but-unsaved tab shows the new name. If that proves noisy, fall back to saved `item.title` (matches the mock). Decide during implementation; default to saved title for MVP simplicity, upgrade if desired.
5. **Rail-row click becomes "open-or-activate," not "replace."** The `+` button implies additive tabs; clicking a rail row opens a tab for that item (or activates the existing one). New note/task/prompt open a fresh draft tab. This changes `selectRow`'s contract and must be applied symmetrically in both pages.
6. **Legacy Original-dark is dropped (requester decision).** Handle the migration of an existing `localStorage["theme"] = "dark"`: on first load post-change, default to `original` (light) if no `palette` key exists. *Optionally* map a legacy `theme=dark` to `v2-dark` so a dark-mode user isn't jarred into light — flagged as an open question with "default to `original`" as the safe fallback.
7. **Update the invariant docs in the same change.** `DESIGN.md`, root `CLAUDE.md`, and `notes-app/CLAUDE.md` all state "themes swap neutrals only; accent/danger/status-dots constant." Amend to: doing/done dots constant; todo tracks the palette muted gray; `--mark` and `--danger` vary per selected palette; five named palettes selected via `data-palette` (+ polarity `data-theme`).

## 6. Implementation Steps

### Phase A — Cosmetic (low risk, ship first)

1. **Change 2 — title tightening.** In `src/styles.css`, `.title`: `font-size: 22px → 17px`, `padding: 6px 2px → 2px 2px`. Leave `flex`, `font-weight: 650`, and the transparent-border hover/focus behavior untouched.
2. **Change 4 — rail padding.** In `src/styles.css`, `.rail-actions`: `padding: 12px 12px 0 → 12px 12px 12px`.
3. **Change 3 — reorder the editor body (notes).** Target DOM order in `Editor.tsx`: `header/title → meta → body <textarea> → JiraRow → AiBar → proposed-rewrite review card`. This is two moves from today's `… meta → JiraRow → review → textarea → AiBar`: (a) move the body `<textarea>` **up** to sit directly below `.meta` and **above** `JiraRow` (matching the handoff's "title → body → JIRA" order), and (b) move `<AiBar>` to sit **directly above** the review card. Keep `.meta` in place (see §3.2). No class/logic changes — DOM order only. *(This resolves the reviewer's note: the naive "just move AiBar" would leave the textarea last, contradicting the handoff.)*
4. **Change 3 — reorder the editor body (prompts).** Apply the equivalent reorder in `PromptEditor.tsx` (no JIRA row): `title → body <textarea> → AiBar → review card`.
5. **Verify Phase A:** `npx tsc --noEmit`, `npm run build`; smoke the editor for both notes and prompts (title size; AI bar now above the proposed-rewrite card during/after a rework; rail spacing clears the project dropdown).

### Phase B — Theme picker + palettes

6. **Add the five palette blocks to `src/styles.css`.** `:root[data-palette="original"]` (may reuse existing `:root` values), plus `v2-light`, `v2-dark`, `neon-noir`, `claude-terminal`, each defining all 14 tokens from the §3.3 table (v2-dark `--mark-soft` = `#14312b`). Keep `--doing`/`--done` constant.
7. **Add per-palette overrides** (§3.3): dark `.btn` background/hover for v2-dark, neon-noir, claude-terminal; `.review-mark` text color for the three dark palettes; and **Change 5** — the v2-light-scoped `.rail-actions .btn` softening.
8. **Create `src/lib/palettes.ts`** — a registry of the five palettes (`id`, `label`, `polarity`) modeled on `aiProvider.ts`, plus `getStoredPalette()` (whitelist-validated read with `original` fallback) and `setStoredPalette(id)`.
9. **Wire palette state in `App.tsx`.** Replace the `theme` `useState`/effect with palette state seeded from `getStoredPalette()`; in the effect set **both** `document.documentElement.dataset.palette = id` and `dataset.theme = POLARITY[id]`, and persist via `setStoredPalette`. Remove the binary light/dark toggle button.
10. **Add the picker UI to the topbar** (replacing the old Light/Dark button) — a **`<select>` dropdown** listing the five palette labels, styled to sit alongside the existing `btn`/`btn-quiet` topbar controls. (Decision: a dropdown, not a cycle button — cycling five palettes needs up to four clicks; a `<select>` is one action and is the only new element type introduced.) Selecting one sets palette state.
11. **No-flash initial apply.** Set `data-palette` + `data-theme` synchronously before React renders — either a tiny inline `<script>` in `index.html` reading `localStorage["palette"]` (whitelisted) or a module-level statement in `main.tsx` before `createRoot().render()`. (This also fixes the pre-existing single-axis flash.)
12. **Drop legacy Original-dark & handle migration.** Ensure no code path can select a yellow-accent dark. Default to `original` when no `palette` key exists; optionally map a stale `theme=dark` → `v2-dark` (open question — see §10).
13. **Update invariant docs** (§ Key Decision 7). In `notes-app/docs/DESIGN.md` the rule and the old toggle description appear in **at least four places — amend all of them** so the doc isn't self-contradictory: `DESIGN.md:5` ("a dark theme swaps only the neutral palette"), `DESIGN.md:19–24` ("Constant across both themes (never re-themed)" + the yellow/danger/status-dot hexes), `DESIGN.md:34` (describes the `Dark`/`Light` topbar button being replaced by the picker), `DESIGN.md:70` ("Theme toggle swaps the neutral palette only"). Also amend the styling invariant line in root `CLAUDE.md` and `notes-app/CLAUDE.md`.
14. **Verify Phase B:** `npx tsc --noEmit`, `npm run build`, `palettes.test.ts` green; smoke all five palettes in `npm run tauri dev` (contrast in every pane; v2-light soft buttons don't leak to Original; dark button/badge overrides correct; relaunch restores the picked palette; no flash).

### Phase C — Tab bar

15. **Create `src/lib/openTabs.ts`** — pure reducer over `{ openItems, activeKey }` (+ a `dirtyByKey` map or dirty-on-tab): `openTab`, `activateTab`, `closeTab`, `setDirty`, and a key helper that never collapses distinct entities/projects. **Adjacency rule (decided, not deferred):** when the active tab is closed, activate its **right neighbor** if one exists, otherwise its **left neighbor**; when the last remaining tab is closed, `activeKey → null` (empty state). The `openTabs.test.ts` cases and the manual-smoke script both assert exactly this rule.
16. **Create `src/components/EditorTabs.tsx`** — presentational tablist per §3.4/§3.5: reuse the `page-tabs` ARIA + roving-tabindex + arrow-key pattern; render `.dot`/`.pin` for item tabs, omit for prompts; real `<button>` for the close ×, **not** a nested `role=button` span (fix the mock's button-in-button — model on the `tag-badge`/`tag-x` sibling pattern); `aria-label={\`Close ${title}\`}`; `.etab-new` "+". Move focus to the newly-activated tab on close; `scrollIntoView({inline:"nearest"})` on keyboard nav.
17. **Add the `.editor-tabs`/`.etab`/`.etab-*`/`.etab-new` CSS block** to `src/styles.css` verbatim from the handoff (values already match the real `.editor` padding), inserted after `.editor-empty`. Render **one** shared `<EditorTabs>` above the editor stack (not one per mounted editor); add a comment that the full-bleed negative margin must track `.editor`'s `18px 22px` padding.
18. **Add `active` + `onDirtyChange` props and an imperative `save()` handle to `Editor.tsx`.** Gate the window Ctrl+S listener so it only saves when `active`. Fire `onDirtyChange` on dirty↔clean transitions (in the `edit()` wrapper and post-save `setDirty(false)`). Add `role="tabpanel"`/`aria-labelledby` to the editor section. **Wrap the component in `forwardRef` and expose `save(): Promise<boolean>` via `useImperativeHandle`** so a background (mounted-hidden, non-active) tab can be saved from the close-dirty "Save" branch — its title/body live only in that instance's local `useState` and cannot be reached otherwise. App/PromptsPage keep a `Map<tabKey, ref>` of these handles.
19. **Transform `App.tsx` to multi-open.** Replace `selectedId`/single `draft` with `openItems` (Item snapshots) + `activeKey` + `dirtyByKey`. Rewire: rail click → open-or-activate; New/`+` → add a draft tab (synthetic `draft-${seq}` key); `openDuplicateDraft` (the existing `Duplicate metadata` feature, App.tsx:192–196 / Editor.tsx:404–407) → **open the duplicated draft as a new tab** (it currently calls `setDraft`/`setSelectedId`, which this step removes — it must be rewritten, not left to break the build); `createFromDraft` → promote the draft key to the created item's `itemKey` so the tab stays open. Render `openItems.map` of `<Editor hidden={key!==activeKey} active={key===activeKey} onDirtyChange=… ref=…>`.
    - **Refresh reconciliation (do NOT diff against the filtered `items` list).** `items` is the rail-**filtered** result (kind/project/status/tag/search), so "not in `items`" does NOT mean "deleted" — a filter change would falsely close still-open tabs and lose their edits. Instead, after `refreshAll()`, reconcile each open tab by **re-fetching its item by id via `api.getItem(id)`** (App owns IPC): a not-found/reject means it was genuinely deleted → close that tab; otherwise **overwrite the snapshot's non-editable-state fields** (pinned/archived/tags/updatedAt/etc.) from the fresh fetch so Pin/Archive labels (rendered from the live `item` prop, Editor.tsx:499–509) don't go stale, **without** clobbering an unsaved dirty tab's in-progress edit buffer (which lives in the mounted instance, not the snapshot).
20. **Close semantics.** Close-active → activate adjacent (Step 15 rule); close-dirty → `api.confirmDialog` three-way (Cancel / Discard / Save). The **Save** branch calls the tab's imperative `save()` handle (Step 18) and closes only on a truthy result; **Discard** closes without saving; **Cancel** keeps the tab open with its edits intact. Wire `EditorTabs.onClose`/`onNew`/`onActivate`.
21. **Generalize unload/reload.** `unloadProject`/`reloadProject` must close/evict **every** open tab whose `projectId` matches (not just the single `selected`), and the confirm copy must reflect N open items (and warn if any of those tabs is dirty).
22. **Mirror to prompts.** Apply steps 15–21's equivalents to `PromptsPage.tsx` + `PromptEditor.tsx`: no status dot on prompt tabs; prompt-side `active`/`onDirtyChange`/Ctrl+S gate + imperative `save()`; prompt draft keying; prompt-side duplicate/open-or-activate. **Generalize `openPromptProjectId`** (App.tsx:74; reported up by PromptsPage) from a single project id to the **set of projects across all open prompt tabs**, so `unloadProject`'s confirm (App.tsx:231–237) fires even when a dirty prompt tab in the to-be-unloaded project is only a *background* tab, not the active one.
23. **Empty state.** When `openItems` is empty, render the existing `.editor-empty` placeholder and do not render the tab strip.
24. **Verify Phase C:** `openTabs.test.ts` green; `npx tsc --noEmit`; `npm run build`; run the full §8 manual-smoke walkthrough.

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `notes-app/src/styles.css` | Modify | `.title`/`.rail-actions` tweaks (A); 5 palette blocks + per-palette `.btn`/`.review-mark`/`.rail-actions .btn` overrides (B); `.editor-tabs`/`.etab*` block (C) |
| `notes-app/src/components/Editor.tsx` | Modify | Body reorder incl. textarea (A); `active` (gates Ctrl+S) + `onDirtyChange` props, `forwardRef`+`useImperativeHandle` `save()`, tabpanel ARIA (C) |
| `notes-app/src/components/PromptEditor.tsx` | Modify | Body reorder (A); `active`/`onDirtyChange`/Ctrl+S gate + imperative `save()` (C) |
| `notes-app/src/lib/palettes.ts` | Create | Palette registry + whitelist-validated persisted-id get/set (B) |
| `notes-app/src/lib/palettes.test.ts` | Create | Registry invariants + persistence validation/fallback (B) |
| `notes-app/index.html` (or `src/main.tsx`) | Modify | Synchronous no-flash palette/theme apply before render (B) |
| `notes-app/src/App.tsx` | Modify | Palette state + picker + `data-palette`/polarity effect, drop light/dark toggle (B); multi-open state, open-or-activate, `openDuplicateDraft` rewrite, per-tab `save()` ref map, `api.getItem`-based refresh reconciliation, unload/reload sweep (C) |
| `notes-app/src/lib/openTabs.ts` | Create | Pure tab-state reducer (open/activate/close/setDirty, keying) (C) |
| `notes-app/src/lib/openTabs.test.ts` | Create | Reducer happy/edge/error cases (C) |
| `notes-app/src/components/EditorTabs.tsx` | Create | Reusable presentational tablist (items + prompts) (C) |
| `notes-app/src/components/PromptsPage.tsx` | Modify | Prompt-side multi-open state + tab wiring, open-prompt-project reporting for N tabs (C) |
| `notes-app/src/hooks/useOpenTabs.ts` | Create *(optional)* | Dedupe open-set logic across the two pages (C) |
| `notes-app/src/components/ItemList.tsx` / `PromptList.tsx` | Modify *(if needed)* | Adjust `onSelect` contract to open-or-activate (C) |
| `notes-app/docs/DESIGN.md` | Modify | Amend the "themes swap neutrals only" invariant (B) |
| `CLAUDE.md` (root) & `notes-app/CLAUDE.md` | Modify | Amend the same styling invariant (B) |

## 8. Test Strategy

*(test-writer — strategy only. Confirmed: `vitest` runs in **node env** ("pure-helper unit tests only, no DOM"); there is **no** `@testing-library/react`/`jsdom` and **none should be added** — put invariant logic in pure `src/lib` modules and cover the rest by manual smoke, consistent with how all of `App.tsx`/`Editor.tsx` are handled today. `src-tauri` tests are unaffected — confirmed no tab/palette surface in `repo.rs`.)*

- [ ] **Unit Tests — `openTabs.ts` (`vitest run`, node, no mocks):**
  - `openTab`: into empty → single active tab; second distinct → appended at end + active, first untouched; already-open key → no duplicate, becomes active (assert the position rule explicitly); fresh tab starts `isDirty:false`; item and prompt sharing an id are two distinct tabs.
  - `activateTab`: existing non-active → only `activeKey` changes, order bit-for-bit unchanged; already-active → idempotent; **unknown key → no-op, no dangling active** (error case).
  - `setDirty`: flips only the target tab; unknown key → no-op; dirty→clean on save.
  - `closeTab`: non-active removed, active unchanged, order preserved; only tab → empty + null active (matches empty-editor placeholder); active-first / active-last / active-middle → the documented adjacent neighbor activates; unknown key → no-op; closing removes only its own dirty bookkeeping.
  - Key helper: same id different entity ("item" vs "prompt") never collapse; same id different `projectId` never collapse; tolerates null `projectId`.
- [ ] **Unit Tests — `palettes.ts` (mirror `aiProvider.test.ts`; clone its `installLocalStorage()`):**
  - Registry has exactly 5 unique ids, each with the fields the picker/apply need (id, label, polarity).
  - Persisted-id get: known id returned; unset → `original`; unrecognized/stale → `original`; round-trip set→get for all 5.
  - Each palette's declared polarity matches the §3.3 table (guards the atomic-set logic).
- [ ] **Integration Tests (only if the orchestration is extracted into injectable functions, per `titleForSave.ts`'s inject-the-async-dep pattern; otherwise defer and note it — matches today's zero coverage of `App.tsx` inline flows):**
  - Opening a not-yet-open item appends + activates a tab; item and prompt sharing an id both open distinctly.
  - Save whose injected callback resolves `true` clears the active tab's `isDirty`; resolves `false`/rejects **leaves it dirty** (parallels Editor's "rejected save stays dirty" rule); saving one tab doesn't clear another's.
  - Deleting/archiving the active open item closes its tab + activates adjacent; non-active → only that tab closes; last → empty state.
  - Mocks: inject save/delete/archive/confirm as `vi.fn().mockResolvedValue/mockRejectedValue`; do **not** `vi.mock('@tauri-apps/api/core')` or import `api.ts` (no test does today).
- [ ] **Edge Cases & Error Scenarios:** unknown-key operations are no-ops (above); empty-open-set renders the placeholder; a failed save keeps the tab dirty; stale/garbage persisted palette id falls back; draft-key→real-key promotion on save keeps the tab open.
- [ ] **E2E / Manual smoke (`npm run tauri dev`) — the parts no unit test can cover:**
  - *(Change 2)* title size at 100/125/150% display scaling, no clip/wrap; *(Change 4)* rail spacing with short & long titles, no new scrollbar; *(Change 5)* soft create-buttons render **only** on v2-light, other four pixel-unaffected.
  - *(Change 3)* Rework input + chips render **above** the proposed-rewrite card (check DOM order); Tab order still sensible after the move; no z-index glitch mid-stream.
  - *(Tabs)* open 3+ mixed items; click each — content swaps, no wrong-item save after a fast switch; **type in tab A, switch to B, back to A — unsaved text + dirty dot still present** (highest-value check); close active-middle → correct neighbor activates, no empty flash; close a dirty tab → Cancel keeps it, Discard closes unsaved, Save persists then closes; close to zero → clean placeholder; overflow → horizontal scroll, no wrap, active scrolls into view; status dot on note/task tabs, fully omitted on prompt tabs; delete/archive an open item closes its tab; **unload/reload a project with multiple open tabs closes every matching tab** (including when a dirty tab in that project is only a background tab); **Ctrl+S multi-fire guard: open 3 tabs, make all three dirty, press Ctrl+S once → exactly the active tab saves** (the confirmed hazard from §5); **both pages populated at once: open several item tabs AND several prompt tabs, switch pages, confirm each side preserves its own tab set and edits** (item and prompt editors are all mounted simultaneously).
  - *(Palettes)* each of the five applies across topbar/rail/editor/dialogs/toasts with no un-themed flash and legible contrast (esp. dark palettes); switch away & back leaves no stale attribute; relaunch restores the picked palette.

## 9. Success Criteria

- [ ] **Functional (A):** title is 17px/tight padding; AI bar sits above the proposed-rewrite card in both editors; rail-actions clears the dropdown below it.
- [ ] **Functional (B):** all five palettes selectable from the topbar and applied live; selection persists across relaunch; no flash on load; v2-light soft create-buttons scoped correctly; dark button/badge overrides correct per palette; legacy yellow dark unreachable; invariant docs updated.
- [ ] **Functional (C):** multiple items/prompts open as tabs; switching preserves each tab's unsaved edits and in-flight rework; unsaved dot reflects dirtiness; close-active activates the right-then-left neighbor; close-dirty prompts (Cancel/Discard/Save via `confirmDialog`, Save actually persists the background tab); `+`/New open draft tabs; strip scrolls on overflow; status dot on item tabs only; deleting/archiving/unloading closes the right tab(s); **one Ctrl+S saves only the active tab**; a filter change never closes an open tab.
- [ ] **Tests:** `openTabs.test.ts` and `palettes.test.ts` pass (each proven able to fail against a deliberately-broken impl before being trusted); all existing `src/lib/*.test.ts` and `cargo test` still green.
- [ ] **Security:** all seven §4 requirements satisfied (title as JSX child; whitelisted palette id; no dynamic CSS/selector injection; CSP unchanged; tab state in memory; no new deps; `api.ts`/commands/keyring untouched).
- [ ] **Quality:** `npx tsc --noEmit` clean (strict, `noUnusedLocals`); `npm run build` clean; no unrelated refactoring bundled in.

## 10. Risks & Open Questions

- **Adversarial-verifier verdicts (all CONFIRMED — these drive the design, not open):** remount-on-select discards edits/cancels streams (→ keep-mounted-hidden); window-level Ctrl+S multi-fires (→ gate on `active`); v2-dark `--mark-soft` = `#14312b` (README swatch wrong). Full evidence in §5.
- **Invariant relaxation is intentional.** The five palettes changing `--mark`/`--danger` contradicts a rule in three docs; the requester approved it and the docs are updated in Phase B. If the invariant is ever reinstated, the two-axis model lets `data-palette` be removed without touching `data-theme`.
- **Open — legacy `theme=dark` migration.** Existing users with `localStorage["theme"]="dark"` lose the yellow dark theme. Default is `original` (light); *optional* map to `v2-dark` to avoid jarring a dark-mode user. Recommendation: default to `original`; decide during Phase B.
- **Resolved — close-dirty fidelity.** Decided: three-way prompt (Cancel/Discard/Save) with the Save branch calling an imperative `save()` handle on the tab (Steps 18/20). If the imperative-handle plumbing proves troublesome, the documented fallback is the two-way confirm-to-discard MVP (Cancel/Discard). Never `window.confirm` — always `api.confirmDialog`.
- **Resolved — mounted-editor count compounds across pages.** Because both the Worknotes and Prompts pages stay mounted (existing pattern), the real worst case is (open item tabs) + (open prompt tabs) all mounted at once, not N on one page. Acceptable for a single-user local app; no hard cap on open tabs is imposed (acknowledged, low risk). Covered by the both-pages-populated smoke case in §8.
- **Open — tab title source.** Live-edited title (needs the title surfaced up like `dirty`) vs. saved `item.title` (simpler, matches mock). MVP: saved title; upgrade if the stale-name-on-rename bothers.
- **Open — background AI stream on tab-switch.** Keep-mounted means an in-flight rework in a background tab keeps streaming (a "don't lose work" win) instead of being cancelled as today. Confirm this is desirable vs. cancelling on deactivate. Do not let it change by accident.
- **Mock a11y bugs must be fixed, not copied:** button-in-button (`role=button` span inside `<button>`) → sibling real buttons; add `aria-controls`/`role="tabpanel"`; per-tab close label. (frontend-specialist.)
- **Full-bleed clipping check:** negative-margin `.editor-tabs` relies on no ancestor `overflow:hidden` in `.panes`/`.editor` (none today) — verify visually at the rail edges.
- **Re-render hygiene:** memo `EditorTabs`; keep tab metadata as primitives so a keystroke in one tab doesn't re-render sibling mounted editors.
- **No new dependency** is introduced anywhere (security + test + architect all concur). Flag in review if one creeps in.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` is on).
- [ ] Error handling covers failure modes (failed save stays dirty; unknown-key tab ops are no-ops; stale palette id falls back).
- [ ] No security vulnerabilities: `.etab-title` renders as a JSX child (no `dangerouslySetInnerHTML`/`title=` string); palette id whitelisted and never interpolated into a selector/`<style>`; CSP unchanged; tab state in memory.
- [ ] All §4 security requirements addressed.
- [ ] Follows existing conventions: ARIA tablist mirrors `page-tabs`; confirmations via `api.confirmDialog`; `itemKey` reused for identity; palette registry mirrors `aiProvider.ts`.
- [ ] Tests cover happy path, edge, and error cases; each new test shown able to fail against a broken impl.
- [ ] No performance regressions: `EditorTabs` memoized; a keystroke re-renders only the active editor; Ctrl+S gated so only one save fires.
- [ ] Changes are minimal — no reformatting/renaming outside the touched rules; `.meta` not relocated by Change 3; `src-tauri`/`api.ts` untouched.
- [ ] Files touched match this table (§7); no `invoke()` added outside `api.ts`.

## 12. Post-Review Improvements

Implementation ran phase by phase (A → B → C), each verified before the next. Reviews used subagents: a code-reviewer per phase, a test-writer (proved every new test can fail against a deliberately-broken impl), a security-auditor (all seven §4 requirements PASS, zero findings), and a frontend-specialist for the tab-bar a11y/CSS. Final gates: `npx tsc --noEmit` clean, `npm run build` clean, `npx vitest run` **161 passed (12 files)** incl. the new `openTabs.test.ts` (28) and `palettes.test.ts` (28).

### Implemented (from the reviews)

**Phase B (code-reviewer):**
- Rewrote the now-false `/* Accents — constant across both themes */` comment and the `:root` neutral comment in `styles.css` — the exact invariant-drift Key Decision 7 required eliminating *everywhere*, previously left inside the CSS file.
- Annotated the legacy `[data-theme="dark"]` neutral block as a specificity-losing fallback superseded by the palette blocks (it no longer takes visible effect but stays as a fallback + polarity hook for the calendar-invert rule).
- Corrected the CSS-comment specificity `0,1,1` → `0,2,0` (an arithmetic error inherited from the plan) and added `--todo` to the "varies per palette" list.
- Added an explicit `isPaletteId` whitelist gate at the picker `onChange` write-site (§4.2 defense-in-depth), replacing an unchecked `as PaletteId` cast.

**Phase C (code-reviewer + frontend-specialist):**
- **CRITICAL — reload now sweeps open prompt tabs.** `reloadProject` previously closed/warned only *item* tabs; since prompts share the same per-project store that reload rebuilds, an open prompt tab could silently clobber the freshly-reloaded file on a later save. It now consults `openPromptProjectIds` for the confirm gate and bumps a `reloadSignal` prop that makes `PromptsPage` close its own saved prompt tabs of the reloaded project (its `loaded`-driven close effect doesn't fire on reload, since the project stays loaded).
- **Close-dirty dialog copy** rewritten from "OK — …/Cancel — …" to Yes/No phrasing: the dialog plugin's `ask()` renders **Yes/No** buttons (not OK/Cancel), so the old copy named buttons that don't exist.
- **Reconcile no longer drops a dirty tab's edits on a transient fetch failure.** `reconcileTabs`/`reconcilePromptTabs` still close a tab whose `getItem`/`getPrompt` rejects (genuine delete) — but only when it is *clean*; a dirty tab is kept so a locked-file/I-O hiccup can't silently discard unsaved work (a real deletion surfaces on the next save).
- **Focus-follow rewritten from a pre-set flag to removal-detection.** The old `focusActiveOnRender` flag could go stale after a *cancelled* dirty-close and later steal focus on an unrelated activation. It now keys focus movement on an actual key disappearing between renders, only when focus was orphaned to `<body>` or still inside the strip.
- **a11y:** the `role="tab"` div now has an explicit `aria-label={title}` (its accessible name was otherwise polluted by the close button's "Close …" label and the pin/dot `title=` attributes).
- **a11y:** closing the *last* tab now moves focus into the empty-editor placeholder (`tabIndex={-1}` + ref) instead of dropping it to `<body>`.
- **Contrast:** `.etab-x:hover` gets per-dark-palette literal dark text (v2-dark `#063a30`, neon-noir `#06210a`, claude-terminal `#3a1c10`), mirroring the `.review-mark` override — the base `var(--mark-ink)` is a *light* tone in dark palettes, so the × was near-invisible on the accent fill.
- Minor: the unload confirm pluralizes the prompt case ("open prompt(s)").

### Deferred (documented, with rationale)

- **Draft→real key promotion remounts the editor** (loses an unapplied AI proposal / in-flight stream / focus on saving a *draft*). This matches pre-Plan-11 behavior (drafts always remounted on save, when the React key went `draft-N` → `selected.id`), so it is not a regression; the clean fix (a stable per-tab React key, decoupled from the identity key) adds a field to the tested `Tab` shape and is a non-parity enhancement — deferred.
- **`Editor`/`PromptEditor` not memoized.** A dirty-transition keystroke (only the first char of an edit; subsequent keystrokes are guarded) re-renders every mounted editor of that page rather than "only the active editor" (§11). Practical cost is negligible at single-user tab counts (a cheap re-render, local state preserved); full memoization needs every per-tab callback stabilized (and `loaded` memoized) — disproportionate. Deferred; `EditorTabs` itself *is* memoized.
- **Active-tab→editor "connected" seam in neon-noir.** `.etab-on` is `--surface` while the editor content area shows `--bg`; the seam is only pronounced where `--bg`/`--surface` differ sharply (neon-noir `#000`/`#2d2d2d`). Giving `.editor` a `--surface` background would flatten the textarea/editor contrast across *all* palettes — a broad visual change deferred pending a deliberate design call.
- **`.etab-unsaved` dot** fill/border are similar-luminance in the dark palettes — cosmetic only, not a WCAG failure (the dot-vs-surface contrast that 1.4.11 requires is fine). Deferred.
- **Unload confirm's "unsaved changes in N of them" warning** counts only item tabs, not prompt tabs (App doesn't track prompt dirty state) — the confirm still *fires* for an open prompt. Deferred.

### Environment / unverified

- **`cargo test` could not be run to completion on this machine.** The first run crashed `rustc` with `STATUS_STACK_BUFFER_OVERRUN`; `cargo clean` + rebuild then hit `windows`-crate codegen OOM / rlib-metadata errors — the documented disk + commit-limit constraint on this box, not corruption and not a code defect. `cargo check --tests` (metadata-only, no `windows` codegen) **passes clean**, and `src-tauri/` is git-verified **unchanged** by this frontend-only plan, so the backend repository/invariant suite is unaffected by Plan 11.
- **Manual smoke (`npm run tauri dev`)** was not runnable in this non-interactive session; the §8 manual walkthrough (five palettes, multi-tab open/switch/close/dirty, single-Ctrl+S, unload with a dirty background tab, both pages populated) remains to be exercised by a human, though its invariant-bearing pieces are covered by `openTabs.test.ts` and the reviews.

## 13. Execution Prompt

```
Implement Plan 11 (editor tabs, cosmetic tightening, AI-bar move & 5-palette theme picker).

1. READ THE PLAN FIRST, in full: notes-app/plans/plan.11.md. It is self-contained.
   Also read notes-app/CLAUDE.md and the root CLAUDE.md for architecture/invariants/conventions,
   and the design handoff at C:\Temp\worknotes\design_handoff_editor_tabs\README.md (the spec) plus
   the relevant screens/*.html references. Frontend-only: do NOT touch src-tauri/, src/lib/api.ts,
   Tauri commands, or keyring paths.

2. IMPLEMENT PHASE BY PHASE, following Section 6 exactly, in order. Each phase is independently
   shippable — verify it before moving on. Commit boundaries should follow the phases.
     - All npm/npx/vitest commands below run from the notes-app/ directory (that is where package.json
       and tsconfig.json live — there is none at the repo root); cargo runs from notes-app/src-tauri.
     - Phase A (Changes 2,3,4): cosmetic CSS + editor body reorder (move the body textarea up to
       title -> body -> JIRA, and AiBar directly above the review card; do NOT relocate .meta). Verify
       (from notes-app/): npx tsc --noEmit; npm run build; eyeball notes & prompts editors.
     - Phase B (Change 6 + Change 5): add the 5 palette CSS blocks + per-palette overrides using the
       EXACT hexes in Section 3.3 (v2-dark --mark-soft = #14312b, NOT #dcf7f0); create
       src/lib/palettes.ts (registry + whitelist-validated persistence, mirroring src/lib/aiProvider.ts);
       add the topbar picker; apply palette+polarity synchronously before render (no flash); DROP the
       legacy yellow-accent Original-dark; update the "themes swap neutrals only" invariant in DESIGN.md
       and BOTH CLAUDE.md files. data-palette (accent+neutrals) + data-theme (polarity light/dark) on
       <html>, both set atomically. Never interpolate the palette id into a selector/<style>.
     - Phase C (Change 1): create src/lib/openTabs.ts (pure reducer) and src/components/EditorTabs.tsx
       (reuse the page-tabs ARIA/roving-tabindex pattern; fix the mock's button-in-button — real sibling
       close <button>, not a nested role=button span); transform App.tsx and PromptsPage.tsx from single
       selection to openItems/activeKey/dirtyByKey with editors KEPT MOUNTED-HIDDEN (hidden={key!==activeKey});
       add `active` (gates the window Ctrl+S listener) and `onDirtyChange` props to Editor.tsx and
       PromptEditor.tsx; ALSO add a forwardRef/useImperativeHandle save() to both editors so the
       close-dirty "Save" branch can persist a background tab; wire open-or-activate rail clicks,
       rewrite openDuplicateDraft to open a new tab (it breaks after the state change otherwise),
       draft-key->real-key promotion on save, refresh reconciliation via api.getItem(id) (NOT diffing the
       filtered items list — that would falsely close tabs on a filter change), close-active activates the
       right-then-left neighbor, close-dirty prompt via api.confirmDialog (NEVER window.confirm), and
       generalize unload/reload (and the prompt-side openPromptProjectId, now a SET) to sweep ALL open tabs
       of a project. Tab identity = itemKey(item) from src/lib/projects.ts, never item.id. Add the
       .editor-tabs CSS block verbatim.

3. USE SUBAGENTS DURING IMPLEMENTATION:
     - After each phase's code is written, spawn a code-reviewer agent (read-only: Read, Grep, Glob)
       to review the diff against Section 11.
     - Spawn a test-writer agent to write src/lib/openTabs.test.ts and src/lib/palettes.test.ts per the
       Section 8 strategy (node-env vitest, no DOM harness, clone installLocalStorage() from
       aiProvider.test.ts) and to PROVE each test can fail against a deliberately-broken impl.
     - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify the Section 4 mitigations
       against the final diff (title as JSX child; whitelisted palette id; no dynamic CSS injection;
       CSP unchanged; no new deps; api.ts/commands/keyring untouched).
     - Spawn a frontend-specialist agent for the tab-bar a11y/CSS review (tablist semantics, focus
       management on close, full-bleed negative-margin clipping, per-palette override scoping).
     - Fall back if a named agent type is unavailable: Explore for read-only analysis, Plan for strategy,
       general-purpose otherwise — state the role in the prompt.

4. RUN THE CODE REVIEW CHECKLIST (Section 11) after implementation and address every item.

5. DOCUMENT AND IMPLEMENT IMPROVEMENTS in Section 12 of the plan file: record what the reviews surfaced,
   then implement the worthwhile ones.

6. BEFORE FINISHING, run the full verification suite from notes-app/CLAUDE.md and fix any regressions:
   from notes-app/src-tauri run `cargo test`; from notes-app/ run `npx tsc --noEmit`, `npm run build`,
   and the vitest suite (`npx vitest run`); then perform the Section 8 manual smoke via `npm run tauri dev`
   from notes-app/ (all five palettes; multi-tab open/switch/close/dirty; one Ctrl+S saves only the active
   tab; unload with multiple tabs incl. a dirty background tab; both pages populated at once).
   Report failing tests, skipped steps, and unverified assumptions plainly — do not smooth them over.
```
