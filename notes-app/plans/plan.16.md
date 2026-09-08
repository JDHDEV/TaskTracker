# Plan 16: Native Context Menu Everywhere + "Insert timestamp"

**Created:** 2026-09-05
**Status:** Implemented 2026-09-05 (approach C; uncommitted — see §12)
**Planning Mode:** Subagent-Enhanced

## 1. Overview

Two related requests for the body editors of worknotes:

1. **Scratch pad menu keeps every default item.** Today a right-click on a *non-empty selection* in the scratch pad opens a React-rendered menu (`src/components/SelectionMenu.tsx`) with the three "New note/task/prompt from selection" items and suppresses the native WebView2 menu — so Cut/Copy/Paste, spell-check suggestions, etc. vanish exactly when the user has text selected. The request is that the menu shows **all** default system/browser items **plus** the custom items.
2. **"Insert timestamp" on every body editor.** A new context-menu item on worknotes, tasks (both `Editor.tsx`), prompts (`PromptEditor.tsx`) and the scratch pad (`ScratchEditor.tsx`) that inserts the current local date and time at the caret.

Both requests are satisfied by one mechanism: stop rendering our own menu and instead **inject custom items into the genuine WebView2 context menu from Rust** (WebView2's `ContextMenuRequested` event), dispatching the chosen item back to the frontend as a Tauri event. The React menu, its CSS, and the scratch-pad `onContextMenu` handler are deleted; the frontend gets simpler. A pure, unit-tested `src/lib/timestamp.ts` supplies the text and the splice.

The plan is **gated by a one-day spike** (Phase 1). If the spike fails its success criteria the executor must STOP and report — the fallback (a Tauri-drawn six-item menu that loses spell-check suggestions on every writing surface) is a product trade-off only the user can accept. It is recorded in §10 so nothing is lost.

## 2. Strategic Assessment

*(Source: tech-lead agent, with the architect's later findings folded in where they superseded it.)*

- **Request 1 is a reversal of a recorded decision, not a bug fix.** `plans/plan.13.md:152` (D8) and `docs/DESIGN.md:150` state the current behaviour as intent: the app owns the menu only when it has something to add. Reversing it is legitimate — the owner asked — but must be a written superseding decision (this plan, §5 D8′) and a rewrite of `DESIGN.md:150`, not a silent change.
- **"All of the default options" is only achievable by hooking the real menu.** WebView2's editable-field menu is roughly: Emoji · Undo · Redo · Cut · Copy · Paste · Select all · spell-check suggestions / Add to dictionary (· Inspect in dev builds). A Tauri/muda `Menu.popup()` can offer exactly six `PredefinedMenuItem`s (Undo/Redo/Cut/Copy/Paste/SelectAll) and **nothing else** — no spell-check fix-its, no emoji entry. The tech lead recommended that six-item approach ("A") *conditional on written acceptance that spell-check is lost*; that acceptance cannot be obtained in an autonomous planning session, and the architect and security auditor both found A introduces a real defect (below). This plan therefore takes the literal approach ("C") and treats A as the user-decided fallback.
- **The tech lead's premise that A needs a capability change was wrong** — `core:default` already includes `core:menu:default` (`src-tauri/gen/schemas/desktop-schema.json:351`, `:662`). Irrelevant for approach C (which needs no `@tauri-apps/api/menu` at all), but recorded because three agents repeated the mistaken claim.
- **Riskiest part (tech lead, confirmed by architect):** platform behaviour that cannot be unit-tested — focus/selection state across a native popup, and (for C) Windows-only COM interop with zero `cargo test` coverage. Mitigation: a timeboxed spike with explicit pass/fail criteria before any wiring, and pushing every testable decision (format, splice, action-id parsing, surface allowlist) into pure helpers.
- **Feature 2 is the cheap, high-value half.** The tech lead suggested shipping it first as a keyboard shortcut. The request is explicit about a *context-menu* item, so the menu item is the deliverable; the pure helper still lands first (Phase 0) because it is approach-independent and fully testable.
- **Right feature now?** Yes for the timestamp (daily-driver ergonomic win in a work-log app). Request 1 is small in user-visible scope but expensive in the literal reading — the spike bounds that cost to one day before committing.

## 3. Research Findings

*(Source: architect agent unless attributed otherwise. All version/behaviour claims were verified against local sources: `node_modules/@tauri-apps/api`, `~/.cargo/registry/src/*/{muda-0.19.3,tauri-2.11.5,wry-0.55.1,webview2-com-0.38.2,webview2-com-sys-0.38.2}`.)*

### The three body editors are structurally identical

| Concern | `src/components/Editor.tsx` | `src/components/PromptEditor.tsx` | `src/components/ScratchEditor.tsx` |
|---|---|---|---|
| body `<textarea>` | `:978` | `:623` | `:415` |
| `bodyRef` | `:256` | `:181` | `:121` |
| `pendingCaretRef` | `:260` | `:185` | `:125` |
| caret-restore `useLayoutEffect` (dep `[body]`) | `:287–294` | `:207–214` | `:152–159` |
| edit chokepoint | `:681` **curried** `edit(setBody)(v)` (used `:984`, `:1006`) | `:439` **curried** | `:305` **plain** `edit(value)` |
| `trackSelection` / `clearSelection` | `:262` / `:274` | `:187` / `:199` | `:133` / `:142` |
| `onContextMenu` | none | none | `:315–323`, wired `:429` |
| title `<input>` | `:730` | `:478` | n/a |

The caret-restore effect is byte-identical in all three: when `body` changes and `pendingCaretRef` is set, it focuses the textarea and calls `setSelectionRange`. **This is the ready-made insertion mechanism** — set `pendingCaretRef`, call `edit(...)`, done. Every programmatic insert in the app (`spliceProposal`, `pasteLine`) already uses it.

**Draft-backup coupling (hard requirement):** `edit()` bumps `lastEditRef` (Editor `:687`, Scratch `:309`); `src/hooks/useDraftBackup.ts:119` skips `flushNow` when `lastEditRef.current <= lastFlushRef.current`, and the periodic tick reads the same ref (`:129`). An insert that called `setBody` directly would be dirty on screen but **invisible to the Plan-15 crash-safe backup**.

### Current scratch-pad menu and its data flow

- `ScratchEditor.tsx:315–323` — `captureSelection` (`src/lib/selection.ts:34`) returns `null` for collapsed / inverted / out-of-range / whitespace-only; `null` → return without `preventDefault` (native menu shows); otherwise `preventDefault`, stash in `menuSelRef` (`:131`), open the React menu at `clientX/Y`.
- `closeMenu()` (`:327–335`) re-focuses and re-selects because `usePopover` only refocuses the trigger — needed only because the React menu steals DOM focus.
- Send flow (`plan.13.md:141`): `SelectionMenu` click → `ScratchEditor.sendTo` (`:337–341`, calls `closeMenu()` first) → `ScratchPage` prop `onSendTo={(dest, text) => sendTo(t.item.projectId, dest, text)}` (`:424`) → `ScratchPage.sendTo` (`:346–349`) → `App.tsx` `sendSelectionToItem` / `sendSelectionToPrompt` (`:1117–1118`). Copy, not cut; nothing persisted until the destination's Save.
- `SelectionMenu.tsx` (105 lines) also **exports the `SendDestination` type** imported by `ScratchEditor.tsx:25` and `ScratchPage.tsx:19` — deleting the component orphans the type; it needs a lib home.
- CSS: `.context-menu` / `.context-menu-item` at `src/styles.css:1134–1163`; sole consumer is `SelectionMenu`. `.popover` (`:1115–1128`) stays (tag/move popovers).
- `src/hooks/usePopover.ts` stays untouched (still used by tag popovers).

### Conventions that bind this plan

- **IPC chokepoint:** `src/lib/api.ts` is the only file importing `@tauri-apps/*` (`notes-app/CLAUDE.md:12`, `api.ts:28–29` "the IPC surface stays greppable"). Precedents: `confirmDialog` (`api.ts:403`, plugin call), `onFlushDrafts` (`api.ts:195–200`, `listen` wrapper returning an unsubscribe — "The IPC-only-through-api.ts rule covers events too"), `aiRewriteStream` (`api.ts:281–322`, resource-owning wrapper).
- **Rust→JS event precedent:** `src-tauri/src/lib.rs:52` `window.emit("flush-drafts", ())` consumed by `onFlushDrafts`; `use tauri::{Emitter, Manager}` already at `lib.rs:14`. `setup()` at `lib.rs:63`; `app.manage(...)` at `:87`/`:92`; `generate_handler!` at `:95`. Commands live in `src-tauri/src/commands.rs`.
- **Pure helpers take the clock as an argument** — `formatWhen(iso, now)` (`src/lib/prompts.ts:31`), `isOverdue(dueAt, now)` (`src/lib/dueDate.ts:62`, "this never reads the clock itself"). The zero-padded local-parts builder `localDateKey` (`dueDate.ts:32–37`) is the right template for a `yyyy-mm-dd HH:mm` formatter. **Not reusable** for inserted text: `formatWhen` (relative), `when()` in `ItemList.tsx:51–58` (reads the clock internally — do not copy), `formatDueDate` (day-only, locale-short).
- **Tests:** `vitest.config.ts` → `environment: "node"`, `include: ["src/**/*.test.ts"]`, no jsdom (plan.13 D13). Fake DOM objects are hand-rolled structural types (`lineEdit.test.ts:17–32`); fake clocks are literal `new Date(2026, 6, 15, 9, 0)` (`dueDate.test.ts:80`). **Menu/DOM wiring is manual-smoke-only; only pure helpers get automated tests.** Rust tests in `src-tauri/tests/` + in-module `#[cfg(test)]`.
- **Microcopy** (frontend specialist): `docs/DESIGN.md:185` "Sentence case everywhere"; existing labels are `"New note from selection"` — the shipped label is **"Insert timestamp"** (not the request's "Insert Timestamp"), no ellipsis.
- **Verify gate** (`notes-app/CLAUDE.md:69–76`): `cargo test`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run tauri dev`.

### Approach C prerequisites — all verified present in the pinned crates

- `tauri::webview::Webview::with_webview` — `tauri-2.11.5/src/webview/mod.rs:1668`; `PlatformWebview::controller() -> ICoreWebView2Controller` — `:180`. `WebviewWindow` exposes the same.
- `webview2_com::ContextMenuRequestedEventHandler` — `webview2-com-0.38.2/src/callback.rs:492–496`; `CustomItemSelectedEventHandler` in the same file.
- `ICoreWebView2_11` (adds `add_ContextMenuRequested`) — `webview2-com-sys-0.38.2/src/bindings.rs:39570`. Requires WebView2 Runtime ≥ 1.0.1185.39 (2022); the Evergreen runtime on Windows 11 is far newer, and `tauri.conf.json:37–41` uses `downloadBootstrapper`.
- `ICoreWebView2Environment9::CreateContextMenuItem(label, iconStream, kind)` — `bindings.rs:15878`; the environment is reached via `ICoreWebView2_2::Environment()`.
- `ICoreWebView2ContextMenuTarget` — `IsEditable` (`bindings.rs:8485`), `HasSelection`, `SelectionText` (`bindings.rs:8587`), `Kind`. **No element identity** is exposed — see D4.
- `ICoreWebView2ContextMenuRequestedEventArgs::MenuItems()` → `ICoreWebView2ContextMenuItemCollection` with `InsertValueAtIndex`; items expose `add_CustomItemSelected`.
- Native menus are on today: `wry-0.55.1/src/lib.rs:1688` `default_context_menus: true` → `webview2/mod.rs:571`.
- Crates: `webview2-com` / `webview2-com-sys` **0.38.2**, `windows` **0.61.3**, `windows-core` **0.61.2 and 0.62.2 both present** (`src-tauri/Cargo.lock:5284`, `:5309`, `:5376`, `:5398`, `:5411`). `tauri` does **not** re-export `webview2_com` (`tauri-2.11.5/src/lib.rs:184` re-exports only `tao`/`wry`), so both become **direct** Windows-only dependencies and must match the versions wry resolves — otherwise `controller()`'s `ICoreWebView2Controller` is a different type and the cast will not compile.
- `src-tauri/src` has **zero** existing `tauri::menu`, `Menu::`, `with_webview`, or `webview2` usage — this is the first native-menu code in the project.
- Release builds have no devtools feature (`Cargo.toml:22` `features = []`), so no "Inspect" item in release; `tauri dev` shows one (harmless).

### Why approach A was rejected (recorded so it is not re-litigated)

*(Sources: security auditor H1/H2/M2, architect, adversarial verifier — all from muda/tauri source.)*

- `muda-0.19.3/src/platform_impl/windows/mod.rs:1202–1209` routes Copy/Cut/Paste/SelectAll/Undo/Redo to `execute_edit_command`, which (`:1264–1294`) builds four `INPUT_KEYBOARD` records and calls **`SendInput`** — a system-wide synthesized Ctrl+key delivered to whatever control holds focus. Consequences:
  - the resulting DOM events are `isTrusted === true`, so `handleLineClipboardKeyDown` (`src/lib/lineEdit.ts:105–118`) fires on a menu "Copy" with a collapsed caret and **copies the whole line**; menu "Cut" deletes a line the user never selected. `isTrusted` cannot distinguish the paths. This breaks the contract written at `lineEdit.ts:6–12` and `ScratchEditor.tsx:430–431`.
  - predefined items **never emit a `MenuEvent`** (`mod.rs:1188–1189` `dispatch = false`), so JS cannot suppress or observe them.
  - Undo/Redo via synthesized Ctrl+Z drive Blink's per-textarea undo stack, which React's controlled re-renders bypass — a desync hazard (frontend specialist).
- Only six predefined items exist (`muda-0.19.3/src/items/predefined.rs:244–265`); spell-check suggestions, "Add to dictionary" and the emoji entry are unreachable. On notes/prompts, which have the full native menu today, A is a **net loss of exactly what request 1 asks to preserve**.
- `tauri-2.11.5/src/menu/plugin.rs:889` `MenuChannels(Mutex<HashMap<MenuId, Channel>>)` entries are inserted (`:162–169`, `:218–225`, `:257–264`) and never removed; `Resource.close()` frees the rid but not the map entry — per-right-click rebuilding leaks for the process lifetime.
- `popup()` resolves after `TrackPopupMenu` returns but the custom-item `action` arrives on an independent async path — ordering is undefined (verifier).
- Positioning would be `LogicalPosition(clientX, clientY)` relative to the client area, DPI-scaled by muda (`mod.rs:1023–1031`, `ClientToScreen`) — solved, but moot under C where WebView2 positions its own menu.

## 4. Security Considerations

*(Source: security-auditor agent; approach-A-specific findings H1/H2/M2 are avoided by design and recorded in §3.)*

**MUST**
1. **Static labels, ids, and event payloads only.** Menu item text (`"Insert timestamp"`, the three send-to labels) and action ids are module-level constants in Rust; the Tauri event payload is a static action id string. Never interpolate selection text, body text, titles, project names or UUIDs into a label, an id, or an event payload. Carry the `SelectionMenu.tsx:23` comment ("Static labels — never user text") into `context_menu.rs`.
2. **Selection text never leaves Rust.** `SelectionText` is read only to decide whether the send-to items appear (non-empty, non-whitespace). It is not emitted, logged, or stored. The frontend re-reads the live DOM selection via `captureSelection` (`selection.ts:34–45`, bounds-checked, rejects whitespace-only) when the action arrives — the existing, clean path (`ScratchPage.tsx:346–349` → `App.tsx:622–631`).
3. **Allowlist the surface command input.** `set_context_menu_surface` accepts exactly `"none" | "body" | "scratch"`; anything else is an `Err`, never stored. The frontend derives the value from a `data-menu-surface` attribute the app itself renders, never from user text.
4. **Isolate and gate the COM code.** All `unsafe` lives in one module, `src-tauri/src/context_menu.rs`; its `install` body is compiled only under `#[cfg(windows)]` with a `#[cfg(not(windows))]` no-op twin (the module itself — the `MenuSurface` type and parser — compiles everywhere). Every `cast()` / COM call failure is handled by **skipping installation** (the app runs with the plain native menu) — never a panic in `setup()`. `CLAUDE.md:64`'s panic-free posture for the Rust side is preserved.
5. **Pin the new crates to the versions wry already resolves** (`webview2-com = "=0.38.2"`, and the `windows-core` version `cargo tree -i webview2-com` shows it uses — Cargo.lock has both 0.61.2 and 0.62.2). Place them under `[target.'cfg(windows)'.dependencies]` with a comment naming the coupling. Flagged as new dependencies per `CLAUDE.md` ("Flag any new dependency before adding it") — the user sees this plan before execution.
6. **No clipboard-read capability** is added (`api.ts:379–394` exposes `writeText` only; `lineEdit.ts:6–9`). Approach C uses WebView2's own Cut/Copy/Paste — same trust level as today's native menu.
7. **Route every IPC touchpoint through `src/lib/api.ts`** — the new `invoke` (`setContextMenuSurface`) and `listen` (`onContextMenuAction`) wrappers; components never import `@tauri-apps/*`.
8. **Re-read caret and body at action time**, not at right-click time — the event arrives asynchronously and the buffer may have moved (AI accept, draft restore, tab reseed). Route the insert through `edit()` so `lastEditRef` and the draft backup stay correct. Refuse the splice (`null`) when the range is out of bounds.

**SHOULD**
9. Do **not** tighten `capabilities/default.json` for this plan — approach C uses no `@tauri-apps/api/menu` command, so the dormant `core:menu:default` grant stays dormant. (If the A fallback is ever chosen, append the four `core:menu:deny-*` entries from the auditor's M1 — capabilities are compiled in and are not on the on-disk compatibility surface, `notes-app/CLAUDE.md:34–43`.)
10. Add a vitest asserting the action-id and label constants are the expected literals — the machine-checkable form of MUST 1 (frontend side: `parseContextMenuAction` rejects unknown strings).
11. Validate the event payload in `onContextMenuAction` with `parseContextMenuAction` and drop anything unrecognised.

**NOTE**
12. **No CSP change** — Tauri events and commands use the same IPC transport as every existing command (`tauri.conf.json:23` untouched).
13. **No new exposure from the default menu.** The genuine WebView2 menu is already shown today on notes, prompts, and the no-selection scratch case; this plan does not add a menu surface, it removes a suppression. Do not filter default items (the request is to keep them all).
14. **Timestamp content** (`2026-09-05 14:32`) discloses only what `created_at`/`updated_at` already do; never extend the format with timezone name, host, or user.
15. Size caps on `scratch.md` / item files already bound the insert (`store/scratchfile.rs:11–14`, `:78–82`). No logging anywhere in `src/` or production Rust — keep it that way.

## 5. Design

### Approach

**Hook WebView2's own context menu from Rust (approach C), gated by a spike.** In `setup()`, obtain the main `WebviewWindow`, call `with_webview`, cast the `ICoreWebView2` to `ICoreWebView2_11`, and register a `ContextMenuRequested` handler. The handler reads a Rust-side "which surface has focus" flag (published by the frontend on focus changes), and — when the target `IsEditable` and the surface is a body editor — appends a separator and **"Insert timestamp"** to the collection; when the surface is the scratch pad and the target has a non-whitespace selection, it also appends the three **"New … from selection"** items. Each custom item's `CustomItemSelected` handler emits a Tauri event carrying a static action id. The frontend subscribes once per mounted editor and acts only if its body textarea is `document.activeElement`.

**Rationale:** it is the only approach that literally satisfies request 1 (spell-check, emoji, correct enable/disable states all remain because WebView2 draws its own menu); it adds an item to notes/prompts **without** replacing their complete native menu; it has no `SendInput` collision with the D9 line-clipboard handler; and it lets the frontend **delete** `SelectionMenu.tsx`, its CSS, `menuSelRef`, `closeMenu()`, and the scratch `onContextMenu` handler. Cost: ~150–250 lines of Windows-only `unsafe` COM with no `cargo test` coverage and two version-coupled direct dependencies — bounded by the Phase 1 spike.

### Architecture

```
frontend                                    Rust (src-tauri)
────────────────────────────────────────    ─────────────────────────────────────────────
<textarea data-menu-surface="body"|"scratch">
   │ focusin / focusout (document-level, one hook)
   ▼
useContextMenuSurface ──api.setContextMenuSurface("body"|"scratch"|"none")──▶ commands: set_context_menu_surface
                                                                                │ (allowlist → AppState.menu_surface)
                                                                                ▼
                            right-click ──WebView2──▶ context_menu.rs handler reads AppState.menu_surface via AppHandle,
                                                       target.IsEditable / HasSelection / SelectionText
                                                       → appends static items to the *native* menu
                                                                                │ user picks a custom item
                                                                                ▼
api.onContextMenuAction(handler) ◀──── app.emit("context-menu-action", "<static id>") ◀── CustomItemSelected
   │ parseContextMenuAction (allowlist)
   ▼
Editor / PromptEditor / ScratchEditor effect: if document.activeElement === bodyRef.current
   • "insert-timestamp" → insertText(live value, live selection, formatTimestamp(new Date()))
                          → pendingCaretRef = collapsed after insert → edit(...) → clearSelection()
   • "send-note|task|prompt" (ScratchEditor only) → captureSelection(live) → onSendTo(dest, text)
```

New modules: `src-tauri/src/context_menu.rs` (COM hook + surface state + command), `src/lib/timestamp.ts` (pure), `src/lib/contextMenu.ts` (pure types/parsers; new home of `SendDestination`), `src/hooks/useContextMenuSurface.ts` (one document-level listener, used once in `App.tsx`). Modified: `lib.rs`, `Cargo.toml`, `api.ts`, the three editors, `ScratchPage.tsx` (import path), `styles.css`, `docs/DESIGN.md`. Deleted: `SelectionMenu.tsx`.

### Key Decisions

- **D1 — Approach C with a hard spike gate; no silent fallback.** If Phase 1 fails any criterion, STOP and report. The A fallback loses spell-check on every editor and needs the user's explicit acceptance (§10).
- **D2 — Timestamp format `yyyy-mm-dd HH:mm`, local wall time, zero-padded, no seconds, no offset, no trailing space.** Built from local `Date` parts with `padStart` (template: `dueDate.ts:32–37`), never `toISOString()` (UTC shift) or `toLocale*` (locale-dependent bytes in git-tracked files). Sortable, greppable in FTS, consistent with the house `yyyy-mm-dd` due-date shape. Signature `formatTimestamp(now: Date): string` — clock injected, per convention.
- **D3 — Insert semantics.** Replace a non-empty selection, otherwise insert at the collapsed caret; caret lands **collapsed after** the inserted text (unlike `spliceProposal`, which selects the insert so the user can see the AI change). `insertText(body, range, text): { body, caret } | null` normalises an inverted range and returns `null` when `end > body.length`. Goes through `edit()` + `pendingCaretRef` — the established idiom — so the dirty flag, `lastEditRef`, and the Plan-15 draft backup behave exactly as for a keystroke. **Accepted residual:** like `pasteLine` and `spliceProposal` (`lineEdit.ts:8–12`, plan.14 D9/R4), the insert is not natively undoable with Ctrl+Z. (`document.execCommand("insertText")` would make it undoable but introduces a deprecated API and a third insert idiom — recorded as a possible follow-up in §10, not adopted.)
- **D4 — Surface identity via a focus-published flag, not per-right-click IPC.** WebView2 exposes no element identity, so the frontend tells Rust which kind of field has focus. A single document-level `focusin`/`focusout` listener (hook used once in `App.tsx`) reads `data-menu-surface` off the focused element (`"body"` on the two item/prompt textareas, `"scratch"` on the pad; anything else → `"none"`), dedupes, and calls `api.setContextMenuSurface`. **One shared state, not two:** the flag is a `menu_surface: Mutex<MenuSurface>` field on the existing managed `commands::AppState` (the single-`AppState` convention, `commands.rs:21`), written by a `set_context_menu_surface` command in `commands.rs` and read inside the COM callback via `app_handle.state::<AppState>()` — `install` takes only an `AppHandle`, never its own copy of the state, so the command and the callback cannot diverge. Focus changes precede a right-click by far more than an IPC round-trip, so there is no meaningful race; publishing on the `contextmenu` event instead **would** race `ContextMenuRequested`. Residual: the very first right-click into a not-yet-focused textarea may occasionally show no custom items (the right mouse-down focuses the field and fires `focusin` before `contextmenu`, so this should be rare) — smoke-test it.
- **D5 — Item placement and gating.** Custom items are appended at the **end** of WebView2's collection after a separator (spell-check suggestions conventionally lead; the default order is untouched). "Insert timestamp" appears when `IsEditable` and surface ∈ {body, scratch}. The three send-to items appear only when surface = scratch **and** `HasSelection` **and** `SelectionText` is non-whitespace (checked in Rust; text discarded). Items are created fresh on every `ContextMenuRequested` (WebView2 owns their lifetime); no caching.
- **D6 — Dispatch and targeting.** Rust emits `app.emit("context-menu-action", id)` with `id ∈ {"insert-timestamp","send-note","send-task","send-prompt"}`. `api.onContextMenuAction(handler)` mirrors `onFlushDrafts` **exactly**: it returns a **synchronous** `() => void` unsubscribe and hides the `listen()` promise inside the wrapper (`api.ts:195–200`), so an editor effect can `return api.onContextMenuAction(...)` directly as its cleanup (as `App.tsx:279–284` does); it validates with `parseContextMenuAction`. Each editor subscribes **once** in a mount effect with `[]` deps, calling through a latest-handler ref (`handleRef.current = handle` on every render) so the subscription never churns per keystroke and never sees a stale `edit`/`onSendTo` closure, and acts **only if `document.activeElement === bodyRef.current`** — WebView2's own menu does not move DOM focus (that is why native Copy works today), and several editors may be mounted at once (all pages stay mounted, `DESIGN.md:128`). The handler reads the **live** textarea `value`/`selectionStart`/`selectionEnd` (source of truth for a controlled textarea, and it avoids a stale-closure `body`) — no `menuSelRef`-style capture is needed.
- **D7 — Delete the React menu.** `SelectionMenu.tsx`, `.context-menu*` CSS, `ScratchEditor`'s `menu` state, `menuSelRef`, `onContextMenu`, `closeMenu()`, and the `<SelectionMenu>` render go. `SendDestination` moves to `src/lib/contextMenu.ts`. `usePopover` is untouched. Comment at `ScratchEditor.tsx:430–431` ("The native right-click menu path is untouched — this is keyboard-only") is rewritten to say the native menu now carries app items via Rust.
- **D8′ — Supersedes plan.13 D8.** Right-click on any body textarea always shows the **native WebView2 menu**; the app never draws a menu of its own; custom entries are native additions. `docs/DESIGN.md:150` is rewritten (Phase 4). Shift+F10 / the ContextMenu key, arrow navigation, Escape, on-screen clamping, and outside-click dismissal are all WebView2/OS behaviour now (note: a native menu **eats** the dismissing click; the old spec's "acts as an ordinary click" clause is dropped).
- **D9 — New dependencies, flagged:** `webview2-com` and `windows-core`, Windows-only, exact-pinned to the lock versions with a comment: "must match the versions `wry` resolves; re-check on every tauri bump (`cargo tree -i webview2-com`)". No npm change, no capability change, no CSP change.
- **D10 — Scope: body textareas only.** Not the title inputs (`Editor.tsx:730`, `PromptEditor.tsx:478` — no caret plumbing; the empty-title-on-Save rule makes a timestamped title wrong), not the search box, never the masked key fields (`SettingsDialog.tsx:128`, `:175`) — same scoping as plan.14 D9/S-7. Enforced by D4: those fields carry no `data-menu-surface`, so Rust sees `none` and adds nothing.
- **D11 — No keyboard shortcut in this plan.** The request is for a menu item. A `Ctrl+;` binding (Excel convention) is a cheap follow-up via the existing `window` keydown pattern (`ScratchEditor.tsx:240`), listed in §10.

## 6. Implementation Steps

Gates after every phase: `cd notes-app/src-tauri && cargo test` · `cd notes-app && npx tsc --noEmit` · `npm test` · `npm run build`. Do not start a phase until the previous one is green.

**Phase 0 — Decision record + pure helpers (approach-independent)**
1. Create `src/lib/timestamp.ts`: `formatTimestamp(now: Date): string` (D2) and `insertText(body: string, range: { start: number; end: number }, text: string): { body: string; caret: number } | null` (D3). Header comment in the `selection.ts:1–7` style ("Pure, unit-testable … No React, no IPC"; clock is always an argument).
2. Create `src/lib/timestamp.test.ts` per §8 (write the tests first; show them failing, then passing).
3. Create `src/lib/contextMenu.ts`: `export type SendDestination = "note" | "task" | "prompt"` (moved from `SelectionMenu.tsx:10`), `export type ContextMenuAction = "insert-timestamp" | "send-note" | "send-task" | "send-prompt"`, `export type MenuSurface = "none" | "body" | "scratch"`, `parseContextMenuAction(payload: unknown): ContextMenuAction | null`, `sendDestinationOf(action: ContextMenuAction): SendDestination | null`, `surfaceOf(el: { dataset?: { menuSurface?: string } } | null): MenuSurface` (structural type so it is node-testable; allowlist, default `"none"`). Header: "Static ids — never user text." Note: `SelectionMenu.tsx:10` still exports an identical `SendDestination` until Phase 3 step 16 deletes the file — the transient duplicate is intended; do not dedupe early.
4. Create `src/lib/contextMenu.test.ts` per §8.
5. Add the one-line "Superseded by plan 16 (D8′)" note beside `plans/plan.13.md:152` D8. Do not otherwise edit plan 13.

**Phase 1 — Rust spike (timebox: one working day) — GATE**
6. In `src-tauri/Cargo.toml` add under `[target.'cfg(windows)'.dependencies]`: `webview2-com = "=0.38.2"` and `windows-core` pinned to the version `cargo tree -i webview2-com` reports as its parent chain uses. Comment the coupling (D9). Confirm `Cargo.lock` gains **no new crate versions** (only new direct edges) — if it does, the pin is wrong.
7. Create `src-tauri/src/context_menu.rs` with: `pub enum MenuSurface { None, Body, Scratch }` (derive `Default` = `None`) + `impl FromStr` (or `pub fn parse(&str) -> Option<MenuSurface>`) accepting exactly `"none"|"body"|"scratch"`; `#[cfg(windows)] pub fn install(app: &tauri::AppHandle) -> tauri::Result<()>` and a `#[cfg(not(windows))] pub fn install(_: &tauri::AppHandle) -> tauri::Result<()> { Ok(()) }` twin. In-module `#[cfg(test)]` tests for the parser (accepts the three values, rejects `""`, `"Body"`, `"title"`) — these run on every platform. Then in `src-tauri/src/commands.rs`: add a field `pub menu_surface: Mutex<context_menu::MenuSurface>` to `AppState` (`commands.rs:21`; initialise it where `AppState` is built at `lib.rs:87`) and a `#[tauri::command] pub fn set_context_menu_surface(state: State<'_, AppState>, surface: String) -> Result<()>` that parses with the allowlist, stores on success, and returns the module's usual `Err` (per `error.rs`) on anything else without touching the stored value. **There is exactly one copy of the surface flag — the `AppState` field — read by the command and by the COM callback alike.**
8. Spike body of `install`: `let window = app.get_webview_window("main")` (return `Ok(())` if absent); `let handle = app.clone()`; `window.with_webview(move |pw| { ... })` → `pw.controller().CoreWebView2()` → `.cast::<ICoreWebView2_11>()` → `add_ContextMenuRequested(&ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| { ... })), &mut token)`. Inside the handler (spike version): read `args.ContextMenuTarget()`, gate on `IsEditable`, read the surface via `handle.state::<commands::AppState>().menu_surface.lock()` (spike: ignore it; Phase 2 gates on it), get the environment via `sender.cast::<ICoreWebView2_2>()?.Environment()` → `.cast::<ICoreWebView2Environment9>()`, `CreateContextMenuItem` a SEPARATOR and a COMMAND item labelled `"Insert timestamp"` (static `HSTRING` → `PCWSTR`), `add_CustomItemSelected` → `handle.emit("context-menu-action", "insert-timestamp")`, `args.MenuItems()?.InsertValueAtIndex(count, item)`. All errors → `return Ok(())`/skip; never unwrap; never panic. Wire in `lib.rs`: `mod context_menu;`, the new `AppState` field at `:87`, `let _ = context_menu::install(app.handle())` in `setup()` after `app.manage(...)` (fail-soft — a returned error is ignored on purpose, with a comment), and `commands::set_context_menu_surface` in `generate_handler!` (`:95`). For the spike only, a temporary `listen("context-menu-action", console.log)` in `api.ts` is acceptable — remove it in Phase 3 (step 17).
9. **Spike success criteria (all must pass under `npm run tauri dev` on this Windows 11 machine):**
   - (a) Right-click in the scratch textarea on a misspelled word shows the **genuine** WebView2 menu with spell-check suggestions **and** the appended "Insert timestamp" item; right-click on the item list / a non-editable area shows no custom item.
   - (b) Choosing "Insert timestamp" delivers the Tauri event to JS; at that moment `document.activeElement` is still the textarea and `selectionStart/End` are unchanged from before the right-click.
   - (c) 50 open/dismiss cycles (Escape, outside click, item chosen) with no crash, no duplicate items accumulating, no visible lag.
   - (d) `cargo build` clean with the pinned crates; `cargo test` still green; the `#[cfg(not(windows))]` stub compiles under `cargo check --target x86_64-unknown-linux-gnu` **if** that target is installed — otherwise record "not checked".
   - **If any criterion fails: STOP.** Revert every Phase 1 change (`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, delete `src-tauri/src/context_menu.rs`, remove the temporary listener from `src/lib/api.ts`) so the tree holds only Phase 0, re-run the gates, then report which criterion failed and the evidence. **Do not implement approach A** (§10 fallback) without the user's decision.

**Phase 2 — Surface tracking + full item set**
10. Add `data-menu-surface="body"` to the body textareas in `Editor.tsx:978` and `PromptEditor.tsx:623`, and `data-menu-surface="scratch"` to `ScratchEditor.tsx:415`.
11. `src/lib/api.ts`: add `setContextMenuSurface(surface: MenuSurface): Promise<void>` (thin `invoke`, comment in the `confirmDialog` style explaining *why* Rust needs to know) and `onContextMenuAction(handler: (action: ContextMenuAction) => void): () => void` — **synchronous** return, copying `onFlushDrafts` at `api.ts:195–200` line for line (the `listen()` promise stays inside; the returned function does `void unlisten.then((un) => un()).catch(() => {})`); inside the listener, validate the payload with `parseContextMenuAction` and drop unknown payloads.
12. Create `src/hooks/useContextMenuSurface.ts`: on mount, add document-level `focusin` and `focusout` listeners; compute `surfaceOf(e.target)` (on `focusout`, use `e.relatedTarget`, which is the element gaining focus, or `"none"`); publish via `api.setContextMenuSurface` only when the value changed since the last publish; swallow/`onError` rejections; remove listeners on unmount. Use it once in `App.tsx`.
13. Complete the Rust handler: read `surface` from `handle.state::<commands::AppState>().menu_surface` (lock, copy, unlock before any COM call); `None` → return without changes; `Body`/`Scratch` → separator + "Insert timestamp"; `Scratch` **and** `HasSelection` **and** `SelectionText` non-whitespace → also "New note from selection", "New task from selection", "New prompt from selection" with ids `send-note` / `send-task` / `send-prompt`. Labels and ids as `const` arrays. Selection text is dropped immediately after the whitespace check.

**Phase 3 — Frontend actions + deletion of the React menu**
14. In each of the three editors: declare `function handle(action: ContextMenuAction)` in the component body and keep it current in a ref (`const handleRef = useRef(handle); handleRef.current = handle;`), then add **one** effect with an explicit empty dependency array — `useEffect(() => api.onContextMenuAction((a) => handleRef.current(a)), []);` — exactly the `App.tsx:279–284` shape, so the subscription is created once per mount, never re-created per keystroke, and never runs a stale `edit`/`onSendTo`. `handle(action)`: `const ta = bodyRef.current; if (!ta || document.activeElement !== ta) return;` then for `"insert-timestamp"`: `const r = insertText(ta.value, { start: ta.selectionStart, end: ta.selectionEnd }, formatTimestamp(new Date())); if (!r) return; pendingCaretRef.current = { start: r.caret, end: r.caret }; edit(setBody)(r.body)` (curried in Editor/PromptEditor; `edit(r.body)` in ScratchEditor); then `clearSelection()`. Other actions are ignored in Editor/PromptEditor.
15. `ScratchEditor.tsx`: for `send-*` actions, `const sel = captureSelection({ start: ta.selectionStart, end: ta.selectionEnd }, ta.value); if (!sel) return; onSendTo(sendDestinationOf(action)!, sel.text)`. Remove `menu` state, `menuSelRef` (`:131`), `onContextMenu` (`:315–323`), `closeMenu()` (`:327–335`), the `onContextMenu={...}` prop (`:429`), the `<SelectionMenu …/>` render (`:446–453`), and the now-wrong comment at `:430–431`. Keep `sendTo`'s focus behaviour consistent: the destination page's tab receives focus as today (via `ScratchPage`/`App`).
16. Update imports: `ScratchEditor.tsx:25` and `ScratchPage.tsx:19` import `SendDestination` from `../lib/contextMenu`. Delete `src/components/SelectionMenu.tsx`. Delete `.context-menu` and `.context-menu-item` rules at `src/styles.css:1134–1163` (leave `.popover`). `npx tsc --noEmit` must report no unused imports (`noUnusedLocals` is on).
17. Remove the Phase-1 temporary console listener from `api.ts`.

**Phase 4 — Docs**
18. Rewrite `docs/DESIGN.md:150` ("Send selection to…") per D8′: right-click always shows the native WebView2 menu; when the pad has a non-empty, non-whitespace selection the menu additionally lists the three send-to items; every body textarea (items, prompts, pad) lists "Insert timestamp", which inserts `yyyy-mm-dd HH:mm` local time at the caret, replacing any selection, caret after; keyboard invocation, navigation, dismissal and positioning are the OS's; choosing a send-to item opens a pre-filled unsaved draft on the destination page exactly as before. Also amend `DESIGN.md:148`'s placeholder sentence if it references the old menu wording (it does not — verify).
19. `notes-app/CLAUDE.md`: under Architecture add one bullet: "`src-tauri/src/context_menu.rs` is the only Windows-only/COM module; it augments the native WebView2 context menu and must fail soft. `webview2-com`/`windows-core` are pinned to wry's versions — re-check on every tauri bump." Add "context menu items + Insert timestamp" to the shipped-features list in `docs/IMPLEMENTATION_PLAN.md` Phase 4 if that list is maintained (see memory: it is).

**Phase 5 — Verification**
20. Full gate suite, then the §8 manual smoke script under `npm run tauri dev`, then `npm run tauri build` and repeat the right-click smoke on the release binary (plan.13 §10 recorded that release-build menu behaviour was never verified; close that gap here).

## 7. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `notes-app/src/lib/timestamp.ts` | Create | `formatTimestamp(now)` + `insertText(body, range, text)` — pure, clock injected (D2, D3) |
| `notes-app/src/lib/timestamp.test.ts` | Create | Unit tests (§8) |
| `notes-app/src/lib/contextMenu.ts` | Create | `SendDestination` (moved), `ContextMenuAction`, `MenuSurface`, `parseContextMenuAction`, `sendDestinationOf`, `surfaceOf` — pure allowlists |
| `notes-app/src/lib/contextMenu.test.ts` | Create | Unit tests (§8) |
| `notes-app/src/hooks/useContextMenuSurface.ts` | Create | One document-level focus tracker publishing the surface to Rust (D4) |
| `notes-app/src/lib/api.ts` | Modify | `setContextMenuSurface` (invoke) + `onContextMenuAction` (listen wrapper, validated) |
| `notes-app/src/App.tsx` | Modify | Call `useContextMenuSurface()` once |
| `notes-app/src/components/Editor.tsx` | Modify | `data-menu-surface="body"`; action subscription; insert via `edit(setBody)` + `pendingCaretRef` |
| `notes-app/src/components/PromptEditor.tsx` | Modify | Same as Editor |
| `notes-app/src/components/ScratchEditor.tsx` | Modify | `data-menu-surface="scratch"`; action subscription (insert + send-to via live `captureSelection`); remove menu state, `menuSelRef`, `onContextMenu`, `closeMenu`, `<SelectionMenu>`; import path for `SendDestination` |
| `notes-app/src/components/ScratchPage.tsx` | Modify | Import `SendDestination` from `../lib/contextMenu` |
| `notes-app/src/components/SelectionMenu.tsx` | Delete | Replaced by native items (D7) |
| `notes-app/src/styles.css` | Modify | Remove `.context-menu` / `.context-menu-item` (`:1134–1163`) |
| `notes-app/src-tauri/Cargo.toml` | Modify | `[target.'cfg(windows)'.dependencies]` `webview2-com`, `windows-core`, exact-pinned + coupling comment (D9) |
| `notes-app/src-tauri/src/context_menu.rs` | Create | `MenuSurface` + allowlist parser (+ unit tests), `install(app: &AppHandle)` — cfg(windows) COM hook reading the surface via `app.state::<AppState>()`, plus the `cfg(not(windows))` no-op twin |
| `notes-app/src-tauri/src/commands.rs` | Modify | `menu_surface: Mutex<MenuSurface>` field on `AppState`; `set_context_menu_surface` command (allowlist, `Err` on anything else) |
| `notes-app/src-tauri/src/lib.rs` | Modify | `mod context_menu;`, initialise the new `AppState` field (`:87`), `let _ = context_menu::install(app.handle())` in `setup()` (fail-soft, commented), register the command in `generate_handler!` (`:95`) |
| `notes-app/docs/DESIGN.md` | Modify | Rewrite line 150 per D8′ |
| `notes-app/CLAUDE.md` | Modify | One bullet on the Windows-only module and the crate-version coupling |
| `notes-app/docs/IMPLEMENTATION_PLAN.md` | Modify | Add to the shipped-features list (if maintained) |
| `notes-app/plans/plan.13.md` | Modify | One-line "superseded by plan 16" note at D8 (`:152`) |

## 8. Test Strategy

*(Source: test-writer agent, adapted from approach A to approach C. Conventions: vitest node env, `src/**/*.test.ts`, `describe/it/expect`, full-object `toEqual`, hand-rolled structural fakes, literal local-time `Date` constructors, no `vi.setSystemTime`.)*

- [ ] **Unit Tests — `src/lib/timestamp.test.ts`**
  - `formatTimestamp`: zero-pads single-digit month and day (`new Date(2026, 0, 5, 9, 5)` → `"2026-01-05 09:05"`); zero-pads hour/minute (`new Date(2026, 8, 5, 4, 3)` → `"2026-09-05 04:03"`); midnight `00:00`; `23:59`; seconds dropped, never rounded (`10:15:45` → `"10:15"`); four-digit year; construct **only** via the local-time constructor and assert a **literal** string (not `toLocale*`) so the test is timezone-stable and a format regression cannot hide; a couple more single-digit months (March, July).
  - `insertText`: collapsed caret mid-body (caret lands **after** the insert, collapsed — pin by name); at offset 0; at `body.length`; into `""`; replaces a non-empty selection; inverted range (`start > end`) is normalised; `end > body.length` → `null`; CRLF body — `\r` treated as an ordinary character; result object asserted with `toEqual`.
- [ ] **Unit Tests — `src/lib/contextMenu.test.ts`**
  - `parseContextMenuAction`: accepts exactly the four ids; rejects `""`, other strings, numbers, objects, `null`, `undefined`; ids are the literal expected strings (MUST 1 / SHOULD 10).
  - `sendDestinationOf`: `send-note→"note"`, `send-task→"task"`, `send-prompt→"prompt"`, `insert-timestamp→null`.
  - `surfaceOf`: `{dataset:{menuSurface:"body"}}→"body"`, `"scratch"→"scratch"`, missing dataset / unknown value / `null` → `"none"`.
- [ ] **Rust unit tests — `src-tauri/src/context_menu.rs` `#[cfg(test)]`** (platform-independent): `MenuSurface` parser accepts `none|body|scratch`, rejects `""`, `"Body"`, `"title"`, `"scratch "`. The `set_context_menu_surface` command is a two-line wrapper (parse → store) over that parser and a `Mutex`; it is not unit-tested separately (no `AppState` fixture exists in the repo) — its "invalid input leaves the stored value unchanged" rule is enforced by the parser returning `None`/`Err` before any write, which the parser tests cover. `cargo test` stays green on Windows and the stub compiles elsewhere.
- [ ] **§4 MUST 8 (stale buffer at action time) — verified by construction, not by smoke.** No realistic manual step can change the buffer while WebView2's modal menu is open (AI proposals never touch the body without a click; draft restore is boot-time; tab reseed needs a click), so there is no smoke item for it. The guarantee comes from (a) reading the **live** textarea value/selection inside `handle` — asserted by code review against step 14 — and (b) `insertText` returning `null` for an out-of-range caret — covered by `timestamp.test.ts`. Record this explicitly in §12.
- [ ] **Integration Tests**
  - The COM hook, `with_webview`, and the Tauri event path cannot be exercised by `cargo test` or vitest — **covered by the Phase 1 spike criteria and the manual smoke below; state this explicitly in §12 when done.** Do not write a `vi.mock("@tauri-apps/api/event")` test for `onContextMenuAction` — it would be vacuous (no precedent in the repo, nothing it could prove).
  - `src/lib/lineEdit.ts` is **untouched** under approach C (no synthesized keystrokes); `lineEdit.test.ts` must keep passing unchanged. `selection.test.ts` must keep passing — `captureSelection` semantics are reused as-is for the send-to gate.
- [ ] **Edge Cases & Error Scenarios**
  - Action event arrives when no body textarea is focused (e.g. focus moved to a toast) → no editor acts; nothing changes.
  - Action arrives after the buffer changed (AI accept / draft restore) → `insertText` uses live value/selection; out-of-range → `null` → no-op.
  - `ICoreWebView2_11` cast fails (old runtime) → `install` returns without hooking; the app runs with the plain native menu; nothing logged; nothing panics.
  - Whitespace-only selection on the scratch pad → send-to items absent (Rust) **and** `captureSelection` returns `null` if an event somehow arrives.
- [ ] **Manual smoke (E2E) — `npm run tauri dev`, then repeat the right-click items on `npm run tauri build`**
  1. Right-click with no selection in a note body, a task body, a prompt body, the scratch pad: the full native menu (Undo/Redo/Cut/Copy/Paste/Select all/emoji…) plus a separator and **"Insert timestamp"**; no send-to items anywhere.
  2. Right-click on a misspelled word: spell-check suggestions still present alongside "Insert timestamp".
  3. Right-click with a selection on the scratch pad: the three send-to items appear **and** native Cut/Copy/Paste are present and act on the selection. With a selection on a note/prompt body: no send-to items.
  4. Right-click on the title input, the search box, the Settings API-key field, the item list, empty page chrome: **no** custom items.
  5. "Insert timestamp": mid-body caret; replacing a selection; at end; in an empty body — text is `yyyy-mm-dd HH:mm` local (compare with the Windows clock), caret sits right after it, the unsaved frame lights (`editor.is-dirty`), and a draft file appears under `app_data_dir\drafts` within the backup interval with no further typing.
  6. Send-to items open the pre-filled unsaved draft on the destination page and switch pages, exactly as before (`DESIGN.md:150` behaviour minus the React menu).
  7. Shift+F10 / ContextMenu key open the same native menu with the same custom items; Escape dismisses; focus and selection remain in the textarea.
  8. First right-click into a **not-yet-focused** textarea shows the custom items (D4 residual check); repeat 10×.
  9. 50 rapid open/dismiss cycles across editors: no duplicate items, no crash, memory stable in Task Manager.
  10. Ctrl+X/C/V keyboard behaviour (plan.14 D9 whole-line clipboard) unchanged.
  11. Cold-start restore of a dirty buffer containing an inserted timestamp (Plan 15) — content intact.

## 9. Success Criteria

- [ ] **Functional (request 1):** Right-clicking a non-empty selection on the scratch pad shows WebView2's complete default menu **plus** "New note/task/prompt from selection"; right-clicking without a selection shows the default menu plus "Insert timestamp". The app renders no menu of its own anywhere.
- [ ] **Functional (request 2):** "Insert timestamp" appears on the context menu of note, task, prompt, and scratch body textareas and inserts the current local `yyyy-mm-dd HH:mm` at the caret (replacing any selection), caret after, buffer dirty, draft backup captured. It does not appear on any other input.
- [ ] **Non-regression:** notes and prompts lose no default menu item (spell-check suggestions included); keyboard clipboard behaviour (D9) is untouched; `captureSelection`/`spliceProposal`/`lineEdit` tests unchanged and green.
- [ ] **Tests:** All §8 unit tests pass (`npm test`, `cargo test`); every §8 manual smoke item executed and recorded in §12 with an honest result.
- [ ] **Security:** Every §4 MUST implemented (static labels/ids/payloads, selection text never leaves Rust, allowlisted surface command, isolated fail-soft `cfg(windows)` COM module, exact-pinned crates, no clipboard-read, all IPC via `api.ts`, live re-read at action time).
- [ ] **Quality:** `npx tsc --noEmit` clean (no unused imports after the deletion), `npm run build` clean, `cargo test` green, `cargo clippy` introduces no new warnings in `context_menu.rs`; `SelectionMenu.tsx` and its CSS are gone; `DESIGN.md:150`, `CLAUDE.md`, plan.13 D8 note updated. No commit unless asked.

## 10. Risks & Open Questions

**Adversarial-verifier verdicts (Step 5)**
- *"muda implements Windows predefined edit items by `SendInput` Ctrl+key."* — **CONFIRMED** (`muda-0.19.3/src/platform_impl/windows/mod.rs:1202–1209`, `:1264–1294`), with the correction that predefined items never emit a `MenuEvent` (`:1188–1189`). Drove the rejection of approach A (§3).
- *"`Menu.popup()` runs a modal `TrackPopupMenu` loop and the JS promise resolves after the menu closes."* — **CONFIRMED** (`mod.rs:1038–1049`; `tauri-2.11.5/src/menu/mod.rs:25–39` blocks on `rx.recv()` on a tokio worker). *"WebView2 loses keyboard focus while it is open"* — **UNVERIFIABLE** from source; not relied upon.
- *"Pass CSS px as `LogicalPosition`."* — **CONFIRMED** (client-area-relative, DPI-scaled by muda; `PhysicalPosition<i32>` would also reject fractional coordinates). Moot under C; kept for the fallback.
- *"Approach A requires adding `core:menu` permissions"* (asserted by the tech lead, test-writer, verifier and frontend agents' asides) — **REFUTED** by `src-tauri/gen/schemas/desktop-schema.json:351` and `:662`: `core:default` ⊇ `core:menu:default` ⊇ `allow-new`, `allow-popup`. Irrelevant to C.
- **Plan review (code-reviewer, Step 8)** found and this revision fixed: a state-sharing bug between the surface command and the COM closure (now one `AppState` field, read through the `AppHandle` — D4/D6, steps 7–8); `onContextMenuAction` declared as `Promise<() => void>` contradicting its `onFlushDrafts` precedent (now synchronous — step 11); unspecified effect deps / stale-closure handling (now `[]` + latest-handler ref — step 14); §4 MUST 8 having no verification path (now stated as verified by construction + unit test — §8); no rollback rule on a failed spike (now step 9 / §13 step 3).

**Risks**
- **R1 — The spike fails** (cast, handler registration, `Send` bounds across `with_webview`, event delivery, or a WebView2 focus surprise). Mitigation: Phase 1 is timeboxed with explicit criteria and a STOP rule. Nothing in Phases 2–4 is started before it passes; Phase 0 work is kept regardless.
- **R2 — Version coupling.** A future tauri/wry bump can change the `webview2-com`/`windows-core` versions and break the `controller()` type identity at compile time (loud, not silent). Mitigation: exact pins + comment + `CLAUDE.md` bullet; `cargo tree -i webview2-com` is the diagnostic.
- **R3 — No automated coverage for the COM path.** Accepted; the module is small, fail-soft, isolated, and smoke-tested in dev **and** release builds. Record in §12.
- **R4 — Surface flag race on the first right-click into an unfocused field** (D4). Expected rare; smoke item 8 characterises it. If it reproduces, add a second publish from the textarea's `onContextMenu` (best-effort refresh) — do not move the gate to per-right-click IPC.
- **R5 — WebView2 runtime too old for `ICoreWebView2_11`.** Fail-soft: no custom items, no error. The bootstrapper installs Evergreen, so this is theoretical on Windows 11.
- **R6 — Not natively undoable** (D3, same as `pasteLine`/`spliceProposal`). Accepted residual. Possible follow-up: `document.execCommand("insertText", false, text)` gives native undo and routes through `onChange`→`edit()` naturally, but is a deprecated API and a new insert idiom — decide separately.
- **R7 — Behaviour changes vs. the old React menu** (frontend specialist): outside-click now dismisses without placing the caret; Tab no longer closes the menu; the menu uses OS chrome, not the app's popover surface. All are consequences of "native", covered by D8′ and the `DESIGN.md` rewrite.
- **R8 — `tauri dev` shows an "Inspect" item** (devtools in debug builds). Expected; absent in release (`Cargo.toml:22`).
- **R9 — Multiple mounted editors all subscribe** to the action event. Only the one whose textarea is `document.activeElement` acts (D6); if WebView2 ever moved DOM focus during its menu, *no* editor would act — smoke item 7 checks this.

**Open questions (defaults chosen; change before execution if you disagree)**
- Timestamp format: `2026-09-05 14:32` (no seconds, no trailing space, 24-hour). Alternatives: append `:ss`; trailing space; `Sep 5, 2026 2:32 PM`.
- Menu placement: custom items **appended after a separator** at the end. Alternative: inserted at index 0 above the default items.
- Label: "Insert timestamp" (house sentence case), not "Insert Timestamp" as written in the request.
- Should `Ctrl+;` also insert a timestamp (D11)? Not in this plan.

**Fallback track (approach A) — only if the user accepts losing spell-check suggestions / emoji on every body editor.** Native Tauri menu via `@tauri-apps/api/menu` wrapped in `api.ts` (`popupEditMenu(kind, at): Promise<void>` owning construction); **build once per menu kind** (`item` vs `scratch`) and reuse — never per right-click (`MenuChannels` leak); stable explicit ids; `PredefinedMenuItem` Cut/Copy/Paste/SelectAll only, **Undo/Redo omitted** (Blink undo-stack desync), and Cut/Copy `setEnabled(hasSelection)` before each popup so a collapsed caret never triggers the D9 whole-line expansion; all post-selection work inside the item `action` callback, never after `await popup()`; `new LogicalPosition(e.clientX, e.clientY)`; keyboard path (`e.button !== 2`) anchored at the textarea's `getBoundingClientRect()` + small offset; append `core:menu:deny-set-as-app-menu`, `deny-set-as-window-menu`, `deny-create-default`, `deny-set-icon` to `capabilities/default.json`; `SelectionMenu.tsx` still deleted; `DESIGN.md:150` rewritten to describe a six-item app-drawn menu. Requires a fresh plan section before execution.

## 11. Code Review Checklist
After implementation, verify:
- [ ] No dead code or unused imports introduced (and none left behind by the `SelectionMenu` deletion — `noUnusedLocals`)
- [ ] Error handling covers failure modes (every COM call and cast fails soft; `install` never panics; IPC rejections are swallowed or toasted, never unhandled)
- [ ] No security vulnerabilities (injection, XSS, credential exposure) — §4 MUST 1–8 each ticked with a file:line
- [ ] Security considerations from Section 4 addressed (static labels/ids/payloads; selection text never leaves Rust; allowlisted surface; isolated `cfg(windows)` module; exact pins; no clipboard read; IPC only via `api.ts`; live re-read at action time)
- [ ] Code follows existing project conventions (curried `edit` in Editor/PromptEditor, plain in Scratch; `pendingCaretRef` idiom; clock-as-argument; `api.ts` wrapper comments; sentence-case microcopy)
- [ ] Tests cover happy path, edge cases, and error scenarios (§8 unit lists complete; each new test shown failing first)
- [ ] No performance regressions (surface publish is deduped — no IPC on every focus change between non-surface elements; no per-keystroke re-subscription to the action event; menu items created per right-click only, owned by WebView2)
- [ ] Changes are minimal — no unrelated refactoring bundled in (usePopover, `.popover` CSS, `lineEdit.ts`, `selection.ts` untouched)

## 12. Post-Review Improvements

**Executed 2026-09-05 on the planning machine (Windows 11, WebView2 Evergreen, rustc 1.98.0, tauri 2.11.5 / wry 0.55.1 / webview2-com 0.38.2).** Status: implemented through Phase 5; not committed (per instructions).

### Spike verdict (Phase 1, §6 step 9) — PASS, approach C adopted
- (a) Right-click on a misspelled word in the pad: the genuine WebView2 menu (suggestions `hello / halo / helot`, Cut/Copy/Paste, Paste as plain text, More tools, Send tab to your devices, Inspect) plus a separator and **Insert timestamp**; right-click on the rail / item list: the page menu (Back/Refresh/Save as/Print/…) with no custom item.
- (b) Choosing the item delivered the Tauri event; a temporary overlay (removed in Phase 3) read `active=TEXTAREA before=10-10 now=10-10` — `document.activeElement` still the textarea, selection unchanged between the `contextmenu` event and the action.
- (c) 50 open/dismiss cycles (20 Escape, 15 outside-click, 15 keyboard-chosen): one `Insert timestamp`, no duplicates, no crash, working set 51.7 → 51.7 MB.
- (d) `cargo build` warning-free, `cargo clippy` no findings in `context_menu.rs`, `cargo test` green. `cargo check --target x86_64-unknown-linux-gnu`: **not checked** — only `x86_64-pc-windows-msvc` is installed; the `cfg(not(windows))` twin is a two-line `Ok(())` stub.
- Crate pins: `webview2-com = "=0.38.2"`, `windows-core = "=0.61.2"` (what `cargo tree -i webview2-com` shows wry resolving). Cargo.lock gained exactly two edges on the `notes-app` package and **no** new `[[package]]` entries.

### Gates (final code)
`cargo test` 12 suites green (139 lib tests incl. 11 new `MenuSurface::parse` tests; all integration suites unchanged) · `npx tsc --noEmit` clean · `npm test` 433/433 (47 new: 21 `timestamp.test.ts`, 26 `contextMenu.test.ts`) · `npm run build` clean (CSS bundle 18.72 → 18.37 kB after the `.context-menu*` removal) · `npm run tauri build` produced the NSIS bundle.

### Review findings and what was done
| Source | Finding | Action |
|---|---|---|
| code-reviewer (nit) | `append_items` inserted the separator before creating the command item, so a COM failure between the two would leave an orphan separator (cosmetic, rare). | **Fixed:** every item is created first (`create_command`), then all are inserted; a creation failure leaves the menu exactly as WebView2 built it. |
| code-reviewer (nit) | Editors write `pendingCaretRef` **after** `edit()`/`clearSelection()`, not before as §6 step 14 literally says. | **Deliberate deviation, kept:** it is byte-for-byte the existing `onPaste`/`handleLinePaste` idiom in the same files; functionally identical (the `[body]` layout effect consumes the ref after commit). |
| security-auditor (LOW) | The surface flag is published asynchronously; after a webview reload (dev HMR) the hook restarts at `"none"` while Rust still holds the last value, so an item could show on a non-surface editable field (cosmetic — the editors' `activeElement` gate refuses to act). | **Fixed:** `useContextMenuSurface` publishes its initial `"none"` on mount (one IPC), so Rust and the hook agree from the first render. The right-click-into-another-field race is the D4/R4 residual (focusout publishes `"none"` ~1 ms IPC vs a physical click's mouse-down→up), unchanged. **Recorded as the auditor asked:** D10's exclusion of titles/search/key fields is *best-effort* via the flag; the enforcement is the `document.activeElement === bodyRef.current` check in all three editors — a refactor must not remove it. |
| security-auditor (info) | `commands.rs::set_context_menu_surface` uses `lock().unwrap()`. | Kept — matches the codebase idiom (`cancellations`, `startup_warnings`); the critical section is a `Copy` assignment, so poisoning is unreachable. The COM callback path is poison-tolerant (`into_inner`). |
| security-auditor (info) | `context-menu-action` is a broadcast event the webview could also emit. | Accepted — with script execution already achieved nothing is gained; CSP untouched, no HTML sinks in `src/`. |
| security-auditor (info) | SHOULD 10 pins the ids only on the TS side; a Rust rename would fail closed (dropped payload). | Accepted residual. |
| frontend-specialist | No code defects; asked that §12 record the smoke evidence for the "WebView2's menu does not move DOM focus" assumption. | Done below (spike (b), smoke 7). |
| security-auditor | All §4 MUST 1–8 PASS with file:line evidence; SHOULD 9/11 PASS; NOTE 12/15 PASS. | — |
| code-reviewer | §11 checklist: all 8 items PASS; D2–D11 all match. | — |

### Verified by construction (per §8)
- MUST 8 (stale buffer at action time): `handleContextMenuAction` reads the live `ta.value` / `selectionStart` / `selectionEnd`; `insertText` returns `null` for an out-of-range caret (`timestamp.test.ts`). No smoke step can move the buffer while WebView2's modal menu is open.
- The COM hook, `with_webview`, and the event path have **no automated coverage** (R3) — covered by the spike criteria and the smoke below, in dev and release builds.

### Manual smoke — `npm run tauri dev` (driven programmatically: Win32 mouse/keyboard input + screenshots; menu items chosen by keyboard, Up wraps to the last item)
1. **PASS** — no selection: note body, task body, prompt body, scratch pad all show the native menu (Emoji, Undo, Cut/Copy disabled, Paste, Paste as plain text, Select all, Writing direction, More tools, Send tab to your devices, Inspect) + separator + `Insert timestamp`; no send-to items.
2. **PASS** — misspelled word (`abc` on the pad; `abc` on a note): suggestions `ABC / abs / arc` above Cut/Copy/Paste, `Insert timestamp` still appended.
3. **PASS** — pad with a selection (`helo`): `New note/task/prompt from selection` appended after `Insert timestamp`; native Cut/Copy/Paste enabled, and choosing **Copy** put `helo` on the clipboard. Note body with a selection: **no** send-to items.
4. **PASS** — title input, search box (both show `Import passwords`… but no app item), Settings API-key field, item list, rail/page chrome: no custom items.
5. **PASS** — inserts: empty pad body → `2026-09-05 18:59` (Windows clock 18:59), unsaved frame + tab dot lit, draft file `<project-uuid>.md` written within 6 s with the exact text; mid-body (caret between `2026` and `-09`) → typed `X` landed right after the stamp (caret-after); replacing the selection `helo` → `2026-09-05 19:01`; at end of a note body → `…19:032026-09-05 19:04` (clock 19:04), draft backup within 6 s.
6. **PASS** — `New note from selection` (selection `abc`, via Shift+F10 + keyboard) switched to Worknotes, opened `Untitled note` in the TaskTracker project with body `abc`, focus on the page tab, nothing written.
7. **PASS** — Shift+F10 with `helo` selected opened the same menu (keyboard-focused first item, mnemonics shown); Escape left the selection highlighted and the AiBar at `4 characters selected`.
8. **PASS** — first right-click into a not-yet-focused textarea showed `Insert timestamp` 10/10 (the D4 residual did not reproduce).
9. **PASS** — 50 cycles on the final build (prompt draft): one item, no duplicates, no crash, working set 44.8 → 44.8 MB; 15 keyboard-chosen cycles inserted exactly 15 stamps (240 chars).
10. **PASS** — Ctrl+C on a collapsed caret still copies the whole line (plan.14 D9).
11. **PASS** — after killing the process with dirty pad/note/prompt buffers, relaunch showed `Restored unsaved edits to 1 item / 1 prompt / 1 scratch pad` with every inserted stamp intact.
- Observed native behaviours, all consistent with D8′: a right-click on a spell-flagged word selects it (so the send-to items appear on the pad); a right-click elsewhere in a textarea with a live selection keeps that selection (so `Insert timestamp` replaces it); `tauri dev` shows `Inspect` (R8).
- Cleanup: every test buffer was discarded through the close-tab dialogs (no `scratch.md` written, no item/prompt created, `app_data_dir\drafts` empty afterwards).

### Manual smoke — release binary (`npm run tauri build` of the final code, `target\release\worknotes.exe` built 19:17; the installed `C:\Tools\worknotes` copy was NOT replaced)
- **PASS** (1) — new note body, no selection: native menu (Emoji, Undo, Cut/Copy disabled, Paste, Paste as plain text, Select all, Writing direction, More tools, Send tab to your devices) + separator + `Insert timestamp`; **no `Inspect`** (R8 confirmed: devtools absent in release).
- **PASS** (5) — keyboard-chosen `Insert timestamp` in that body produced `2026-09-05 19:18` (clock 19:18) — the Rust→JS event path works in release.
- **PASS** (3, 7) — TaskTracker pad with `helo` selected, menu opened by Shift+F10: suggestions `hello / halo / helot`, Cut/Copy/Paste, More tools, Send tab, then `Insert timestamp`, `New note/task/prompt from selection`.
- **PASS** (4, partial) — a right-click aimed at the title row landed on page chrome (the user's "Neon noir" palette + a scrolled multi-tab strip shift the layout ~19 px): page menu only, no app items. The title-input negative itself was verified in dev, not re-verified in release.
- Not repeated in release: items 2, 6, 8–11 (verified in dev; the Rust path is identical, and the release build closes plan.13 §10's open question that release-build menu behaviour was never verified).
- Cleanup: pad and note buffers discarded via the dialogs, `app_data_dir\drafts` empty, no `scratch.md`/item written; the app was closed with Alt+F4 (graceful close path). The user's restored tabs were left untouched.

### User smoke — 2026-09-07 (release binary, installed instance closed)
The owner ran the seven-step walkthrough by hand: all steps passed, including step 7 (an inserted timestamp in a saved note's body was backed up to `app_data_dir\drafts` within a minute with no further typing).

### Process notes
- The user's installed `C:\Tools\worknotes\worknotes.exe` was running throughout (shared `catalog.db`/drafts dir); it was never touched. One early GUI-driver batch clicked outside the app window and sent ~50 stray inputs (Escape, Up+Enter, right-clicks) to VS Code before the driver gained a foreground-window guard; no effect was observed.
- `npm test` was not run at the Phase 1 gate (only `cargo test` + `tsc`); the temporary spike listener would have failed it (`document` under node) — caught and removed at the Phase 2 gate.

## 13. Execution Prompt

Copy everything inside the fence into a fresh Claude Code session started at the repo root (`c:\Projects\TaskTracker\TaskTracker`):

```
Implement plan 16 for the worknotes app.

1. Read `notes-app/plans/plan.16.md` in full before writing any code. Also read `notes-app/CLAUDE.md` (hard architectural rules: components never import @tauri-apps — only `src/lib/api.ts` does; pure helpers take the clock as an argument; docs/DESIGN.md is the authoritative UI spec). The plan depends on both.

2. Implement Section 6 step by step, phase by phase, in order: Phase 0 (pure helpers + decision record) → Phase 1 (Rust spike, GATE) → Phase 2 (surface tracking + full item set) → Phase 3 (frontend actions + delete the React menu) → Phase 4 (docs) → Phase 5 (verification). Do not start a phase until the previous phase's gate is green. The gates are:
   - `cd notes-app/src-tauri && cargo test` (kill any running `notes-app.exe` first — it locks the target binary; an LNK1318 link error means low disk space: clean `target/` and retry, it is not a test failure)
   - `cd notes-app && npx tsc --noEmit`
   - `cd notes-app && npm test`
   - `cd notes-app && npm run build`

3. Phase 1 is a timeboxed spike with explicit success criteria (Section 6 step 9, items a–d). If ANY criterion fails, STOP: revert every Phase 1 change (Cargo.toml, Cargo.lock, lib.rs, commands.rs, delete context_menu.rs, remove the temporary api.ts listener) so only Phase 0 remains, re-run the gates, write down which criterion failed and the evidence, and report to the user. Do NOT implement the approach-A fallback described in Section 10 — that trade-off (losing spell-check suggestions on every editor) is the user's decision, not yours.

4. Honor the plan's design decisions (Section 5) exactly, especially: approach C (WebView2 `ContextMenuRequested` hooked from Rust, custom items appended to the genuine native menu — the app draws no menu of its own); ONE copy of the surface flag as a `menu_surface` field on the existing `commands::AppState`, written by `set_context_menu_surface` in `commands.rs` and read inside the COM callback through the `AppHandle` (`install` takes only `&AppHandle`); timestamp format `yyyy-mm-dd HH:mm` local time from `formatTimestamp(now: Date)` with the clock injected; insertion replaces the selection or inserts at the caret with the caret collapsed after, routed through each editor's `edit()` chokepoint (curried `edit(setBody)(v)` in Editor/PromptEditor, plain `edit(v)` in ScratchEditor) plus `pendingCaretRef`; `api.onContextMenuAction` returns a synchronous `() => void` exactly like `onFlushDrafts`, and each editor subscribes once (`useEffect(..., [])`) through a latest-handler ref reading the live textarea value and selection; surface identity via `data-menu-surface` + one document-level focus tracker publishing to Rust; static labels/ids/event payloads only — selection text never leaves Rust; body textareas only; `SelectionMenu.tsx` and its CSS deleted, `SendDestination` moved to `src/lib/contextMenu.ts`; `webview2-com`/`windows-core` exact-pinned to the versions wry resolves under `[target.'cfg(windows)'.dependencies]`, all COM code isolated in `src-tauri/src/context_menu.rs`, fail-soft, never a panic in setup; no capability change, no CSP change, no npm change; the label is "Insert timestamp" (sentence case).

5. Use subagents during implementation:
   - Spawn a `test-writer` agent to write tests per the strategy in Section 8 (`src/lib/timestamp.test.ts`, `src/lib/contextMenu.test.ts`, and the `#[cfg(test)]` block in `src-tauri/src/context_menu.rs`) — each new test must be shown to fail before the code that makes it pass; follow the repo's conventions (vitest node env, literal local-time `Date` constructors, no `vi.setSystemTime`, no `vi.mock` of `@tauri-apps/*`).
   - After the code is written, spawn a `code-reviewer` agent (read-only: Read, Grep, Glob) to review the full diff against the plan and run the Section 11 checklist.
   - Spawn a `security-auditor` agent (read-only: Read, Grep, Glob) to verify every Section 4 MUST is actually implemented (static labels/ids/payloads, selection text never emitted or logged, allowlisted surface command, isolated fail-soft cfg(windows) COM module, exact-pinned crates with no new crate versions in Cargo.lock, no clipboard-read, all IPC via api.ts, live re-read at action time).
   - Spawn a `frontend-specialist` agent only for the Phase 3 editor-wiring review (activeElement gating with multiple mounted editors, stale-closure avoidance by reading the live textarea value, caret placement, dirty flag and draft-backup capture, clean deletion of the React menu with no dead CSS or unused imports).
   - Do not spawn database-architect, api-designer, devops-engineer, or performance-optimizer — the feature touches none of their domains (no schema/migration changes, no HTTP API, no CI/deploy changes, no hot path).
   - Fallback: if a named agent type is unavailable, use a generic type instead (`Explore` for read-only analysis, `Plan` for strategy, `general-purpose` otherwise) with the role stated in the prompt.
   - Any bug or blocking constraint a reviewer claims must be verified (an `adversarial-verifier` agent, or `general-purpose` instructed to refute it) before you act on it.

6. After implementation, run the code review checklist in Section 11 of the plan against the diff and fix anything it catches.

7. Document the review findings and the improvements you made in Section 12 of `notes-app/plans/plan.16.md` (findings fixed, deliberate deviations, accepted residuals, and the manual-smoke results), then implement those improvements.

8. Before finishing: run the full gate suite from step 2 one more time and fix any regressions; then run the manual smoke script from Section 8 with `npm run tauri dev` AND repeat the right-click items on an `npm run tauri build` release binary; report the results honestly — including any step you could not perform. Do not commit or push unless explicitly asked.
```
