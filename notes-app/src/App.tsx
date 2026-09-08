import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  Draft,
  Item,
  Kind,
  ListFilter,
  NewItem,
  ProjectInfo,
  Sort,
  UpdateItem,
} from "./types";
import * as api from "./lib/api";
import { missingKeyToastKey } from "./lib/aiErrors";
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
  classifyRestore,
  draftIdFromTabKey,
  draftTabKey,
  flushAllDrafts,
  sanitizeDraft,
} from "./lib/drafts";
import { readSession, tabKeyId, writeSession } from "./lib/session";
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
import DraftConflictBar from "./components/DraftConflictBar";
import Editor, { type EditorHandle } from "./components/Editor";
import EditorTabs, { type EditorTabDescriptor } from "./components/EditorTabs";
import SettingsDialog from "./components/SettingsDialog";
import ManageProjectsDialog from "./components/ManageProjectsDialog";
import AboutDialog from "./components/AboutDialog";
import PromptsPage from "./components/PromptsPage";
import ScratchPage from "./components/ScratchPage";
import Toasts from "./components/Toasts";
import { useToasts } from "./hooks/useToasts";
import { useContextMenuSurface } from "./hooks/useContextMenuSurface";

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
  // Drafts get a synthetic `draft-<uuid>` key (real items key on itemKey()); on
  // save the draft key is promoted to the created item's key so the tab stays
  // open and re-clicking its row activates it instead of duplicating it.
  const [tabs, setTabs] = useState<OpenTabsState<Item>>(emptyTabs);
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

  // F4 (D10) — session restore. The stored blob is read ONCE, synchronously,
  // at mount (lazy initializer); restore itself waits for the first successful
  // loadMeta so tab keys / project ids can be validated against what is
  // actually loaded (the stale-projectFilter and tag-prune effects only fire
  // on CHANGES, so a stale restore before that data exists would stick).
  // `sessionRestored` gates the debounced writers below, so the initial empty
  // state can never clobber the stored session before restore has run.
  const [initialSession] = useState(readSession);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const restoredRef = useRef(false); // StrictMode double-invoke guard
  const [sessionRestored, setSessionRestored] = useState(false);

  // Plan.15 boot restore (D5). `restoredDraftsRef` maps tab key → the draft
  // snapshot its editor consumes ONCE at mount (a ref: it must never re-render
  // App, and a mount is the only consumer); `supersededRef` maps an orphan's
  // fresh tab key → the dead item's old draft file id (deleted only after the
  // first successful flush under the new id — step 13). `conflicts` is state:
  // the two-button bar renders from it (D4).
  const restoredDraftsRef = useRef(new Map<string, Draft>());
  const supersededRef = useRef(new Map<string, string>());
  const [conflicts, setConflicts] = useState<Map<string, Draft>>(new Map());

  // Drop restore bookkeeping for tabs that are no longer open, whatever path
  // closed them — a re-opened tab must never re-seed from a stale snapshot,
  // and a closed conflict tab keeps its draft FILE (closing is not choosing)
  // but loses its bar until the next boot re-offers it.
  useEffect(() => {
    for (const key of Array.from(restoredDraftsRef.current.keys()))
      if (!hasTab(tabs, key)) restoredDraftsRef.current.delete(key);
    for (const key of Array.from(supersededRef.current.keys()))
      if (!hasTab(tabs, key)) supersededRef.current.delete(key);
    setConflicts((m) => {
      if (![...m.keys()].some((key) => !hasTab(tabs, key))) return m;
      const next = new Map(m);
      for (const key of Array.from(next.keys())) if (!hasTab(tabs, key)) next.delete(key);
      return next;
    });
  }, [tabs]);

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

  // One-shot "send to prompt" seed: PromptsPage opens a dirty draft tab
  // pre-filled with `body` in `projectId`. Plan 13's send-selection passes no
  // `title`; Plan 14's "Create prompt from note" (F7) passes the note's title.
  // `n` makes each send a fresh object so the consuming effect re-fires even
  // for identical text.
  const [promptSeed, setPromptSeed] =
    useState<{ projectId: string; body: string; title?: string; n: number } | null>(null);

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
      setMetaLoaded(true); // F4: session restore is gated on the FIRST success
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

  // Plan.15 Phase 6 (R6): Rust intercepts the window close, emits
  // `flush-drafts`, and waits for our ack (or its ~1.5 s timeout). Flush every
  // registered dirty editor — item, prompt, AND scratch, via the module-level
  // registry their shared hook maintains — through flushDraft (NEVER save():
  // that would write items/<uuid>.md on every close and can fire an AI call),
  // then ack. StrictMode's dev double-subscribe is harmless: the second flush
  // is a serialized no-op and the second destroy is ignored.
  useEffect(() => {
    return api.onFlushDrafts(async () => {
      await flushAllDrafts();
      void api.ackClose().catch(() => {});
    });
  }, []);

  // Plan.16 D4: publish which kind of field has focus (body textarea / scratch
  // pad / none) so Rust can append the right items to the native context menu.
  useContextMenuSurface();

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

  // F4 restore, once, after the first successful loadMeta. Filters and page
  // restore synchronously (validated against the now-known projects/tags);
  // item tabs are fetched by id in persisted order, misses dropped silently
  // (the reconcileTabs rule), then the persisted active tab re-activates —
  // openTab's own activation of the last-opened tab is the neighbor fallback.
  // Restored session tabs open CLEAN (openTab seeds isDirty false), so the D2
  // frame never lights on boot — with plan.15's one narrow, deliberate
  // exception: a tab carrying RECOVERED UNSAVED EDITS opens dirty (D3, restore
  // is visible), unioned in from the on-disk draft backups below whether or
  // not the session remembered its tab (the Notepad++ guarantee).
  useEffect(() => {
    if (!metaLoaded || restoredRef.current) return;
    restoredRef.current = true;
    const s = initialSession;
    if (s) {
      setPage(s.page);
      setKind(s.worknotes.filters.kind);
      setStatusFilter(s.worknotes.filters.statusFilter);
      setSort(s.worknotes.filters.sort);
      setTagFilter(s.worknotes.filters.tags.filter((t) => activeTags.includes(t)));
      const pf = s.worknotes.filters.projectFilter;
      if (pf && knownProjects.some((p) => p.id === pf && p.loaded)) setProjectFilter(pf);
    }
    void (async () => {
      const sessionItems = await Promise.all(
        (s?.worknotes.tabKeys ?? []).map((key) => {
          const id = tabKeyId(key);
          return id
            ? api.getItem(id).then(
                (item): Item | null => item,
                (): Item | null => null,
              )
            : Promise.resolve<Item | null>(null);
        }),
      );

      // Plan.15 step 13: the draft-backup union. Whitelist-validated records
      // only (sanitizeDraft — session.ts discipline); each classified per the
      // D5 matrix AFTER its item is fetched, so the decision lands on the
      // correct base. Fetch/list failures degrade to "no drafts restored" —
      // never a boot failure.
      const drafts = await api.listDrafts().then(
        (list) => list.map(sanitizeDraft).filter((d): d is Draft => d !== null),
        (): Draft[] => [],
      );
      const outcomes = await Promise.all(
        drafts
          .filter((d) => d.surface === "item")
          .map(async (d) => {
            const projectLoaded =
              !d.projectId || knownProjects.some((p) => p.id === d.projectId && p.loaded);
            const item =
              d.entityId && projectLoaded
                ? await api.getItem(d.entityId).then(
                    (it): Item | null => it,
                    (): Item | null => null,
                  )
                : null;
            return { draft: d, item, outcome: classifyRestore(d, item, projectLoaded) };
          }),
      );

      // Decide everything BEFORE touching state, so the setTabs updater stays
      // pure (StrictMode re-invokes updaters; side effects in one would fire
      // twice). `dirty: true` entries are recovered buffers (D3).
      const toOpen: Array<{ key: string; item: Item; dirty: boolean }> = [];
      const newConflicts = new Map<string, Draft>();
      let restoredCount = 0;
      let orphanCount = 0;
      for (const { draft, item, outcome } of outcomes) {
        switch (outcome) {
          case "skip":
            break; // unloaded project: keep the file, restore nothing (D5)
          case "clean":
            // Buffer == saved content: self-heal the leftover file (a crash
            // between save and draft-delete, or type-then-revert).
            void api.deleteDraft(draft.draftId).catch(() => {});
            break;
          case "restore": {
            if (item) {
              const key = itemKey(item);
              restoredDraftsRef.current.set(key, draft);
              toOpen.push({ key, item, dirty: true });
            } else {
              // Never-saved draft: reopen under its persistent draft-<uuid>
              // key with an EMPTY template as base (the buffer seeds from the
              // snapshot; base stays empty so the backup keeps maintaining
              // itself until a real save).
              const key = draftTabKey(draft.draftId);
              restoredDraftsRef.current.set(key, draft);
              toOpen.push({ key, item: newDraft(draft.kind ?? "note", draft.projectId), dirty: true });
            }
            restoredCount += 1;
            break;
          }
          case "conflict": {
            if (!item) break; // defensive: conflict implies a live item
            // D4: open CLEAN on disk content, keep the draft file, offer the
            // two-button bar. Never auto-restore over changed content.
            const key = itemKey(item);
            newConflicts.set(key, draft);
            toOpen.push({ key, item, dirty: false });
            break;
          }
          case "orphan": {
            // The owning item is gone: reopen the content as a NEW draft tab
            // (D5 — resurrecting typed text beats silently discarding it; the
            // notice below keeps it honest). The dead item's draft file is
            // kept until the new tab's first successful flush under its
            // freshly minted id, then deleted (step 13).
            const freshId = crypto.randomUUID();
            const key = draftTabKey(freshId);
            restoredDraftsRef.current.set(key, {
              ...draft,
              draftId: freshId,
              entityId: "",
              baseUpdatedAt: "",
            });
            supersededRef.current.set(key, draft.draftId);
            toOpen.push({ key, item: newDraft(draft.kind ?? "note", draft.projectId), dirty: true });
            orphanCount += 1;
            break;
          }
        }
      }

      setTabs((prev) => {
        let next = prev;
        for (const item of sessionItems) {
          if (item) next = openTab(next, itemKey(item), item);
        }
        for (const entry of toOpen) {
          next = openTab(next, entry.key, entry.item, entry.dirty);
          // openTab on an already-open key (a session tab that also carries a
          // draft) is activation-only — set the recovered-dirty flag explicitly.
          if (entry.dirty) next = setDirty(next, entry.key, true);
        }
        const ak = s?.worknotes.activeKey;
        if (ak && hasTab(next, ak)) next = activateTab(next, ak);
        return next;
      });
      if (newConflicts.size > 0) {
        setConflicts(newConflicts);
        // D3 applies to conflicts too (post-review): a bar on a background tab
        // is invisible until that tab is visited — announce it.
        showNotice(
          `${newConflicts.size} item${newConflicts.size === 1 ? "" : "s"} changed on disk since your unsaved edits — open the tab to choose.`,
          { key: "draft-conflicts" },
        );
      }
      if (restoredCount > 0) {
        // D3: restore is visible, never silent.
        showNotice(
          `Restored unsaved edits to ${restoredCount} item${restoredCount === 1 ? "" : "s"}.`,
          { key: "draft-restore" },
        );
      }
      if (orphanCount > 0) {
        showNotice(
          `${orphanCount} recovered draft${orphanCount === 1 ? " belongs" : "s belong"} to an item that no longer exists — reopened as a new draft.`,
          { key: "draft-orphans" },
        );
      }
      setSessionRestored(true);
    })();
  }, [metaLoaded, initialSession, knownProjects, activeTags, showNotice]);

  // F4 persistence: the page + worknotes slice, debounced ~300 ms. Identifiers
  // only (S-4) — draft tabs (id "") and the search text are never written. Tab
  // state is already keystroke-decoupled (dirty fires on transitions only), so
  // this adds no per-keystroke work.
  const itemTabKeys = useMemo(
    () => tabs.tabs.filter((t) => t.item.id !== "").map((t) => t.key),
    [tabs],
  );
  const activeItemTabKey = useMemo(() => {
    const a = activeTab(tabs);
    return a && a.item.id !== "" ? a.key : null;
  }, [tabs]);
  useEffect(() => {
    if (!sessionRestored) return;
    const t = window.setTimeout(() => {
      writeSession({
        page,
        worknotes: {
          tabKeys: itemTabKeys,
          activeKey: activeItemTabKey,
          filters: { kind, statusFilter, sort, projectFilter, tags: tagFilter },
        },
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [
    sessionRestored,
    page,
    itemTabKeys,
    activeItemTabKey,
    kind,
    statusFilter,
    sort,
    projectFilter,
    tagFilter,
  ]);

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
  // Keys are `draft-<uuid>` (plan.15 D8): the bare UUID inside the key is the
  // draft's persistent on-disk draftId, so a key survives a restart without
  // colliding (the old per-boot `draft-<seq>` counter reset every launch, and
  // openTab treats an existing key as activation — a collision would silently
  // drop a restored buffer).
  function openNewDraft(kind: Kind, target?: string, body = "") {
    // Target the rail's project when it names a loaded project; otherwise ""
    // (All projects), so the editor requires an explicit target before Save.
    const draftItem = newDraft(kind, target ?? resolveCreateTarget(projectFilter, loaded), body);
    setTabs((s) => openTab(s, `draft-${crypto.randomUUID()}`, draftItem, true)); // a fresh draft starts dirty
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

  // "Create prompt from note" (F7, D8): seed a dirty, UNSAVED prompt draft on
  // the Prompts page with the note's on-screen title+body. Copy, not move — the
  // note is never mutated or deleted, and nothing is written until the prompt
  // draft's own explicit Save.
  function sendNoteToPrompt(projectId: string, title: string, body: string) {
    setPromptSeed((s) => ({ projectId, body, title, n: (s?.n ?? 0) + 1 }));
    setPage("prompts");
    document.getElementById("tab-prompts")?.focus();
  }

  // Convert a saved note into a task (F7, D8): one-way, confirmed. The tab key
  // (projectId:id) is unchanged, so reconcileTabs (inside mutate) refreshes the
  // same tab in place and it re-renders as a task.
  function requestConvertToTask(item: Item) {
    void (async () => {
      if (
        !(await api.confirmDialog(
          `Convert "${item.title}" to a task? It gets status todo and normal priority; this cannot be converted back.`,
        ))
      )
        return;
      await mutate(() => api.convertNoteToTask(item.id));
    })();
  }

  function openDuplicateDraft(source: Item) {
    setTabs((s) => openTab(s, `draft-${crypto.randomUUID()}`, duplicateDraft(source), true));
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

  // Conflict-bar resolutions (plan.15 D4). "Keep saved version" deletes the
  // kept draft file and dismisses the bar; "Restore unsaved edits" seeds the
  // mounted editor through its applyDraft handle (the only way content enters
  // an already-mounted clean editor) and keeps the file until save/discard.
  function resolveConflictKeep(key: string, draft: Draft) {
    void api.deleteDraft(draft.draftId).catch(() => {});
    setConflicts((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }
  function resolveConflictRestore(key: string, draft: Draft) {
    editorRefs.current.get(key)?.applyDraft(draft);
    setConflicts((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
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
          // Plan.15 §4.3: an explicit Discard clears the on-disk backup too —
          // via the editor's handle, which seals its queue first so a straggler
          // snapshot can never land after this delete and resurrect the draft.
          await editorRefs.current.get(key)?.discardDraft();
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
            // (a successful save cleared the draft backup itself)
          } else {
            // The Discard branch of the three-way choice (plan.15 §4.3).
            await editorRefs.current.get(key)?.discardDraft();
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
      if (ok) {
        // Plan.15 §4.3: "delete means gone" — the draft can hold MORE than the
        // last saved version, so it goes with the item. Through the handle
        // (queue sealed first) when the editor is still mounted; directly by
        // id when reconcileTabs already unmounted it.
        const handle = editorRefs.current.get(key);
        if (handle) await handle.discardDraft();
        else await api.deleteDraft(item.id).catch(() => {});
        closeTabByKey(key);
      }
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
    // Plan.15 step 12: sweep the project's draft backups BEFORE the unload
    // (the command requires a loaded project) and UNCONDITIONALLY — not gated
    // on affectsOpen: drafts can exist on disk for a project with no open tab
    // (an earlier crash, never reopened this session), and the confirm above
    // promised "unsaved changes will be lost". Best-effort: a failed sweep
    // must not block the unload (leftover drafts for an unloaded project are
    // the kept-on-disk case D5 already defines, bounded by TTL/cap).
    await api.sweepProjectDrafts(p.id).catch(() => {});
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
    // Plan.15 step 12: unconditional draft sweep before the reload, mirroring
    // unloadProject — a reload's fresh disk state makes every existing draft
    // of this project stale. (An open never-saved draft tab survives a reload
    // and simply re-flushes its live buffer on the next tick — correct: its
    // content exists nowhere on disk but in the backup.)
    await api.sweepProjectDrafts(p.id).catch(() => {});
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
              // The on-disk draft-backup id (plan.15 D8): the item's UUID for
              // a saved item, the bare UUID inside a `draft-<uuid>` key for a
              // new draft. "" disables backup (an unexpected key shape).
              const draftId = isDraft ? (draftIdFromTabKey(t.key) ?? "") : t.item.id;
              const conflict = conflicts.get(t.key);
              return (
                <Fragment key={t.key}>
                {conflict && (
                  <DraftConflictBar
                    title={itemTabTitle(t.item)}
                    hidden={t.key !== tabs.activeKey}
                    onKeep={() => resolveConflictKeep(t.key, conflict)}
                    onRestore={() => resolveConflictRestore(t.key, conflict)}
                  />
                )}
                <Editor
                  ref={(h) => {
                    if (h) editorRefs.current.set(t.key, h);
                    else editorRefs.current.delete(t.key);
                  }}
                  tabKey={t.key}
                  draftId={draftId}
                  restoredDraft={restoredDraftsRef.current.get(t.key) ?? null}
                  supersedesDraftId={supersededRef.current.get(t.key) ?? null}
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
                  onStatusChange={(status) =>
                    mutate(() => api.updateItem(t.item.id, { status }))
                  }
                  onCreate={(input) => createFromDraft(t.key, input)}
                  onTargetChange={(id) =>
                    setTabs((s) => setTabItem(s, t.key, { ...t.item, projectId: id || null }))
                  }
                  onDuplicate={() => openDuplicateDraft(t.item)}
                  onConvertToTask={() => requestConvertToTask(t.item)}
                  onCreatePromptFromNote={(title, body) =>
                    t.item.projectId && sendNoteToPrompt(t.item.projectId, title, body)
                  }
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
                </Fragment>
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
          onNotice={showNotice}
          onResolve={dismissKey}
          onOpenPromptsChange={setOpenPromptProjectIds}
          seed={promptSeed}
          session={initialSession?.prompts ?? null}
          sessionReady={metaLoaded}
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
          onNotice={showNotice}
          onResolve={dismissKey}
          onOpenScratchChange={setOpenScratchProjectIds}
          onSendToItem={sendSelectionToItem}
          onSendToPrompt={sendSelectionToPrompt}
          session={initialSession?.scratch ?? null}
          sessionReady={metaLoaded}
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
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onError={showError}
          onKeySaved={(p) => dismissKey(missingKeyToastKey(p))}
        />
      )}
      {showAbout && (
        <AboutDialog onClose={() => setShowAbout(false)} onError={showError} />
      )}
    </div>
  );
}
