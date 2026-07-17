# Plan 5: AI Title Proposals — Rework Titles, Save-on-Accept, and Auto-Title on Empty Save

**Created:** 2026-07-17
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Four connected behaviors around the AI rework flow and the Save path:

1. **R1 — Rework proposes a title too.** A successful AI rework yields, alongside the streamed body proposal, a proposed new title the user can accept.
2. **R2 — `Replace text` also saves.** Applying the body proposal persists the item in the same action (today it only marks dirty).
3. **R3 — Accepting the proposed title also saves.** Same save-on-accept semantics for the title.
4. **R4 — Auto-title on empty save.** Saving an item whose title is empty fires an AI call to generate a title from the body; on success the title is auto-accepted and the save proceeds **silently**; a toast appears only when the call fails or no API key is configured.

Why it matters: untitled notes are a real friction point (you must invent a title before you can save), and the propose → replace → save three-step adds a click that users almost always want collapsed. This feature is **not** in `docs/IMPLEMENTATION_PLAN.md` — it is net-new scope, and it deliberately amends two committed specs (see §2 and §5).

## 2. Strategic Assessment

*(tech-lead agent — verdict: buildable, but only with spec amendments and a decoupled title command)*

- **Two committed specs are contradicted by the literal request.** `docs/DESIGN.md:63` says "`Replace text` copies the proposal into the body, closes the card, **marks dirty**" (R2 changes that to *saves*), and the CLAUDE.md invariant says "AI rewrites are proposals. Nothing replaces the body without an explicit user action" (R4 auto-accepts AI output). **Verified firsthand by the planning orchestrator** (DESIGN.md:52–64, Editor.tsx:90–94). This plan therefore treats DESIGN.md + CLAUDE.md amendments as *part of the implementation* (Step 1), not an afterthought — the product's AI contract is being consciously changed, not accidentally eroded. The reconciling frame (architect): R4 (a) fires only on the user's explicit Save, (b) only fills an **empty** title — never overwrites one, and (c) never touches the body.
- **Do not carry the title inside the streamed rewrite response.** The Track 3 streaming path accumulates raw `text_delta` tokens straight into the review card; a structured `{title, body}` response would either stream visible JSON into the card or require a partial-JSON parser, and would change the just-shipped `RewriteEvent` contract. Keep the rewrite stream body-only.
- **R4 converts Save (including reflexive Ctrl+S) from an instant local op into a fallible, billable network call.** This is the riskiest part of the feature — it needs in-flight state, race guards, and the security posture in §4. The tech lead's preferred alternative (deterministic first-line-of-body fallback, AI only as an explicit action) is **recorded as an alternative in §10, not adopted**, because the request explicitly specifies the AI call with auto-accept.
- **Highest-level approach:** keep the body rewrite stream untouched; add a separate, non-streamed `ai_generate_title` command reused by both R1 (fired after the stream's `done`) and R4 (fired from the empty-title save branch); refactor `Editor.save()` to take explicit value overrides so "set field then save" can never persist stale state.

## 3. Research Findings

*(architect + api-designer + frontend-specialist agents, grounded in the code; file:line references verified against the current tree)*

### Current AI rework flow (architect)
- **`AiBar.tsx`** owns the provider select (lines 24–32, `useState` seeded from `localStorage["provider"]`, fallback `"anthropic"`), preset chips, the `Rework` button (`onRework(instruction, provider)`), and the **Save button** (78–80: `disabled={!dirty}`, label `Save`/`Saved`). AiBar does **not** own the proposal card.
- **`Editor.tsx`** owns all draft state and the review card. `rework()` (138–181) streams via `aiRewriteStream`, appending deltas to `proposal` guarded by a per-request `cancelled` closure flag + `stopRef` cancel handle. The review card (304–329) renders when `proposal !== null`; `Replace text` (310–319) does `edit(setBody)(proposal); setProposal(null)` — **no save**. `Discard` → `discardProposal()` (186–192) cancels the backend stream and clears card state. An `aria-live="polite"` sr-only span announces streaming state (325–327).
- **`save()`** (90–124) hard-blocks empty titles (91–94: `onError("Give it a title before saving.")`), then branches `isDraft` → `onCreate(NewItem)` vs `onSave(UpdateItem)`, reading **all values from React state closures**. Ctrl/Cmd+S calls the same `save()` (127–136).
- **`api.ts`** is the only IPC seam: `aiRewriteStream` (81–122) hides the Tauri `Channel`, returns `{result, cancel}`; `aiRewrite` (66–68, non-streamed) exists but is unused by Editor; `hasApiKey` (128–130) → bool.
- **Rust:** `AiProvider` trait (`ai/mod.rs:27–57`) — `rewrite(text, instruction)` + `rewrite_stream` (default impl delegates to `rewrite`). `REWRITE_SYSTEM_PROMPT` (89–94) and `rewrite_user_message` (97–99) are backend constants — prompt wording never crosses IPC. `commands.rs`: `ai_rewrite` (109–116) preflights empty text → `AppError::Invalid` and `provider_for` only — the missing-key case surfaces from `keys::get_key()` *inside* the provider's `rewrite()` (`anthropic.rs:63`, `openai.rs:64`), not from the command; `ai_rewrite_stream` (161–213) additionally preflights `keys::has_key()` (`commands.rs:172`). *(Corrected in plan review — the two commands do not share an identical preflight.)* Request DTOs (`RewriteRequest`, `RewriteStreamRequest`) live in `commands.rs`, not `models.rs`. `lib.rs` `generate_handler!` (46–68) registers every command.
- **No title-generation code exists anywhere** (grep confirmed). The Track 3 pattern (trait capability → command with shared preflight → `lib.rs` registration → `api.ts` wrapper → `types.ts` mirror → fake-provider test in `src-tauri/tests/`) is the template to copy.

### Save, dirty, and toasts (frontend-specialist)
- `dirty` is local Editor state; App.tsx never sees it. App exposes `onSave`/`onCreate` → `mutate()`/`createFromDraft()` (App.tsx:116–125, 144–157), both returning `Promise<boolean>`; success flips `dirty` false (Editor.tsx:109, 123).
- **The toast system is a single error slot**: `error: string | null` in App (App.tsx:42) rendered as one `<div className="toast" role="alert">` with Dismiss (178–185), passed down as `onError`. Error-only, no success variant, second error overwrites the first. R4's "toast only on failure" maps onto it **with nothing new to build**; R4's silent success matches "no success toast exists."
- **Editor remounts on selection change** (App.tsx keys `<Editor>` by `draft-${draftSeq}`/`selected.id`, App.tsx:211) and the item-keyed effect (Editor.tsx:69–88) already cancels in-flight streams on cleanup — the pattern to extend for a pending title call.
- `ItemList.tsx:185` renders `{item.title}` with **no empty fallback** — currently unreachable because the frontend guard blocks empty titles. R4 must keep "title is always non-empty at the IPC call" true end-to-end.

### The single most load-bearing implementation constraint (architect + api-designer + frontend-specialist, independently)
`save()` reads `title`/`body` from state closures; `setBody(proposal)` only schedules an update. A naive `setBody(proposal); save()` **persists the stale pre-replace body while the screen shows the new one** — silently defeating R2/R3/R4. `save()` must accept explicit overrides (`save({ title?, body? })`) and every accept path must pass the fresh value explicitly. This refactor lands first (Step 4) and everything else builds on it.

### Contract shape (api-designer)
- **No new `AiProvider` trait method is required.** The trait already generalizes over `instruction`; title generation is `provider.rewrite(http, text, TITLE_INSTRUCTION)` with a backend-fixed instruction constant — both vendors work with zero changes to `anthropic.rs`/`openai.rs`. Note the vendors hardcode `REWRITE_SYSTEM_PROMPT` as the system message (`anthropic.rs:68`, `openai.rs:71/127`), so the title ask travels entirely in the instruction — see D3 for the consciously accepted tradeoff.
- The new DTO (`GenerateTitleRequest { provider, text }`) belongs in `commands.rs` beside `RewriteRequest`, mirrored in `types.ts`. Response is a plain `String`. **No `models.rs` change, no migration.**
- Error copy for R4 needs no new plumbing: `AppError` serializes as its `Display` string (error.rs:39–46), and `MissingKey`'s copy ("no API key saved for {provider} — add one in Settings") is already distinct from failure copy. `keys::get_key` runs before any HTTP request, so the missing-key case never touches the network — **no client-side `hasApiKey` preflight needed**.
- Provider access for Editor: a tiny pure helper `getPreferredProvider()` reading `localStorage["provider"]` (the same logic AiBar already uses), shared by AiBar and Editor — no state-lifting refactor.

### Prior art / conventions
- Pure-helper modules with colocated vitest tests: `src/lib/jira.ts`, `src/lib/dueDate.ts` (+ `.test.ts`, node env, no DOM — `vitest.config.ts` scope).
- Fake-provider integration harness: `src-tauri/tests/streaming.rs` (hand-rolled fakes, no mocking framework; includes "prove the test can fail" counter-fakes like `IgnoresCancellationProvider`).
- Spec-first precedent: plan.4 CC3 required a DESIGN.md addition to land *with* the due-date track. Same discipline applies here (DESIGN.md has zero coverage of any of R1–R4; grep confirmed).

## 4. Security Considerations

*(security-auditor agent; posture verdict: no injection/XSS holes opened — the material new risk is consent/egress, plus untrusted-output hygiene)*

**High — silent third-party egress on R4 (consent posture).** Today note content leaves the machine only on an explicit `Rework` click. R4 makes a plain Save — including reflexive Ctrl+S — POST the full body to Anthropic/OpenAI whenever the title is blank, with success deliberately unsignalled. Required mitigations built into this plan:
- The generated title lands **visibly** in the title input as part of the save (the user sees the field populate — success is toast-silent, not invisible).
- The Save button shows an explicit in-flight label (`Generating title…`) for the duration, so the network call is observable while it happens (§5).
- The missing-key case never makes a network call (`get_key` fails before HTTP).
- The residual consent concern (a user may not expect Ctrl+S to invoke AI at all) **cannot be fully mitigated without deviating from the request** — it is recorded as an explicit accepted-risk decision for the user in §10, with the tech lead's non-AI fallback as the documented alternative.

**Medium — AI title is untrusted model output persisted without review (R4).** The repository only trims and rejects empty (`sqlite.rs:183–186`, `259–266`); `models.rs` has no length bound; titles render in the list row and in the native delete-confirm dialog. Mitigation (required): a backend `sanitize_title()` applied to provider output in the new command — take first non-empty line, trim, strip wrapping quotes, strip control characters, char-safe truncate (120 chars), and treat empty-after-sanitize as an error. (A repository-layer clamp covering *manually typed* titles too is a conscious non-goal here — see §10.)

**Medium — raw upstream provider response bodies reach toasts.** `anthropic.rs:84–90` / `openai.rs:89–95` embed the vendor's raw error body in the error string, which propagates verbatim to the toast. For the new title path, `ai_generate_title` maps `Provider`/`Http` errors to a short generic message ("couldn't generate a title — try again") while letting `MissingKey` pass through with its distinct copy. (Applying the same treatment to the existing rewrite path is out of scope — noted in §10.)

**Low — prompt injection via note body can steer the auto-accepted title.** Pasted content (email, tickets, web) can override the title instruction. Ceiling is content spoofing of the title field (React escapes everything; CSP `default-src 'self'` is strict; grep confirmed no `dangerouslySetInnerHTML`/`innerHTML`/`eval` anywhere). `sanitize_title()` bounds the blast radius; R1/R3 titles are additionally behind explicit acceptance.

**Clean (verified, stated for the record):** no XSS sink for titles; SQL/FTS access fully parameterized (titles never fed raw to `MATCH`); key confidentiality holds (keys only in request headers, `has_key` → bool, no read-back command); AI egress endpoints are hardcoded constants (no SSRF surface); **no new dependency required**; no content/secret logging exists (keep it that way — no `println!`/`console.*` in the new paths).

## 5. Design

### Approach

One new backend capability — `ai_generate_title` — reused by R1 and R4; the streaming rewrite contract stays byte-for-byte untouched. `Editor.save()` gains explicit overrides and becomes the single persistence path for R2/R3/R4. The review card grows an optional title row. DESIGN.md and CLAUDE.md are amended in the same change.

Three of four agents (tech lead, architect, api-designer) independently converged on the separate-command shape; the frontend specialist's alternative (title as a field on the `done` event) was rejected because it changes the just-shipped `RewriteEvent` contract, couples title latency to `Replace text` availability, and still leaves R4 needing a standalone command anyway.

### Architecture

```
AiBar (provider select, Save button w/ "Generating title…" state)
  └─ Editor
      ├─ rework(): aiRewriteStream (UNCHANGED) ──► done ──► aiGenerateTitle(provider, proposalText)
      │                                                        └─► proposedTitle state → TITLE row in review card
      ├─ Replace text  → save({ body: proposal })           (R2)
      ├─ Replace title → save({ title: proposedTitle })     (R3)
      └─ save(overrides?):
            empty effective title + empty body → toast (unchanged copy)
            empty effective title + body       → aiGenerateTitle(provider, effectiveBody)
                                                   ├─ ok  → save proceeds with generated title (silent)  (R4)
                                                   └─ err → onError(String(err)), save aborted
api.ts: aiGenerateTitle(provider, text) ──invoke──► commands::ai_generate_title (thin wrapper)
  provider_for(req.provider) → ai::generate_title(&*provider, &state.http, &req.text)  ← testable core fn
    empty-text guard → provider.rewrite(http, text, TITLE_INSTRUCTION) → error mapping → sanitize_title()
  [AiProvider trait, RewriteEvent, streaming, vendors' hardcoded system prompt: ALL UNCHANGED]
```

### Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Separate non-streamed `ai_generate_title` command; no trait change | Title-gen is `rewrite()` with a fixed backend instruction; serves R1 + R4 with one capability; zero risk to the shipped streaming path |
| D2 | `save(overrides?: {title?; body?}): Promise<boolean>` refactor lands first | The stale-closure hazard silently breaks R2/R3/R4; every accept path passes fresh values explicitly; returned boolean lets callers clear proposal halves only on success |
| D3 | Prompt wording (`TITLE_INSTRUCTION`) lives in Rust, not the frontend; **no separate title system prompt** | Preserves the backend-side prompt seam, single-sourced for R1 + R4. Conscious tradeoff (plan-review finding): the vendors hardcode `REWRITE_SYSTEM_PROMPT` as the system message (`anthropic.rs:68`, `openai.rs:71/127`) and D1 forbids vendor changes, so the title ask rides entirely in the instruction ("Reply with ONLY the title") under the existing system prompt, bounded by `sanitize_title`. If manual smoke shows rewrite-shaped output, escalate: thread a system-prompt parameter through `rewrite()` — a disclosed trait + both-vendor change |
| D4 | R1 title is generated **eagerly after `done`**, from the **proposed** body | Matches the literal requirement ("the rework also gives a title"); a title should summarize the *new* content. Cost: one extra small AI call per rework (flagged in §10) |
| D5 | R1 title-gen failure is **silent** (no toast); R4 failure toasts | An ancillary enhancement must not interrupt a successful rework; R4's toast is explicitly specified |
| D6 | Title row lives inside the existing review card; button label **`Replace title`** | DESIGN.md: one signature AI element; buttons say exactly what they do (`Replace text` precedent) |
| D7 | Body/title proposal halves resolve independently; `Discard` clears both | One `Rework`, one card; `Replace text` clears only the body half, `Replace title` only the title half; card stays mounted until both halves are resolved (mount condition widens) |
| D8 | `sanitize_title()` applied in the command, not the repository | The untrusted input is model output at the command boundary; clamping user-typed titles repo-wide is a separate product decision (§10) |
| D9 | Generic error copy for provider/HTTP failures of the title path; `MissingKey` copy passes through | Keeps raw vendor response bodies out of toasts (security §4) while preserving the distinct no-key message with zero new frontend branching |
| D10 | No client-side `hasApiKey` preflight | `get_key` fails before any HTTP request, so `MissingKey` surfaces fast with its own copy; a preflight would duplicate backend logic |
| D11 | R4 applies to **both kinds** (notes and tasks) and reuses `!title.trim()` as the emptiness predicate | The existing guard is kind-agnostic; a single-space title already counts as empty; no new emptiness definition |
| D12 | The R4 branch is implemented as a pure, injectable helper (`src/lib/titleForSave.ts`) | Converts the highest-value behavior ("generate → auto-accept → save, toast only on failure") into a conventionally unit-testable function under the existing Vitest setup — no jsdom/testing-library dependency needed (test-writer) |
| D13 | The command's core logic is a plain `pub async fn ai::generate_title(&dyn AiProvider, &reqwest::Client, &str)`; the `#[tauri::command]` is a thin wrapper (`provider_for` + delegate) | Commands needing `State<AppState>` cannot run in integration tests — a documented convention (`tests/jira.rs:1–6`; `streaming.rs`/`repo.rs` test traits directly). The free fn gives `tests/ai_title.rs` a real seam for fake providers; without it the §8 tests would be unwritable (plan-review finding) |

### Microcopy (new, goes into DESIGN.md)

- Review card title row: mono-uppercase label `TITLE`, proposed title text, right-aligned `Replace title` button; while generating, the row reads `Generating…` (text only — no spinners/icons per DESIGN.md).
- Card header chip: `PROPOSED REWRITE` while the body half is unresolved; `PROPOSED TITLE` when only the title half remains (body text omitted, `Discard` stays). The card closes when both halves are resolved.
- Save button while R4 generation is in flight: `Generating title…`, disabled.
- R4 failure toasts reuse existing error strings: backend `MissingKey` copy for no-key; `"couldn't generate a title — try again"` for call failures; the both-empty case keeps `"Give it a title before saving."`

## 6. Implementation Steps

1. **Amend the authoritative specs** (same commit as the feature, per plan.4 CC3 precedent):
   - `docs/DESIGN.md` §Editor pane item 4 + §Behaviors: review card may carry a `TITLE` row (label, proposed title, `Replace title`; `Generating…` while pending); `Replace text` and `Replace title` now **apply and save**. **Explicitly rewrite the DESIGN.md:63 clause** "`Replace text` copies the proposal into the body, closes the card, marks dirty" → each accept applies its half and saves; the card closes when both halves are resolved; when only the title half remains, the chip reads `PROPOSED TITLE` and the body text is omitted; `Discard` clears both halves. Saving with an empty title generates one from the body (silent on success, toast on failure/no-key, both-empty keeps the current error); Save button reads `Generating title…` during R4; **Ctrl+S follows the identical path**.
   - `CLAUDE.md` (notes-app) invariants: amend "AI rewrites are proposals…" to add: titles are accepted via explicit `Replace title`; the single carve-out is Save-with-empty-title, which generates and accepts a title as part of that explicit Save — the body is still never auto-written.
2. **Backend core** — `src-tauri/src/ai/mod.rs`: add `TITLE_INSTRUCTION` (short, specific title; a few words; no ending punctuation; "Reply with ONLY the title" — deliberately **no** separate system prompt, per D3), `pub fn sanitize_title(raw: &str) -> String` (first non-empty line → trim → strip wrapping quotes → strip control chars → char-safe truncate at 120), and the testable core `pub async fn generate_title(provider: &dyn AiProvider, http: &reqwest::Client, text: &str) -> Result<String, AppError>` (empty-text guard → `provider.rewrite(http, text, TITLE_INSTRUCTION)` → error mapping per D9 → `sanitize_title`; empty-after-sanitize → the generic Provider error). Colocated `#[cfg(test)]` unit tests for `sanitize_title` (see §8).
3. **Backend command (thin wrapper)** — `src-tauri/src/commands.rs`: `GenerateTitleRequest { provider, text }` (serde camelCase, beside `RewriteRequest`) + `#[tauri::command] ai_generate_title`: `provider_for(&req.provider)?`, then delegate to `ai::generate_title(&*provider, &state.http, &req.text)` — no logic of its own (D13). Error semantics live in the core fn: empty text → `AppError::Invalid("there is no text to generate a title from")`; `MissingKey` passes through untouched; every other provider/HTTP error → `AppError::Provider("couldn't generate a title — try again")`. Register in `lib.rs` `generate_handler!`.
4. **Backend integration tests** — new `src-tauri/tests/ai_title.rs` exercising `ai::generate_title` **directly with hand-rolled fake `AiProvider`s** (the `#[tauri::command]` wrapper itself stays untested — commands needing `State<AppState>` can't run outside a live Tauri app; state this limit in the module doc comment, matching `tests/jira.rs:1–6`). See §8. `cd src-tauri && cargo test` green.
5. **Contract mirror** — `src/types.ts`: `GenerateTitleRequest`; `src/lib/api.ts`: `aiGenerateTitle(provider, text): Promise<string>` invoking `ai_generate_title`. (Change both in the same commit — mirror rule.)
6. **Provider helper** — new `src/lib/aiProvider.ts`: `getPreferredProvider(): ProviderId` (`localStorage["provider"]` fallback `"anthropic"`) and the symmetric `setPreferredProvider(id)`; adopt both in `AiBar.tsx` (state seed + its `localStorage.setItem` write); vitest test.
7. **`save()` overrides refactor** — `Editor.tsx`: `save(overrides?: { title?: string; body?: string }): Promise<boolean>`; compute `effectiveTitle = (overrides?.title ?? title).trim()` / `effectiveBody = overrides?.body ?? body` and use them throughout both branches; add a `savingRef` re-entry guard; return the success boolean. Pure refactor — no behavior change; verify Ctrl+S and button save still work.
8. **R2** — `Replace text` handler: `edit(setBody)(proposal)` as today, then `const ok = await save({ body: proposal })`; clear only the body half on success (keep proposal visible on failed save so work isn't lost).
9. **Pure R4 helper** — new `src/lib/titleForSave.ts`: `resolveTitleForSave(title: string, body: string, generate: (text: string) => Promise<string>): Promise<{ title: string } | { error: string }>` encoding: non-empty title → passthrough; both empty → `{error: "Give it a title before saving."}`; empty title + body → `generate(body)`, mapping rejection to `{error: String(err)}`. Vitest tests (§8).
10. **R4 wiring** — `Editor.tsx` `save()`: replace the 91–94 guard with `resolveTitleForSave(effectiveTitle, effectiveBody, (t) => aiGenerateTitle(getPreferredProvider(), t))`; on `{error}` → `onError(error)`, abort (stay dirty); on `{title}` → `setTitle(generated)` (visible) and proceed with `effectiveTitle = generated`, no toast. Add `generatingTitle` state → thread to AiBar as a prop; Save button reads `Generating title…` and is disabled while true. Races: `savingRef` blocks double-save; the item-keyed effect cleanup (Editor.tsx:84–87 pattern) sets a cancelled flag checked before applying a late result. **Stale-closure fix (plan-review):** introduce `titleRef` (a `useRef` mirrored to live `title` inside `edit(setTitle)`, since the async continuation's closed-over `title` is always the pre-await empty value); after the await, if `titleRef.current.trim()` is non-empty the user typed a title mid-generation → drop the generated one and save with theirs. Name `titleRef` in the Editor state list. Ctrl+S reaches this identical path (no separate branch).
11. **R1 + R3** — `Editor.tsx`: add `proposedTitle: string | null` + `titlePending: boolean`; after `await result` resolves un-cancelled in `rework()`, fire `aiGenerateTitle(provider, finalText)` guarded by the same `cancelled` flag — success sets `proposedTitle`, failure silently clears `titlePending` (D5). **Race fix (plan-review): the R1 title call outlives the body stream's `finally` (Editor.tsx:174–180), which currently nulls `stopRef` and clears `aiBusy` the instant the body settles — a second Rework would then start with a no-op `stopRef.current?.()` and the first call's stale title would land on the second's card.** Keep `aiBusy`/`stopRef` (the Rework-disable + cancel handle) live through the title phase: only clear them after the title call settles, and have the per-request `cancelled` flag / `stopRef` abandon a pending title call so a superseding Rework can't be clobbered. Review card: widen mount condition to `proposal !== null || proposedTitle !== null || titlePending`; header chip `PROPOSED REWRITE` vs `PROPOSED TITLE` per which halves remain; render the `TITLE` row (label + text or `Generating…` + `Replace title`, disabled while pending); `Replace title` → `edit(setTitle)(proposedTitle)` + `await save({ title: proposedTitle })`, clearing the title half on success; `discardProposal()` clears both halves and abandons any pending title call; extend the sr-only `aria-live` copy for "Title proposed".
12. **Styling** — `src/styles.css`: title row styles inside the review card using existing yellow-card tokens; verify light/dark (neutrals swap only, yellows constant).
13. **Verify loop** (CLAUDE.md): `cd src-tauri && cargo test` · `npx tsc --noEmit` · `npm run build` · `npm run tauri dev` manual smoke per §8 E2E checklist.

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `docs/DESIGN.md` | Modify | Spec the title row, save-on-accept, auto-title behaviors + microcopy (Step 1) |
| `CLAUDE.md` (notes-app) | Modify | Amend the "AI rewrites are proposals" invariant with the scoped carve-out |
| `src-tauri/src/ai/mod.rs` | Modify | `TITLE_INSTRUCTION`, `sanitize_title()`, testable `generate_title()` core fn (D13) + unit tests |
| `src-tauri/src/commands.rs` | Modify | `GenerateTitleRequest` DTO + thin `ai_generate_title` wrapper delegating to `ai::generate_title` |
| `src-tauri/src/lib.rs` | Modify | Register `ai_generate_title` in `generate_handler!` |
| `src-tauri/tests/ai_title.rs` | Create | Fake-provider integration tests for the title command path |
| `src/types.ts` | Modify | Mirror `GenerateTitleRequest` (same commit as commands.rs) |
| `src/lib/api.ts` | Modify | `aiGenerateTitle()` wrapper (components never call `invoke()`) |
| `src/lib/aiProvider.ts` | Create | `getPreferredProvider()` shared by AiBar + Editor |
| `src/lib/aiProvider.test.ts` | Create | Helper unit tests |
| `src/lib/titleForSave.ts` | Create | Pure `resolveTitleForSave()` — the R4 branch, dependency-injected |
| `src/lib/titleForSave.test.ts` | Create | R4 branch unit tests (happy/edge/error) |
| `src/components/Editor.tsx` | Modify | `save(overrides)` refactor; R2/R3 save-on-accept; R1 title proposal state + card row; R4 wiring + races |
| `src/components/AiBar.tsx` | Modify | Adopt `getPreferredProvider()`; `generatingTitle` prop → Save button label/disabled |
| `src/styles.css` | Modify | Review-card title row styles (existing tokens) |

No migration. No `models.rs` change. **No new dependencies** (jsdom/testing-library explicitly avoided via D12).

## 8. Test Strategy

*(test-writer agent; conventions: hand-rolled Rust fakes as in `tests/streaming.rs`, pure-helper vitest as in `dueDate.test.ts` — no mocking frameworks, no DOM. Each new invariant-shaped test gets a "prove it can fail" check against a deliberately broken variant, per the project's `IgnoresCancellationProvider` discipline.)*

- [ ] **Unit Tests — Rust (`ai/mod.rs` colocated):** `sanitize_title`:
  - [ ] well-formed one-line title → passthrough (trimmed)
  - [ ] multi-line output → first non-empty line only
  - [ ] wrapping quotes stripped; inner quotes kept
  - [ ] control characters stripped; whitespace-only → empty
  - [ ] > 120 chars → char-safe truncation (no panic on multibyte boundaries)
- [ ] **Integration Tests — Rust (`tests/ai_title.rs`, calling `ai::generate_title` directly with fake `AiProvider`s per D13 — the `#[tauri::command]` wrapper is untestable and stays untested; note this in the module doc):**
  - [ ] happy path: fake `rewrite()` returns a title → `generate_title` returns it sanitized
  - [ ] empty/whitespace-only request text → `AppError::Invalid` **before** any provider call (assert the fake's `rewrite` was never invoked)
  - [ ] fake returns `MissingKey` → propagates with the distinct settings copy
  - [ ] fake returns `Provider`/`Http` error → surfaces as the generic "couldn't generate a title" copy, raw upstream body absent (assert not contained)
  - [ ] fake returns whitespace/empty → generic error, never an empty-string success
  - [ ] prove-red: against a variant that skips sanitization, the multi-line test fails
- [ ] **Unit Tests — Frontend (vitest, node env):** `titleForSave.test.ts`:
  - [ ] non-empty title → passthrough, `generate` never called
  - [ ] whitespace-only title + body → `generate` called with the body; success returns generated title
  - [ ] both empty → `{error: "Give it a title before saving."}`, `generate` never called
  - [ ] `generate` rejects → `{error: String(err)}` (missing-key copy and generic copy both pass through verbatim)
  - [ ] `aiProvider.test.ts`: stored provider returned; absent → `"anthropic"`
- [ ] **Regression:** full existing suites (`cargo test`, all `src/lib/*.test.ts`) stay green; `RewriteEvent`/streaming tests untouched and passing (contract unchanged is itself the assertion).
- [ ] **Edge Cases & Error Scenarios (covered above + manual):** whitespace-only titles; multibyte truncation; double-save re-entry; late title arriving after item switch or discard; user typing a title mid-generation.
- [ ] **E2E / manual smoke (`npm run tauri dev`, one real key configured):**
  - [ ] R1: Rework → body streams; after it finishes the `TITLE` row appears (`Generating…` then the proposal); Discard mid-stream never yields a title row
  - [ ] R2: `Replace text` → body updates AND Save button flips to `Saved` in one click; reselect item to confirm persistence
  - [ ] R3: `Replace title` → title updates AND saves; under `Sort: updated` the row moves (title is a content edit → `updatedAt` bumps)
  - [ ] R4 happy: blank title + body → Save → button reads `Generating title…` → title populates, saves, **no toast**
  - [ ] R4 via Ctrl+S: on an untitled note, **Ctrl+S** (not the mouse) triggers the identical visible `Generating title…` flow — the security §4 headline risk, verified explicitly
  - [ ] R1 double-Rework race: Rework, then click Rework again the instant the body stream ends (before the title lands) → the first rework's title never populates the second rework's card
  - [ ] R4 typing race: blank title + body, Save, then type a real title while `Generating title…` shows → the user's typed title is saved, the generated one is dropped
  - [ ] R4 no key: delete keys in Settings → Save → toast with the missing-key copy; item stays unsaved (`Save`, not `Saved`); confirm no network attempt
  - [ ] R4 failure: bad key/offline → generic toast; nothing persisted; no raw vendor JSON in the toast
  - [ ] R4 both-empty: Save on an empty draft → `"Give it a title before saving."` toast, no AI call
  - [ ] Single-space title treated as empty (triggers generation)
  - [ ] Works identically for notes and tasks; light + dark theme render of the title row
- [ ] **Mocks/stubs:** Rust — hand-rolled fake `AiProvider` scripted per scenario (title, empty, each `AppError` variant). Frontend — only the injected `generate` callback is stubbed; no `api.ts` mock, no new dev dependency.
- [ ] **Known coverage gap (stated plainly, per project precedent):** the React wiring inside `Editor.tsx` (card halves, race guards, `generatingTitle` threading) has no automated coverage — same manual-smoke-only status as Track 3's "body never auto-replaced" behavior. The logic-bearing branch is extracted to `titleForSave.ts` precisely to shrink this gap.

## 9. Success Criteria

- [ ] **Functional:** all four requirements behave per §5/§6 — title proposal after rework with `Replace title`; `Replace text` and `Replace title` persist in one action; empty-title save auto-generates + auto-accepts silently; toasts appear only on failure/missing key (with distinct copy each); both-empty save keeps the existing error.
- [ ] **Invariants held:** body is never written without explicit `Replace text`; `updatedAt` moves on these saves (content edits); no empty title ever reaches `create_item`/`update_item`; streaming `RewriteEvent` contract byte-identical.
- [ ] **Tests:** all §8 automated tests pass; existing suites stay green.
- [ ] **Security:** §4 mitigations implemented — `sanitize_title` in the command path, generic provider-failure copy (no raw vendor bodies in toasts), visible in-flight state, no new egress destinations, no key exposure.
- [ ] **Specs:** DESIGN.md + CLAUDE.md amendments land in the same change.
- [ ] **Quality:** `cargo test` · `npx tsc --noEmit` (strict, `noUnusedLocals`) · `npm run build` all clean; manual smoke per §8 done.

## 10. Risks & Open Questions

**Decisions the user should confirm (plan proceeds with the stated defaults):**
1. **R4 consent posture (security High, tech-lead objection — accepted-risk by request).** A reflexive Ctrl+S on an untitled note silently sends the body to the AI vendor. The plan follows the request (silent success) with observability mitigations (visible `Generating title…` state, title visibly populating). *Alternative on record (tech lead): deterministic first-line-of-body title with AI only as an explicit action — zero cost/latency/egress. Say the word and Steps 9–10 simplify accordingly.*
2. **Eager R1 title doubles provider calls per Rework** (default: eager, from the *proposed* body — D4). Lazy alternative: a `Suggest title` button in the card.
3. **R1 title-gen failure is silent** (D5) — confirm no toast is wanted there.
4. **Requirement wording says "note"** — the plan applies R4 to notes *and* tasks (D11), since the existing guard is kind-agnostic.

**Risks:**
- **Stale-closure hazard** is the top implementation risk — mitigated by landing the `save(overrides)` refactor first (Step 7) and passing fresh values everywhere; R2/R3/R4 all depend on it.
- **Model disobedience** on the title prompt (quotes, preamble, multi-line) — bounded by `sanitize_title` + tests.
- **Race conditions** — four identified, all addressed in Steps 10–11 with the codebase's `cancelled`-flag/ref patterns; residual risk is manual-smoke-only (§8 coverage gap):
  - double-save (`savingRef` guard);
  - item switch mid-generation (item-keyed effect cleanup sets a cancelled flag);
  - **user typing a title during R4 generation** — the async continuation's closed-over `title` is stale, so a `titleRef` mirrors live state and is read post-await (plan-review fix, Step 10);
  - **second Rework starting before R1's title call resolves** — the body stream's `finally` clears `aiBusy`/`stopRef` too early, so the title phase must extend that lifecycle and abandon a superseded title call (plan-review fix, Step 11).
- **R1/R4 title calls for the same item resolving out of order** (e.g., Rework then immediate Ctrl+S) — low probability, covered by the blanket manual-smoke-only disclaimer for Editor wiring; verify the last write wins and no empty title persists.
- **Toast copy source**: `MissingKey` copy lives in `error.rs` `Display`; if it changes, R4's no-key toast changes with it (single-sourced — accepted).
- Repository-layer title length clamp for *all* titles (manual edits included) was recommended by security but **not adopted** (D8) — user-typed titles are the user's own data; revisit if titles ever sync anywhere.
- Raw vendor bodies in the *existing* rewrite error path remain (pre-existing); only the new path is sanitized. Candidate follow-up, out of scope.

**Adversarial-verification note:** no agent claimed an existing bug/defect, so no adversarial-verifier runs were triggered. The two plan-shaping factual claims (empty-title guard at `Editor.tsx:91–94`; DESIGN.md:63–64 "marks dirty" / "body never touched until Replace text") were **verified directly by the planning orchestrator — CONFIRMED**. One agent divergence (frontend specialist preferred the title on the `done` event) was resolved 3-to-1 in favor of the separate command (see §5 Approach).

**Plan-review corrections applied (code-reviewer pass on this plan):** dropped an unreachable `TITLE_SYSTEM_PROMPT` (vendors hardcode their system prompt; D1 forbids vendor changes — the title ask rides in the instruction, D3); added the testable `ai::generate_title` core fn so the §8 Rust tests are actually writable (D13); closed the double-Rework/pending-title race (Step 11) and the stale-closure gap in the "prefer the user's typed title" mitigation via `titleRef` (Step 10); rewrote DESIGN.md's "closes the card" clause for the half-resolved card (Step 1); added an explicit Ctrl+S smoke item (§8). One §3 factual error the review caught (the two AI commands do not share an identical preflight) was corrected in place.

## 11. Code Review Checklist

After implementation, verify:
- [ ] No dead code or unused imports introduced (`noUnusedLocals` will catch TS; check Rust warnings)
- [ ] Error handling covers failure modes (missing key, provider error, empty generation, cancelled/late resolutions)
- [ ] No security vulnerabilities (injection, XSS, credential exposure); §4 mitigations addressed — `sanitize_title` in place, no raw vendor bodies in toasts, no key material anywhere new
- [ ] Code follows existing project conventions (api.ts seam, DTO mirror rule, backend-owned prompts, pure-helper testing pattern, DESIGN.md microcopy voice)
- [ ] Tests cover happy path, edge cases, and error scenarios; each invariant-shaped test proven able to fail
- [ ] No performance regressions (no extra re-renders from the new Editor state; no duplicate AI calls from race conditions)
- [ ] Changes are minimal — no unrelated refactoring bundled in; streaming path diff is empty
- [ ] DESIGN.md + CLAUDE.md amendments landed with the code

## 12. Post-Review Improvements

Implementation complete. A test-writer agent audited §8 coverage (verdict: complete, no gaps — proven non-vacuous by mutation), then three read-only reviewers ran in parallel: **code-reviewer** (§11 + invariants), **security-auditor** (§4 mitigations), **frontend-specialist** (DESIGN.md conformance). Triage below.

### Accepted — fixed

1. **[Critical · code-reviewer] `save()`'s R4 title-generation had no item-lifecycle guard** (`Editor.tsx`). §10 claimed the "item switch mid-generation" race was closed by the item-keyed effect cleanup, but that cleanup only served `rework()`; `save()` had no equivalent. Repro: fresh untitled draft with body → Save (R4 generating) → click another row → the Editor remounts (App keys it by draft/id), but the orphaned `save()` continuation still resolved, called `onCreate` (= `createFromDraft`), created the item, and `setSelectedId(created.id)` **yanked selection back** — completing an AI-triggered save invisibly, defeating the §4 "observable while it happens" mitigation.
   **Fix:** added an `aliveRef` (`useRef(true)`), set false in the item-effect cleanup and re-armed at the top of the effect body (StrictMode-safe, confirmed `main.tsx` uses StrictMode). `save()` checks `aliveRef.current` immediately after the `await` and abandons silently before any `onError`/persist. Navigating away from an unsaved draft has always discarded it, so abandoning is consistent — and it now honors the plan's stated intent.

2. **[Warning · code-reviewer] Silent no-op on the `savingRef` re-entry guard** (`Editor.tsx`). A second click on `Replace text`/`Replace title` during the visible R4 window hit the guard, returned `false`, and skipped its `set…(null)` — the click did nothing with no feedback (functionally safe, no double persist).
   **Fix:** added a `saving` state (set around the whole `save()`), and disabled `Replace text` (`streaming || saving`) and `Replace title` (`titlePending || proposedTitle === null || saving`) while a save is in flight, so a re-click surfaces as a disabled control. The Save button already covered its long window via `generatingTitle`.

3. **[Low · security-auditor] `sanitize_title` stripped only Cc control chars** (`ai/mod.rs`). `char::is_control()` leaves bidi overrides (U+202E), zero-width chars (U+200B), and line/paragraph separators (U+2028/9) — invisible glyphs that can visually spoof/reflow the title where it renders without an explicit accept step (list row, native delete-confirm dialog). This sits inside the content-spoofing ceiling §4 accepted, but §4 asserted control-char stripping bounds it, and these categories slipped through.
   **Fix:** added `is_title_junk()` — `is_control()` plus the bidi/zero-width/separator ranges — and switched the filter to it. New colocated unit test asserts they are stripped while visible letters survive. No new dependency (hand-rolled `matches!` ranges). XSS remained impossible regardless (React text nodes + strict CSP); this is defense-in-depth for the spoofing vector the plan named.

4. **[Should-fix nit · frontend-specialist] Static review-region `aria-label`** (`Editor.tsx`). The region was always labelled "AI rewrite proposal", misleading a screen-reader user in the title-only state (body half already resolved).
   **Fix:** `aria-label` is now `proposal !== null ? "AI rewrite proposal" : "AI title proposal"`, matching the same condition that drives the header chip.

### Accepted — documented, no code change

5. **[Warning · code-reviewer] R4 fires a fresh title call even when an R1 `proposedTitle` already exists** (untitled item → Rework yields a proposed title → `Replace text` before accepting it → the save's empty-title branch generates a *second* title). **Not changed:** reusing the R1 proposal for the R4 save would either (a) auto-consume/clear a proposal the user never accepted — violating "titles are accepted only via explicit `Replace title`" — or (b) deviate from the plan's deliberate R1/R4 split (D4 generates from the *proposed* body, R4 from the *effective* body). The resulting state is coherent: the title field shows the generated title (visible), and the still-unaccepted R1 proposal remains available to `Replace title`/`Discard`. Cost is one extra AI call in a narrow interaction — within the §10 "R1/R4 out-of-order, manual-smoke-only" envelope.

6. **[Nit · code-reviewer] `resolveTitleForSave` has no local trim/non-empty check on the generated title.** Relies on the backend contract (`sanitize_title` trims and treats empty-after-sanitize as an error, so `generate_title` never returns `Ok("")` — pinned by `ai_title.rs`). The single caller injects exactly that backend call. Adding a redundant guard is speculative per "minimum code"; left as-is.

7. **[Nit · code-reviewer / security informational] No server-side cancellation for `ai_generate_title`.** Accepted per D1/D13 — it is a one-shot, non-streamed command; a late response is dropped client-side (`rework()`'s `cancelled` flag for R1; the new `aliveRef` for R4). Symmetry with the stream path's `cancellations` map is unnecessary for a single request.

8. **[Pre-existing · frontend-specialist] `Discard` button styling** uses `btn btn-quiet` (neutral border) rather than DESIGN.md's yellow-bordered treatment. Confirmed untouched by this plan (dates to the Track 3 streaming commit). Out of scope; noted for a possible follow-up.

### Verified clean (reviewers, for the record)
Streaming `RewriteEvent`/`ai_rewrite_stream`/vendor `rewrite_stream` byte-identical; the `save(overrides)` refactor never persists stale pre-accept state on any branch (R2/R3/normal); no empty title can reach `create_item`/`update_item`; the R4 "typed-title-mid-generation" override activates only when `needsGeneration` (never clobbers R3's explicit title); the R1 double-Rework race is closed (`aiBusy`/`stopRef` held through the title phase); DTO mirror + `api.ts`-only IPC seam intact; no key/content logging, no new egress/SSRF, `has_api_key` still boolean; title row is theme-constant (dark-yellow ink on soft-yellow ≈5.9:1 contrast, AA).

## 13. Execution Prompt

Paste the following into a fresh Claude Code session (repo root `c:\Projects\TaskTracker\TaskTracker`):

```
Implement Plan 5 (AI title proposals + save-on-accept + auto-title on empty save) for the worknotes app.

1. Read notes-app/plans/plan.5.md in full — it is the authoritative plan. Also read notes-app/CLAUDE.md (architecture rules + invariants) and notes-app/docs/DESIGN.md §Editor pane / §Behaviors before touching code. The app lives in the notes-app/ subfolder.

2. Implement Section 6 step by step, in order (1 → 13). Do not reorder: the spec amendments (Step 1) and the save(overrides) refactor (Step 7) are deliberate prerequisites — Steps 8–11 silently persist stale state without Step 7. Key invariants that must survive: the streaming RewriteEvent contract is byte-identical; the body is never written without explicit "Replace text"; no empty title ever reaches create_item/update_item; types.ts and commands.rs DTOs change in the same commit; components never call invoke() directly (everything through src/lib/api.ts).

3. Write tests per Section 8 as you go (Rust sanitize_title unit tests in Step 2, tests/ai_title.rs in Step 4, vitest helpers in Steps 6/9). Additionally spawn a test-writer agent after Step 11 to review coverage against the Section 8 checklist and fill any gaps (hand-rolled fakes only — no new dev dependencies; jsdom/@testing-library are explicitly out of scope).

4. After implementation is complete, spawn in parallel:
   - a code-reviewer agent (read-only: Read, Grep, Glob) to review the full diff against the Section 11 checklist and the invariants above;
   - a security-auditor agent (read-only: Read, Grep, Glob) to verify every Section 4 mitigation landed: sanitize_title applied to all provider output in ai_generate_title; MissingKey passes through but Provider/Http errors surface as the generic copy with no raw vendor response bodies reaching toasts; visible "Generating title…" in-flight state; no key material or content logging in new code;
   - a frontend-specialist agent to check the review-card title row, AiBar Save-button states, and light/dark rendering against DESIGN.md (analysis only — do NOT create or modify any files).
   Only spawn other domain agents (api-designer, database-architect, devops-engineer, performance-optimizer) if the work unexpectedly crosses into their domain — this plan needs no schema, deployment, or perf work.
   Fallback: if a named agent type is unavailable, use a generic type instead (Explore for read-only analysis, Plan for strategy, general-purpose otherwise) with the role stated in the prompt.

5. Triage the reviewers' findings: fix real issues, document each accepted/rejected finding and any resulting improvements in Section 12 of notes-app/plans/plan.5.md, and implement the improvements.

6. Before finishing, run the full verify loop from notes-app/CLAUDE.md and fix any regressions:
   cd notes-app/src-tauri && cargo test
   cd notes-app && npx tsc --noEmit
   cd notes-app && npm run build
   npm run tauri dev  → run the Section 8 E2E/manual smoke checklist (needs a real API key; the R4 no-key case needs keys removed in Settings).
   Note: on this machine cargo test can fail with LNK1318 when the C: drive is near-full — if that happens, clean the target dir and disable debuginfo rather than treating it as a code failure.

7. Do not commit unless explicitly asked. Report results plainly, including any failing tests or skipped smoke items.
```
