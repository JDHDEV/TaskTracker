# Plan 4: Phase 4 Backlog — Roadmap (Installer · Due-date UI · Streaming Rewrites · JIRA Enrichment · PostgresRepository [deferred])

**Created:** 2026-07-15
**Status:** Draft
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Phase 4 of `docs/IMPLEMENTATION_PLAN.md` (lines 80–87) is an explicitly **unscheduled backlog of five independent tracks**, not a single feature. This is a **roadmap plan**: it sequences the tracks, records the cross-cutting decisions and risks, and gives each track an executable sub-plan (files, design, tests, security) so any one can be pulled into its own focused implementation session when scheduled. The tracks:

1. **Installer** via `npm run tauri build` — produce a distributable Windows installer. Config-only; zero architectural surface.
2. **Due-date UI** — surface the already-supported `dueAt` (RFC 3339 TEXT; empty clears; omitted = unchanged). **Task-only** per the CLAUDE.md invariant. Frontend-only for capture/display; a due-date *sort* is a separate full-stack decision.
3. **Streaming rewrites** — stream the AI proposal token-by-token into the review card via Tauri channels, extending the `AiProvider` trait; one-shot `rewrite()` stays as fallback.
4. **JIRA enrichment** — fetch ticket title/status onto the chip via Atlassian Cloud REST, introducing a third swap-point trait `JiraProvider` (mirroring `ItemRepository` and `AiProvider`), with the API token in the keyring.
5. **PostgresRepository** — a second `ItemRepository` impl (own SQL incl. `tsvector`). **Recommended DEFERRED** (see §2/§10): a second repo impl is not cloud sync, and it forces a re-spec of a committed invariant.

**Recommended sequence:** **Installer → Due-date → Streaming → JIRA → (defer Postgres).** Rationale in §2.

**Cross-cutting decisions taken at planning time:**
- **CC1 — Defer PostgresRepository** until a real sync design exists that names Postgres as the *sync backend* (not a repo swap). Cross-confirmed independently by the tech-lead and the database-architect.
- **CC2 — Re-spec the list-order tiebreak now** in CLAUDE.md from "`rowid DESC`" to "a monotonic insertion sequence (SQLite `rowid`; a future Postgres impl an `IDENTITY`/`seq` column)." Cheap wording change today; left unwritten it entrenches `rowid` in every new `push_sort` arm (notably a due-date sort) and raises the eventual Postgres cost.
- **CC3 — Due-date has no DESIGN.md authority.** Verified: `grep -niE 'due|deadline' docs/DESIGN.md` and `docs/reference/` return nothing. A short DESIGN.md addition (mirroring the "Tag lifecycle (new)" / "Project removal guard (new)" sections) must land with the due-date track — not a silent implementation choice. Proposed defaults are in §5.
- **CC4 — Every new IPC mechanism stays behind `src/lib/api.ts`.** The "components never call `invoke()` directly" rule extends to Tauri `Channel`s (streaming) and to the JIRA enrichment lookup.

## 2. Strategic Assessment

*(tech-lead agent — verdict: rethink scope; four tracks proceed, one defers)*

- **PostgresRepository is speculative and mislabeled.** It is sold as "for cloud sync," but a second `ItemRepository` impl only changes *where the single source of truth lives* — `lib.rs setup()` still constructs exactly one `Arc<dyn ItemRepository>`. Sync is a different problem (multi-device identity, conflict resolution, offline queue, merge semantics) that a second impl delivers none of. Building it now violates the "no features for later" rule and trades away the local-first/offline/zero-ops properties that define the app. **Defer it.**
- **The list-order invariant is SQLite-leaky.** The tiebreak is `rowid DESC`; Postgres has no stable `rowid` (`ctid` is not stable across `VACUUM`). A second impl cannot honor the invariant verbatim — it forces a re-specification of a committed invariant (→ CC2). Search-rank parity (FTS5 bm25 vs Postgres `ts_rank`) is likewise **impossible** and must be declared engine-specific.
- **Due-date is mechanically trivial but design-blocked** (→ CC3). Display/edit is `Editor.tsx` + `ItemList.tsx` only. A due-date *sort* punches through the deliberately-closed `Sort` enum (`models.rs` + `types.ts` + `push_sort` + `search`) — treat it as a separate, conscious decision, not part of "the UI track."
- **Streaming introduces a second IPC mechanism** that must respect the `api.ts` seam (→ CC4) and the strongest AI invariant: *proposals never auto-replace the body*. Tokens must land in the review-card proposal buffer only.
- **JIRA enrichment's real cost is Atlassian auth**, not the third trait. The `JiraProvider` trait + keyring token is the clean 20%; Cloud auth (Basic `email:api_token`, per-org base URL), rate limits, and the chip's new failure/stale states are the 80%.

**Recommended sequencing (value-per-effort, risk-ascending):**
1. **Installer first** — nearly free, enables dogfooding, and flushes out the keyring-in-packaged-build question before more keyring-dependent features (JIRA) land.
2. **Due-date UI** — highest value-per-effort for a task app; backend is ready. Ship display/edit; make sort a conscious follow-on.
3. **Streaming rewrites** — contained polish; establishes the channel-through-`api.ts` pattern once, guarded by a "body never written pre-`Replace text`" test.
4. **JIRA enrichment** — real value; sequence after the installer has proven keyring-in-production.
5. **PostgresRepository — deferred** (CC1).

**Conditional swap (architect):** due-date sits at #2 *only if* the DESIGN.md due-date decision (CC3) is made before that slot opens. If not, swap Streaming into #2 so a coding-ready track keeps moving rather than stalling on an unwritten spec.

**Riskiest track:** PostgresRepository (highest effort, forces invariant re-spec, doubles SQL-maintenance surface forever, doesn't deliver its stated value). **Riskiest cross-cutting concern:** behavioral parity between two `ItemRepository` impls, currently unverified (the `repo.rs` suite runs on in-memory SQLite only). Within the scheduled tracks, the sharpest single-track risk is streaming breaking "proposals never auto-replace body" — mitigate with an explicit test.

## 3. Research Findings

*(architect + database-architect + api-designer + frontend-specialist + devops-engineer, grounded in the actual code)*

### Seams to reuse (architect)
- **Storage seam:** `ItemRepository` (`src-tauri/src/db/mod.rs`), one impl `SqliteRepository` (`db/sqlite.rs`), selected in exactly one place — `lib.rs setup()`. SQL lives entirely in the impl (`push_filters`, `push_sort`, `fts_query`).
- **AI seam:** `AiProvider` (`ai/mod.rs`) with a `provider_for(id)` registry match; impls `anthropic.rs`, `openai.rs`, both calling `keys::get_key(self.id())`.
- **Keys:** `ai/keys.rs`, generic `(provider, key)` over one keyring `SERVICE = "notes-app"` (hardcoded literal, **not** derived from the bundle identifier — devops-confirmed, so keyring naming does not drift dev↔packaged); empty save deletes; no command returns a key (`has_api_key` → bool).
- **IPC:** thin `#[tauri::command]` in `commands.rs` delegating to `state.repo` / `provider_for`; `AppState` holds `Arc<dyn ItemRepository>` + a shared `reqwest::Client`. Frontend touches backend only via `src/lib/api.ts`; `src/types.ts` hand-mirrors `models.rs` (serde camelCase).
- **JIRA (Phase 3):** `jira_url` validated http(s)-only on write (`validate_jira_url`); `JiraRow.tsx` renders a mono input + a `<button>` chip (never `<a href>`) calling `api.openExternal` → opener; `jira.ts` has pure, unit-tested `isHttpUrl` and `ticketLabel` (regex `^[A-Za-z][A-Za-z0-9]*-\d+$` on the last path segment).
- **Migrations:** additive, numbered, SQLite-dialect (`0001`–`0003`), run by `sqlx::migrate!("./migrations")`.

### Track 1 — Installer (devops)
- `npm run tauri build` with `bundle.targets: "all"` on Windows produces **both** an NSIS `.exe` and a WiX `.msi`. **Recommend narrowing to `"nsis"`** (lighter per-user installer; WiX pulls its own toolchain) unless enterprise/GPO deployment is needed.
- `tauri.conf.json` today: `identifier: com.vendnovation.worknotes`, `productName: worknotes`, `version: 0.1.0`, **no `bundle.publisher`**, **no `bundle.windows` block**. Icons under `src-tauri/icons/` include `icon.ico` (confirm it's a genuine multi-resolution ICO). `"csp": null` (security gap — see §4).
- Add a `bundle.windows` block: `publisher`, and `webviewInstallMode` set explicitly (`downloadBootstrapper` is reasonable for Win11-only, where WebView2 is evergreen/in-box).
- **Code signing:** unsigned installers trigger SmartScreen ("Windows protected your PC" → More info → Run anyway). Acceptable for single-dev dogfooding **if documented explicitly**; a thumbprint (not a secret) goes in config, the cert stays in the OS store / CI secret. Defer cert purchase until distribution widens.
- **Updater:** absent today; **defer** (needs its own signing keypair + hosted manifest — meaningful infra for a self-rebuilding single user).
- **Version hygiene:** `package.json`, `tauri.conf.json`, `Cargo.toml` all agree at `0.1.0` but nothing enforces it — bump all three in the same commit as a Definition-of-Done line item.

### Track 2 — Due-date UI (frontend)
- **Task-only** (CLAUDE.md invariant: notes never carry `dueAt`; patches are silently ignored) — so the control lives inside the existing `item.kind === "task"` block, after priority and before the project select. No visible-but-ignored control for notes.
- Files: `src/components/Editor.tsx` (state + control, wired exactly like `jiraUrl`: `edit()` for dirty, `dueAt || undefined` on create, `dueAt ? fromDateInputValue(dueAt) : ""` on save so empty clears), `src/components/ItemList.tsx` (row display). **No** `api.ts`, `models.rs`, `types.ts`, or migration change for capture/display.
- Control: native `<input type="date">` (free date parsing/validation + a11y), styled like `.jira-input`, with a mono `DUE` label. Date-only granularity. Dark-theme wrinkle: `[data-theme="dark"] input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(1); }` — contrast correction for an OS-drawn glyph, not a themed accent.
- Row display: gate on `item.kind === "task" && item.dueAt`; format `due Jul 20` (reuse the `when()` month/day formatting). Overdue cue reuses the existing `--danger` token (as `.prio-high` does) **plus** a visible `· overdue` word (WCAG 1.4.1 — never color-only). A **done** task never renders overdue (reuse the `released` boolean ItemList already computes).
- New pure helpers (vitest, DOM-free, mirroring `jira.ts`): `src/lib/dueDate.ts` — `toDateInputValue`, `fromDateInputValue`, `formatDueDate`, `isOverdue(dueAt, now)` (takes `now` as an explicit param — never reads `new Date()` internally).
- Due-date **sort** (database + architect + frontend): a separate, deferred decision. If taken, add `Sort::DueDate` (mirror `models.rs` + `types.ts` + a `push_sort` arm + `search()` order), ordered **ascending (soonest first), NULLs last**, expressed portably with a `CASE` bucket (not `NULLS LAST`, which older SQLite lacks):
  ```
  ORDER BY i.pinned DESC,
           CASE WHEN i.due_at IS NULL THEN 1 ELSE 0 END,
           i.due_at ASC,
           <tiebreak>
  ```

### Track 3 — Streaming rewrites (architect + api-designer + frontend)
- Files: `ai/mod.rs` (extend trait), `ai/anthropic.rs` + `ai/openai.rs` (SSE streaming impls), `commands.rs` (new commands), `lib.rs` (`generate_handler!`), `src/lib/api.ts` (wrapper), `src/components/{Editor,AiBar}.tsx`, `src/styles.css`. No migration; no `models.rs` change beyond the event DTO.
- **Extend `AiProvider`, don't fork it.** Add `rewrite_stream(&self, http, text, instruction, sink: &dyn ChunkSink) -> Result<String>` and keep `rewrite()` as the non-streaming fallback (give `rewrite_stream` a default impl that calls `rewrite()` and emits one chunk, so future providers aren't forced to stream). Keep Tauri's `Channel` type **out** of `ai/mod.rs` via a vendor-agnostic `ChunkSink` trait (`send_chunk(&str)`, `is_cancelled()`), the same discipline that keeps SQLite out of `ItemRepository`.
- Event contract (camelCase tagged union, one channel): `RewriteEvent = Chunk{delta} | Done{text} | Error{code, message}` with `RewriteErrorCode = Cancelled | Network | Provider | Invalid`.
- Commands: `ai_rewrite_stream(req: RewriteStreamRequest{requestId, provider, text, instruction}, on_event: Channel<RewriteEvent>)` and `ai_rewrite_cancel(requestId)`. **Failure split:** preflight validation (empty text, unknown provider, missing key) rejects the `invoke` promise immediately (nothing to stream); once the HTTP stream starts, *all* outcomes report only via the channel's terminal `Done`/`Error`, and the command returns `Ok(())`. One terminal signal, not two.
- Cancellation: `AppState` gains `cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>`; `ai_rewrite_cancel` flips the flag; the stream loop checks `sink.is_cancelled()` between chunks (cooperative). A missing `requestId` is a silent no-op. No new crate (`Arc<AtomicBool>`).
- `api.ts` wrapper constructs the `Channel` internally and returns `{ result: Promise<string>, cancel: () => void }`; components pass an `onChunk` callback and never see `Channel` (CC4).
- Frontend: keep `proposal: string | null` as the accumulator; add `streaming: boolean`. On Rework, set `proposal("")` + `streaming(true)` synchronously (instant card). Each chunk does a **functional** update `setProposal(prev => (prev ?? "") + delta)`. Hold the cancel handle in a ref + a `cancelledRef` flag checked before every chunk-driven setState (so a late chunk can't resurrect a discarded/stale card); the `[item.id, isDraft]` reset effect's cleanup must call `stopRef.current?.()` to kill a zombie stream on navigation. While streaming: disable `Replace text`, keep `Discard` enabled; small mono `Streaming…` label in `--mark-ink`; a tiny `aria-live="polite"` node for start/done only (not per-chunk).
- SSE parsing (`"stream": true`; Anthropic `content_block_delta`, OpenAI `data: {...}`/`[DONE]`) lives inside the vendor impls via `reqwest`'s `bytes_stream()`. **New dependency:** enable the `stream` feature on the existing `reqwest` (feature addition, not a new crate — flag it).

### Track 4 — JIRA enrichment (architect + api-designer + frontend)
- New module `src/jira/mod.rs` (`JiraProvider` trait + `jira_provider_for(id)`; Cloud impl `atlassian-cloud`, Data Center addable later). Trait: `fetch_ticket(&self, http, base_url, key) -> Result<TicketMeta>`. DTO `TicketMeta { key, title, status, statusCategory: "new"|"indeterminate"|"done", fetchedAt }` (mirror in `types.ts`).
- Command `get_jira_ticket(jira_url: String) -> TicketMeta` — takes the stored `jira_url` and **re-derives the ticket key server-side** (Rust port of `jira.ts`'s anchored `^[A-Za-z][A-Za-z0-9]*-\d+$` on the last path segment); if no key extracts, `AppError::Invalid` **before any network call**.
- **Credential model:** the API **token** goes in the keyring (`set_jira_token`/`has_jira_token`, empty deletes, boolean-only — parallel to `set_api_key`/`has_api_key`, same "never returned" contract). But the **non-secret** `JiraConfig { baseUrl, email }` must be readable back for the Settings UI, which the keyring surface deliberately refuses — so store it in a **new additive `app_settings(key TEXT PRIMARY KEY, value TEXT)` table** (new numbered migration; fits the "repository owns storage, additive migrations" convention), with `get_jira_config`/`set_jira_config` commands. Do **not** stuff non-secret config into keyring "for consistency."
- Atlassian realities: **Cloud only** for v1 (Server EOL Feb 2024). Endpoint `GET {base_url}/rest/api/3/issue/{KEY}?fields=summary,status`. Auth = **HTTP Basic** `email:api_token` (not Bearer). `Accept: application/json`. 429 carries `Retry-After` — surface as a distinct error, do **not** auto-retry (on-demand, not a poller). Set a request timeout (reqwest default is none). New `AppError` variants: `RateLimited`, `NotConfigured` (distinct from `MissingKey`).
- Reuse the existing shared `reqwest::Client` — **no new HTTP crate** (reqwest `.basic_auth()` covers it).
- Frontend: extract `src/components/JiraChip.tsx` + a `src/hooks/useJiraEnrichment(url)` hook (owns fetch/cache/debounce, returns `{label, tooltip, state}`). **Click always calls `api.openExternal`** regardless of enrichment state (the one invariant that must not move). States: `no-token` → today's plain `ticketLabel`; `loading` → label unchanged, tooltip only (no layout shift); `loaded` → `{KEY} — {title} ↗` + a status dot reusing the existing `.dot-todo/.dot-doing/.dot-done` classes (zero new colors) mapped from `statusCategory`, status word in text too; `stale` → render like loaded with a tooltip note; `error` → fall back to plain `ticketLabel` (chip must keep working), muted tooltip, **not** `--danger`. Add `max-width` + ellipsis to `.jira-chip`.

### Track 5 — PostgresRepository (database-architect + architect) — DEFERRED (CC1)
- New `db/postgres.rs` (second `ItemRepository` impl), `db/mod.rs` `pub use`, `lib.rs setup()` selection (env var or Cargo feature), `Cargo.toml` (sqlx `postgres` + a TLS backend). `models.rs` does **not** change (models are already engine-neutral: `Json<Vec<String>>` tags, `sqlx::Type` text enums, `String` timestamps, `bool`).
- **Two structural problems that make this more than "add an impl":**
  - **Tiebreak (CC2):** re-spec "`rowid DESC`" → "monotonic insertion sequence"; keep `rowid` on SQLite, add `seq BIGINT GENERATED ALWAYS AS IDENTITY` on Postgres. `(created_at, id)` is **not** an option — `id` is a random UUIDv4, so it would be a genuine behavior break (same-instant items reorder unpredictably). The `#[cfg(feature="test-support")] set_timestamps_for_test` seam must exist on the Postgres impl too, or the tiebreak tests can't run there.
  - **Migrations:** split into per-engine trees `migrations/sqlite/` + `migrations/postgres/`, each impl calling `sqlx::migrate!("./migrations/<engine>")`. Relocating the existing SQLite files is safe **only if byte-identical** — sqlx's `_sqlx_migrations` ledger checksums content, not path (any whitespace edit trips "migration modified").
- Dialect leaks that stay behind the trait: FTS5→`tsvector` (`GENERATED ALWAYS AS ... STORED` + GIN, replacing the 3 sync triggers); `json_each(tags)`→`jsonb` (`jsonb_array_elements_text`, `= ANY($1)`); `?1`→`$1`; `BEGIN IMMEDIATE` delete-project lock → `SELECT ... FOR UPDATE`/serializable. `projects.name` must be `COLLATE "C"` to match SQLite BINARY case-sensitivity.
- **Search-rank parity is impossible** (bm25 vs `ts_rank`): declare search ordering **engine-specific**; parity tests assert set-equality + filter correctness, not positional order. The Postgres search sanitizer is **new code**, not a port — tokenize input and emit bound `token:*` lexemes to `to_tsquery` (`websearch_to_tsquery` drops prefix matching and would fail the existing "prefix matches 'Quarterly'" test).
- Timestamp caveat (applies to SQLite too, worth fixing now — see §5 CC-adjacent): `chrono::to_rfc3339()` emits variable fractional precision, so lexical ordering only equals chronological if normalized. Masked by the `rowid` tiebreak today; becomes visible under Postgres. Normalizing the producer to fixed precision is a cheap, independent hardening.
- **Preconditions to lift the deferral** are enumerated in §10.

## 4. Security Considerations

*(security-auditor agent; single-user local desktop — injection, unsafe-URL/SSRF, secret handling, data integrity dominate. Baseline confirmed strong: parameterized SQL, `fts_query()` sanitizer, `jira_url` http(s) write allowlist, keyring-only secrets with no read-back, Phase-3 open-time URL guard, scoped opener, zero `dangerouslySetInnerHTML`, and no backend logging framework — so no secret-in-logs risk exists today; keep it that way.)*

**Track 1 — Installer:**
- **[High] Code-sign the installer/binary**, or document unsigned distribution + SmartScreen as an explicit known limitation (re-evaluate the moment it's handed to anyone else). Signing material comes from CI secrets / the OS store, never the repo/bundle (only a thumbprint — public — in config).
- **[High] Ship no secrets in the bundle** — verify no `.env`/keys/DSN/signing key is tracked or bundled (`git ls-files | grep -iE '\.env|secret|\.pfx|\.key'` empty; keyring-only posture means no key is ever in config).
- **[Medium] Verify keyring in the packaged build** (not just `tauri dev`): install, save a key, relaunch, confirm `has_api_key` + a real rewrite round-trip against Windows Credential Manager. (`SERVICE` is a hardcoded literal, so target naming shouldn't drift — but Credential Manager is per-user; test under the dogfood account.)
- **[Medium] Set a real CSP.** `tauri.conf.json` has `"csp": null` (verified) — no backstop for the new remote-derived content (streaming AI tokens, JIRA data). Define a restrictive CSP (e.g. `default-src 'self'`; all HTTP is Rust-side today, so `connect-src 'self'` likely suffices) as defense-in-depth behind the render-as-text rules.
- **[Medium] Updater trust:** if an updater is added, it must be signature-verified (pubkey in config, private key in CI only); otherwise state explicitly that no updater ships.

**Track 2 — Due-date:** **[Low]** frontend-only over existing `dueAt`. Confirm the date value renders only as a controlled `<input value>` / text node / `title` attribute — no new sink. Backend stays authoritative (stores opaque RFC3339 TEXT). Confirm no `due_at` sort key is ever built from user text (it's a static `Sort` enum arm).

**Track 3 — Streaming:**
- **[High] Streamed tokens render as React text only** — never HTML. AI output is attacker-influenceable (spoofed/prompt-injected provider echoing markup); with `csp: null` there is no backstop, so render-as-text is the sole control. Repro: a chunk `<img src=x onerror=alert(1)>` must display as literal text.
- **[High] The stream never auto-writes the editor body** — chunks populate only the proposal buffer; `body`/`updatedAt` change only on explicit `Replace text`. Repro: run a rewrite, don't click Replace → `update_item` never fires.
- **[Medium] Use request-scoped `tauri::ipc::Channel`**, not a global `emit`/`listen` (no ambient broadcast; no new event capability). **[Medium]** aborted/errored streams fail closed (partial text never auto-applied) and never serialize the API key into a channel/`AppError` payload (key stays in headers).
- **[Info]** `tauri::ipc::Channel` is in-crate; the only dependency change is enabling reqwest's `stream` feature — flag it.

**Track 4 — JIRA enrichment (largest new surface):**
- **[Critical] SSRF / host-pinning.** `item.jira_url` passes only a *scheme* allowlist, not a host allowlist — it can be `http://169.254.169.254/...`, `http://localhost:port`, or any internal host. Enrichment must call **only** the configured Atlassian `base_url` (server-held config), keyed by the server-re-extracted ticket id; `jira_url`'s host is discarded after key extraction and is never a `reqwest` destination. Enforce **server-side** (frontend `ticketLabel`/`isHttpUrl` are cosmetic per plan.3.md). The anchored key regex also blocks `../`, `?`, `#`, whitespace in the one dynamic path segment. Repro: an item `jira_url` of `http://169.254.169.254/latest/meta-data/` triggers no request to that host.
- **[High] Atlassian token in keyring only** — never returned to the frontend, never logged, attached only as an HTTP `Authorization` header; never echoed into an error body/URL/channel. **[High] TLS verification stays on** — no `danger_accept_invalid_certs`; base URL must be `https`.
- **[Medium] Ticket title/status render as React text only** (Atlassian summaries can contain markup). **[Medium]** 429/4xx/5xx/timeout surface a clean `AppError` (status only, no auth header), degrade the chip to its non-enriched label, and never block opening the link or editing the item.

**Track 5 — Postgres (deferred):**
- **[High] DSN/credentials never in plaintext config or hardcoded** — keyring or env, read at `setup()`, never written to disk; no `postgres://` credential literal in source.
- **[High] SQL-injection parity** — sqlx runtime API with bound params exactly like SQLite; sort keys static from the closed `Sort` enum; `tsvector` input parameterized (`to_tsquery($1)` over sanitized tokens, never concatenated). Dedicated adversarial-input test for the new `tsquery` sanitizer.
- **[Medium] TLS to the DB required** (`sslmode=require`/`VerifyFull`, rustls to match reqwest). **[Medium]** error-mapping parity (duplicate/FK/"project still has N items") returns clean `AppError`, no raw Postgres text leaked; the delete guard runs in an equivalent transaction/lock.
- **[Supply-chain]** sqlx `postgres` + TLS feature + `testcontainers` (dev) are new dependencies — flag and `cargo audit`.

## 5. Design

### Approach
Execute the four value tracks in ascending-architectural-surface order (Installer → Due-date → Streaming → JIRA), each as an isolated, independently-shippable unit that reuses an existing seam (config, `edit()`-wired field, `AiProvider` extension, third trait). Defer PostgresRepository behind explicit preconditions. Land two cheap hardening items early regardless of order: the tiebreak re-spec (CC2) and RFC3339 timestamp-precision normalization. Close the DESIGN.md due-date gap (CC3) before or with the due-date track.

### Architecture
- **Installer:** `tauri.conf.json` config only (bundle target, `windows` block, version). No app code.
- **Due-date:** `Editor.tsx` (task-only control) + `ItemList.tsx` (row display) + pure `dueDate.ts`. Optional, deferred: `Sort::DueDate` across `models.rs`/`types.ts`/`sqlite.rs`.
- **Streaming:** `AiProvider` grows `rewrite_stream` (Channel kept out via `ChunkSink`); new `ai_rewrite_stream`/`ai_rewrite_cancel` commands; `api.ts` wraps the channel into `{result, cancel}`; `Editor` accumulates into `proposal`, never `body`.
- **JIRA:** new `JiraProvider` trait + Cloud impl; `get_jira_ticket` (server-side key re-extraction, host-pinned to configured `base_url`); token in keyring, `JiraConfig` in a new `app_settings` table; `JiraChip.tsx` + `useJiraEnrichment` hook; `SettingsDialog.tsx` gains a JIRA row.
- **Postgres (deferred):** second `ItemRepository` impl behind the trait; per-engine migration trees; `seq` tiebreak; parity test matrix.

### Key Decisions
- **K1 (CC1): Defer Postgres.** A second repo impl ≠ sync; build it only when a sync design names it.
- **K2 (CC2): Re-spec the tiebreak to "monotonic insertion sequence" now.** Keep `rowid` on SQLite; document the `seq` mechanism for Postgres. Avoids entrenching `rowid` in new sort arms.
- **K3 (CC3): Add a DESIGN.md due-date section** before implementing — mono `DUE` label, native date input, date-only, task-only (backend invariant), overdue = existing `--danger` + `· overdue` text, never overdue on a done task.
- **K4: Extend `AiProvider` with `rewrite_stream` (default-impl to one-shot); keep `Channel` out of the trait via `ChunkSink`.**
- **K5: Streaming failure model — preflight rejects the promise; post-start uses one channel terminal event.** UI has a single failure signal.
- **K6: JIRA token in keyring, non-secret `JiraConfig` in a new `app_settings` table.** Don't overload the keyring's never-read-back contract.
- **K7: SSRF host-pinning — enrichment calls only the configured `base_url`; `jira_url` is used only to extract the key, server-side.**
- **K8: Due-date is task-only and (for now) not sortable.** Sort is a separate, explicit full-stack decision with NULLs-last CASE-bucket ordering.
- **K9: Installer = NSIS only, `publisher` + `webviewInstallMode` set, unsigned documented, no updater, versions synced across three manifests.**
- **K10: Normalize the RFC3339 timestamp producer to fixed fractional precision** — closes a latent lexical-vs-chronological ordering hazard, independent of Postgres.

## 6. Implementation Steps

Each track is independently executable in the recommended order. Land and verify one before the next. **When a track is scheduled for real work, pull it into its own focused plan** using this section as the spec; a roadmap step here maps to a small PR.

**Track 0 — Cross-cutting hardening (do these WITH the first scheduled track, whichever it is — not gated on the deferred Postgres track)**
0a. Re-spec the list-order tiebreak wording in `CLAUDE.md` (CC2): "`pinned DESC`, then the sort mode, with `rowid DESC` as the tiebreak" → "…with a monotonic insertion sequence as the tiebreak (SQLite `rowid`; a future Postgres impl an `IDENTITY`/`seq` column)". No behavior change on SQLite; documentation only.
0b. Normalize the RFC 3339 timestamp producer to fixed fractional precision (K10) wherever timestamps are minted in the repository, and add/extend a `repo.rs` test asserting two same-instant items order deterministically. Closes the latent lexical-vs-chronological hazard masked by the `rowid` tiebreak today.

**Track 1 — Installer**
1. In `tauri.conf.json`, set `bundle.targets` to `["nsis"]`; add a `bundle.windows` block with `webviewInstallMode: { type: "downloadBootstrapper" }`; add `bundle.publisher`. Confirm `icon.ico` is multi-resolution.
2. Set an explicit `"csp"` (start `default-src 'self'; connect-src 'self'`) and confirm the app still loads (defense-in-depth for later tracks).
3. Establish version-sync discipline: verify `package.json`/`tauri.conf.json`/`Cargo.toml` agree; document "bump all three in one commit" in the track's DoD.
4. Run `npm run tauri build`; confirm an NSIS artifact in `src-tauri/target/release/bundle/`.
5. Manual: install on a clean Win11 account, launch from the Start Menu shortcut, run first-launch DB migration, save an API key, relaunch, confirm `has_api_key` + a real rewrite round-trips (keyring-in-packaged smoke). Document unsigned/SmartScreen as a known limitation. Confirm no updater ships.

**Track 2 — Due-date UI** *(prerequisite: land the CC3 DESIGN.md due-date section first)*
6. Add the DESIGN.md due-date subsection (K3 defaults).
7. Create `src/lib/dueDate.ts` (`toDateInputValue`, `fromDateInputValue`, `formatDueDate`, `isOverdue(dueAt, now)`) + `src/lib/dueDate.test.ts`; prove one test red against a broken branch.
8. `Editor.tsx`: add a task-only `<input type="date">` (label `DUE`) after priority, wired via `edit()`. Note the state asymmetry vs other fields: local `dueAt` state holds the input's `yyyy-mm-dd` string (not the RFC 3339 wire value), initialized from `toDateInputValue(item.dueAt)` in both the initial `useState` and the reset effect; on create send `dueAt || undefined`, on save send `dueAt ? fromDateInputValue(dueAt) : ""` (empty clears).
9. `ItemList.tsx`: render `due <date>` on task rows with `dueAt`; overdue → `--danger` + `· overdue`, suppressed on done tasks (reuse `released`).
10. `styles.css`: date-input styling + the dark-theme calendar-glyph `filter: invert(1)` rule.
11. *(Deferred sub-decision)* If a due-date sort is approved: add `Sort::DueDate` (`models.rs` + `types.ts`), a `push_sort` arm + `search()` order (NULLs-last CASE bucket), and `repo.rs` tests (soonest-first, NULL placement, pinned-first, rowid-tiebreak on equal `due_at`).

**Track 3 — Streaming rewrites**
12. `ai/mod.rs`: add `ChunkSink` trait + `rewrite_stream(..., sink)` with a default impl delegating to `rewrite()` (one emitted chunk). Add `RewriteEvent`/`RewriteErrorCode` DTOs.
13. `ai/anthropic.rs` + `ai/openai.rs`: implement SSE streaming via `reqwest` `bytes_stream()` (enable the `stream` feature in `Cargo.toml` — flag the dependency change).
14. `commands.rs`: `ai_rewrite_stream(req, on_event: Channel)` (a `ChunkSink` adapter over the channel + a per-request `Arc<AtomicBool>`); `ai_rewrite_cancel(requestId)`; `AppState.cancellations` (entry registered when the stream starts, **removed on any terminal event** so the map can't grow unbounded). Preflight rejects the promise; post-start uses channel terminals. Register both in `lib.rs`.
15. `src/lib/api.ts`: `aiRewriteStream(req, onChunk): { result, cancel }` constructing the `Channel` internally; add DTOs to `types.ts`.
16. `Editor.tsx` (review card owns Replace/proposal; `AiBar.tsx` only for the Rework/Save controls): functional `setProposal` accumulation, `streaming` state, cancel ref + `cancelledRef`. Wire cancel to fire on BOTH the `[item.id, isDraft]` cleanup (navigation) AND clicking `Discard` mid-stream — so discarding actually stops the backend stream, not just the display. `Replace text` disabled while streaming; `Streaming…` label + `aria-live` node. Body never written pre-Replace. Decide whether the single Rework button always streams (recommended) or a fallback non-streaming path stays in the UI (Q-list).
17. `src-tauri/tests/streaming.rs` (new): `FakeStreamingProvider`; assert chunk accumulation/ordering equals a one-shot call, and partial/abort/error/empty-text terminal behavior. Note the limit honestly: the streaming command has no repository access (like `ai_rewrite` today), so a Rust test can only assert the *structural* guard that the stream flow never calls `state.repo` — it cannot observe the real "body only changes on `Replace text`" invariant, which lives entirely in `Editor.tsx` React state. That invariant is verified by **manual smoke** (Section 8) because the project has no component-test infra; covering it automatically would require adding jsdom/@testing-library (a flagged new dependency, out of scope for this track unless the user opts in).

**Track 4 — JIRA enrichment**
18. New migration `0004_app_settings.sql`: `app_settings(key TEXT PRIMARY KEY, value TEXT)`. Add repo methods (or a small settings accessor) + `get_jira_config`/`set_jira_config` commands, **registered in `lib.rs` `generate_handler!`**. `JiraConfig { baseUrl, email }` validated https + non-empty host on save.
19. `ai/keys.rs` reuse: `set_jira_token`/`has_jira_token` (entry `"atlassian"`, empty deletes, boolean-only), **both registered in `lib.rs`**.
20. New `src-tauri/src/jira/mod.rs`: `JiraProvider` trait + `jira_provider_for`; Cloud impl (`GET {base_url}/rest/api/3/issue/{KEY}?fields=summary,status`, Basic `email:token`, timeout, distinct 401/404/429 handling). Add `AppError::RateLimited`/`NotConfigured`.
21. `commands.rs`: `get_jira_ticket(jira_url)` — server-side key re-extraction (Rust port of the anchored regex), host-pinned to `base_url`, `AppError::Invalid` if no key. `TicketMeta` in `models.rs` + `types.ts`. Register in `lib.rs` (all five JIRA commands must appear in `generate_handler!`).
22. `src/lib/api.ts`: `getJiraTicket`, `getJiraConfig`, `setJiraConfig`, `setJiraToken`, `hasJiraToken`.
23. Frontend: `JiraChip.tsx` + `useJiraEnrichment(url)` hook (fetch/cache/debounce, states no-token/loading/loaded/stale/error); `JiraRow.tsx` delegates; click always opens the browser; status dot reuses `.dot-*`; `.jira-chip` max-width/ellipsis. `SettingsDialog.tsx` gains a JIRA config + token row (mirror the API-key row).
24. `src-tauri/tests/jira.rs` (new): `FakeJiraProvider`; enrichment mapping, error/stale/token-absent states, and the **SSRF-guard** test (an item `jira_url` on a foreign/metadata host must not be called) — prove red against a "use `jira_url`'s host" bug.

**Track 5 — PostgresRepository (DEFERRED)**
25. *(Do not implement now.)* The cheap groundwork (CC2 tiebreak re-spec, K10 timestamp normalization) is Track 0 above and should already be done with the first scheduled track. Record the §10 preconditions; full implementation waits on a real sync design.

## 7. Files to Create or Modify

| File | Action | Track | Purpose |
|------|--------|-------|---------|
| `src-tauri/tauri.conf.json` | Modify | 1 | NSIS target, `windows` block (publisher, webviewInstallMode), CSP, version |
| `package.json` / `Cargo.toml` | Modify | 1,3,5 | Version sync (1); reqwest `stream` feature (3); sqlx `postgres`+TLS, testcontainers (5, deferred) |
| `CLAUDE.md` | Modify | CC2 | Re-spec list-order tiebreak wording |
| `docs/DESIGN.md` | Modify | CC3/2 | Add the due-date subsection (label, control, overdue, task-only) |
| `src/lib/dueDate.ts` (+ `.test.ts`) | Create | 2 | Pure date helpers + unit tests |
| `src/components/Editor.tsx` | Modify | 2,3 | Task-only due-date control; streaming proposal accumulation + cancel |
| `src/components/ItemList.tsx` | Modify | 2 | Due-date row display + overdue cue |
| `src/components/Editor.tsx` (review card) | Modify | 3 | Streaming affordance (`Streaming…`, disable Replace mid-stream, Discard→cancel) — review card lives here, not AiBar |
| `src/styles.css` | Modify | 2,3,4 | Date input + dark glyph; `.review-streaming`; `.jira-chip` ellipsis |
| `src-tauri/src/ai/mod.rs` | Modify | 3 | `ChunkSink` + `rewrite_stream`, `RewriteEvent` DTOs |
| `src-tauri/src/ai/anthropic.rs`, `ai/openai.rs` | Modify | 3 | SSE streaming impls |
| `src-tauri/src/commands.rs` | Modify | 3,4 | `ai_rewrite_stream`/`cancel`; `get_jira_ticket`, jira config/token commands |
| `src-tauri/src/lib.rs` | Modify | 3,4 | Register new commands; `AppState.cancellations` |
| `src-tauri/src/models.rs` | Modify | 4 (2 if sort) | `TicketMeta`, `JiraConfig`; `Sort::DueDate` only if sort approved |
| `src/types.ts` | Modify | 3,4 (2 if sort) | Mirror streaming/JIRA DTOs; `Sort` union if sort approved |
| `src/lib/api.ts` | Modify | 3,4 | `aiRewriteStream`; jira lookup/config/token wrappers |
| `src-tauri/src/jira/mod.rs` | Create | 4 | `JiraProvider` trait + Atlassian Cloud impl (Rust backend module) |
| `src-tauri/migrations/0004_app_settings.sql` | Create | 4 | `app_settings` table for non-secret JIRA config |
| `src-tauri/src/error.rs` | Modify | 4 | `RateLimited`, `NotConfigured` variants |
| `src/components/JiraChip.tsx`, `src/hooks/useJiraEnrichment.ts` | Create | 4 | Enriched chip + fetch/cache hook |
| `src/components/JiraRow.tsx`, `SettingsDialog.tsx` | Modify | 4 | Delegate to chip; JIRA config/token settings row |
| `src-tauri/tests/streaming.rs` | Create | 3 | Streaming invariant tests + `FakeStreamingProvider` |
| `src-tauri/tests/jira.rs` | Create | 4 | Enrichment + SSRF-guard tests + `FakeJiraProvider` |
| `src-tauri/tests/repo.rs` | Modify | 2 | Due-date CRUD/clear; due-date sort (if approved) |
| `src-tauri/src/db/postgres.rs`, `migrations/{sqlite,postgres}/` | Create | 5 | DEFERRED — second impl + per-engine migration trees |

## 8. Test Strategy

*(test-writer + database-architect. Existing infra: Rust `src-tauri/tests/repo.rs` (in-memory SQLite, invariant suite); vitest node-env for pure helpers in `src/lib/*.test.ts`; no jsdom/component tests; manual smoke for UI/native. Prove every invariant-shaped test red against a deliberately broken impl before trusting it — the Phase-3 vacuous-pass discipline.)*

- [ ] **Unit tests:**
  - **Due-date (vitest, new `src/lib/dueDate.test.ts`):** `formatDueDate` known/boundary/invalid (no throw); `isOverdue(dueAt, now)` — past+not-done → true, past+done → false, null → false, today-boundary explicit (the likely off-by-one); `toDateInputValue`/`fromDateInputValue` round-trip; empty-clears passthrough (never coerce `""`→`undefined`). Non-vacuous: flip `isOverdue`'s comparator, confirm red.
  - **JIRA key re-extraction (Rust unit):** the server-side anchored-regex port matches `jira.ts` behavior (`…/browse/PLAT-142` → `PLAT-142`; no key → error).
- [ ] **Integration tests:**
  - **Due-date (extend `repo.rs`; currently zero `due_at` coverage):** create/update round-trip; `due_at: Some("")` clears to `None`; `due_at: None` in patch leaves it unchanged; **and the CLAUDE.md invariant regression — a `due_at` patch on a Note is silently dropped** (`sqlite.rs` gates it on `Kind::Task`, but it's untested today; close the gap in this track). If sort added: `sort_due_at_orders_soonest_first` incl. NULL placement, pinned-supremacy, and an explicit equal-`due_at` tiebreak-stability test.
  - **Streaming (`src-tauri/tests/streaming.rs`, new):** `FakeStreamingProvider` emits N chunks → accumulator assembles correctly and equals a non-streamed call; a **structural** guard that the stream flow never calls `state.repo` (the closest the backend can assert); partial/abort → terminal `Cancelled` not `Done`; error mid-stream surfaces; empty-text preflight rejects before any stream. **The real "body unchanged until `Replace text`" invariant is frontend-only and covered by manual smoke** (no component-test infra — see step 17); if the user opts into jsdom/@testing-library (flagged dependency), add a component test that runs a stream to completion and asserts the `body` textarea value is unchanged until Replace is clicked (prove red against auto-apply).
  - **JIRA (`src-tauri/tests/jira.rs`, new):** `FakeJiraProvider` — valid enrichment mapping; missing optional fields don't panic; distinct not-found/API-error/token-absent states; stale/TTL if cached. **SSRF guard (hard assertion):** seed an item whose `jira_url` host is foreign/metadata (`http://169.254.169.254/…`); assert enrichment calls only the configured Atlassian host (or refuses), never the stored host. Prove red against a "use `jira_url`'s host" bug.
  - **Postgres parity (deferred):** parameterize `repo.rs` bodies over `&dyn ItemRepository`; run against SQLite in-memory **and** a `testcontainers` Postgres; assert set-equality (not positional rank) for search; dedicated adversarial-input test for the new `tsquery` sanitizer; `set_timestamps_for_test` on both impls; Docker-gate so the Docker-less verify loop stays green.
- [ ] **Edge cases & error scenarios:**
  - Due-date shown only on tasks (notes never — regression guard); done task never overdue; dark-mode calendar glyph visible.
  - Streaming: bursty/out-of-order chunks (functional setState); navigate away mid-stream (no zombie state); Discard mid-stream; provider 401 → error carries status/body but no `x-api-key`.
  - JIRA: no config vs no token vs 401 vs 404 vs 429 vs network — each a distinct, non-leaking UI state; chip still opens the browser in every state; title with markup renders as literal text.
- [ ] **Manual smoke (`npm run tauri dev` / installed build):** installer keyring round-trip (Track 1 §6.5); live streaming accumulates incrementally with body untouched until Replace; live JIRA enrichment against a real token matching the JIRA web UI, and outbound calls only to the configured host.

## 9. Success Criteria

- [ ] **Functional (per shipped track):** (1) `npm run tauri build` produces an installable NSIS package that launches, migrates a fresh DB, and round-trips keyring keys; (2) due dates can be set/cleared on tasks and display with an overdue cue (never on done tasks/notes); (3) rewrites stream incrementally into the review card and never touch the body until `Replace text`, with working cancel; (4) the JIRA chip shows live ticket title/status, degrades cleanly on every failure state, and always opens the browser. Postgres is explicitly deferred (not a gap).
- [ ] **Tests:** all Section 8 tests for shipped tracks pass; every *automated* invariant-shaped test was proven red-then-green (the streaming "body unchanged until Replace text" invariant is frontend-only and verified by manual smoke unless component-test infra is opted in); `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo test` all clean.
- [ ] **Security:** JIRA enrichment is host-pinned to the configured `base_url` (SSRF closed); streamed/JIRA content renders as text (no `dangerouslySetInnerHTML`); tokens stay in keyring and never serialize into errors/logs; a real CSP is set; the installer ships no secrets and is signed or documented-unsigned.
- [ ] **Quality:** new IPC (channels, JIRA lookup) confined to `api.ts`; `types.ts` mirrors `models.rs`; new DESIGN.md due-date section exists; constant accents not re-themed; no new runtime crate except the flagged reqwest `stream` feature (and, only if Postgres is un-deferred, sqlx `postgres`/testcontainers).

## 10. Risks & Open Questions

**Cross-confirmed claims driving plan decisions (no adversarial-verifier needed — verified by ≥2 independent agents or by direct inspection):**
- **CONFIRMED — Due-date has no DESIGN.md spec.** Verified directly: `grep -niE 'due|deadline' docs/DESIGN.md` and `docs/reference/` return nothing. Drives CC3 (must add the spec) and K8 (task-only, no sort yet).
- **CONFIRMED — `dueAt` is task-only.** CLAUDE.md invariant ("Notes never carry status, priority, or dueAt"); the backend silently drops it for notes. Resolves the notes-vs-tasks question with no discretion.
- **CONFIRMED — `rowid` tiebreak cannot port to Postgres verbatim** (tech-lead + database-architect independently); `ctid` isn't stable. Drives CC2. `(created_at, id)` is rejected (random UUID → behavior break); use a `seq` IDENTITY column.
- **CONFIRMED — search-rank parity across engines is impossible** (bm25 vs `ts_rank`). Search ordering must be declared engine-specific; parity tests assert set-equality.
- **CONFIRMED — `csp: null`** in `tauri.conf.json` (verified). Drives the Track-1 CSP requirement.
- **CONFIRMED — keyring `SERVICE` is a hardcoded literal**, not derived from the bundle identifier (devops read of `ai/keys.rs`), so credential naming shouldn't drift dev↔packaged — but per-user scope still needs a packaged-build smoke test.

**Risks:**
- **Streaming vs "proposals never auto-replace body"** — the sharpest scheduled-track risk. Mitigated by the dedicated invariant test (prove red) and the `cancelledRef`/cleanup discipline.
- **JIRA SSRF** — the Critical security item; mitigated by server-side host-pinning + the dedicated SSRF test.
- **Due-date design stall** — if CC3 isn't decided, swap Streaming into slot #2 (architect's conditional).
- **Installer signing/SmartScreen** — external/cost decision; unsigned is acceptable for solo dogfooding **if documented**, re-evaluated when distribution widens.
- **Latent timestamp-precision hazard** — `chrono::to_rfc3339()` variable fractional precision; masked by `rowid` today, surfaces under Postgres. K10 normalizes it cheaply.

**Preconditions to lift the PostgresRepository deferral (CC1) — make explicit before scheduling it:**
1. A real **sync design** exists that names Postgres as the *sync backend*, not a repository swap.
2. The tiebreak invariant is re-specified (CC2) and a `seq` mechanism landed on both impls; `sort_rowid_tiebreak_is_stable` re-expressed.
3. Search ordering formally declared engine-specific; each impl has its own hostile-input-safe query sanitizer with prefix support.
4. A `testcontainers` parity matrix exists and is green, with `set_timestamps_for_test` on both impls and Docker-gating that preserves the Docker-less verify loop.
5. New dependencies approved (sqlx `postgres` + rustls TLS; `testcontainers`/`testcontainers-modules` dev-deps); `cargo audit` clean.

**Open questions (decide when each track is scheduled):**
- **Q1 — Due-date sort/filter:** ship it (full-stack, closed-enum change) or defer to display/edit only? Plan defaults to **defer** (K8).
- **Q2 — Streaming cancel UX:** on Discard/error mid-stream, keep the partial text in the card (with a "stopped" cue) or clear it? The event contract (`Cancelled` vs `Network`) supports either; UX call.
- **Q3 — JIRA base URL source:** a single configured `JiraConfig.baseUrl` (recommended) vs deriving per-item from `jira_url`'s origin (multi-site, but weakens host-pinning). Plan defaults to the single configured host (K7).
- **Q4 — Installer target:** NSIS only (recommended) vs also MSI for enterprise/GPO.
- **Q5 — CSP strictness:** `connect-src 'self'` (all HTTP is Rust-side today) — confirm no webview-side fetch is introduced by any track.

## 11. Code Review Checklist
After implementing any track, verify:
- [ ] No dead code or unused imports; no leftover debug artifacts
- [ ] Error handling covers failure modes (streaming abort/error/empty; JIRA no-config/no-token/401/404/429/network/timeout; installer keyring-absent) — surfaced via toast/state, never a raw rejection
- [ ] No security issues: JIRA enrichment host-pinned to configured `base_url` (SSRF closed); server-side key re-extraction; streamed/JIRA strings render as React text (no `dangerouslySetInnerHTML`); tokens never returned/logged/serialized; TLS verification on; CSP set; installer ships no secrets
- [ ] Security considerations from Section 4 addressed for the track
- [ ] Conventions: new `invoke`/`Channel`/opener calls only in `api.ts`; `types.ts` mirrors `models.rs`; each repo/provider impl owns its SQL/HTTP; commands depend on `Arc<dyn Trait>`; sentence-case copy except mono UPPERCASE labels; DESIGN.md due-date section added
- [ ] Tests cover happy/edge/error; every invariant-shaped test proven red-then-green; new pure helpers unit-tested
- [ ] No performance regressions (no per-render JIRA refetch — debounce/cache; streaming uses functional setState; no N+1 in new SQL)
- [ ] Minimal changes — no unrelated refactoring; constant accents (yellow/danger/status dots) not re-themed; new dependencies flagged (reqwest `stream`, and if applicable sqlx `postgres`/testcontainers)

## 12. Post-Review Improvements

### Track 1 (Installer) + Track 0 (hardening) — shipped 2026-07-15

Implemented: Track 0a (CC2 tiebreak re-spec in both `CLAUDE.md` copies), Track 0b (K10 `now_rfc3339()` fixed-ms producer + `repo.rs` regression test, proven red against the old `to_rfc3339()`), and Track 1 (NSIS-only target, `bundle.publisher`, `webviewInstallMode: downloadBootstrapper`, real CSP replacing `null`, version-sync verified). `icon.ico` confirmed a genuine 6-image multi-resolution ICO (16/24/32/48/64/256). README gained a "Building the installer" section (NSIS-only, unsigned/SmartScreen limitation, no updater, version-sync DoD, packaged-keyring smoke).

Review outcomes (security-auditor + code-reviewer, both read-only on the diff):

1. **CSP tightening — considered, not added (cosmetic).** The auditor noted `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` could be added explicitly, but `default-src 'self'` already denies all three, so the addition is cosmetic. Kept the CSP at the plan's exact recommended `default-src 'self'; connect-src 'self'` (§6 step 2) to keep the change minimal; the string is embedded at build time via tauri-codegen, so no security-relevant behavior differs.
2. **CSP vs Vite HMR in dev — analyzed safe, no `devCsp` needed.** Tauri injects the production `csp` in dev when `devCsp` is unset (confirmed against the Tauri v2 config reference). The dev page's origin is `http://localhost:1420` and Vite's HMR WebSocket targets that same origin; CSP `'self'` matches the `ws://` variant of the page's own origin, so HMR is not blocked. The plan's manual `npm run tauri dev` smoke (step 2/5) remains the human confirmation step and is documented in the README.
3. **`sqlite.rs` doc comments say "rowid DESC" — left as-is.** After CC2 the tiebreak is "a monotonic insertion sequence (SQLite `rowid`; …)", so the SQLite impl's comments describing its concrete mechanism as `rowid` remain accurate. Plan step 0a scopes the wording change to `CLAUDE.md` only; no code-comment churn (global rule 3).

No blocking findings; no code changes required beyond the track itself.

### Track 2 (Due-date UI) — shipped 2026-07-16

Implemented (frontend-only, per §3/§7): the CC3/K3 DESIGN.md "Due dates (new)" subsection; `src/lib/dueDate.ts` (`toDateInputValue`, `fromDateInputValue`, `formatDueDate`, `isOverdue(dueAt, now)`); a task-only `<input type="date">` with a mono `DUE` label in `Editor.tsx` (meta row, after priority, before project); overdue row display in `ItemList.tsx` (`--danger` + literal `· overdue`, suppressed on done via the existing `released`); date-input, dark-mode calendar-glyph, and `.row-due` styles. No `models.rs`/`types.ts`/migration/repository change — `dueAt` was already an opaque RFC 3339 TEXT column. The deferred **due-date sort** (K8) was NOT implemented; the `Sort` enum is unchanged.

Tests: 19 new vitest cases in `src/lib/dueDate.test.ts` and 5 new `repo.rs` integration tests (create-persists, empty-clears, omitted-unchanged, **note-patch-silently-dropped** regression, task-due-change-bumps-updatedAt). Both invariant-shaped tests proven red-then-green: the `isOverdue` today-boundary against a `<`→`<=` comparator flip, and the note-patch-dropped test against temporarily removing the `Kind::Task` gate in `sqlite.rs` (restored byte-identical). Full suite: vitest 51, cargo test 53, tsc/build clean.

Review outcomes (security-auditor + code-reviewer, read-only on the diff):

1. **Security — clean.** All four §4 [Low] requirements confirmed: `dueAt` renders only as a controlled `<input value>` / escaped React text node (no HTML sink, no `dangerouslySetInnerHTML`); no `Sort::DueDate` or dynamic ORDER BY; backend untouched; the `toDateInputValue`/`fromDateInputValue` transforms are anchored to `^\d{4}-\d{2}-\d{2}$` with a fixed `T00:00:00Z` suffix, so no script/URL payload can flow through.
2. **Create/save wire format unified — deviation from the plan's shorthand.** §3 wrote "`dueAt || undefined` on create, `dueAt ? fromDateInputValue(dueAt) : ""` on save", which would store a raw `yyyy-mm-dd` on create but an RFC 3339 value on save. Both paths now route through `fromDateInputValue`, so the stored wire value is a consistent `yyyy-mm-ddT00:00:00Z` regardless of create-vs-update, honoring the "RFC 3339 TEXT end to end" convention. All date math operates on the calendar-date parts (never `new Date(rfc3339)` in local tz), so a bare-date stored form still displays correctly — the change is defensive consistency, not a behavior requirement.
3. **`new Date()` hoisted (code-reviewer nit — fixed).** The overdue check's clock read moved out of the `items.map()` callback to one `const now` per render pass (`ItemList.tsx`). Cosmetic/micro-perf; no behavior change.
4. **`<label>`-wrapped DUE control kept (code-reviewer nit — no change).** The DUE field wraps its label+input in `<label>` where the sibling JIRA field uses a plain `<span>` + `aria-label`. Kept as-is: the explicit `aria-label="Due date"` still wins the accessible-name computation, and the wrap adds click-to-focus. A minor a11y improvement, not a defect.

Backend observation (out of scope, flagged not fixed): the repository **create** path (`sqlite.rs:213` `due_at: input.due_at.filter(|s| !s.is_empty())`) does NOT gate `due_at` on `kind`, unlike status/priority (lines 205–211) and unlike the **update** path (task-gated at line 271). A note created with a `due_at` would persist it, a latent gap in the "notes never carry dueAt" invariant. This track is frontend-only (§3 forbids backend changes here) and the UI gates create on `isTask`, so it is unreachable via the app; left for a future backend-hardening pass. Also noted: the test-writer saw the pre-existing `sort_updated_is_default` test flake once during a red run (equal-ms timestamp tie) but pass on every clean run — pre-existing, unrelated to this track.

### Track 3 (Streaming rewrites) — shipped 2026-07-16

Implemented (§6 steps 12–17): `AiProvider` gained `rewrite_stream(http, text, instruction, sink: &dyn ChunkSink)` with a default impl that delegates to `rewrite()` and emits one chunk; Tauri's `Channel` is kept out of `ai/mod.rs` behind the new `ChunkSink` trait (`send_chunk`/`is_cancelled`), bridged only by `ChannelSink` in `commands.rs` (CC4/K4). New camelCase tagged union `RewriteEvent` (`Chunk|Done|Error`) + `RewriteErrorCode` in `ai/mod.rs`, mirrored in `types.ts`. SSE streaming impls in `anthropic.rs`/`openai.rs` parse `data:` frames via a private `parse_delta`. Commands `ai_rewrite_stream`/`ai_rewrite_cancel` with `AppState.cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>` (entry removed on every terminal). `api.ts` `aiRewriteStream` constructs the `Channel` and returns `{ result, cancel }`; components see only an `onChunk` callback. `Editor.tsx` accumulates into `proposal` with a functional setState, a `STREAMING…` chip, `Replace text` disabled mid-stream, an `aria-live` node, and per-request cancel wired to Discard and to the navigation-cleanup. A one-line DESIGN.md behavior note was added (the review card now streams). The single Rework button always streams (Q2/step-16 recommended path); the one-shot `ai_rewrite` command + its `api.ts` wrapper are retained as the documented fallback.

**Failure model (K5):** preflight (empty text / unknown provider / missing key) rejects the invoke promise; once the stream starts, every outcome — Done, Error, or Cancelled — is reported via exactly one channel terminal and the command returns `Ok(())`. A cancelled stream is forced to `Cancelled` even if the provider returned partial `Ok` text (the flag wins). Errored/cancelled streams fail closed: the partial proposal is discarded, never applied to the body.

**Deviations / decisions:**
1. **No new dependency — not even the flagged `reqwest` `stream` feature.** §3/§4 anticipated enabling reqwest's `stream` feature for `bytes_stream()`. The impl instead uses `reqwest::Response::chunk()`, which is available without that feature (and needs no `futures`/`StreamExt` import), so `Cargo.toml` is unchanged. `tauri::ipc::Channel` and `Arc<AtomicBool>` are in-crate/std. Strictly fewer changes than planned.
2. **Per-request `cancelled` closure flag instead of a shared `cancelledRef`.** The plan suggested a `cancelledRef` ref checked before each chunk-driven setState. A single shared ref is unsafe across overlapping requests: the `[item.id,isDraft]` reset would flip it back to `false` while a prior request's promise is still settling, letting a stale late chunk mutate the new item's card. Each `rework()` invocation now owns a closure-local `cancelled` flag; `stopRef` holds that request's stopper. This correctly isolates navigate-away / new-rework / discard races (confirmed by the code-reviewer).

**Tests:** `src-tauri/tests/streaming.rs` (9) covers the `AiProvider`/`ChunkSink` contract — accumulation-equals-ordering, default-impl-one-chunk, cooperative cancellation (both proven red-then-green), the exact `RewriteEvent`/`RewriteErrorCode` wire shapes (locks the `types.ts` mirror), and verbatim markup passthrough. Inline `#[cfg(test)] mod tests` in `anthropic.rs`/`openai.rs` cover `parse_delta` (valid/`[DONE]`/comment/malformed/non-text frames, markup verbatim). `ai/mod.rs` gained tests for `take_lines` (partial-line retention, EOF flush, multibyte-codepoint-split reassembly). Full suite: **vitest 51, cargo test 77 (15 lib + 53 repo + 9 streaming), tsc/build clean.**

Review outcomes (security-auditor + code-reviewer, read-only on the diff):

1. **Security — clean, all five §4 items SATISFIED.** Streamed tokens render only as an escaped React text node (`<pre>{proposal}</pre>`, no `dangerouslySetInnerHTML` anywhere); the body is written only by the `Replace text` click handler (backend never touches `state.repo`); the channel is request-scoped (no ambient `emit`/`listen`); the API key is attached only as an HTTP header and never serialized into any `RewriteEvent`/`AppError`/log; no new runtime crate. Backed now by the Track-1 CSP, so render-as-text is no longer the sole backstop.
2. **SSE buffer hardening (code-reviewer Warning 1 + auditor info — fixed).** The original line buffer was a `String` fed with `from_utf8_lossy` per raw chunk (a multibyte codepoint split across chunks → U+FFFD) and only flushed on `\n` (a final frame arriving without a trailing newline before EOF → silently dropped, emitting a truncated `Done`). Replaced with a raw `Vec<u8>` buffer split on the `\n` byte plus an EOF flush, extracted into the tested `ai::take_lines(buf, flush)`. Both correctness edges are now covered.
3. **`"Error: "` toast prefix (code-reviewer Warning 3 — fixed).** `aiRewriteStream` rejected `result` with `new Error(message)`, so `String(err)` produced `"Error: …"` — inconsistent with every other toast (which stringifies the bare `AppError` string). Now rejects with the raw message/rejection; toasts match the rest of the app.
4. **Comment nits (code-reviewer — fixed).** Corrected the reset-effect comment (App.tsx keys the editor, so most selections remount; the cleanup fires on unmount and dep-change alike) and annotated the defensive `stopRef.current?.()` at the top of `rework()` (unreachable today because AiBar disables Rework while busy).

Known limitation (documented, not fixed — matches plan §6 step 17 / §8): the command layer (`ai_rewrite_stream`, the cancellation-map lifecycle, the cancellation-wins-over-`Ok` logic) has no automated test, because `tauri::State<AppState>` and `tauri::ipc::Channel` can't be constructed outside a running Tauri app and the project has no component-test infra. The provider/`ChunkSink` contract is tested directly; the one-terminal split and map cleanup were verified by the code-reviewer by inspection; the end-to-end "body unchanged until Replace text" invariant is verified by manual smoke. Adding jsdom/@testing-library (frontend) or a Tauri test harness (backend) is a flagged dependency, out of scope for this track. Also flagged (not a bug): the fake provider in `streaming.rs` models cancellation per-delta while the real providers poll `is_cancelled()` per network read (`response.chunk()`) — both honor the "cooperative, between chunks" contract; the test just shows finer granularity than production provides.

**Manual smoke remaining (requires an interactive session, cannot run here):** with a real API key, run a rework and confirm tokens accumulate incrementally into the card; the body stays untouched until `Replace text`; `Discard` mid-stream stops the backend stream; navigating to another item mid-stream leaves no zombie state; a provider 401 surfaces a clean toast with no `x-api-key`.

## 13. Execution Prompt

```
Implement a track of Phase 4 of the worknotes app, following the roadmap plan at
notes-app/plans/plan.4.md. Read that plan file IN FULL first — it is the authoritative
spec — together with docs/IMPLEMENTATION_PLAN.md (lines 80–87), docs/DESIGN.md (wins on all
UI/microcopy), and notes-app/CLAUDE.md (architecture rules + verification block).

Project root: notes-app/.

SCOPE: Phase 4 is a five-track backlog, not one feature. Do NOT implement all of it at once.
The recommended order is Installer → Due-date UI → Streaming rewrites → JIRA enrichment →
(PostgresRepository is DEFERRED per §2/§10 — do NOT implement it unless its five preconditions
in §10 are met and the user explicitly asks). Unless the user names a specific track, ASK which
track to implement, then implement ONLY that track's steps from Section 6, in order. Each track
is an independently shippable unit.

Honor these cross-cutting decisions (CC1–CC4, K1–K10) from the plan:
  - Land the cheap hardening early regardless of track: re-spec the list-order tiebreak wording
    in CLAUDE.md to "monotonic insertion sequence" (CC2), and normalize the RFC3339 timestamp
    producer to fixed fractional precision (K10).
  - Due-date: it is TASK-ONLY (CLAUDE.md invariant) and has NO DESIGN.md spec — add the DESIGN.md
    due-date subsection BEFORE implementing (CC3/K3). Ship capture/display/overdue only; a
    due-date SORT is a separate, deferred full-stack decision (K8) — do not add it without
    explicit approval. Overdue uses the existing --danger token + a visible "· overdue" word
    (never color-only), never shown on a done task.
  - Streaming: extend the AiProvider trait with rewrite_stream (keep one-shot rewrite as
    fallback); keep Tauri's Channel type OUT of ai/mod.rs via a ChunkSink abstraction; wrap the
    channel inside src/lib/api.ts so components only ever see a callback (CC4/K4). Preflight
    errors reject the invoke promise; post-stream-start outcomes use ONE channel terminal event
    (K5). The editor body is NEVER written until the user clicks Replace text — this is the
    hardest invariant; guard it with a test.
  - JIRA: introduce a JiraProvider trait mirroring AiProvider; get_jira_ticket must RE-EXTRACT
    the ticket key server-side and call ONLY the configured JiraConfig.base_url — never a host
    parsed from the stored jira_url (SSRF host-pinning, K7 — the Critical security item). Token
    in the keyring (boolean-only, never returned); the non-secret JiraConfig{baseUrl,email} in a
    new app_settings table, NOT the keyring (K6). Cloud only; Basic email:token auth.
  - Every new invoke/Channel/opener call stays inside src/lib/api.ts; types.ts mirrors
    models.rs (change both or neither); each provider/repo impl owns its own SQL/HTTP.

Use subagents during implementation (if a named agent type is unavailable, fall back to a
generic type — Explore for read-only analysis, Plan for strategy, general-purpose otherwise —
with the role stated in the prompt):
  - Spawn a test-writer agent to write the track's tests per Section 8 (extend
    src-tauri/tests/repo.rs for due-date; new src-tauri/tests/streaming.rs and jira.rs for those
    tracks; new src/lib/dueDate.test.ts). Prove each invariant-shaped test RED against a
    deliberately broken branch before trusting it (the streaming "never write body before
    Replace text" test and the JIRA SSRF-guard test especially).
  - Spawn a security-auditor agent (read-only: Read, Grep, Glob) to verify the track's Section 4
    requirements in the actual diff — for JIRA the SSRF host-pinning + token handling; for
    streaming the render-as-text + never-write-body + no-key-in-errors; for the installer the
    no-secrets-in-bundle + CSP + keyring-in-packaged.
  - Spawn a code-reviewer agent (read-only: Read, Grep, Glob) on the full diff against the
    Section 11 checklist.
  - Spawn the relevant domain agent ONLY where the track touches its domain: frontend-specialist
    (due-date UI, streaming review card, JIRA chip), api-designer (streaming/JIRA IPC contracts),
    devops-engineer (installer/tauri.conf/signing), database-architect (only if the deferred
    Postgres track or the due-date sort is un-deferred).

After implementing the track:
  - Run the Section 11 Code Review Checklist and address every item.
  - Document any improvements in Section 12 of the plan file and implement them.
  - Run the full verification block from notes-app/CLAUDE.md and fix regressions before finishing:
        cd notes-app
        npm test                     # vitest pure helpers
        npx tsc --noEmit
        npm run build
        cd src-tauri && cargo test   # repository/provider tests
        npm run tauri dev            # manual smoke of the track's DESIGN.md behavior
  - Flag any new dependency (e.g. the reqwest `stream` feature for streaming) explicitly before
    adding it.

Stop when the chosen track's Section 9 success criteria are met and all tests/builds pass. Do
not begin another track without the user's go-ahead.
```
