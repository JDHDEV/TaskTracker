import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  Item,
  Kind,
  ListFilter,
  NewItem,
  ProjectInfo,
  Sort,
  UpdateItem,
} from "./types";
import * as api from "./lib/api";
import { recomputeTagFilter } from "./lib/tags";
import {
  itemKey,
  loadedProjects,
  nextToken,
  resolveCreateTarget,
  shouldCommit,
} from "./lib/projects";
import { duplicateDraft, newDraft } from "./lib/draft";
import {
  getStoredPalette,
  isPaletteId,
  PALETTES,
  polarityOf,
  setStoredPalette,
  type PaletteId,
} from "./lib/palettes";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  hasTab,
  openTab,
  promoteTab,
  setDirty,
  setTabItem,
  type OpenTabsState,
} from "./lib/openTabs";
import ItemList, { KindFilter, StatusFilter } from "./components/ItemList";
import Editor, { type EditorHandle } from "./components/Editor";
import EditorTabs, { type EditorTabDescriptor } from "./components/EditorTabs";
import SettingsDialog from "./components/SettingsDialog";
import ManageProjectsDialog from "./components/ManageProjectsDialog";
import AboutDialog from "./components/AboutDialog";
import PromptsPage from "./components/PromptsPage";
import ScratchPage from "./components/ScratchPage";
import Toasts from "./components/Toasts";
import { useToasts } from "./hooks/useToasts";

type Page = "worknotes" | "prompts" | "scratch";
// Tablist order — the arrow-key walk (with wrap) follows this.
const PAGES: Page[] = ["worknotes", "prompts", "scratch"];

/** A tab's display title: the saved title, or a kind-based placeholder while an
 *  item/draft is still untitled. */
function itemTabTitle(item: Item): string {
  return item.title || (item.kind === "task" ? "Untitled task" : "Untitled note");
}

export default function App() {
  const [items, setItems] = useState<Item[]>([]);

  // Filter set — each is AND-combined; tagFilter is OR within itself. All of it
  // drives one ListFilter built in loadItems() and sent to both IPC paths.
  const [kind, setKind] = useState<KindFilter>("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>(""); // "" = All projects
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [search, setSearch] = useState("");

  // Known projects (the catalog, each with a `loaded` flag) and the derived tag
  // vocabulary union across loaded projects.
  const [knownProjects, setKnownProjects] = useState<ProjectInfo[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const loaded = loadedProjects(knownProjects);

  // Open editor tabs (Plan 11). Each tab holds a snapshot Item + an unsaved flag;
  // the active tab is the visible editor. Every open item keeps a mounted-hidden
  // <Editor>, so per-tab edits and in-flight AI streams survive a tab switch.
  // Drafts get a synthetic `draft-<seq>` key (real items key on itemKey()); on
  // save the draft key is promoted to the created item's key so the tab stays
  // open and re-clicking its row activates it instead of duplicating it.
  const [tabs, setTabs] = useState<OpenTabsState<Item>>(emptyTabs);
  const [draftSeq, setDraftSeq] = useState(0);
  // Latest tabs, so async reconciliation reads the current set after an await.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // Imperative save() handles per open tab, so the close-dirty "Save" branch can
  // persist a background (non-active) tab whose buffer lives only in its editor.
  const editorRefs = useRef(new Map<string, EditorHandle>());

  const [showSettings, setShowSettings] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  // Toasts replace the former single-slot error/notice banners. Errors persist
  // until dismissed/resolved; notices auto-expire at 30s. Resolvable validation
  // toasts are pushed with a stable key and cleared (dismissKey) the instant the
  // owning field's condition becomes false. The callbacks are stable across
  // renders (the hook memoizes them), so they are safe useCallback/effect deps.
  const {
    toasts: toastList,
    error: showError,
    notice: showNotice,
    dismiss: dismissToast,
    dismissKey,
  } = useToasts();
  // The selected palette (accent family + neutrals + polarity). Seeded from the
  // whitelist-validated store so a stale/garbage id falls back to "original".
  const [palette, setPalette] = useState<PaletteId>(getStoredPalette);

  // Router-free page toggle (Worknotes / Prompts). Both pages stay mounted
  // (the inactive one is hidden, not unmounted — see the `hidden` wrappers
  // below), so switching never discards an in-progress edit on either page.
  const [page, setPage] = useState<Page>("worknotes");

  // The set of projects with at least one open prompt tab on the Prompts page
  // (reported up by PromptsPage). Lets the unload confirm warn before an unload
  // closes an open prompt — even a dirty background one — not just an item.
  const [openPromptProjectIds, setOpenPromptProjectIds] = useState<string[]>([]);
  // Likewise for open scratch-pad tabs on the Scratch page (Plan 13).
  const [openScratchProjectIds, setOpenScratchProjectIds] = useState<string[]>([]);

  // Bumped when a project is reloaded so PromptsPage closes its own open prompt
  // tabs of that project — reload keeps the project `loaded`, so PromptsPage's
  // loaded-driven close effect won't fire on its own. ScratchPage consumes the
  // same signal to close that project's pad tab.
  const [promptReloadSignal, setPromptReloadSignal] =
    useState<{ projectId: string; n: number } | null>(null);

  // One-shot "send selection to prompt" seed (Plan 13): PromptsPage opens a
  // dirty draft tab pre-filled with `body` in `projectId`. `n` makes each send a
  // fresh object so the consuming effect re-fires even for identical text.
  const [promptSeed, setPromptSeed] =
    useState<{ projectId: string; body: string; n: number } | null>(null);

  // Focus target for the empty-editor placeholder, so closing the LAST tab moves
  // focus into the placeholder region instead of dropping it to <body>.
  const emptyEditorRef = useRef<HTMLElement>(null);
  const hadTabsRef = useRef(false);
  useEffect(() => {
    const has = tabs.tabs.length > 0;
    if (hadTabsRef.current && !has) emptyEditorRef.current?.focus();
    hadTabsRef.current = has;
  }, [tabs.tabs.length]);

  // Monotonic request token: a slow listItems that resolves after a newer load
  // (or after an unload closed a store) must not repopulate the list. Only the
  // latest token commits — the exact race the single-DB app never had.
  const loadToken = useRef(0);

  // A palette drives two <html> attributes, set atomically: data-palette (accent
  // + neutrals — the authoritative token source) and data-theme (polarity, which
  // the legacy [data-theme="dark"] rules key on). main.tsx applies the same pair
  // synchronously before first render (no flash); this keeps them in sync on
  // every later change and persists via the whitelist-validated setter.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.palette = palette;
    root.dataset.theme = polarityOf(palette);
    setStoredPalette(palette);
  }, [palette]);

  // One ListFilter for both the list and search paths. projectFilter "" means
  // "no filter" and is OMITTED — the manager then queries all loaded stores.
  const loadItems = useCallback(async () => {
    const token = (loadToken.current = nextToken(loadToken.current));
    try {
      const f: ListFilter = {
        kind: kind === "all" ? undefined : kind,
        projectId: projectFilter || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        tags: tagFilter.length ? tagFilter : undefined,
        sort,
      };
      const result = search.trim()
        ? await api.searchItems(search, f)
        : await api.listItems(f);
      if (shouldCommit(token, loadToken.current)) setItems(result);
    } catch (err) {
      if (shouldCommit(token, loadToken.current)) showError(String(err));
    }
  }, [kind, projectFilter, statusFilter, tagFilter, sort, search, showError]);

  const loadMeta = useCallback(async () => {
    try {
      const [nextProjects, nextTags] = await Promise.all([
        api.listProjects(),
        api.listActiveTags(),
      ]);
      setKnownProjects(nextProjects);
      setActiveTags(nextTags);
    } catch (err) {
      showError(String(err));
    }
  }, [showError]);

  // Debounce search only; discrete filter changes fire immediately (0 ms).
  useEffect(() => {
    const t = setTimeout(() => void loadItems(), search.trim() ? 200 : 0);
    return () => clearTimeout(t);
  }, [loadItems, search]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Surface one-time startup warnings (a moved/corrupt/newer project file).
  useEffect(() => {
    void (async () => {
      try {
        const warnings = await api.startupWarnings();
        // Coalesced into ONE keyed notice (not N banners) — the stable key keeps
        // the multi-warning startup case a single row (§3.2).
        if (warnings.length) showNotice(warnings.join(" "), { key: "startup-warnings" });
      } catch {
        // A missing warnings channel is not itself worth alarming about.
      }
    })();
  }, [showNotice]);

  // Tag lifecycle: when the vocabulary shrinks (a tag's last active reference
  // finished, was archived, or its project unloaded), drop any selected filter
  // badge for it. Guarded so it only re-renders when the set actually shrank —
  // and because tagFilter drives loadItems(), pruning re-fires the query.
  useEffect(() => {
    setTagFilter((tf) => {
      const next = recomputeTagFilter(tf, activeTags);
      return next.length === tf.length ? tf : next;
    });
  }, [activeTags]);

  // Project filter follows the same lifecycle: if the filtered project is no
  // longer loaded (unloaded/forgotten/deleted), reset to "All projects" so the
  // rail select never points at a missing option and the list can't silently
  // strand on a closed store.
  useEffect(() => {
    setProjectFilter((pf) => (pf && !knownProjects.some((p) => p.id === pf && p.loaded) ? "" : pf));
  }, [knownProjects]);

  const active = activeTab(tabs);
  // Rail highlight: the active tab's saved item id (a draft has "" → no row).
  const selectedId = active && active.item.id !== "" ? active.item.id : null;

  // EditorTabs descriptors — primitives only, so a keystroke in one editor (which
  // re-renders only that editor, not App) never rebuilds this list.
  const tabDescriptors = useMemo<EditorTabDescriptor[]>(
    () =>
      tabs.tabs.map((t) => ({
        key: t.key,
        title: itemTabTitle(t.item),
        pinned: t.item.pinned,
        dotClass: t.item.kind === "task" ? `dot dot-${t.item.status ?? "todo"}` : undefined,
        dotTitle: t.item.kind === "task" ? (t.item.status ?? "todo") : undefined,
        dirty: t.isDirty,
      })),
    [tabs],
  );

  async function refreshAll() {
    await Promise.all([loadItems(), loadMeta()]);
  }

  // After a refresh, re-sync each open (non-draft) tab's snapshot from the store
  // BY ID — never by diffing the filtered `items` list (a filter change would
  // then falsely "delete" still-open tabs and lose their edits). A rejected
  // getItem means the item is genuinely gone → close that tab; otherwise refresh
  // the snapshot so Pin/Archive labels and the tab title track the store, WITHOUT
  // disturbing the mounted editor's local edit buffer (its re-seed keys on
  // item.id, which is unchanged, so a dirty tab keeps its in-progress edits).
  const reconcileTabs = useCallback(async () => {
    const open = tabsRef.current.tabs.filter((t) => t.item.id !== "");
    if (open.length === 0) return;
    const results = await Promise.all(
      open.map((t) =>
        api.getItem(t.item.id).then(
          (item): { key: string; item: Item | null } => ({ key: t.key, item }),
          (): { key: string; item: Item | null } => ({ key: t.key, item: null }),
        ),
      ),
    );
    setTabs((s) => {
      let next = s;
      for (const r of results) {
        if (!hasTab(next, r.key)) continue; // closed meanwhile
        if (r.item) {
          next = setTabItem(next, r.key, r.item);
        } else if (!next.tabs.find((t) => t.key === r.key)?.isDirty) {
          // Genuinely gone → close it. But never silently drop a DIRTY tab on a
          // (possibly transient) fetch failure — keep its unsaved edits; a real
          // deletion surfaces when the user next tries to save.
          next = closeTab(next, r.key);
        }
      }
      return next;
    });
  }, []);

  // Returns whether the action succeeded so callers (Editor.save) only clear
  // their dirty state on a real persist — a rejected save must stay "Save".
  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await refreshAll();
      await reconcileTabs();
      return true;
    } catch (err) {
      showError(String(err));
      return false;
    }
  }

  // Rail click / open-or-activate: open a tab for `id` (looked up in `items` for
  // its snapshot), or just activate it if already open — openTab keeps an
  // already-open tab's snapshot and edits, so re-clicking never discards them.
  function selectRow(id: string) {
    const item = items.find((i) => i.id === id);
    if (item) setTabs((s) => openTab(s, itemKey(item), item));
  }

  // `target`/`body` are the "send selection to…" seeds (Plan 13): the pad's own
  // project and the selected text. Existing callers pass only `kind`.
  function openNewDraft(kind: Kind, target?: string, body = "") {
    const seq = draftSeq + 1;
    setDraftSeq(seq);
    // Target the rail's project when it names a loaded project; otherwise ""
    // (All projects), so the editor requires an explicit target before Save.
    const draftItem = newDraft(kind, target ?? resolveCreateTarget(projectFilter, loaded), body);
    setTabs((s) => openTab(s, `draft-${seq}`, draftItem, true)); // a fresh draft starts dirty
  }

  // "Send selection to…" from a scratch pad (D5): a pre-filled, UNSAVED draft in
  // the pad's project, title empty (R4 titles it on Save); the pad is untouched
  // (copy, not cut) and nothing is written until the destination's own Save.
  // Focus lands on the destination page's tab: the pad's panel goes `hidden`,
  // which would otherwise drop a keyboard user's focus to <body>.
  function sendSelectionToItem(kind: Kind, projectId: string, body: string) {
    openNewDraft(kind, projectId, body);
    setPage("worknotes");
    document.getElementById("tab-worknotes")?.focus();
  }
  function sendSelectionToPrompt(projectId: string, body: string) {
    setPromptSeed((s) => ({ projectId, body, n: (s?.n ?? 0) + 1 }));
    setPage("prompts");
    document.getElementById("tab-prompts")?.focus();
  }

  function openDuplicateDraft(source: Item) {
    const seq = draftSeq + 1;
    setDraftSeq(seq);
    setTabs((s) => openTab(s, `draft-${seq}`, duplicateDraft(source), true));
  }

  async function createFromDraft(draftKey: string, input: NewItem): Promise<boolean> {
    try {
      const created = await api.createItem(input);
      setSearch("");
      if (kind !== "all" && kind !== created.kind) setKind("all");
      // Same guard the kind filter gets: if the new item landed in a project the
      // rail is filtering AWAY, relax the project filter so it stays visible and
      // selectable (otherwise the just-saved item would vanish from the list).
      if (projectFilter && projectFilter !== created.projectId) setProjectFilter("");
      await refreshAll();
      // Promote the draft tab to the created item's real key so the tab stays
      // open and its rail row now activates it instead of opening a duplicate.
      setTabs((s) => promoteTab(s, draftKey, itemKey(created), created));
      return true;
    } catch (err) {
      showError(String(err));
      return false;
    }
  }

  // Close a tab, dropping its imperative-save handle. Neighbour activation and
  // empty-state handling live in the pure closeTab reducer.
  function closeTabByKey(key: string) {
    setTabs((s) => closeTab(s, key));
    editorRefs.current.delete(key);
  }

  // Close × / Delete-key on a tab. A clean tab closes immediately. A dirty tab
  // prompts first (never window.confirm — the webview suppresses it): a brand-new
  // draft offers Discard/keep; a saved item offers the three-way Cancel / Discard
  // / Save, the Save branch persisting via the tab's imperative save() handle so
  // even a background tab is saved before it closes.
  function requestCloseTab(key: string) {
    void (async () => {
      const tab = tabsRef.current.tabs.find((t) => t.key === key);
      if (!tab) return;
      if (tab.isDirty) {
        const title = itemTabTitle(tab.item);
        if (tab.item.id === "") {
          // A scratch draft has no saved version to save back to on close.
          if (!(await api.confirmDialog(`Discard this unsaved ${tab.item.kind}?`))) return;
        } else {
          // api.confirmDialog renders the dialog plugin's ask() — a two-button
          // Yes/No dialog — so the three-way choice is two chained Yes/No prompts.
          if (
            !(await api.confirmDialog(`"${title}" has unsaved changes. Close this tab?`))
          )
            return; // No → keep editing
          if (
            await api.confirmDialog(
              `Save your changes to "${title}" before closing? Yes saves and closes; No discards them.`,
            )
          ) {
            const saved = await editorRefs.current.get(key)?.save();
            if (!saved) return; // save failed → keep the tab open, edits intact
          }
        }
      }
      closeTabByKey(key);
    })();
  }

  function requestDeleteItem(key: string, item: Item) {
    void (async () => {
      if (!(await api.confirmDialog(`Delete "${item.title}"? This cannot be undone.`)))
        return;
      const ok = await mutate(() => api.deleteItem(item.id));
      // reconcileTabs (inside mutate) already closes the deleted item's tab; this
      // is the explicit, immediate close of the tab the user acted on.
      if (ok) closeTabByKey(key);
    })();
  }

  // Unload confirms first when the target owns anything open — Worknotes item
  // tabs (including background/dirty ones), an open prompt on the Prompts page,
  // OR its scratch pad on the Scratch page — since unloading silently drops
  // them; then evicts and announces.
  async function unloadProject(p: ProjectInfo) {
    const affectedItemTabs = tabs.tabs.filter((t) => t.item.projectId === p.id);
    const affectsOpenItem = affectedItemTabs.length > 0;
    const affectsOpenPrompt = openPromptProjectIds.includes(p.id);
    const affectsOpenScratch = openScratchProjectIds.includes(p.id);
    const affectsOpen = affectsOpenItem || affectsOpenPrompt || affectsOpenScratch;
    if (affectsOpen) {
      const parts: string[] = [];
      if (affectsOpenItem) {
        const n = affectedItemTabs.length;
        parts.push(`${n} open item${n === 1 ? "" : "s"}`);
      }
      if (affectsOpenPrompt) parts.push("open prompt(s)");
      if (affectsOpenScratch) parts.push("its open scratch pad");
      const dirtyN = affectedItemTabs.filter((t) => t.isDirty).length;
      const dirtyWarn = dirtyN > 0 ? ` Unsaved changes in ${dirtyN} of them will be lost.` : "";
      if (
        !(await api.confirmDialog(
          `Unloading "${p.name}" will close ${parts.join(" and ")}.${dirtyWarn} Continue?`,
        ))
      )
        return;
    }
    const ok = await mutate(() => api.unloadProject(p.id));
    if (ok) {
      if (affectsOpenItem) {
        // Close every item tab of the unloaded project (PromptsPage closes its
        // own prompt tabs when `loaded` drops the project).
        setTabs((s) => affectedItemTabs.reduce((acc, t) => closeTab(acc, t.key), s));
        affectedItemTabs.forEach((t) => editorRefs.current.delete(t.key));
      }
      showNotice(
        affectsOpen
          ? `Unloaded "${p.name}" — closed the items/prompts/scratch pad you had open.`
          : `Unloaded "${p.name}".`,
      );
    }
  }

  // Reload re-reads a project from its on-disk files (after a git pull/sync). Any
  // SAVED item of that project open in a tab may have changed underneath — saving
  // stale local edits would clobber the pulled change — so confirm, then close
  // every such tab (the user re-opens to see the fresh content). Drafts of that
  // project are left alone: they aren't on disk yet, so a reload can't stale them.
  async function reloadProject(p: ProjectInfo) {
    const affectedItemTabs = tabs.tabs.filter(
      (t) => t.item.id !== "" && t.item.projectId === p.id,
    );
    const n = affectedItemTabs.length;
    // Prompts live in the SAME per-project store, which reload tears down and
    // rebuilds — so an open prompt tab of this project would silently clobber the
    // freshly-reloaded file on a later save, exactly like an item tab. The
    // scratch pad's `scratch.md` may equally have been pulled. Confirm for all
    // three, and sweep all three.
    const affectsPrompt = openPromptProjectIds.includes(p.id);
    const affectsScratch = openScratchProjectIds.includes(p.id);
    if (
      (n > 0 || affectsPrompt || affectsScratch) &&
      !(await api.confirmDialog(
        `Reloading "${p.name}" re-reads its files from disk and will close the item(s), prompt(s) and/or scratch pad you have open in it (any unsaved edits are discarded). Continue?`,
      ))
    )
      return;
    let warnings: string[] = [];
    const ok = await mutate(async () => {
      warnings = await api.reloadProject(p.id);
    });
    if (!ok) return;
    if (n > 0) {
      setTabs((s) => affectedItemTabs.reduce((acc, t) => closeTab(acc, t.key), s));
      affectedItemTabs.forEach((t) => editorRefs.current.delete(t.key));
    }
    // Nudge PromptsPage / ScratchPage to close their own open tabs of this project.
    if (affectsPrompt || affectsScratch)
      setPromptReloadSignal((prev) => ({ projectId: p.id, n: (prev?.n ?? 0) + 1 }));
    if (n > 0 || affectsPrompt || affectsScratch) {
      showNotice(
        `Reloaded "${p.name}" — closed the item(s)/prompt(s)/scratch pad you had open so they can reload.`,
      );
    }
    if (warnings.length > 0) {
      const w = warnings.length;
      // An error (persists — names files the user must fix), not a notice.
      showError(
        `Reloaded "${p.name}", but ${w} item${w === 1 ? "" : "s"} couldn't be imported:\n` +
          warnings.join("\n"),
      );
    }
  }

  // Roving-tab-index page tablist: Left/Right walks PAGES in order (wrapping),
  // activating the neighbour and moving focus there — standard WAI-ARIA tabs.
  function onPageTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = PAGES.indexOf(page);
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const next = PAGES[(i + step + PAGES.length) % PAGES.length];
    setPage(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">worknotes</span>
        <div className="page-tabs" role="tablist" aria-label="Pages">
          <button
            id="tab-worknotes"
            role="tab"
            aria-selected={page === "worknotes"}
            aria-controls="panel-worknotes"
            tabIndex={page === "worknotes" ? 0 : -1}
            className={page === "worknotes" ? "page-tab page-tab-on" : "page-tab"}
            onClick={() => setPage("worknotes")}
            onKeyDown={onPageTabKeyDown}
          >
            Worknotes
          </button>
          <button
            id="tab-prompts"
            role="tab"
            aria-selected={page === "prompts"}
            aria-controls="panel-prompts"
            tabIndex={page === "prompts" ? 0 : -1}
            className={page === "prompts" ? "page-tab page-tab-on" : "page-tab"}
            onClick={() => setPage("prompts")}
            onKeyDown={onPageTabKeyDown}
          >
            Prompts
          </button>
          <button
            id="tab-scratch"
            role="tab"
            aria-selected={page === "scratch"}
            aria-controls="panel-scratch"
            tabIndex={page === "scratch" ? 0 : -1}
            className={page === "scratch" ? "page-tab page-tab-on" : "page-tab"}
            onClick={() => setPage("scratch")}
            onKeyDown={onPageTabKeyDown}
          >
            Scratch
          </button>
        </div>
        <span className="meta-spring" />
        <select
          className="select"
          value={palette}
          aria-label="Color palette"
          onChange={(e) => {
            // Whitelist the value before it becomes state (and then a DOM attr),
            // per §4.2 — not just the persisted-read gate. Options come only from
            // PALETTES, so this always passes; it removes the unchecked cast.
            if (isPaletteId(e.target.value)) setPalette(e.target.value);
          }}
        >
          {PALETTES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="btn btn-quiet" onClick={() => setShowProjects(true)}>
          Manage projects
        </button>
        <button className="btn btn-quiet" onClick={() => setShowSettings(true)}>
          Settings
        </button>
        <button className="btn btn-quiet" onClick={() => setShowAbout(true)}>
          About
        </button>
      </header>

      <Toasts toasts={toastList} onDismiss={dismissToast} />

      <div
        className="page-body"
        role="tabpanel"
        id="panel-worknotes"
        aria-labelledby="tab-worknotes"
        hidden={page !== "worknotes"}
      >
      <div className="panes">
        <ItemList
          items={items}
          selectedId={selectedId}
          kind={kind}
          search={search}
          tagFilter={tagFilter}
          projectFilter={projectFilter}
          statusFilter={statusFilter}
          sort={sort}
          loaded={loaded}
          activeTags={activeTags}
          onSelect={selectRow}
          onKind={setKind}
          onSearch={setSearch}
          onTagFilter={setTagFilter}
          onProjectFilter={setProjectFilter}
          onStatusFilter={setStatusFilter}
          onSort={setSort}
          onCreate={openNewDraft}
        />

        {tabs.tabs.length > 0 ? (
          <div className="editor-pane">
            <EditorTabs
              tabs={tabDescriptors}
              activeKey={tabs.activeKey}
              onActivate={(key) => setTabs((s) => activateTab(s, key))}
              onClose={requestCloseTab}
              onNew={() => openNewDraft("note")}
              listLabel="Open items"
              newLabel="Open another item"
            />
            {tabs.tabs.map((t) => {
              const isDraft = t.item.id === "";
              return (
                <Editor
                  key={t.key}
                  ref={(h) => {
                    if (h) editorRefs.current.set(t.key, h);
                    else editorRefs.current.delete(t.key);
                  }}
                  tabKey={t.key}
                  hidden={t.key !== tabs.activeKey}
                  active={page === "worknotes" && t.key === tabs.activeKey}
                  item={t.item}
                  isDraft={isDraft}
                  loaded={loaded}
                  activeTags={activeTags}
                  onDirtyChange={(dirty) => setTabs((s) => setDirty(s, t.key, dirty))}
                  onSave={(patch: UpdateItem) =>
                    mutate(() => api.updateItem(t.item.id, patch))
                  }
                  onCreate={(input) => createFromDraft(t.key, input)}
                  onTargetChange={(id) =>
                    setTabs((s) => setTabItem(s, t.key, { ...t.item, projectId: id || null }))
                  }
                  onDuplicate={() => openDuplicateDraft(t.item)}
                  onArchive={(archived) =>
                    void mutate(() => api.updateItem(t.item.id, { archived }))
                  }
                  onPin={(pinned) =>
                    void mutate(() => api.updateItem(t.item.id, { pinned }))
                  }
                  onDelete={() => requestDeleteItem(t.key, t.item)}
                  onError={showError}
                  onResolve={dismissKey}
                />
              );
            })}
          </div>
        ) : (
          <section className="editor editor-empty" tabIndex={-1} ref={emptyEditorRef}>
            <p>
              {loaded.length === 0
                ? "No projects loaded — open or create one to start."
                : "Select something on the left, or create a note to start."}
            </p>
          </section>
        )}
      </div>
      </div>

      <div
        className="page-body"
        role="tabpanel"
        id="panel-prompts"
        aria-labelledby="tab-prompts"
        hidden={page !== "prompts"}
      >
        <PromptsPage
          loaded={loaded}
          pageActive={page === "prompts"}
          reloadSignal={promptReloadSignal}
          onProjectsChanged={() => void loadMeta()}
          onError={showError}
          onResolve={dismissKey}
          onOpenPromptsChange={setOpenPromptProjectIds}
          seed={promptSeed}
        />
      </div>

      <div
        className="page-body"
        role="tabpanel"
        id="panel-scratch"
        aria-labelledby="tab-scratch"
        hidden={page !== "scratch"}
      >
        <ScratchPage
          loaded={loaded}
          pageActive={page === "scratch"}
          reloadSignal={promptReloadSignal}
          onError={showError}
          onResolve={dismissKey}
          onOpenScratchChange={setOpenScratchProjectIds}
          onSendToItem={sendSelectionToItem}
          onSendToPrompt={sendSelectionToPrompt}
        />
      </div>

      {showProjects && (
        <ManageProjectsDialog
          projects={knownProjects}
          onClose={() => setShowProjects(false)}
          onChanged={() => void refreshAll()}
          onUnload={(p) => unloadProject(p)}
          onReload={(p) => reloadProject(p)}
          onError={showError}
          onResolve={dismissKey}
        />
      )}
      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} onError={showError} />
      )}
      {showAbout && (
        <AboutDialog onClose={() => setShowAbout(false)} onError={showError} />
      )}
    </div>
  );
}
