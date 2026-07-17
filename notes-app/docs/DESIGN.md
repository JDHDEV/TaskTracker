# worknotes — design specification

This is the agreed UI/behavior spec. The interactive reference is `reference/Worknotes_dc.html` (open in a browser); `reference/design-tool-handoff.md` is the design tool's own handoff notes. Where they disagree, THIS document wins — it includes rules added after the prototype was generated (tag lifecycle, project removal guard, JIRA link).

worknotes is a local-first Windows 11 desktop app called **worknotes**, used by one person to capture work notes and tasks and refine them with AI. One primary screen — a two-pane workbench — plus three overlays: an **API keys** dialog, a **Manage projects** dialog, and inline **tag picker** popups. The feeling is a calm, native productivity workbench: warm paper-gray surfaces, hairline borders, typographic (no icons), quiet everywhere except one signature element — a highlighter-yellow "Proposed rewrite" card where AI suggestions land. Flat design: no gradients, no drop shadows. Light theme is the default; a dark theme swaps only the neutral palette — the yellow stays the single bright accent in both. Desktop frame 1200 × 760.

## Design tokens (use these exactly)

Light theme neutrals:
- App background `#F1F0EC` — also input fields, the selected-row background, dialog input fields
- Panel / card surface `#FBFAF8` — top bar, left rail, editor controls, textarea, dialogs; also the text color on solid-ink buttons
- Ink (primary text, solid-button fill) `#23272A`
- Muted text `#6E7378`
- Hairline borders `#E3E1DB`
- Window surround `#DCDAD4`; app outer border `#CCC9C1`

Dark theme neutrals: bg `#1D1C1A`, surface `#272623`, ink `#ECEAE4`, muted `#A0A09A`, hairlines `#3A3833`, surround `#131211`, outer border `#3A3833`.

Constant across both themes (never re-themed):
- Signature highlighter yellow `#F6E05E`; soft yellow fill `#FBF3C9`; dark yellow ink for text on yellow `#6B5C0E`; Discard-button border `#E6D68A`
- Danger `#B4533A` (Delete, the `high` priority word)
- Status dots — todo `#9AA0A6`, doing `#D9A441`, done `#4C8A64`
- Dialog scrim `rgba(35, 39, 42, 0.35)`

Type:
- UI text: Segoe UI Variable (fallback Segoe UI, then system-ui), 14px base, line-height ~1.45
- Metadata voice: Cascadia Mono (fallback Consolas), 11px, usually UPPERCASE with 0.08em letter-spacing — timestamps, kind labels, tags, priority words, section labels
- Editor title 22px weight ~650, borderless; body textarea 15px, line-height 1.6

Radii 6px (controls) / 8px (cards, dialogs) / 20px (pill chips). Focus is a 2px ink outline, no glow. Editor padding ~20–22px; rail header block ~14px.

## Main screen

**Top bar** (46px, surface, bottom hairline, padding 0 18px): left, wordmark `worknotes` in Cascadia Mono 13px, letter-spacing 0.14em. Right, three quiet outline buttons (mono 11px, muted, hairline border): `Dark` or `Light` (label names the *target* theme and toggles it), `Manage projects`, `API keys`.

**Left rail** (300px, surface, right hairline). Header block, then a scrolling list.

Header block:
1. Two solid ink buttons side by side: `New note`, `New task`
2. Search input on the bg-color field: placeholder `Search title and body`
3. **Filter by tag** row: mono label `FILTER BY TAG`; zero or more selected badges (soft-yellow `#FBF3C9` fill, `#F6E05E` border, dark-yellow mono text, each with a `×` remove); a `+ tag` button (dashed border, mono, muted) opening a 220px popup: mono label `TAGS`, then hairline pills of the remaining **active** tags (see tag lifecycle below); if none remain, `All tags selected.` No new-tag creation here.
4. Filter chips: `All`, `Notes`, `Tasks` — pills; active = solid ink with surface text
5. Full-width project select: `All projects` + one option per project
6. Half-width pair: status filter (`All statuses`, `todo`, `doing`, `done`) and sort (`Sort: updated`, `Sort: created`, `Sort: priority`, `Sort: status`)

List rows (12px 14px padding, bottom hairline): optional pin diamond (8px yellow square rotated 45°, thin dark-yellow border), a 9px status dot for tasks, the title (600 weight, ellipsis), a priority word for tasks when not normal (`high` in danger, `low` in muted — mono 11px), right-aligned mono timestamp (`14:32` today, else `Jul 9`); below, an optional muted preview line, then a mono tags line like `#platform #migration`. Selected row: bg-color fill with a 3px yellow left edge. **On a task marked done, the row's tag line renders in the released style — ~55% opacity** (see lifecycle). Empty state: `Nothing here yet — create your first note.`

**Editor pane:**
1. Header row: big borderless title input + a quiet `Duplicate metadata` button
2. Meta row (wraps): `TASK`/`NOTE` mono label; for tasks, status and priority selects (`low priority / normal priority / high priority`); a project select listing all projects; the **tags widget** — neutral badges (bg fill, hairline, ink mono text) each with `×`, plus a `+ tag` button opening a popup titled `EXISTING TAGS` (only tags with active references, not already on the item) with a bottom row `new tag` input + `Add` button (Enter adds; lowercased, `#` stripped, de-duped); then a flexible gap and three quiet buttons: `Pin` (soft-yellow tint, dark-yellow text and yellow border when pinned, labeled `Unpin`), `Archive`, `Delete` (danger outline)
3. **JIRA reference row**, directly under the meta row: mono uppercase label `JIRA`, then an input on the bg-color field (Cascadia Mono 12px, max-width ~420px) with placeholder `Paste JIRA ticket URL (empty removes)`. While it holds a URL, a quiet chip renders to its right — hairline border, mono 11px — reading the ticket key extracted from the URL's last path segment (`PLAT-142 ↗`), or `Open ticket ↗` if the URL doesn't end in a key. Clicking the chip opens the URL in the default browser; the full URL is the hover tooltip
4. **The signature — AI review card**, shown when the item has a proposed rewrite: `#FBF3C9` fill, `#F6E05E` border, 8px radius; header holds a chip on solid yellow reading `PROPOSED REWRITE` (mono, dark-yellow ink), then right-aligned solid-ink `Replace text` and a `Discard` button (transparent, `#E6D68A` border, dark-yellow text); body text in `#6B5C0E`, 14px, line-height 1.6
5. Body textarea: surface, hairline, 8px radius, no resize
6. Bottom AI bar (wraps): mono label `REWORK WITH`, model select (`Claude` default / `GPT`), four preset chips — `Tighten this up`, `Fix grammar and spelling`, `Make it more professional`, `Turn into bullet points` — a flexible instruction input (`Or type your own instruction…`), a solid-ink `Rework` button, and to its right the **`Save` button**: yellow `#F6E05E` fill, dark-yellow text; reads `Save` when dirty, `Saved` at half opacity and disabled otherwise

Empty editor state: `Select something on the left, or create a note to start.`

## Behaviors

- Clicking a row loads the item into the editor (title, status, priority, project, tags, body, pin state, proposal if any). Any edit marks it dirty → `Save`; saving returns to `Saved`.
- Pinned items always sort first, under every sort mode. Then: updated (newest), created (newest), priority (high → normal → low), or status (doing → todo → done); notes carry no status/priority and sort last under those two modes.
- Filters combine with AND: kind chip ∧ project ∧ status ∧ tag filter. The tag filter itself is OR — an item matches if it carries *any* selected filter tag.
- Preset chips fill the instruction input. `Rework` opens the review card; `Replace text` copies the proposal into the body, closes the card, marks dirty; `Discard` just closes.
- `Rework` streams the proposal in token by token: the card opens immediately, its chip reads `STREAMING…` while text arrives, and `Replace text` stays disabled until the stream finishes (then the chip returns to `PROPOSED REWRITE`). `Discard` during streaming both closes the card and stops the request; navigating to another item does the same. The body is never touched until `Replace text` — streaming only fills the proposal.
- The JIRA field associates an external ticket with any item, note or task. Typing or clearing it marks the item dirty like any other edit; the link chip exists only while a URL is present and always opens the default browser — it never navigates inside the app.
- `Duplicate metadata` creates a new item at the top carrying over kind, status, priority, project, and tags — empty title and body, unpinned, and no JIRA link (it identifies one specific ticket) — then selects it, dirty.
- Theme toggle swaps the neutral palette only; every accent listed as constant stays put.

### Tag lifecycle (new)

Tags are a derived vocabulary, not a managed list: a tag exists because at least one item carries it. Every tag on an item is a *reference*, and a reference is **active** while its item is neither a done task nor archived. The moment a ticket is finished (status set to `done`), its tag references are released: the tags stay visible on that item for history — rendered in a released style, ~55% opacity, with dashed badge borders in the editor — and they can still be removed by hand via `×`, but they no longer count. A tag whose last active reference is released disappears from both `+ tag` popups and from `FILTER BY TAG`; if it was selected as a filter badge, the badge is removed and the list recomputes. Reopening the task (status back to todo/doing) or typing the tag again via `new tag` brings it back into the vocabulary.

### Project removal guard (new)

In **Manage projects**, each row's mono count reflects live assignments. `Remove` is disabled — half opacity, not clickable — whenever the count is 1 or more: a project can only be removed once no notes or tasks are assigned to it. (This replaces any orphan-on-remove behavior.)

### Due dates (new)

Due dates are **task-only** — notes never carry one (a backend invariant, so there is no due control on a note). In the editor meta row a task gains a `DUE` field after priority and before the project select: a mono UPPERCASE `DUE` label next to a native date input (`<input type="date">`), styled like the JIRA field. Granularity is a single calendar day, not a time. Setting or clearing the date marks the item dirty like any other edit; an empty field means no due date. In dark mode the OS-drawn calendar-picker glyph is inverted for contrast — it is a legibility correction, not a themed accent.

On a task row in the list, a task with a due date shows `due Jul 20` (same month/day formatting as the timestamp). A due date in the past reads in danger red **with a trailing `· overdue` word** — the colour is never the only signal. A **done** task never renders as overdue: finished work is not late.

### JIRA enrichment (new)

The JIRA chip (the `<button>` beside the ticket URL, which always opens the ticket in the browser and never navigates in-app) can enrich its label with live ticket title and status when a JIRA connection is configured. Enrichment only decorates the label — the click behavior never changes, in any state. Chip states: **plain** (no connection configured, or the URL has no ticket key) shows today's `PLAT-142 ↗`; **loading** keeps the plain label with only a tooltip cue (no layout shift); **loaded** shows a status dot + `PLAT-142 — {title} · {status} ↗`, the dot reusing the existing status-dot colours mapped from Atlassian's status *category* (`new` → todo, `indeterminate` → doing, `done` → done) with the status word also in text so colour is never the only signal, the whole label ellipsized within a max width; **error** (rate-limited, auth, network, or no key) quietly falls back to the plain label with a muted tooltip — never danger red, never blocking. Ticket title and status are remote text and render as React text nodes, never HTML. Enrichment is host-pinned server-side: the backend re-extracts the ticket key and calls only the configured site, so the stored URL's host is never contacted.

## Dialogs

**Settings** — 520px card on the scrim: heading `Settings`; muted note `Keys and the JIRA token are stored in the Windows credential manager on this machine. They are used for requests and are never shown again here.`; two API-key rows (`Anthropic (Claude)`, `OpenAI (GPT)`), each with a state pill — `key saved` in green `#4C8A64` outline or `no key` muted — a password input (`Paste key from console.anthropic.com (empty removes)`) and a solid-ink `Save key`. Below them a `JIRA` row with a `token saved` / `no token` pill, a short note, a site-URL + account-email pair with `Save connection` (the site URL must be https), and a password token input (`empty removes`) with `Save token`. Right-aligned `Done`.

**Manage projects** — 480px card on the scrim: heading `Manage projects`; muted note `Rename a project inline. A project can be removed only when no notes or tasks are assigned to it.`; one row per project: an inline rename input on the bg field, a mono count (`1 ITEM` / `3 ITEMS`), and a `Remove` button in danger outline, disabled per the guard above; empty state `No projects yet.`; an add row under a top hairline: `New project name` input + solid-ink `Add project` (Enter adds); right-aligned `Done`.

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

Two states worth checking by hand: (a) the **Manage projects** dialog — `Platform Migration 2 ITEMS`, `Q3 Planning 2 ITEMS`, `Admin 1 ITEM` all with disabled Remove, and `Sandbox 0 ITEMS` with Remove enabled; (b) the main screen in **dark mode**, yellow review card unchanged.

## Voice

Sentence case everywhere except the mono UPPERCASE labels called out above. Buttons say exactly what they do (`Replace text`, not `Apply`). No emoji, no icons — the pin diamond and status dots are the only non-text marks, both drawn with CSS.
