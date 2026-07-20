import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
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
import { loadedProjects, nextToken, resolveCreateTarget, shouldCommit } from "./lib/projects";
import { duplicateDraft, newDraft } from "./lib/draft";
import ItemList, { KindFilter, StatusFilter } from "./components/ItemList";
import Editor from "./components/Editor";
import SettingsDialog from "./components/SettingsDialog";
import ManageProjectsDialog from "./components/ManageProjectsDialog";
import PromptsPage from "./components/PromptsPage";
import Toasts from "./components/Toasts";
import { useToasts } from "./hooks/useToasts";

type Page = "worknotes" | "prompts";

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // A local-only draft item (D1). While set, it is what the editor edits.
  const [draft, setDraft] = useState<Item | null>(null);
  const [draftSeq, setDraftSeq] = useState(0); // per-draft remount key (D1b)

  const [showSettings, setShowSettings] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
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
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light",
  );

  // Router-free page toggle (Worknotes / Prompts). Both pages stay mounted
  // (the inactive one is hidden, not unmounted — see the `hidden` wrappers
  // below), so switching never discards an in-progress edit on either page.
  const [page, setPage] = useState<Page>("worknotes");

  // Monotonic request token: a slow listItems that resolves after a newer load
  // (or after an unload closed a store) must not repopulate the list. Only the
  // latest token commits — the exact race the single-DB app never had.
  const loadToken = useRef(0);

  // Neutrals swap via [data-theme] on <html>; light uses the :root defaults.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

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

  // selected resolves to the draft first (D1c); a clicked rail row clears it.
  const selected = draft ?? items.find((i) => i.id === selectedId) ?? null;

  async function refreshAll() {
    await Promise.all([loadItems(), loadMeta()]);
  }

  // Returns whether the action succeeded so callers (Editor.save) only clear
  // their dirty state on a real persist — a rejected save must stay "Save".
  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await refreshAll();
      return true;
    } catch (err) {
      showError(String(err));
      return false;
    }
  }

  function openNewDraft(kind: Kind) {
    // Target the rail's project when it names a loaded project; otherwise ""
    // (All projects), so the editor requires an explicit target before Save.
    setDraft(newDraft(kind, resolveCreateTarget(projectFilter, loaded)));
    setDraftSeq((s) => s + 1);
    setSelectedId(null);
  }

  function openDuplicateDraft(source: Item) {
    setDraft(duplicateDraft(source));
    setDraftSeq((s) => s + 1);
    setSelectedId(null);
  }

  function selectRow(id: string) {
    setDraft(null); // a rail click always exits the draft (D1c)
    setSelectedId(id);
  }

  async function createFromDraft(input: NewItem): Promise<boolean> {
    try {
      const created = await api.createItem(input);
      setDraft(null);
      setSearch("");
      if (kind !== "all" && kind !== created.kind) setKind("all");
      // Same guard the kind filter gets: if the new item landed in a project the
      // rail is filtering AWAY, relax the project filter so it stays visible and
      // selectable (otherwise the just-saved item would vanish from the list).
      if (projectFilter && projectFilter !== created.projectId) setProjectFilter("");
      await refreshAll();
      setSelectedId(created.id);
      return true;
    } catch (err) {
      showError(String(err));
      return false;
    }
  }

  // Unload confirms first when the open item (or draft) belongs to the target —
  // unloading would silently drop it — then evicts it with an SR announcement.
  async function unloadProject(p: ProjectInfo) {
    const affectsOpen = selected != null && selected.projectId === p.id;
    if (
      affectsOpen &&
      !(await api.confirmDialog(
        `Unloading "${p.name}" will close the item you have open. Continue?`,
      ))
    )
      return;
    const ok = await mutate(() => api.unloadProject(p.id));
    if (ok) {
      if (affectsOpen) {
        setDraft(null);
        setSelectedId(null);
        showNotice(`Unloaded "${p.name}" — the open item was closed.`);
      } else {
        // Confirm every unload, not only the one that closed an open item —
        // a later unload with nothing open gave no feedback at all otherwise.
        showNotice(`Unloaded "${p.name}".`);
      }
    }
  }

  // Reload re-reads a project from its on-disk files (after a git pull/sync).
  // If an EXISTING item from that project is open in the editor, its file may
  // have changed underneath — saving stale local edits would silently clobber
  // the pulled change — so confirm first, then evict it (the user re-opens to
  // see the fresh content). A new unsaved draft is left alone: it isn't on disk
  // yet, so a reload can't stale it and it can still be saved. Any file that
  // couldn't be imported (e.g. unresolved conflict markers) is reported.
  async function reloadProject(p: ProjectInfo) {
    const affectsOpenItem =
      draft == null && selected != null && selected.projectId === p.id;
    if (
      affectsOpenItem &&
      !(await api.confirmDialog(
        `Reloading "${p.name}" re-reads its files from disk and will close the item you have open (any unsaved edits are discarded). Continue?`,
      ))
    )
      return;
    let warnings: string[] = [];
    const ok = await mutate(async () => {
      warnings = await api.reloadProject(p.id);
    });
    if (!ok) return;
    if (affectsOpenItem) {
      setSelectedId(null);
      showNotice(`Reloaded "${p.name}" — the open item was closed so it can reload.`);
    }
    if (warnings.length > 0) {
      const n = warnings.length;
      // An error (persists — names files the user must fix), not a notice.
      showError(
        `Reloaded "${p.name}", but ${n} item${n === 1 ? "" : "s"} couldn't be imported:\n` +
          warnings.join("\n"),
      );
    }
  }

  // Roving-tab-index page tablist: Left/Right moves to (and activates) the
  // other tab and moves focus there, matching standard WAI-ARIA tab behavior.
  function onPageTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Page = page === "worknotes" ? "prompts" : "worknotes";
    setPage(next);
    document
      .getElementById(next === "worknotes" ? "tab-worknotes" : "tab-prompts")
      ?.focus();
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
        </div>
        <span className="meta-spring" />
        <button
          className="btn btn-quiet"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <button className="btn btn-quiet" onClick={() => setShowProjects(true)}>
          Manage projects
        </button>
        <button className="btn btn-quiet" onClick={() => setShowSettings(true)}>
          Settings
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
          selectedId={draft ? null : selectedId}
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

        {selected ? (
          <Editor
            key={draft ? `draft-${draftSeq}` : selected.id}
            item={selected}
            isDraft={draft !== null}
            loaded={loaded}
            activeTags={activeTags}
            onSave={(patch: UpdateItem) =>
              mutate(() => api.updateItem(selected.id, patch))
            }
            onCreate={(input) => createFromDraft(input)}
            onTargetChange={(id) =>
              setDraft((d) => (d ? { ...d, projectId: id || null } : d))
            }
            onDuplicate={() => openDuplicateDraft(selected)}
            onArchive={(archived) =>
              void mutate(() => api.updateItem(selected.id, { archived }))
            }
            onPin={(pinned) =>
              void mutate(() => api.updateItem(selected.id, { pinned }))
            }
            onDelete={() => {
              void (async () => {
                if (
                  !(await api.confirmDialog(
                    `Delete "${selected.title}"? This cannot be undone.`,
                  ))
                )
                  return;
                await mutate(async () => {
                  await api.deleteItem(selected.id);
                  setSelectedId(null);
                });
              })();
            }}
            onError={showError}
            onResolve={dismissKey}
          />
        ) : (
          <section className="editor editor-empty">
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
          onProjectsChanged={() => void loadMeta()}
          onError={showError}
          onResolve={dismissKey}
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
    </div>
  );
}
