# worknotes — design specification

This is the agreed UI/behavior spec. The interactive reference is `reference/Worknotes_dc.html` (open in a browser); `reference/design-tool-handoff.md` is the design tool's own handoff notes. Where they disagree, THIS document wins — it includes rules added after the prototype was generated (tag lifecycle, project removal guard, JIRA link).

worknotes is a local-first Windows 11 desktop app called **worknotes**, used by one person to capture work notes and tasks and refine them with AI. One primary screen — a two-pane workbench — plus three overlays: an **API keys** dialog, a **Manage projects** dialog, and inline **tag picker** popups. The feeling is a calm, native productivity workbench: warm paper-gray surfaces, hairline borders, typographic (no icons), quiet everywhere except one signature element — a highlighter-yellow "Proposed rewrite" card where AI suggestions land. Flat design: no gradients, no drop shadows. The default look is the **Original** light palette; a topbar picker selects one of **five named palettes** — Original (light), Gray + teal light, Gray + teal dark, Neon noir (dark), Claude terminal (dark) — each a full token set. As of Plan 11 a palette re-themes the neutrals **and** the accent/danger family (the earlier "swap neutrals only, accents stay constant" rule is relaxed — see the palette tokens below); only the doing/done status-dot colors stay fixed across all five. Desktop frame 1200 × 760.

## Design tokens (use these exactly)

Light theme neutrals:
- App background `#F1F0EC` — also input fields, the selected-row background, dialog input fields
- Panel / card surface `#FBFAF8` — top bar, left rail, editor controls, textarea, dialogs; also the text color on solid-ink buttons
- Ink (primary text, solid-button fill) `#23272A`
- Muted text `#6E7378`
- Hairline borders `#E3E1DB`
- Window surround `#DCDAD4`; app outer border `#CCC9C1`

Dark theme neutrals: bg `#1D1C1A`, surface `#272623`, ink `#ECEAE4`, muted `#A0A09A`, hairlines `#3A3833`, surround `#131211`, outer border `#3A3833`.

Palette-dependent as of Plan 11 (each palette declares its own — see "New palettes" below for the full five token sets):
- The signature accent `--mark` / soft fill `--mark-soft` / ink-on-accent `--mark-ink`, and `--danger`. The **Original** palette keeps the historical highlighter yellow `#F6E05E` / `#FBF3C9` / `#6B5C0E` and danger `#B4533A` (Delete, the `high` priority word); the other four substitute their own accent + danger (teal, neon green, Claude orange, etc.).
- `--todo` (the todo status dot) tracks each palette's muted gray.

Constant across all five palettes (never re-themed):
- Status dots — doing `#D9A441`, done `#4C8A64`
- Dialog scrim `rgba(35, 39, 42, 0.35)`

Type:
- UI text: Segoe UI Variable (fallback Segoe UI, then system-ui), 14px base, line-height ~1.45
- Metadata voice: Cascadia Mono (fallback Consolas), 11px, usually UPPERCASE with 0.08em letter-spacing — timestamps, kind labels, tags, priority words, section labels
- Editor title 17px weight ~650, borderless (tightened from 22px in Plan 11); body textarea 15px, line-height 1.6

Radii 6px (controls) / 8px (cards, dialogs) / 20px (pill chips). Focus is a 2px ink outline, no glow. Editor padding ~20–22px; rail header block ~14px.

### New palettes (Plan 11)

Five palettes ship, chosen from a topbar dropdown and persisted; the selection sets two attributes on `<html>`, applied together: `data-palette` (accent family + neutrals) and `data-theme` (`light`/`dark` polarity, which the neutral-swap and calendar-invert rules still key on). The authoritative full 14-token set for each lives in `src/styles.css` (`:root[data-palette="…"]`). Signature accents:

- **Original** (light) — highlighter yellow `#F6E05E`, danger `#B4533A`. This is the base `:root`; it is the default when nothing is stored.
- **Gray + teal, light** (`v2-light`) — teal `#4DDDBC`, danger `#FF4D4D`; its `New note`/`New task` create buttons are softened to a surface fill (Change 5).
- **Gray + teal, dark** (`v2-dark`) — teal `#4DDDBC` on dark neutrals, review-card fill `#14312B`, danger `#FF4D4D`.
- **Neon noir** (dark) — neon green `#2CFF05`, danger neon magenta `#BF00FF`.
- **Claude terminal** (dark) — Claude orange `#D97757`, danger clay `#C0553A`.

The three dark palettes override the solid-primary `.btn` fill (ink is light in dark mode) and darken the review-badge text for contrast; the doing/done status dots stay constant across all five. The legacy yellow-accent "Original dark" theme is dropped — there is no code path to it.

## Main screen

**Top bar** (46px, surface, bottom hairline, padding 0 18px): left, wordmark `worknotes` in Cascadia Mono 13px, letter-spacing 0.14em. Right, a **palette picker** `<select>` (the five palettes above; replaces the old Light/Dark toggle) followed by two quiet outline buttons (mono 11px, muted, hairline border): `Manage projects`, `API keys`.

**Left rail** (300px, surface, right hairline). Header block, then a scrolling list.

Header block:
1. Two solid ink buttons side by side: `New note`, `New task`
2. Search input on the bg-color field: placeholder `Search title and body`
3. **Filter by tag** row: mono label `FILTER BY TAG`; zero or more selected badges (soft-yellow `#FBF3C9` fill, `#F6E05E` border, dark-yellow mono text, each with a `×` remove); a `+ tag` button (dashed border, mono, muted) opening a 220px popup: mono label `TAGS`, then hairline pills of the remaining **active** tags (see tag lifecycle below); if none remain, `All tags selected.` No new-tag creation here.
4. Filter chips: `All`, `Notes`, `Tasks` — pills; active = solid ink with surface text
5. Full-width project select: `All projects` + one option per **loaded** project (see "Projects as loadable on-disk stores")
6. Half-width pair: status filter (`All statuses`, `todo`, `doing`, `done`) and sort (`Sort: updated`, `Sort: created`, `Sort: priority`, `Sort: status`)

List rows (12px 14px padding, bottom hairline): optional pin diamond (8px yellow square rotated 45°, thin dark-yellow border), a 9px status dot for tasks, the title (600 weight, ellipsis), a priority word for tasks when not normal (`high` in danger, `low` in muted — mono 11px), right-aligned mono timestamp (`14:32` today, else `Jul 9`); below, an optional muted preview line, then a mono tags line like `#platform #migration`. Selected row: bg-color fill with a 3px yellow left edge. **On a task marked done, the row's tag line renders in the released style — ~55% opacity** (see lifecycle). Empty state: `Nothing here yet — create your first note.`

**Editor pane:**
1. Header row: big borderless title input, a quiet `Suggest title` button (reads `Suggesting…` while it runs), and a quiet `Duplicate metadata` button
2. Meta row (wraps): `TASK`/`NOTE` mono label; for tasks, status and priority selects (`low priority / normal priority / high priority`); a project select listing all projects; the **tags widget** — neutral badges (bg fill, hairline, ink mono text) each with `×`, plus a `+ tag` button opening a popup titled `EXISTING TAGS` (only tags with active references, not already on the item) with a bottom row `new tag` input + `Add` button (Enter adds; lowercased, `#` stripped, de-duped); then a flexible gap and three quiet buttons: `Pin` (soft-yellow tint, dark-yellow text and yellow border when pinned, labeled `Unpin`), `Archive`, `Delete` (danger outline)
3. **JIRA reference row**, directly under the meta row: mono uppercase label `JIRA`, then an input on the bg-color field (Cascadia Mono 12px, max-width ~420px) with placeholder `Paste JIRA ticket URL (empty removes)`. While it holds a URL, a quiet chip renders to its right — hairline border, mono 11px — reading the ticket key extracted from the URL's last path segment (`PLAT-142 ↗`), or `Open ticket ↗` if the URL doesn't end in a key. Clicking the chip opens the URL in the default browser; the full URL is the hover tooltip
4. **The signature — AI review card**, shown when the item has a proposed rewrite and/or a proposed title: `#FBF3C9` fill, `#F6E05E` border, 8px radius; header holds a chip on solid yellow (mono, dark-yellow ink) reading `PROPOSED REWRITE` while the body proposal is unresolved, or `PROPOSED TITLE` when only a title proposal remains (the body text is then omitted); then right-aligned solid-ink `Replace text` and a `Discard` button (transparent, `#E6D68A` border, dark-yellow text); body text in `#6B5C0E`, 14px, line-height 1.6. The card may also carry a `TITLE` row — a mono UPPERCASE `TITLE` label, the proposed title text (or `Generating…` while it is still being produced, text only, no spinner), and a right-aligned solid-ink `Replace title` button (disabled while generating). `Replace text` and `Replace title` each **apply their half and save the item** in one action, clearing that half; the card stays open until both halves are resolved and closes when the last one is; `Discard` clears both halves and saves nothing
5. Body textarea: surface, hairline, 8px radius, no resize
6. Bottom AI bar (wraps): mono label `REWORK WITH`, model select (`Claude` default / `GPT`), four preset chips — `Tighten this up`, `Fix grammar and spelling`, `Make it more professional`, `Turn into bullet points` — a flexible instruction input (`Or type your own instruction…`), a solid-ink `Rework` button, and to its right the **`Save` button**: yellow `#F6E05E` fill, dark-yellow text; reads `Save` when dirty, `Saved` at half opacity and disabled otherwise

Empty editor state: `Select something on the left, or create a note to start.`

## Behaviors

- Clicking a row loads the item into the editor (title, status, priority, project, tags, body, pin state, proposal if any). Any edit marks it dirty → `Save`; saving returns to `Saved`.
- Pinned items always sort first, under every sort mode. Then: updated (newest), created (newest), priority (high → normal → low), or status (doing → todo → done); notes carry no status/priority and sort last under those two modes.
- Filters combine with AND: kind chip ∧ project ∧ status ∧ tag filter. The tag filter itself is OR — an item matches if it carries *any* selected filter tag.
- Preset chips fill the instruction input. `Rework` opens the review card; `Replace text` copies the proposal into the body **and saves the item**, clearing the body half of the card; `Replace title` copies the proposed title into the title field **and saves**, clearing the title half; the card closes once both halves are resolved. `Discard` just closes (both halves) and saves nothing.
- `Rework` streams the proposal in token by token: the card opens immediately, its chip reads `STREAMING…` while text arrives, and `Replace text` stays disabled until the stream finishes (then the chip returns to `PROPOSED REWRITE`). `Discard` during streaming both closes the card and stops the request; navigating to another item does the same. The body is never touched until `Replace text` — streaming only fills the proposal.
- **A successful rework also proposes a title.** Once the body stream finishes, a separate (non-streamed) AI call proposes a new title from the *proposed* body; it lands in the card's `TITLE` row (`Generating…`, then the text) and is accepted only via `Replace title`. If that call fails, the row silently never appears — a title suggestion is ancillary and never interrupts or errors out a successful rework. Discarding, or navigating to another item, before it lands abandons it. If the proposed title exactly matches the current title it is skipped silently (see `Suggest title`).
- **`Suggest title` generates a title on demand.** The header's `Suggest title` button asks the AI for a title from the current body and shows it in the review card's `TITLE` row for approval — applied only via `Replace title`, never automatically. The button reads `Suggesting…` and is disabled while it runs (and while a rework is in progress); an empty body toasts `There is no text to generate a title from.`, and a failed call toasts the error. **If the generated title exactly matches the current title, nothing is shown and no approval is prompted — the suggestion is skipped silently.** This exact-match skip applies to every generated title, the rework proposal included.
- **Saving an item with an empty title generates one.** When a save runs on an item whose title is blank but whose body is not — the Save button, Ctrl+S, or a `Replace text` accept, which all route through the one save path — the app calls the AI to generate a title from the body, auto-accepts it, and completes the save — silently on success: the title visibly populates the field and there is no toast. The Save button reads `Generating title…` and is disabled while the call is in flight. A failure or a missing API key surfaces as a toast (the missing-key message names the provider; other failures read `couldn't generate a title — try again`) and the save is aborted, leaving the item dirty. Saving with **both** title and body empty keeps the existing `Give it a title before saving.` error and makes no AI call. This is the one case where AI output is accepted without an explicit accept click — it fills only an empty title, never overwrites one, and never touches the body. It applies to notes and tasks alike; a single-space title counts as empty.
- The JIRA field associates an external ticket with any item, note or task. Typing or clearing it marks the item dirty like any other edit; the link chip exists only while a URL is present and always opens the default browser — it never navigates inside the app.
- `Duplicate metadata` creates a new item at the top carrying over kind, status, priority, project, and tags — empty title and body, unpinned, and no JIRA link (it identifies one specific ticket) — then selects it, dirty.
- The palette picker selects one of the five named palettes (see "New palettes"); each re-themes the neutrals **and** the accent/danger family. Only the doing/done status dots stay constant; `--todo` tracks the palette's muted gray. The selection persists and is applied before first paint (no flash).

### Tag lifecycle (new)

Tags are a derived vocabulary, not a managed list: a tag exists because at least one item carries it. Every tag on an item is a *reference*, and a reference is **active** while its item is neither a done task nor archived. The moment a ticket is finished (status set to `done`), its tag references are released: the tags stay visible on that item for history — rendered in a released style, ~55% opacity, with dashed badge borders in the editor — and they can still be removed by hand via `×`, but they no longer count. A tag whose last active reference is released disappears from both `+ tag` popups and from `FILTER BY TAG`; if it was selected as a filter badge, the badge is removed and the list recomputes. Reopening the task (status back to todo/doing) or typing the tag again via `new tag` brings it back into the vocabulary.

### Projects as loadable on-disk stores (new — replaces the row-based project model)

A project is a **folder on disk** the user opens and closes, not a row in a shared database. Each project is a self-contained SQLite store in its directory; the app shows the union of the currently **loaded** projects. This replaces the earlier row-based project + removal-guard model entirely.

**Main screen effects:**
- The rail's project select lists the **loaded** projects only (`All projects` + one option per loaded project). Filtering to a project scopes the list/search to that store.
- When **more than one** project is loaded, each list row carries a muted mono project label (below the tags line, `--muted`, 0.08em tracking) so a row's origin is never ambiguous. With one (or zero) project loaded the label is omitted.
- `New note` / `New task` are **disabled when no project is loaded**; the rail and editor empty states then read `No projects loaded — open or create one to start.`
- A new item is created **into a project store**: the target is the rail's filtered project, or — when the filter is `All projects` — the editor's project select becomes a required choice (`Choose a project…`) and `Save` stays disabled until one is picked. An existing item's project is **read-only** (items do not move between projects in v1).
- **Search** results are grouped by project — hits from one project are contiguous (projects ordered by name), each group in its own relevance order — because bm25 relevance is not comparable across separate stores; the per-row project label is the grouping cue.
- Startup surfaces any per-project load failure (a moved, corrupt, or newer-version file) as a one-time non-alarming status line, never a crash.
- **Unloading a project whose item is open** in the editor (or whose id a dirty draft targets) first confirms, then closes the item with a `role="status"` screen-reader announcement.

### Project manager dialog (new)

**Manage projects** replaces the old rename/remove dialog. One row per known project: the project **name**, its muted on-disk **path**, a mono state chip (`N ITEMS · M PROMPTS` in the `--done` green when loaded, else `UNLOADED` in `--muted`), and — grouped in a trailing, wrap-as-a-unit `.project-actions` cluster — **visually and verbally distinct** actions so reversible and irreversible operations never look alike:
- **Open folder** (quiet, available regardless of loaded state — revealing a folder needs no open store) — opens the project's directory in the OS file manager. Keyed by project **id**: the webview never passes or receives a path; a Rust command resolves the directory server-side, verifies it is a directory, and asks the OS to open it (a stale/missing path surfaces a plain error and opens nothing). Gated only by the shared busy lock.
- **Load / Unload** — the reversible toggle. Load opens the store; Unload closes it (files untouched), and is confirmed by the main screen when it would evict the open item.
- **Reload** (loaded rows only, quiet) — re-reads the project from its on-disk `items/*.md` files after an out-of-band change (a `git pull` / folder sync). Any file that can't be imported (e.g. one still carrying unresolved git conflict markers) is reported by name so the user knows which items are missing until they resolve them; the rest import. No file watcher — this is the deliberate manual refresh.
- **Forget** — removes the project from this list; its files are left on disk (re-openable later). Disabled until the project is unloaded.
- **Delete files** — destructive, in danger outline: a confirm names the **absolute path**, then the store contents (the canonical `items/` folder + the `prompts/` folder + the rebuildable `index.db` and its WAL sidecars + any pre-upgrade `.bak` + the generated `.gitignore`) and the catalog row are deleted. Disabled until unloaded.

A bottom row offers a **widened** `New project name` input (a floor width so it stays comfortably typeable beside its buttons) + **Create in folder…** and **Open project…**, both using the native OS folder picker; focus returns to the trigger after the picker closes. Two empty states: `No projects yet. Create a new one or open an existing folder to start.` (none known) and `No projects are loaded.` (some known, none loaded). All styling uses existing tokens (loaded/unloaded indicators reuse `--done` / `--muted`; Delete files reuses `--danger`) — no new colors.

A project's items are stored as one git-mergeable Markdown-with-frontmatter file each (`items/<uuid>.md`); the SQLite `index.db` beside them is a git-ignored, rebuildable search/query index, not the source of truth. A directory opened from an earlier single-file (`project.db`) layout is upgraded in place on first load, its original kept as a `.bak`. This is a storage-shape detail with no other UI surface beyond Reload and the Delete-files wording above.

### Due dates (new)

Due dates are **task-only** — notes never carry one (a backend invariant, so there is no due control on a note). In the editor meta row a task gains a `DUE` field after priority and before the project select: a mono UPPERCASE `DUE` label next to a native date input (`<input type="date">`), styled like the JIRA field. Granularity is a single calendar day, not a time. Setting or clearing the date marks the item dirty like any other edit; an empty field means no due date. In dark mode the OS-drawn calendar-picker glyph is inverted for contrast — it is a legibility correction, not a themed accent.

On a task row in the list, a task with a due date shows `due Jul 20` (same month/day formatting as the timestamp). A due date in the past reads in danger red **with a trailing `· overdue` word** — the colour is never the only signal. A **done** task never renders as overdue: finished work is not late.

### JIRA enrichment (new)

The JIRA chip (the `<button>` beside the ticket URL, which always opens the ticket in the browser and never navigates in-app) can enrich its label with live ticket title and status when a JIRA connection is configured. Enrichment only decorates the label — the click behavior never changes, in any state. Chip states: **plain** (no connection configured, or the URL has no ticket key) shows today's `PLAT-142 ↗`; **loading** keeps the plain label with only a tooltip cue (no layout shift); **loaded** shows a status dot + `PLAT-142 — {title} · {status} ↗`, the dot reusing the existing status-dot colours mapped from Atlassian's status *category* (`new` → todo, `indeterminate` → doing, `done` → done) with the status word also in text so colour is never the only signal, the whole label ellipsized within a max width; **error** (rate-limited, auth, network, or no key) quietly falls back to the plain label with a muted tooltip — never danger red, never blocking. Ticket title and status are remote text and render as React text nodes, never HTML. Enrichment is host-pinned server-side: the backend re-extracts the ticket key and calls only the configured site, so the stored URL's host is never contacted.

### Page switching (new)

worknotes gained a second top-level page, **Prompts**, alongside the existing **Worknotes** page — a router-free `page` state toggle, no deep-linking. In the top bar, directly after the wordmark, a two-item `role="tablist"` reads `Worknotes` / `Prompts`. The active tab's indicator is an **ink** bottom-border underline plus bold weight — never the signature yellow, which stays reserved for the AI review card — with standard tab keyboard behavior: `aria-selected`, `aria-controls`, roving `tabIndex` (0 on the active tab, -1 on the other), and Left/Right arrow keys move to and activate the other tab. Both pages stay mounted at all times; the inactive one is hidden (the `hidden` attribute, not unmounted), so switching pages never discards an in-progress edit — a Worknotes draft, or a Prompts draft/dirty edit — on the page left behind. `Manage projects`, `Settings`, and the error/notice toasts are shared chrome, unaffected by which page is active.

### Prompts page (new)

A per-project, versioned prompt library: every content edit — including accepting an AI-enhanced rewrite — is captured as an immutable version, and the original is never lost. The rail scopes the list to **one project or to "All projects"** — the latter an aggregate that surfaces every **reusable** prompt across all loaded projects (mirroring how Worknotes fans items across stores), each row labeled with its owning project. A prompt is always authored *into* one project, but a reusable one is then browsable everywhere. Because a mutation routes by prompt id to its true owning store, a reusable prompt edited from the All-projects scope writes back to the project that owns it — so that scope labels every row and the editor with the owning project, and names it in the destructive confirmations.

**Optional title.** A prompt's title is optional — a prompt is often just a body, and a title is ceremony. Wherever a prompt or version is labeled (list row, History, the delete/move confirms) the shown label is a **derived display label**: the trimmed title if present, else the first non-blank line of the body (truncated), else the literal `Untitled` — so a titleless prompt is never a blank row. The title `<input>` itself stays visually empty (showing its placeholder). The only content floor is that a prompt may not have an empty title **and** an empty body at once (rejected on save, surfaced like any save error); the title is always rendered as plain text, never HTML.

**Rail:** a solid `New prompt` button (disabled when no project is loaded **or when the scope is `All projects`** — a new prompt needs a concrete target store), a full-width project select whose first option is **`All projects`** (the cross-store reusable scope), followed by the loaded projects — when nothing is loaded that first option is instead an inert `No projects loaded`; an `All` / `Reusable only` filter-chip pair (AND-combined with the project selection) that in the **`All projects`** scope is **forced to `Reusable only` and disabled** (that scope is reusable-only by definition; the chips carry a tooltip saying so); and the row list. A row shows the **derived display label**, a `REUSABLE` pill badge when the prompt is marked reusable (green `--done` outline, reusing the pill token already used for "key saved" — the reusable state never uses yellow), a muted preview line of the body, a right-aligned mono updated timestamp, a muted mono `vN` version-count badge, **and — in the `All projects` scope only — a muted mono owning-project label** (the same `.row-project` treatment Worknotes uses), so a cross-project row's origin is never ambiguous. Empty states: `No projects loaded — open or create one to start.` when nothing is loaded, **`No reusable prompts in any loaded project yet.` in the `All projects` scope**, and `Nothing here yet — create your first prompt.` for a specific project with no prompts. In the `All projects` scope rows are ordered by recency across stores (newest current-version first), the same "updated" order a single project uses.

**Editor:** a borderless title input only — no `Suggest title` (prompts have no AI-generated titles), and empty is allowed; a meta row with a `prompt` mono kind label, **(in the `All projects` scope only) a persistent muted mono owning-project label right after it** — the Save and Mark-reusable paths have no confirmation dialog, so when a reusable prompt from another project is open this label is the only in-context signal of which project the edit writes back to — a `Mark reusable` / `Unmark reusable` toggle button (`aria-pressed`; green outline when on, matching the rail pill) that persists immediately — no version, no dirty state, since the reusable flag is prompt-level state, not a content edit — the `vN` badge, a **`Copy to clipboard`** button (available in draft and persisted states; copies the current body text to the OS clipboard and swaps its label to `Copied` for ~1.5s, with an `sr-only` `aria-live` announcement — the app's inline success-feedback convention, no toast), and (existing prompts only) a **`Move to project…`** popover trigger, `History`, and `Delete` (danger outline) buttons. **Move to project…** opens a small popover (the shared outside-click/Escape popover discipline) listing the other loaded projects; picking one confirms via the native dialog, then relocates the prompt — with its **full version history and provenance** — to that project (it vanishes from the current list). The trigger is disabled with a tooltip when no other project is loaded. `Delete` confirms via the native dialog, mirroring the Worknotes item delete path. The AI review card, body textarea, and bottom AI bar are reused verbatim from Worknotes — the same soft-yellow proposal card, `Replace text` / `Discard`, and token-by-token streaming — except there is no proposed-title half. The AI bar's preset chips are prompt-flavored: `Make it more specific`, `Add clear constraints`, `Clarify the ask`, `Tighten this up`. `Replace text` saves the accepted proposal as a new version tagged `aiEnhanced`, keeping the previous version intact in history.

**History dialog:** a card on the scrim (`role="dialog"`), listing every version **newest first** — an origin tag (`manual` or `AI enhanced`), a mono timestamp, the version's **derived display label**, and its body in a `<pre>` block (plain text only, matching the app's no-HTML-rendering rule). Unlike the older dialogs, this one moves initial focus to `Close` on open and closes on Escape as well as the scrim/`Close`. The very first (oldest) version is always present and never overwritten.

## Dialogs

**Settings** — 520px card on the scrim: heading `Settings`; muted note `Keys and the JIRA token are stored in the Windows credential manager on this machine. They are used for requests and are never shown again here.`; two API-key rows (`Anthropic (Claude)`, `OpenAI (GPT)`), each with a state pill — `key saved` in green `#4C8A64` outline or `no key` muted — a password input (`Paste key from console.anthropic.com (empty removes)`) and a solid-ink `Save key`. Below them a `JIRA` row with a `token saved` / `no token` pill, a short note, a site-URL + account-email pair with `Save connection` (the site URL must be https), and a password token input (`empty removes`) with `Save token`. Right-aligned `Done`.

**Manage projects** — a card on the scrim; the project manager surface specified in "Project manager dialog (new)" above (rows of name + muted path + loaded state + the actions Load/Unload, Reload (loaded rows), Forget, Delete files; a `New project name` + `Create in folder…` / `Open project…` row; two empty states; right-aligned `Done`). Supersedes the earlier inline-rename + count + Remove-guard dialog.

**Prompt history** — the version-history surface specified in "Prompts page (new)" above: newest-first list of origin tag + timestamp + title + `<pre>` body; initial focus on `Close`, Escape closes it; right-aligned `Close`.

## Reference sample state (used across design reviews — handy for manual testing)

Projects: `Platform Migration`, `Q3 Planning`, `Admin`, `Sandbox`.

List, top to bottom:
1. Pinned note — `Platform migration notes`, project Platform Migration, preview `Cutover checklist and open questions for the…`, tags `#platform #migration`, `14:32`
2. Task, doing, high — `Send follow-up email to platform team`, project Platform Migration, preview `Summarize the decisions from Tuesday and…`, tags `#platform`, `11:05` — **selected**
3. Task, todo — `Book room for Q3 review`, project Q3 Planning, tags `#planning`, `Jul 11`
4. Note — `Quarterly planning meeting`, project Q3 Planning, preview `Discussed roadmap, hiring plan and budget…`, tags `#work #planning`, `Jul 10`
5. Task, **done** — `File expense report`, project Admin, tags `#admin` shown in the released style, `Jul 8`

Because item 5 is finished and nothing else carries `admin`, that tag appears in **no** picker or filter popup — the available tag vocabulary is exactly `platform`, `migration`, `planning`, `work`. `FILTER BY TAG` has no badges selected; project filter `All projects`; status filter `All statuses`; sort `Sort: updated`.

Editor shows item 2: title `Send follow-up email to platform team`, status `doing`, priority `high priority`, project `Platform Migration`, tag badge `#platform`, unpinned, `Save` enabled. The JIRA row holds `https://acme.atlassian.net/browse/PLAT-142`, its chip reading `PLAT-142 ↗`. Review card open with: `Hi team — following up on Tuesday's discussion. We agreed to freeze schema changes until the cutover completes, and I'll circulate the rollback checklist by Thursday. Please flag any blocking migrations before then.` The body beneath holds a rougher draft of the same message.

Two states worth checking by hand: (a) the **Manage projects** dialog — each loaded project shows its item-count chip (`Platform Migration 2 ITEMS`, `Admin 1 ITEM`) with an `Unload` button plus disabled `Forget`/`Delete files` (unload-first), while any unloaded project reads `UNLOADED` with `Load` + enabled `Forget`/`Delete files`; (b) the main screen in **dark mode**, yellow review card unchanged. (This reference predates the loadable-project model — treat "projects" here as separate loadable folders; the row/editor states above still hold for whichever projects are loaded.)

## Voice

Sentence case everywhere except the mono UPPERCASE labels called out above. Buttons say exactly what they do (`Replace text`, not `Apply`). No emoji, no icons — the pin diamond and status dots are the only non-text marks, both drawn with CSS.
