# Handoff: worknotes — desktop notes & tasks app

## Overview
`worknotes` is a **local-first Windows 11 desktop app** for a single person to capture work notes and tasks and refine them with AI. The design is one primary screen (a two-pane workbench) plus three overlays: an **API keys** dialog, a **Manage projects** dialog, and an inline **tag picker** popup. The feeling is a calm, native productivity workbench: warm paper-gray surfaces, hairline borders, typographic (no icons), quiet everywhere except one signature element — a highlighter-yellow "Proposed rewrite" card where AI suggestions land. Flat design: no gradients, no drop shadows. A dark mode was added on top of the original spec.

## About the Design Files
The file in this bundle (`Worknotes.dc.html`) is a **design reference created in HTML** — a working prototype showing the intended look and behavior. It is **not production code to copy directly**. It happens to be authored as a "Design Component" (a streaming-preview format) whose logic lives in a `<script data-dc-script>` block near the bottom of the file; treat that script purely as a behavior reference.

The task is to **recreate this design in the target codebase's environment**. For a Windows 11 desktop app the natural targets are WinUI 3 / WPF (native, matches the Segoe/Fluent look best) or a web-tech desktop shell (Electron/Tauri + React). If no environment exists yet, choose the most appropriate for a local-first single-user desktop app and implement there using its established patterns.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, radii, and interactions are all specified below and should be matched closely. Recreate the UI faithfully using the codebase's existing component library, adapting only where the platform's conventions differ (e.g. native combo boxes vs. HTML `<select>`).

## Design Tokens

### Colors — light theme (default)
- App background (`--bg`): `#F1F0EC` (warm gray) — also used for input fields, the selected-row background, and dialog input fields
- Panel / card surface (`--surface`): `#FBFAF8` — top bar, left rail, editor controls, textarea, dialogs; also the text color on solid-ink buttons
- Ink / primary text (`--ink`): `#23272A` — also the fill of primary (solid) buttons
- Muted text (`--muted`): `#6E7378`
- Hairline borders (`--hair`): `#E3E1DB`
- Window surround (`--frame`): `#dcdad4`
- App outer border (`--border`): `#ccc9c1`

### Colors — dark theme
- `--bg`: `#1d1c1a`, `--surface`: `#272623`, `--ink`: `#eceae4`, `--muted`: `#a0a09a`, `--hair`: `#3a3833`, `--frame`: `#131211`, `--border`: `#3a3833`

### Colors — signature & semantic (CONSTANT across both themes)
- Highlighter yellow (borders, Save/chip fills): `#F6E05E`
- Soft yellow fill (review card, pinned/active tints): `#FBF3C9`
- Dark yellow ink (text/border on yellow surfaces): `#6B5C0E`
- Discard button soft-yellow border: `#e6d68a`
- Danger (Delete, `high` priority word): `#B4533A`
- Status dots — todo `#9AA0A6`, doing `#D9A441`, done `#4C8A64`
- Scrim behind dialogs: `rgba(35,39,42,0.35)`

The theme colors flow through CSS custom properties; the signature yellow, danger red, and status dots are intentionally **not** themed — the yellow review card stays bright in dark mode as the single accent. Implement themes the same way (a theme switch that swaps the neutral palette but leaves accents fixed).

### Typography
- UI text: **Segoe UI Variable** (fallback `Segoe UI`, then `system-ui`), 14px base, line-height ~1.45
- Metadata voice: **Cascadia Mono** (fallback `Consolas`, then `ui-monospace`), 11px, usually UPPERCASE with `letter-spacing: 0.08em` — used for timestamps, kind labels, tags, priority words, and section labels
- Editor title: 22px, weight ~650, borderless input
- Body textarea: 15px, line-height 1.6

### Radii, focus, spacing
- Corner radius: 6px (controls, buttons), 8px (cards, dialogs), 20px (pill chips/badges)
- Focus state: 2px ink outline, no glow (flat)
- Editor pane padding ~20–22px; left-rail header block padding ~14px; gaps 6–10px

## Screens / Views

### 1. Main screen (1200 × 760 desktop frame)
A vertical stack: slim top bar, then a two-pane row (left rail + editor).

#### Top bar (height 46px, `--surface`, bottom hairline, padding 0 18px)
- **Left**: wordmark `worknotes` in Cascadia Mono 13px, `letter-spacing: 0.14em`, ink.
- **Right**: a row (gap 8px) of three quiet outline buttons, each Cascadia Mono 11px `letter-spacing:0.06em`, muted text, 1px hairline border, radius 6px, padding 6px 12px:
  1. `Dark` / `Light` — toggles theme (label reflects the *target* theme).
  2. `Manage projects` — opens the Manage projects dialog.
  3. `API keys` — opens the API keys dialog.

#### Left rail (width 300px, `--surface`, right hairline border, vertical flex)
Top block (padding 14px, gap 10px, bottom hairline):
1. Two solid ink buttons side by side (flex:1 each, gap 8px): `New note`, `New task` — bg `--ink`, text `--surface`, radius 6px, padding 9px.
2. Search input (full width): placeholder `Search title and body`, bg `--bg`, 1px hairline, radius 6px, padding 8px 10px.
3. **Filter by tag** widget (flex row, wrap, gap 6px, position relative):
   - Mono label `FILTER BY TAG` (10px, letter-spacing 0.08em, muted).
   - Zero or more selected filter-tag badges: soft-yellow fill `#FBF3C9`, 1px `#F6E05E` border, radius 6px, dark-yellow text `#6B5C0E`, Cascadia Mono 11px, each with a `×` remove button.
   - A `+ tag` button (dashed border `#cdcabf`, mono 11px, muted) that toggles a popup.
   - **Popup** (absolute, below the button, width 220px, `--surface`, hairline, radius 8px, padding 10px): mono label `TAGS`, then wrap of existing-tag buttons (`#tag`, hairline pill) that are not already selected; clicking one adds a filter badge. If none remain: `All tags selected.` No add-new-tag here.
4. Filter chips row (gap 8px): `All`, `Notes`, `Tasks` — pill shaped (radius 20px, padding 6px 14px). Inactive: transparent bg, 1px hairline, muted text. Active: solid ink bg, surface text.
5. **Project filter** dropdown (full width `<select>` on `--bg`): options `All projects` + one per project.
6. Row (gap 8px) of two half-width `<select>`s:
   - **Status filter**: `All statuses`, `todo`, `doing`, `done`.
   - **Sort by**: `Sort: updated`, `Sort: created`, `Sort: priority`, `Sort: status`.

Scrolling item list (flex:1, overflow-y auto). Each **row** (padding 12px 14px, bottom hairline, cursor pointer):
- Top line (flex, align center, gap 8px):
  - Optional **pin marker**: 8px square, bg `#F6E05E`, 1px `#6B5C0E` border, `transform: rotate(45deg)` → diamond. Shown only when pinned.
  - Optional **status dot** (tasks only): 9px circle, color by status (todo/doing/done constants above).
  - **Title**: weight 600, 14px, ellipsis, flex:1.
  - Optional **priority word** (tasks, when not `normal`): Cascadia Mono 11px — `high` in danger `#B4533A`, `low` in muted.
  - **Timestamp**: mono 11px muted, right-aligned (`14:32` if today, else `Jul 9`).
- Optional **preview line**: muted 13px, single-line ellipsis.
- Optional **tags line**: Cascadia Mono 11px muted, e.g. `#platform #migration`.
- **Selected row**: bg `--bg`, 3px `#F6E05E` left border (left padding reduced by 3px to compensate), rest transparent left border.
- Empty list state (when filters match nothing): centered muted 13px text `Nothing here yet — create your first note.`

#### Editor pane (flex:1, padding 20px 22px, vertical flex)
1. **Header row** (flex, align flex-start, gap 16px): large borderless **title input** (22px, weight 650, transparent bg, flex:1) + a quiet outline **`Duplicate metadata`** button (surface bg, hairline, muted text, radius 6px).
2. **Meta row** (flex, align center, gap 10px, wrap):
   - Kind label: Cascadia Mono 11px uppercase muted — `TASK` or `NOTE`.
   - **Tasks only**: two `<select>`s — status (`todo`/`doing`/`done`) and priority (`low priority`/`normal priority`/`high priority`, values `low`/`normal`/`high`). Surface bg, hairline, radius 6px, 13px.
   - **Project `<select>`** (all items): options are the project list.
   - **Tags widget** (flex, wrap, gap 6px, position relative): tag badges (neutral: `--bg` fill, hairline, ink text, Cascadia Mono 11px) each with a `×` remove; a `+ tag` button; a popup titled `EXISTING TAGS` listing not-yet-added tags to click, plus a bottom row with a `new tag` text input + `Add` button (Enter also adds). New tags are lowercased, `#` stripped, de-duped.
   - Flexible gap, then three quiet buttons: **`Pin`** (turns soft-yellow-tinted with dark-yellow text and yellow border when pinned, label becomes `Unpin`), **`Archive`** (surface/hairline/muted), **`Delete`** (outline in danger `#B4533A`).
3. **Signature — AI review card** (shown when the current item has a proposed rewrite). Margin-top 16px, bg `#FBF3C9`, 1px `#F6E05E` border, radius 8px, padding 14px 16px:
   - Header row: a chip on solid yellow `#F6E05E` reading `PROPOSED REWRITE` (Cascadia Mono 11px, letter-spacing 0.08em, dark-yellow ink `#6B5C0E`, radius 5px, padding 3px 8px); flexible gap; then right-aligned **`Replace text`** (solid ink) and **`Discard`** (transparent, `#e6d68a` border, dark-yellow text).
   - Body: proposed text in `#6B5C0E`, 14px, line-height 1.6.
4. **Body textarea** (flex:1, margin-top 16px, `--surface` bg, hairline, radius 8px, padding 14px 16px, 15px text, line-height 1.6, no resize).
5. **Bottom AI bar** (flex, align center, gap 8px, wrap, margin-top 14px):
   - Mono uppercase label `REWORK WITH`.
   - Model `<select>`: `Claude` (default) / `GPT`.
   - Four preset chips (surface bg, hairline, radius 20px, 12px): `Tighten this up`, `Fix grammar and spelling`, `Make it more professional`, `Turn into bullet points`. Clicking one fills the instruction input.
   - Flexible **instruction input** (flex:1, min-width 160px): placeholder `Or type your own instruction…`.
   - **`Rework`** button (solid ink, radius 6px, padding 8px 16px).
   - **`Save`** button, to the right of Rework: bg `#F6E05E`, text `#6B5C0E`, radius 6px, padding 8px 18px. Label `Save` when there are unsaved edits; `Saved` (0.5 opacity, disabled) otherwise.
- Empty editor state (nothing selected): `Select something on the left, or create a note to start.`

### 2. API keys dialog
Centered card (width 520px) on a `rgba(35,39,42,0.35)` scrim. `--surface` bg, hairline, radius 8px, padding 22px 24px.
- Heading `API keys` (20px, weight 650).
- Muted note (13px, line-height 1.55): `Keys are stored in the Windows credential manager on this machine. They are used for rework requests and are never shown again here.`
- Two rows (`Anthropic (Claude)`, `OpenAI (GPT)`), each: a label + a state pill — `key saved` (green outline `#4C8A64`) or `no key` (muted hairline outline), Cascadia Mono 10px; then a password input (placeholder `Paste key from console.anthropic.com (empty removes)`) on `--bg` + a solid ink `Save key` button.
- Right-aligned solid ink `Done` button closes.

### 3. Manage projects dialog
Centered card (width 480px) on the same scrim.
- Heading `Manage projects`; muted note: `Rename a project inline, or remove it — items on a removed project keep no project.`
- One row per project (gap 8px): an inline **rename** text input (`--bg`) bound to the project name, a mono item-count label (`N ITEM`/`N ITEMS`), and a `Remove` button (danger outline). Empty state: `No projects yet.`
- Add row (top hairline): `New project name` input + solid ink `Add project` button (Enter also adds).
- Right-aligned solid ink `Done` closes.

## Interactions & Behavior
- **Row click** selects an item and loads it into the editor (title, status, priority, project, tags, body, pin state, and its proposed rewrite if any). Save resets to enabled/`Saved` accordingly.
- **Any edit** (title, status, priority, project, tags, body, pin toggle) marks the item dirty → Save button reads `Save`. `Save` sets it back to `Saved` (disabled).
- **Pin/Unpin** toggles the pin; pinned items always sort to the top of the list regardless of sort mode.
- **Replace text** copies the proposed rewrite into the body and closes the review card (marks dirty). **Discard** just closes the card. **Rework** reopens the card (in the prototype it re-shows the canned proposal; in production it would issue the AI request using the selected model + instruction).
- **Preset chips** set the instruction input text.
- **Tag widget**: `+ tag` opens a popup; pick an existing tag or type a new one (Enter/Add). Removing via `×`. All changes mark dirty.
- **Filter by tag**: additive OR filter — an item matches if it has *any* selected filter tag. Combined (AND) with the All/Notes/Tasks chip, the project dropdown, and the status dropdown.
- **Sort**: pinned-first, then by updated (newest), created (newest), priority (high→normal→low), or status (doing→todo→done). Notes (no status/priority) sort last under those two modes.
- **Duplicate metadata**: creates a new item at the top of the list carrying over the current kind, status, priority, project, and tags — but with empty title and body and unpinned — then selects it with Save enabled.
- **Theme toggle**: swaps the neutral palette (accents fixed); in the prototype it sets a `data-theme` attribute on the document body.
- **Dialogs** open from the top bar and close via `Done`.

## State Management
Per-item model: `{ id, kind: 'note'|'task', status?: 'todo'|'doing'|'done', priority?: 'low'|'normal'|'high', project?: string|null, title, body, preview, tags: string[], pinned: bool, ts (display string), created (ISO), updated (ISO), proposed?: string }`.

App/UI state:
- `items: Item[]`, `projects: string[]`
- `selectedId`
- Editor draft fields: `editTitle, editStatus, editPriority, editProject, editTagsArr[], editBody, pinned, proposed`, plus `dirty` and `showReview`
- Filters/sort: `filter` (All/Notes/Tasks), `filterTags[]`, `projectFilter`, `statusFilter`, `sortBy`
- Popups/dialogs: `tagPopupOpen`, `newTag`, `filterPopupOpen`, `projectsDialogOpen`, `newProject`, `dialogOpen` (API keys)
- `dark` (theme)

Data fetching / persistence (production): local-first storage on the machine; API keys stored in the Windows credential manager; `Rework` calls the selected provider (Anthropic/OpenAI) with the note body + instruction and returns the proposed rewrite.

## Assets
None. There are no images or icons — the pin diamond and status dots are the only non-text marks, both drawn with CSS. Fonts (Segoe UI Variable, Cascadia Mono) are Windows system fonts; on other platforms they fall back to a sans/monospace stack.

## Voice
Sentence case everywhere except the mono UPPERCASE labels called out above. Buttons say exactly what they do (`Replace text`, not `Apply`). No emoji, no icons.

## Files
- `Worknotes.dc.html` — the full design reference (markup at the top; behavior in the `<script data-dc-script>` block near the bottom). Open it in a browser to see the live prototype and all interactions.
