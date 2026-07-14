# worknotes

A local-first Windows desktop app for work notes and tasks, with built-in AI rewriting. Tauri 2 shell, React + TypeScript frontend, Rust core, SQLite storage with full-text search.

The design has two deliberate swap points, both Rust traits:

- `ItemRepository` (src-tauri/src/db/mod.rs) — storage. SQLite today; a cloud database later means writing one more impl, not touching the UI.
- `AiProvider` (src-tauri/src/ai/mod.rs) — rewriting. Claude and GPT ship; a third vendor or a local model is one new impl plus one match arm.

The React side only ever calls typed commands (`list_items`, `search_items`, `ai_rewrite`, …) through `src/lib/api.ts`. It has no idea what a database or an API key is.

**Working on this repo with Claude Code?** Start with `CLAUDE.md` (architecture rules, invariants, verification commands), then `docs/IMPLEMENTATION_PLAN.md` for the agreed roadmap and `docs/DESIGN.md` for the target UI spec.

## Setup

Prerequisites (Windows): [Rust via rustup](https://rustup.rs) with the default MSVC toolchain, Node.js LTS, and the Visual Studio C++ Build Tools ("Desktop development with C++" workload). Windows 11 already ships the WebView2 runtime; on Windows 10 the installer bootstraps it.

This folder is an overlay onto a fresh Tauri scaffold, which supplies the pieces that are machine-generated (icons, `tauri.conf.json`, `build.rs`, capabilities):

1. `npm create tauri-app@latest notes-app` — choose **npm**, then the **React / TypeScript** template. The app name must be `notes-app` so the crate and lib names line up.
2. Copy everything in this folder over the scaffold, overwriting on conflict.
3. `cd notes-app && npm install`
4. `npm run tauri dev`

First compile pulls the full Rust dependency tree — a few minutes. After that, incremental builds are quick and the frontend hot-reloads.

To produce a distributable installer later: `npm run tauri build` (NSIS/MSI output under `src-tauri/target/release/bundle`).

## Using the AI rework

Open **API keys** in the top bar and paste a key for Anthropic and/or OpenAI. Keys go straight into the **Windows Credential Manager** via the `keyring` crate — not into a config file, not into localStorage. No IPC command returns a key to the frontend; the UI can only ask "is one saved?" (`has_api_key`). Saving an empty key removes it.

Select a note, then use the bar under the editor: pick a provider, hit a preset ("Tighten this up", "Fix grammar and spelling", …) or type your own instruction. The result arrives as a yellow **Proposed rewrite** card — nothing touches your text until you click **Replace text**. Rewrites are proposals, never silent overwrites.

Models are constants at the top of each provider file — `MODEL` in `src-tauri/src/ai/anthropic.rs` (default `claude-sonnet-4-6`; current names at https://docs.claude.com/en/docs/about-claude/models/overview) and `src-tauri/src/ai/openai.rs` (default `gpt-4o-mini`).

## Where things live

```
CLAUDE.md                     project guide for Claude Code (invariants, conventions)
docs/
  DESIGN.md                   the agreed UI/behavior specification
  IMPLEMENTATION_PLAN.md      phased roadmap for the not-yet-built features
  reference/                  interactive design prototype + design-tool handoff
src/                          React frontend
  lib/api.ts                  the ONLY file that calls invoke()
  types.ts                    TS mirrors of the Rust models
  components/                 ItemList, Editor, AiBar, SettingsDialog
src-tauri/
  migrations/                 0001: items table + FTS5 + sync triggers
                              0002: task priority, pinning, list-order index
  src/
    models.rs                 Item, Kind, Status, DTOs (serde camelCase over IPC)
    db/mod.rs                 ItemRepository trait  ← storage swap point
    db/sqlite.rs              sqlx implementation, sanitized FTS5 search
    ai/mod.rs                 AiProvider trait      ← model swap point
    ai/anthropic.rs, openai.rs, keys.rs
    commands.rs               thin #[tauri::command] handlers
    lib.rs                    wiring: open DB in app-data dir, register commands
  tests/repo.rs               repository integration tests — `cargo test` from src-tauri
```

Data lives in `%APPDATA%\<identifier>\notes.db` (WAL mode). Lists sort pinned-first, then by `updated_at` — which only content edits refresh; pinning or archiving something never changes its edit timestamp. Search is SQLite FTS5 over title + body, kept in sync by triggers; user input is quoted into prefix phrases so characters like `"` or `(` can never cause a query error.

## Moving to a cloud database later

Write `db/postgres.rs` implementing `ItemRepository` (sqlx already supports Postgres — add the `postgres` feature), including its own `search` using `tsvector` instead of FTS5. Then change one line in `lib.rs` where the repository is constructed. Nothing else in the app knows or cares.

## What has been verified, and what hasn't

The storage and AI layers (everything except the two thin Tauri glue files) were compiled with rustc 1.91 and exercised by the integration tests in `src-tauri/tests/repo.rs` against in-memory SQLite: CRUD, FTS5 availability in the bundled SQLite, index sync on update, prefix search, hostile-input search, archived-item exclusion, priority/pinned semantics, deterministic ordering, timestamp rules, validation, and the exact camelCase JSON shapes the frontend types expect. (They were verified against a non-Tauri mirror of the same modules; on this machine `cd src-tauri && cargo test` runs the identical file directly.) The React code passes `tsc --noEmit` under the strict template config and produces a clean production bundle.

Not verified here: `commands.rs` and `lib.rs` compile only against the real `tauri` crate, so their first compile happens on your machine during `npm run tauri dev` — they are small and were written against stable Tauri 2 APIs, but if anything trips, it will be in those two files. Live API calls to Anthropic/OpenAI were also not made (no keys here); the request/response shapes follow each vendor's current documented API.
