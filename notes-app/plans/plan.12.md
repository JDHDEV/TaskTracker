# Plan 12: Editor reorder, rail spacing tightening, and an About dialog

**Created:** 2026-07-24
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Three small, independent, frontend-only changes to `worknotes`:

1. **Editor element reorder.** Change the render order of the item Editor's children from `body textarea → JIRA row → AI bar → review card` to `JIRA row → AI bar → review card → body textarea`. The body textarea moves to the bottom and becomes the growing element there; the JIRA row, AI bar, and (conditional) review card stack above it at natural height.
2. **Rail spacing tightening.** Halve the ~24px vertical gap between the New note/New task buttons and the search bar in the left rail.
3. **About dialog.** Add an "About" entry in the topbar that opens a small dialog showing the product name, the app version, a one-line tagline, and a "View on GitHub" link. This gives a shipped `.exe` a "which build am I running?" answer.

All three are cosmetic/informational. No Rust, no schema, no IPC-command changes are required. The only backend-adjacent addition is a one-line `api.ts` wrapper around Tauri's existing `getVersion()`.

## 2. Strategic Assessment

_(tech-lead)_

**Verdict: proceed.** Three right-sized, low-risk changes with clear entry points and an existing dialog pattern to reuse — no new abstractions. An About/version dialog is genuinely useful for a shipped binary at near-zero cost. Ship as one small PR; the three items are independent.

Two things the tech-lead flagged that shaped this plan:

- **Item 1 carries a microcopy coupling the request doesn't mention.** The body textarea placeholder at [Editor.tsx:578](../src/components/Editor.tsx#L578) reads _"Write here. Select a rework below when it's rough."_ In the shipped order the AI bar is **below** the body, so this is currently correct. After the reorder the AI bar sits **above** the body, making "below" wrong. This is a two-file change (component + `docs/DESIGN.md`, which owns microcopy).
- **Item 1's riskiest effect is on streaming, not static layout.** Moving the body last actually _improves_ static proposal-vs-original adjacency (the review card now sits directly above the body). The real regression is during a live rework: today the body is top-anchored and rock-steady while the proposal streams in below it; in the new order the streaming review card sits _above_ the body and shoves/shrinks it (`.body` is `flex:1`) while the user is reading their own text. A modest but real jitter regression on the core rework flow — accepted because the reorder is user-directed, mitigated by a defensive `min-height` on `.body`.

## 3. Research Findings

_(architect + frontend-specialist)_

### Dialog conventions

Three dialogs exist, in two tiers. The older two ([SettingsDialog.tsx](../src/components/SettingsDialog.tsx), [ManageProjectsDialog.tsx](../src/components/ManageProjectsDialog.tsx)) have **no** Escape or focus handling. The newest, [PromptHistoryDialog.tsx](../src/components/PromptHistoryDialog.tsx), adds Escape-to-close and initial focus, and `docs/DESIGN.md` presents that as the improved standard ("Unlike the older dialogs, this one moves initial focus to `Close` on open and closes on Escape"). **The new AboutDialog should follow PromptHistoryDialog**, not the older two. There is **no focus trap** anywhere in the app — match that; do not add one.

Shared dialog shell (all three):
- Scrim: `<div className="scrim" onClick={onClose}>` — backdrop click closes. `.scrim` at [styles.css:891](../src/styles.css).
- Card: `<div className="dialog" role="dialog" aria-label="…" onClick={(e) => e.stopPropagation()}>` — `stopPropagation` prevents an inside click bubbling to the scrim. `.dialog` at styles.css:901.
- `<h2>` title, `<p className="dialog-note">` muted body copy, `<div className="dialog-foot">` right-aligned footer with the close `<button className="btn">`.

Escape + focus pattern to copy (PromptHistoryDialog.tsx:38–45):
```tsx
const closeRef = useRef<HTMLButtonElement>(null);
useEffect(() => {
  closeRef.current?.focus();
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, [onClose]);
```

App wiring (three touch points, mirroring `showSettings`): state near [App.tsx:100](../src/App.tsx#L100), a trigger button in the topbar next to Settings ([App.tsx:558–560](../src/App.tsx#L558)), and a conditional render at the end of the `.app` tree next to the other dialog mounts ([App.tsx:684–686](../src/App.tsx#L684)).

### External links

The single sanctioned URL-opening path is `openExternal` in [api.ts:279–284](../src/lib/api.ts#L279):
```ts
export async function openExternal(url: string): Promise<void> {
  if (!isHttpUrl(url)) throw new Error("Refusing to open a non-http(s) URL.");
  await openUrl(url); // @tauri-apps/plugin-opener
}
```
Reuse idiom from [JiraChip.tsx:32](../src/components/JiraChip.tsx#L32): `onClick={() => void api.openExternal(url).catch((e) => onError(String(e)))}`. It is rendered as a `<button>`, never an `<a href>` (CSP `default-src 'self'` + the "no in-app navigation" rule). The opener capability is already permissioned for `https://*`/`http://*`. Consequence: AboutDialog needs an `onError` prop if it renders the link.

### Version source

- `@tauri-apps/api` v2 is already a dependency ([package.json:14](../package.json)); `getVersion()` from `@tauri-apps/api/app` is a new import path, **not** a new dependency.
- **Permission: CONFIRMED available with zero capability edits.** Verified against the generated ACL manifest (`src-tauri/gen/schemas/acl-manifests.json`): the app grants `core:default` in [capabilities/default.json](../src-tauri/capabilities/default.json); `core:default` aggregates `core:app:default`; `core:app:default` includes `allow-version` (alongside `allow-name`, `allow-tauri-version`, `allow-identifier`, `allow-bundle-type`). So `getVersion()`, `getName()`, `getTauriVersion()`, and `getIdentifier()` all work today under the existing capability.
- Version is `1.0.1` in both [package.json:4](../package.json) and [tauri.conf.json:4](../src-tauri/tauri.conf.json), kept in sync manually.
- No existing `import.meta.env`, `getVersion`, `__APP_VERSION__`, or `define` usage anywhere; `tsconfig.json` has `resolveJsonModule: true` with `include: ["src"]`; **no `*.d.ts` exists under `src/`**.

### Editor reorder — coupling check (CONFIRMED SAFE)

`.editor` is `display:flex; flex-direction:column; gap:12px` ([styles.css:561](../src/styles.css)). `.body` is the **sole** flex-growing child (`flex:1; min-height:0`, styles.css:709); `.jira-row` (styles.css:1156), `.aibar` (styles.css:808), and `.review` (styles.css:723; its `.review-body` self-caps at `max-height:220px`) are all natural-height. Flex distributes remaining space to grow-items **independent of DOM order**, so `.body` stays the sole growing/absorbing element wherever it sits.

A grep for sibling combinators (`+`/`~`) and `:first/last/nth/only-child` touching `.body`, `.review`, `.aibar`, `.jira-row`, or `.editor` children returned **nothing**. There is no JS coupling either — `Editor.tsx` has no `querySelector`, positional ref, or index logic on these children, and no `scrollIntoView`/`focus()` tied to the review card opening. **The reorder is a pure JSX child-move; no CSS change is required** (one optional defensive `min-height` is recommended — see §5).

### Prior art & docs

- **No existing About/app-version UI.** The only product-identity element today is the topbar wordmark `<span className="wordmark">worknotes</span>` ([App.tsx:510](../src/App.tsx#L510)). Every other "version" reference in `src/` is prompt-versioning, unrelated.
- **`docs/DESIGN.md` already documents a stale editor order.** Its "Editor pane" numbered list (≈ lines 62–68) reads header → meta → JIRA row → AI review card → **body textarea → AI bar**, which already disagrees with the shipped `Editor.tsx` (`body → JIRA → AiBar → review`). The requested new order is a third ordering. The MEMORY note "Design-system bundle & DESIGN.md drift" corroborates the doc lag. This plan updates the DESIGN.md editor list and adds the About dialog to the dialogs section; the generated `docs/design-system` bundle mirrors the built UI and will lag until regenerated (flag only — not hand-edited here).
- **Content sources:** `tauri.conf.json` gives productName `worknotes`, version `1.0.1`, identifier `io.github.jdhdev.worknotes`, publisher `JDHDEV`. There is **no stored repo URL or tagline** in the codebase. The git remote is `https://github.com/JDHDEV/TaskTracker.git` (verified via `git remote -v`) → browser URL `https://github.com/JDHDEV/TaskTracker`. Tagline seed from DESIGN.md/CLAUDE.md framing: _"Local-first notes and tasks, refined with AI."_

## 4. Security Considerations

_(security-auditor — no critical/high/medium findings; low-risk feature)_

1. **XSS/injection:** None introduced. There is no `dangerouslySetInnerHTML` anywhere in `src/` (the only mention, in EditorTabs.tsx, is a comment noting its avoidance). All About fields (name, version, tagline, repo URL) are static build/runtime constants, not user- or project-controlled, and React escapes JSX text by default. **Requirement:** render every field as a JSX text node; do not add `dangerouslySetInnerHTML`. The feature adds no new inputs, so no validation surface.
2. **External link:** **Requirement** — open the repo link via `api.openExternal(REPO_URL)` with `REPO_URL` a hardcoded `https://` constant, matching the JiraChip pattern. Do **not** use `<a target="_blank">` or `window.open` (in a Tauri webview these bypass the scoped opener; an anchor would also need `rel="noopener noreferrer"` to avoid reverse-tabnabbing). `openExternal` already gates on `isHttpUrl()` and routes through the permission-scoped opener.
3. **Version disclosure:** Not a meaningful risk for a local-first single-user desktop app — the version already ships in the binary/installer metadata and is visible to anyone who can run the app. Accept, no remediation.
4. **`getVersion()` capability:** Confirmed already granted via `core:default` (see §3) — no capability widening, and `allow-version` is a read-only grant regardless.
5. **Editor reorder + CSS gap:** No security relevance — confirmed. The textarea stays a controlled React input with unchanged escaping; no data source/sink changes; the CSS edit is pure presentation.

The surrounding codebase already has the relevant defenses: a strict CSP (`default-src 'self'; connect-src 'self'`), a narrowly-scoped opener capability, a single validated `openExternal` chokepoint, and no `dangerouslySetInnerHTML`.

## 5. Design

### Approach

Implement all three as one small PR, each isolated:

- **Item 1:** Move the `<textarea className="body">` JSX block to render last (after the review-card conditional), and fix the now-inaccurate placeholder. Add an optional defensive `min-height` to `.body`.
- **Item 2:** One-value CSS edit: `.search` top margin `12px → 0` (Worknotes-rail only — not the shared `.rail-actions`; see D4).
- **Item 3:** New `AboutDialog.tsx` following the PromptHistoryDialog pattern; a one-line `getAppVersion()` wrapper in `api.ts`; `showAbout` state + topbar button + conditional mount in `App.tsx`.

### Architecture

Nothing crosses the frontend boundary except the version read, which routes through `api.ts` exactly like the existing non-`invoke` OS wrappers (`openExternal`, `copyToClipboard`, `confirmDialog`). No Rust, no migrations, no DTO changes, no new dependency.

### Key Decisions

**D1 — Version source: `getVersion()` wrapped in `api.ts` (chosen). [Alternative: Vite `define`.]**
Add `getAppVersion(): Promise<string>` to `api.ts` wrapping `getVersion()` from `@tauri-apps/api/app`; the dialog loads it in a `useEffect` like SettingsDialog loads its state. Rationale:
- **Authoritative, drift-proof version.** `getVersion()` reads `tauri.conf.json` — the same version the OS/installer reports. An About box's whole purpose is "which build is this?", so it must not be able to silently lie if someone forgets to bump `package.json`. (tech-lead, frontend-specialist, test-writer all favored this for the no-drift reason.)
- **Matches the codebase's own idiom.** `api.ts` deliberately wraps non-`invoke` OS/plugin touchpoints so the OS surface stays greppable (see the comments in `api.ts`). `getAppVersion()` is the same one-line idiom.
- **Zero cost, verified.** Confirmed available under the existing `core:default` capability (§3); the async cost is trivial and has a direct precedent (SettingsDialog's `useEffect` load).

The **architect preferred the alternative — a Vite `define` of the package.json version (`__APP_VERSION__`)** — as the minimal, IPC-free path (a build-time literal is not IPC/storage/AI/keys, so it doesn't breach the api.ts rule). It is a valid choice; it is not chosen here because (a) it surfaces the _frontend package_ version as a proxy rather than the shipped version and is drift-prone, and (b) it requires a new build-config change **and** a brand-new ambient `src/vite-env.d.ts` declaring `__APP_VERSION__` — and test-writer flagged that a missing ambient decl makes `tsc --noEmit` fail even when `vite build` substitutes the value. If the owner wants to flip to this alternative, add both the `define` and the ambient decl together.

**D2 — Editor reorder is a pure JSX move; no `order` CSS.** Reorder the children in the DOM; `flex:1` keeps `.body` growing at the bottom regardless of position (§3).

**D3 — Defensive `min-height` on `.body`.** Because `.body` is now the element that visibly shrinks when the review card opens during streaming, add `min-height: 120px` (or similar) to `.body` so it can't collapse in a tall-content/short-window case. This is robustness polish, not required for the reorder to "work." Recommended-include.

**D4 — Rail gap edit lives on `.search`, NOT `.rail-actions` (`.rail-actions` is a shared class).** Change `.search { margin: 12px }` → `margin: 0 12px 12px` (top `12px → 0`, left/right/bottom unchanged). Worknotes-rail gap becomes `.rail-actions` bottom padding (12px, untouched) + `.search` top margin (0) = 12px, exactly halved, with no horizontal churn.

**Do not edit `.rail-actions` for this** — it is a single unscoped rule shared by both [ItemList.tsx:87](../src/components/ItemList.tsx#L87) (Worknotes rail, followed by `.search`, `margin: 12px` all sides → 24px gap) **and** [PromptList.tsx:45](../src/components/PromptList.tsx#L45) (Prompts rail, followed by `.rail-select`, `margin: 0 12px 10px` → **top margin 0**, so that gap is already 12px). Zeroing `.rail-actions` bottom padding would halve the Worknotes gap as intended but collapse the **Prompts** gap to 0px (New prompt flush against the project dropdown) — a silent regression on a page the request never mentions. Editing `.search` (which exists only in ItemList, verified: the sole `className="search"` in `src/`) scopes the change to the Worknotes rail exactly. (Not recommended: halving both `.rail-actions` bottom and a search value to 6px — still touches the shared class and regresses Prompts.)

**D5 — AboutDialog a11y matches PromptHistoryDialog** (role="dialog", `aria-label="About worknotes"`, scrim-click close, **Escape close, focus the Close button on open**), which is the app's documented standard for new dialogs. No focus trap (the app has none). Footer button reads **"Close"** (informational dialog), not "Done".

**D6 — About content (minimal, on-brand):**
- Title `worknotes`
- `Version {version}` (from `getAppVersion()`)
- Tagline: `Local-first notes and tasks, refined with AI.`
- `View on GitHub` button → `api.openExternal("https://github.com/JDHDEV/TaskTracker")`
- `Close` footer button

Reuse existing classes (`.scrim`/`.dialog`/`.dialog-note`/`.dialog-foot`/`.btn`) — **no new CSS**. (Optional "any other relevant info" for debugging a shipped exe — a muted line with the identifier `io.github.jdhdev.worknotes` and Tauri version via `getTauriVersion()`, both zero-permission — may be added if the owner wants it; kept out of the minimal default.)

## 6. Implementation Steps

1. **Add the version wrapper.** In [api.ts](../src/lib/api.ts), add `import { getVersion } from "@tauri-apps/api/app";` and export `getAppVersion(): Promise<string> { return getVersion(); }`, placed near the other OS-touchpoint wrappers (`openExternal`, `copyToClipboard`) with a one-line comment matching their style.
2. **Create `src/components/AboutDialog.tsx`.** Props `{ onClose: () => void; onError: (message: string) => void }`. Follow PromptHistoryDialog: scrim + `.dialog` (`role="dialog"`, `aria-label="About worknotes"`, `stopPropagation`), Escape-to-close + focus-on-open on a `closeRef` Close button. On mount, a `useEffect` loads the version: `api.getAppVersion().then(setVersion).catch(() => {})` into local state initialized to `""` — the `.catch` is required so a failed version read leaves the dialog rendering with an empty version rather than an unhandled rejection (this is the graceful-degrade the §11 checklist expects; note SettingsDialog's own load has no try/catch, so do **not** blindly copy that — add the `.catch` here). Render `<h2>worknotes</h2>`, `<p className="dialog-note">Version {version}</p>`, `<p className="dialog-note">Local-first notes and tasks, refined with AI.</p>`, a `View on GitHub` `<button className="btn btn-quiet" onClick={() => void api.openExternal(REPO_URL).catch((e) => onError(String(e)))}>`, and a `.dialog-foot` with `<button ref={closeRef} className="btn" onClick={onClose}>Close</button>`. Define `REPO_URL = "https://github.com/JDHDEV/TaskTracker"` as a module constant.
3. **Wire AboutDialog into App.tsx.** Add `import AboutDialog from "./components/AboutDialog";`; add `const [showAbout, setShowAbout] = useState(false);` next to `showSettings`; add a topbar `<button className="btn btn-quiet" onClick={() => setShowAbout(true)}>About</button>` immediately after the Settings button (after [App.tsx:560](../src/App.tsx#L560)); add `{showAbout && <AboutDialog onClose={() => setShowAbout(false)} onError={showError} />}` next to the other dialog mounts (≈ [App.tsx:685](../src/App.tsx#L685)).
4. **Reorder the Editor children.** In [Editor.tsx](../src/components/Editor.tsx), move the `<textarea className="body">…</textarea>` block (currently lines 575–580) to render **after** the `{cardOpen && (…review…)}` block and before `</section>`. Resulting order: `<header>` → `<div className="meta">` → `<JiraRow>` → `<AiBar>` → `{cardOpen && review}` → `<textarea className="body">`.
5. **Fix the body placeholder microcopy.** In Editor.tsx (the moved textarea, was line 578), change `"Write here. Select a rework below when it's rough."` to position-independent copy, e.g. `"Write here. Use a rework when it's rough."` (drops the now-wrong "below").
6. **Add the defensive body min-height (D3).** In [styles.css](../src/styles.css) `.body` rule (≈ line 709), add `min-height: 120px;`.
7. **Halve the rail gap (D4).** In [styles.css](../src/styles.css) `.search` (line 388), change `margin: 12px;` → `margin: 0 12px 12px;`. **Do NOT touch `.rail-actions`** — it is shared with the Prompts rail (see D4); editing it would zero the Prompts-page gap.
8. **Update the docs.** In [docs/DESIGN.md](../docs/DESIGN.md) "Editor pane" numbered list (≈ lines 62–68), renumber the items to the new shipped order: `header → meta row → JIRA row → AI bar → AI review card → body textarea` (the doc currently lists body-textarea at 5 and AI-bar at 6; both move relative to the new order). Note: the literal placeholder string ("Select a rework below…") lives in `Editor.tsx`, not DESIGN.md, so there is no placeholder text to edit in the doc — only the list order changes. Add an "About" entry to the Dialogs section (product name, version, tagline, GitHub link, Close; Escape + scrim close). Note in the PR description that the generated `docs/design-system` bundle will need regeneration separately.
9. **(Optional, recommended) Extract About metadata to a testable helper.** Create `src/lib/about.ts` exporting `ABOUT = { name: "worknotes", tagline: "Local-first notes and tasks, refined with AI.", repoUrl: "https://github.com/JDHDEV/TaskTracker" } as const;` and consume it in AboutDialog. This gives the feature a pure unit to test (see §8) and a single place for the constants. The test imports `isHttpUrl` from `./jira` (it is exported from [src/lib/jira.ts](../src/lib/jira.ts), the same validator `api.openExternal` uses internally — it is not re-exported from `api.ts`). If skipped, keep the constants local to AboutDialog and record the skipped unit test as an intentional gap.
10. **Verify.** Run the full verification gate (§9) and the manual smoke checklist (§8).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/components/AboutDialog.tsx` | Create | The About dialog (name, version, tagline, GitHub link, Close); PromptHistoryDialog a11y pattern |
| `src/lib/about.ts` | Create (optional, recommended) | Static About metadata constants (name/tagline/repoUrl) — testable seam |
| `src/lib/about.test.ts` | Create (optional, recommended) | Assert `repoUrl` passes `isHttpUrl` so `openExternal` can't silently throw |
| `src/lib/api.ts` | Modify | Add `getAppVersion()` wrapping `getVersion()` from `@tauri-apps/api/app` |
| `src/App.tsx` | Modify | `showAbout` state, "About" topbar button, AboutDialog mount |
| `src/components/Editor.tsx` | Modify | Reorder children (body textarea → last); fix placeholder microcopy |
| `src/styles.css` | Modify | `.search` top margin `12px → 0` (Worknotes-rail gap only — NOT the shared `.rail-actions`); add `.body { min-height: 120px }` |
| `docs/DESIGN.md` | Modify | Update editor-pane order + microcopy; add About to Dialogs section |

## 8. Test Strategy

_(test-writer — the project is node-env Vitest, pure-helper tests only; there are **no** React/DOM tests and no `@testing-library`/`jsdom`. Do NOT introduce them for this change.)_

- [ ] **Unit Tests (Vitest, `src/lib`, node env):**
  - Only if step 9's `src/lib/about.ts` is created: `src/lib/about.test.ts` asserting `isHttpUrl(ABOUT.repoUrl) === true` (guards the `openExternal` precondition against a future typo), and that `name`/`tagline` are non-empty. Matches the existing lib-test style (explicit boundary cases, e.g. `dueDate.test.ts`).
  - If no pure logic is extracted, **skip unit tests entirely** and record it as an intentional gap — do not add a vacuous "renders a string" test that would require a jsdom env this project doesn't have.
  - Do **not** add anything under `src/components/*.test.tsx` — no precedent and no test-env support (`environment: "node"` in `vitest.config.ts`).
- [ ] **Integration Tests:** None — the feature crosses no module/IPC boundary (the only backend touch is the pre-existing `getVersion()` plugin command).
- [ ] **Type/build checks (must stay green):**
  - `npx tsc --noEmit` — strict, `noUnusedLocals` on. Watch for an unused import if the reorder leaves anything dangling, and confirm AboutDialog's props are fully consumed.
  - `npm run build` (`tsc && vite build`) stays clean.
  - `cd src-tauri && cargo test` — expected no-op (frontend-only), run anyway per convention.
  - (Only if the D1 alternative — Vite `define` — is chosen instead: confirm a matching `declare const __APP_VERSION__: string;` ambient decl exists, or `tsc --noEmit` fails.)
- [ ] **Edge Cases & Error Scenarios / Manual smoke (`npm run tauri dev`):**
  - **Editor reorder:** open both a note **and** a task (shared JSX); order is meta → JIRA row → AI bar → (review card) → body textarea; body still grows/fills and is editable; typing flips the unsaved dot. Tab order is sane (DOM order now visits JIRA/AI bar before the textarea) — not trapped, textarea not skipped.
  - **Rework flow:** trigger a Rework — review card appears above the body, streams, and **Replace text** still writes into the (relocated) textarea and saves. Confirm the streaming card shoving/shrinking the body is tolerable (min-height holds it). Confirm JiraRow link/chip and AiBar Save/Rework/busy states are functionally intact after the move.
  - **Rail gap (Worknotes):** the vertical gap between the New note/New task row and the search input is visibly halved, no overlap/clip; check a light and a dark palette.
  - **Rail gap (Prompts) — regression guard:** switch to the **Prompts** page and confirm the New prompt button and the project-scope dropdown below it are **unchanged** (still ~12px apart, not flush). This is the shared-`.rail-actions` trap the plan routes around by editing `.search` instead; verify the edit did not leak to the Prompts rail.
  - **About dialog:** the topbar "About" button opens the dialog (scrim + centered card) without disturbing the Worknotes/Prompts page-tablist keyboard handling; it shows product name, **version matching `tauri.conf.json` (`1.0.1`)**, and the tagline; closes on scrim click, on **Close**, and on **Escape**; focus lands on Close on open; **View on GitHub** opens `https://github.com/JDHDEV/TaskTracker` in the external browser (not in-webview). Opening About while an editor tab is dirty does not discard tab state.
  - **Topbar width:** the new fourth topbar control ("About") does not overflow/clip the non-wrapping `.topbar` flex row at the default window width; glance at a narrower width since `.topbar` has no `flex-wrap`.
- [ ] **Regression re-verification:** all 12 existing `src/lib/*.test.ts` pass unmodified; `cargo test` pass count unchanged.

## 9. Success Criteria

- [ ] **Functional:**
  - Editor renders children as JIRA row → AI bar → review card → body textarea; the body textarea fills the remaining space at the bottom and stays editable; the AI rewrite Replace-text flow still works.
  - The gap between the New note/New task buttons and the search bar is exactly halved (24px → 12px).
  - A topbar "About" button opens a dialog showing product name, the app version from `getVersion()`, the tagline, and a working "View on GitHub" link; it closes via scrim/Close/Escape.
  - The body placeholder no longer says "below"; `docs/DESIGN.md` editor order + Dialogs section are updated.
- [ ] **Tests:** All tests from §8 pass; the full existing Vitest suite and `cargo test` remain green.
- [ ] **Security:** §4 mitigations implemented — repo link goes through `api.openExternal` with a hardcoded URL (no `<a target=_blank>`/`window.open`); no `dangerouslySetInnerHTML`.
- [ ] **Quality:** `npx tsc --noEmit` and `npm run build` are clean; no new dependency added; changes minimal with no unrelated refactoring.

## 10. Risks & Open Questions

- **Version source (D1) is a documented decision with a live alternative.** Plan chooses `getVersion()` via `api.ts` (drift-proof, matches idiom, zero-cost/verified). Architect preferred the Vite-`define` alternative (less code). Either is acceptable — the owner can flip; if flipping, add both the `define` and the ambient `declare const`.
- **UX inversion (accepted, user-directed).** The proposal (review card) now appears _above_ the original text it replaces, and "Replace text" targets a textarea that is visually below it — an inversion of the natural "read original → see proposal → apply" flow. Implement as specified; worth one line of UX review before merge (does "Replace text" at the top still read sensibly when it fills content below?).
- **Streaming jitter (accepted, mitigated).** During a live rework the body shrinks/shifts as the card streams above it. Mitigated by the `.body` `min-height` (D3); no auto-scroll bug exists (no `scrollIntoView` tied to the card).
- **Hierarchy change.** The primary writing surface now sits at the very bottom, beneath the JIRA field and AI bar. This is a deliberate layout choice per the request, not a side effect — noted so it's an owned decision.
- **Content inputs — resolved with defaults; owner may override.** Repo URL `https://github.com/JDHDEV/TaskTracker` (verified via `git remote -v`, `.git` stripped). Tagline `Local-first notes and tasks, refined with AI.` (seeded from DESIGN.md/CLAUDE.md). If the owner prefers different copy, or wants the GitHub link omitted (drop the `onError` prop then), adjust before/at implementation.
- **Doc/bundle drift.** `docs/DESIGN.md` is updated by this plan; the generated `docs/design-system` bundle mirrors the built UI and will lag until regenerated separately (out of scope here — flagged).

### Verified claims (no adversarial-verifier subagent needed)

- **`getVersion()` requires no capability edit** — the only load-bearing factual claim in this plan. Raised by tech-lead and security-auditor; **CONFIRMED locally** by the planner by reading `src-tauri/gen/schemas/acl-manifests.json`: `core:default` → `core:app:default` → `allow-version`, and `capabilities/default.json` grants `core:default`. Because this is a confirmed non-blocking fact (not a defect/blocking constraint), the Step-5 adversarial-verification gate does not apply. Fallback if ever contradicted at runtime: add `core:app:allow-version` to `capabilities/default.json` (a narrow read-only grant), or switch to the D1 Vite-`define` alternative.
- **No breaking CSS/JS coupling on the reordered children** — CONFIRMED by the architect's grep (no sibling combinators / positional selectors / positional JS) and corroborated by the frontend-specialist's flex analysis.

### Plan-review corrections (code-reviewer pass)

A code-reviewer pass over this plan caught and the plan now incorporates:
- **Shared-class regression (fixed in D4/Step 7):** the original draft edited `.rail-actions`, which is shared by the Worknotes and Prompts rails; that would have silently zeroed the Prompts-page gap. The plan now edits `.search` (Worknotes-only, verified sole `className="search"` in `src/`) and adds a Prompts-rail smoke check.
- **`getAppVersion()` error handling (clarified in Step 2):** the load must `.catch()` so a failed version read degrades gracefully — SettingsDialog's precedent has no try/catch, so it must not be copied blindly here.
- **Minor:** the "rework below" string is in `Editor.tsx`, not DESIGN.md (Step 8 clarified to a list-renumber only); `isHttpUrl` import source spelled out (`./jira`); topbar-width smoke check added for the new fourth control.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (esp. after the Editor reorder and the AboutDialog wiring)
- [ ] Error handling covers failure modes (the `openExternal` call catches and routes to `onError`; `getAppVersion` failure degrades gracefully — dialog still renders with an empty/placeholder version)
- [ ] No security vulnerabilities: repo link via `api.openExternal` with a hardcoded URL, no `<a target=_blank>`/`window.open`, no `dangerouslySetInnerHTML`
- [ ] Security considerations from §4 addressed
- [ ] Code follows existing conventions (dialog shell matches PromptHistoryDialog; `api.ts` wrapper matches the OS-touchpoint idiom; camelCase; no `invoke()` outside `api.ts`)
- [ ] Tests cover the pure helper if extracted; manual smoke checklist completed for all three UI changes
- [ ] No performance regressions (the About dialog mounts only when open; no extra re-renders in the editor from the reorder)
- [ ] Changes are minimal — no unrelated refactoring bundled in; the rail gap is a single-value edit; the reorder is a pure JSX move
- [ ] `docs/DESIGN.md` updated (editor order + About dialog); `docs/design-system` regeneration noted in the PR

## 12. Post-Review Improvements

Implemented all of §6 as specified. Four review subagents (code-reviewer, security-auditor,
frontend-specialist, test-writer) reviewed the diff against §4 and §11.

**Verification gate — all green:**
- `npx tsc --noEmit` — clean (strict, `noUnusedLocals` on).
- `npm run build` — clean production bundle.
- `cargo test` — all Rust suites pass. Confirmed frontend-only: `git status --short -- src-tauri`
  is empty (zero backend edits — the real no-regression signal). Ran single-threaded with
  test-debuginfo off (`CARGO_BUILD_JOBS=1 CARGO_PROFILE_TEST_DEBUG=0`) per the machine's
  memory-constraint history; cached artifacts reused, no `windows` recompile.
- `npx vitest run` — 164 tests / 13 files pass (12 pre-existing lib suites + the new
  `about.test.ts`, 3 assertions, verified non-vacuous).

**Review findings (all cosmetic or pre-existing — none are defects introduced by this change):**

1. **`View on GitHub` button is a bare child of `.dialog`, not wrapped in a named row class**
   (code-reviewer nit). Harmless: `.dialog-note`'s 16px bottom margin sits above it and the
   `button` falls onto its own line. **Deferred, not implemented** — the plan (D6) specifies
   reuse of existing classes with *no new CSS*; wrapping it in `.dialog-foot` would wrongly
   right-align a primary content action, and a new wrapper class is out of scope. Left as the
   literal D6 spec.

2. **Short-window body overflow from `.body { min-height: 120px }`** (frontend-specialist).
   `.editor` and its ancestors have no `overflow-y`, so in a very short window with the review
   card open, content can bleed past the section rather than scroll. **Pre-existing** (the
   absence of scroll on `.editor` predates this change) and **explicitly accepted by D3** as a
   robustness tradeoff (bounded 120px floor vs. unbounded collapse). **Not implemented** — adding
   editor-level scroll is a broader layout change beyond this plan's scope; flagged for a future
   pass.

3. **Topbar narrow-window overflow with the new 4th control** (frontend-specialist). `.topbar`
   has no `flex-wrap`/overflow handling; the "About" button lowers the width at which overflow
   first occurs but introduces no new failure mode (the topbar already lacked wrap at 3 buttons).
   Ample headroom at the default 1200×760 window. **Pre-existing**, matches the §8 smoke note;
   **not implemented** — a topbar wrap/overflow strategy is out of scope; flagged for a future pass.

4. **`docs/design-system` generated bundle still lags** the shipped UI (editor reorder + About
   dialog). Out of scope here — regenerated separately (see the "Design-system bundle & DESIGN.md
   drift" note). `docs/DESIGN.md` itself was updated by this plan (editor order + Dialogs section).

**Not performed in this session:** the §8 manual GUI smoke (`npm run tauri dev`) — this is a
non-interactive session with no way to visually verify the app, and a full `tauri dev` codegen
build is blocked by the current commit-limit pressure. The automated gate above is green; the
manual smoke (editor reorder visual, rework streaming, rail gap light/dark, Prompts-rail
regression guard, About open/close/Escape/focus/GitHub-link, topbar width) remains for the owner.

## 13. Execution Prompt

Paste the following into a fresh Claude Code session (run from `c:\Projects\TaskTracker\TaskTracker`, where the app lives under `notes-app/`):

```
Implement the plan at notes-app/plans/plan.12.md. Read the whole plan first, then work Section 6 step by step. Context: worknotes is a Tauri 2 + React 19 + TypeScript (Vite) local-first desktop app under notes-app/. Read notes-app/CLAUDE.md for architecture rules (never call invoke() outside src/lib/api.ts; IPC DTOs are serde camelCase; styling is CSS custom properties). This is three independent, frontend-only changes — no Rust, no migrations, no new dependency.

Scope and key decisions (do not deviate without flagging):
1. Editor reorder — move <textarea className="body"> to render LAST in Editor.tsx (order: header → meta → JiraRow → AiBar → review card → body textarea). It is a pure JSX child-move, no `order` CSS. Also fix the body placeholder microcopy (drop the now-wrong "below") and add `min-height: 120px` to `.body` in styles.css.
2. Rail spacing — change `.search` margin from `12px` to `0 12px 12px` in styles.css (top 12px→0, halving the Worknotes-rail gap from 24px to 12px). Do NOT edit `.rail-actions` — it is shared with the Prompts rail (PromptList.tsx) and zeroing its bottom padding would collapse the Prompts-page gap to 0. After the edit, smoke-check the Prompts page rail is unchanged.
3. About dialog — create src/components/AboutDialog.tsx following the PromptHistoryDialog pattern (role="dialog", aria-label, scrim-click close, Escape close, focus Close on open; NO focus trap). Show product name "worknotes", the version from a new api.ts getAppVersion() wrapping getVersion() from "@tauri-apps/api/app", the tagline "Local-first notes and tasks, refined with AI.", a "View on GitHub" button calling api.openExternal("https://github.com/JDHDEV/TaskTracker"), and a "Close" footer button. Wire showAbout state + an "About" topbar button next to Settings + the conditional mount in App.tsx. Reuse existing .scrim/.dialog/.dialog-note/.dialog-foot/.btn classes — no new CSS. Optionally extract the constants to src/lib/about.ts and add src/lib/about.test.ts asserting isHttpUrl(ABOUT.repoUrl). Also update docs/DESIGN.md (editor order + Dialogs section).

Version source is CONFIRMED to need no capability edit (core:default already includes core:app:default → allow-version; verified against src-tauri/gen/schemas/acl-manifests.json). If getVersion() ever errors at runtime with a permission error, add "core:app:allow-version" to src-tauri/capabilities/default.json.

Use subagents during implementation:
- After implementing, spawn a code-reviewer agent (read-only: Read, Grep, Glob) to review the diff against Section 11.
- Spawn a test-writer agent to add the optional src/lib/about.test.ts per Section 8 IF src/lib/about.ts is created. Do NOT introduce React Testing Library / jsdom — this project has node-env Vitest with pure-helper tests only.
- Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify the Section 4 mitigations (openExternal via hardcoded URL, no <a target=_blank>/window.open, no dangerouslySetInnerHTML).
- Spawn a frontend-specialist agent to sanity-check the editor reorder layout and the AboutDialog a11y (Escape/focus) match the app's bar.
- Fallback: if a named agent type is unavailable, use a generic type (Explore for read-only analysis, Plan for strategy, general-purpose otherwise) with the role stated in the prompt.

After implementation:
- Run the Section 11 code review checklist and fix anything it surfaces.
- Document any follow-on improvements in Section 12 of the plan and implement them.
- Run the full verification gate and fix regressions before finishing:
    cd notes-app && npx tsc --noEmit
    cd notes-app && npm run build
    cd notes-app/src-tauri && cargo test
    cd notes-app && npx vitest run     # all 12 existing lib tests must stay green
  Then manually smoke-test per Section 8 with: cd notes-app && npm run tauri dev
- Do not commit or push unless explicitly asked.
```

