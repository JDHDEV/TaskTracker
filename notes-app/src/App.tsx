import { useCallback, useEffect, useMemo, useState } from "react";
import type { Item, Kind } from "./types";
import * as api from "./lib/api";
import ItemList, { KindFilter } from "./components/ItemList";
import Editor from "./components/Editor";
import SettingsDialog from "./components/SettingsDialog";

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light",
  );

  // Neutrals swap via [data-theme] on <html>; light uses the :root defaults.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const result = search.trim()
        ? await api.searchItems(search)
        : await api.listItems(filter === "all" ? {} : { kind: filter });
      // Search runs over everything; the kind filter still applies to it.
      setItems(
        filter === "all" ? result : result.filter((i) => i.kind === filter),
      );
    } catch (err) {
      setError(String(err));
    }
  }, [search, filter]);

  // Debounce so search doesn't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => void refresh(), search.trim() ? 200 : 0);
    return () => clearTimeout(t);
  }, [refresh, search]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  async function create(kind: Kind) {
    try {
      const item = await api.createItem({
        kind,
        title: kind === "note" ? "Untitled note" : "New task",
      });
      setSearch("");
      if (filter !== "all" && filter !== kind) setFilter("all");
      await refresh();
      setSelectedId(item.id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(String(err));
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
        <button className="btn btn-quiet" onClick={() => setShowSettings(true)}>
          API keys
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
          selectedId={selectedId}
          filter={filter}
          search={search}
          onSelect={setSelectedId}
          onFilter={setFilter}
          onSearch={setSearch}
          onCreate={(kind) => void create(kind)}
        />

        {selected ? (
          <Editor
            key={selected.id}
            item={selected}
            onSave={(patch) => mutate(() => api.updateItem(selected.id, patch))}
            onArchive={(archived) =>
              void mutate(() => api.updateItem(selected.id, { archived }))
            }
            onPin={(pinned) =>
              void mutate(() => api.updateItem(selected.id, { pinned }))
            }
            onDelete={() => {
              if (!window.confirm(`Delete "${selected.title}"? This cannot be undone.`)) return;
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

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} onError={setError} />
      )}
    </div>
  );
}
