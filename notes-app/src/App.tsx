import { useCallback, useEffect, useState } from "react";
import type {
  Item,
  Kind,
  ListFilter,
  NewItem,
  ProjectWithCount,
  Sort,
  UpdateItem,
} from "./types";
import * as api from "./lib/api";
import { recomputeTagFilter } from "./lib/tags";
import { duplicateDraft, newDraft } from "./lib/draft";
import ItemList, { KindFilter, StatusFilter } from "./components/ItemList";
import Editor from "./components/Editor";
import SettingsDialog from "./components/SettingsDialog";
import ManageProjectsDialog from "./components/ManageProjectsDialog";

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

  // Single source of truth for the project list and derived tag vocabulary.
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  // A local-only draft item (D1). While set, it is what the editor edits.
  const [draft, setDraft] = useState<Item | null>(null);
  const [draftSeq, setDraftSeq] = useState(0); // per-draft remount key (D1b)

  const [showSettings, setShowSettings] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light",
  );

  // Neutrals swap via [data-theme] on <html>; light uses the :root defaults.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  // One ListFilter for both the list and search paths. projectFilter "" means
  // "no filter" and is OMITTED (D7) — the opposite of UpdateItem.projectId "".
  const loadItems = useCallback(async () => {
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
      setItems(result);
    } catch (err) {
      setError(String(err));
    }
  }, [kind, projectFilter, statusFilter, tagFilter, sort, search]);

  const loadMeta = useCallback(async () => {
    try {
      const [nextProjects, nextTags] = await Promise.all([
        api.listProjects(),
        api.listActiveTags(),
      ]);
      setProjects(nextProjects);
      setActiveTags(nextTags);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Debounce search only; discrete filter changes fire immediately (0 ms).
  useEffect(() => {
    const t = setTimeout(() => void loadItems(), search.trim() ? 200 : 0);
    return () => clearTimeout(t);
  }, [loadItems, search]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Tag lifecycle: when the vocabulary shrinks (a tag's last active reference
  // finished or was archived), drop any selected filter badge for it. Guarded
  // so it only re-renders when the set actually shrank — and because tagFilter
  // drives loadItems(), pruning re-fires the query with the corrected filter.
  useEffect(() => {
    setTagFilter((tf) => {
      const next = recomputeTagFilter(tf, activeTags);
      return next.length === tf.length ? tf : next;
    });
  }, [activeTags]);

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
      setError(String(err));
      return false;
    }
  }

  function openNewDraft(kind: Kind) {
    setDraft(newDraft(kind));
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
      await refreshAll();
      setSelectedId(created.id);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">worknotes</span>
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

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button className="btn btn-quiet" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

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
          projects={projects}
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
            projects={projects}
            activeTags={activeTags}
            onSave={(patch: UpdateItem) =>
              mutate(() => api.updateItem(selected.id, patch))
            }
            onCreate={(input) => createFromDraft(input)}
            onDuplicate={() => openDuplicateDraft(selected)}
            onArchive={(archived) =>
              void mutate(() => api.updateItem(selected.id, { archived }))
            }
            onPin={(pinned) =>
              void mutate(() => api.updateItem(selected.id, { pinned }))
            }
            onDelete={() => {
              if (
                !window.confirm(
                  `Delete "${selected.title}"? This cannot be undone.`,
                )
              )
                return;
              void mutate(async () => {
                await api.deleteItem(selected.id);
                setSelectedId(null);
              });
            }}
            onError={setError}
          />
        ) : (
          <section className="editor editor-empty">
            <p>Select something on the left, or create a note to start.</p>
          </section>
        )}
      </div>

      {showProjects && (
        <ManageProjectsDialog
          onClose={() => setShowProjects(false)}
          onChanged={() => void refreshAll()}
          onError={setError}
        />
      )}
      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} onError={setError} />
      )}
    </div>
  );
}
