# worknotes — Claude Code project guide

Local-first Windows 11 desktop app: one person's work notes and tasks, with AI rewriting.
Stack: Tauri 2 shell · React 19 + TypeScript (Vite) · Rust core · SQLite via sqlx (runtime API) · FTS5 search.

## Read first
1. `docs/DESIGN.md` — the authoritative UI/behavior spec (tokens, layout, interactions, microcopy). Where the HTML prototype disagrees, DESIGN.md wins.
2. `docs/IMPLEMENTATION_PLAN.md` — the agreed roadmap. Work phases top to bottom; each has acceptance criteria.
3. `docs/reference/` — the interactive design prototype (`Worknotes_dc.html`, open in a browser) and the design tool's handoff notes.

## Architecture (do not bypass)
- The frontend never touches storage, AI vendors, or keys. It calls typed Tauri commands, and only through `src/lib/api.ts` — components never call `invoke()` directly.
- Two swap points, both Rust traits: `ItemRepository` (`src-tauri/src/db/mod.rs`) and `AiProvider` (`src-tauri/src/ai/mod.rs`). Commands depend on `Arc<dyn ItemRepository>` and a provider registry — never on a concrete impl.
- Each repository impl owns its own SQL. SQLite uses FTS5 for search; a future Postgres impl would use `tsvector`. None of that may leak past the trait.
- `src-tauri/src/lib.rs` `setup()` is the single place that knows which repository the app runs on.

## Invariants (enforced in the repository layer — keep them there, not just in UI)
- The backend owns `id`, `createdAt`, `updatedAt`. `updatedAt` moves ONLY on content edits (title, body, status, priority, dueAt, tags — and once added: project, jiraUrl). Pin and archive flips never move it, and never reorder the list by recency.
- `kind` is fixed at creation. Notes never carry status, priority, or dueAt — patches attempting it are silently ignored.
- List order: `pinned DESC`, then the sort mode, with a monotonic insertion sequence as the tiebreak (SQLite `rowid`; a future Postgres impl an `IDENTITY`/`seq` column) — equal timestamps must never flap. Archived items are excluded from the default list AND from search.
- All search input goes through `fts_query()` (quoted prefix phrases). Never feed raw user text to `MATCH`.
- API keys live in the OS credential store (`keyring`). No command returns a key — `has_api_key` returns a boolean only. Saving an empty key deletes it.
- AI rewrites are proposals. Nothing replaces the body without an explicit user action (`Replace text`).
- Tag vocabulary is DERIVED, never stored: a tag exists while ≥1 non-archived item that is not a done task carries it. Do not add a tags table.
- Projects are id-referenced entities (rename-safe). Deleting a project that still has items assigned must fail in the repository with a clear error — the disabled UI button is not the enforcement.
- Empty string clears optional text fields over IPC (`dueAt`, and once added `jiraUrl`); omitted fields mean "unchanged".

## Conventions
- IPC DTOs are serde camelCase. `src/types.ts` mirrors `src-tauri/src/models.rs` — change both or neither.
- sqlx runtime API only (`query`, `query_as`, `QueryBuilder`). No `query!` compile-time macros; the build must never need a live `DATABASE_URL`.
- Schema changes are additive numbered migrations in `src-tauri/migrations/`; sqlx applies them at startup. Never edit an existing migration.
- Timestamps are RFC 3339 TEXT end to end (SQLite ↔ Rust ↔ JS), no mapping layers.
- Styling: CSS custom properties in `src/styles.css`, tokens per `docs/DESIGN.md`. Five named palettes are selected via `data-palette` on `<html>` alongside a polarity `data-theme` (`light`/`dark`), both set atomically; a palette swaps the neutrals **and** the accent/danger family (`--mark*`, `--danger`, and `--todo` all vary per palette). Only the doing/done status-dot colors are constant across all five. (Pre-Plan-11 this read "themes swap neutrals only; accents constant" — that rule is relaxed.)
- AI models are constants: `MODEL` in `src-tauri/src/ai/anthropic.rs` (`claude-sonnet-4-6`; current names at https://docs.claude.com/en/docs/about-claude/models/overview) and `src-tauri/src/ai/openai.rs` (`gpt-4o-mini`).

## Verify after every change
```
cd src-tauri && cargo test        # repository integration tests (in-memory SQLite, covers invariants above)
npx tsc --noEmit                  # strict typecheck (noUnusedLocals is on)
npm run build                     # production bundle must stay clean
npm run tauri dev                 # manual smoke test
```
Extend `src-tauri/tests/repo.rs` alongside every repository change; new invariants get a test in the same commit.

## Current state vs. plan
Implemented and test-covered: items CRUD, FTS5 search with sanitizer, kind/status/priority/pinned/tags/archive semantics, timestamp rules, AI rewrite flow (Anthropic + OpenAI), key storage, and the v1 two-pane UI.
Designed but NOT yet implemented (see `docs/IMPLEMENTATION_PLAN.md`): projects + removal guard, tag lifecycle + pickers + tag filter, status filter + sort modes, JIRA ticket link, dark mode, `Duplicate metadata`, Save button relocation, due-date UI (backend already supports `dueAt`).
