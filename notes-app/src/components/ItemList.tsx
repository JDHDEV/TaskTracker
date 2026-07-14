import type { Item, Kind } from "../types";

export type KindFilter = "all" | Kind;

interface Props {
  items: Item[];
  selectedId: string | null;
  filter: KindFilter;
  search: string;
  onSelect: (id: string) => void;
  onFilter: (filter: KindFilter) => void;
  onSearch: (query: string) => void;
  onCreate: (kind: Kind) => void;
}

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "note", label: "Notes" },
  { id: "task", label: "Tasks" },
];

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ItemList({
  items,
  selectedId,
  filter,
  search,
  onSelect,
  onFilter,
  onSearch,
  onCreate,
}: Props) {
  return (
    <aside className="rail">
      <div className="rail-actions">
        <button className="btn" onClick={() => onCreate("note")}>
          New note
        </button>
        <button className="btn" onClick={() => onCreate("task")}>
          New task
        </button>
      </div>

      <input
        className="search"
        type="search"
        placeholder="Search title and body"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />

      <div className="chips" role="tablist" aria-label="Filter by kind">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? "chip chip-on" : "chip"}
            onClick={() => onFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="list">
        {items.length === 0 && (
          <li className="list-empty">
            {search
              ? "No matches. Try fewer words."
              : "Nothing here yet — create your first note."}
          </li>
        )}
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={item.id === selectedId ? "row row-on" : "row"}
              onClick={() => onSelect(item.id)}
            >
              <span className="row-top">
                {item.pinned && <span className="pin" title="Pinned" />}
                {item.kind === "task" && (
                  <span
                    className={`dot dot-${item.status ?? "todo"}`}
                    title={item.status ?? "todo"}
                  />
                )}
                <span className="row-title">{item.title}</span>
                {item.kind === "task" &&
                  item.priority &&
                  item.priority !== "normal" && (
                    <span className={`prio prio-${item.priority}`}>
                      {item.priority}
                    </span>
                  )}
                <span className="row-when">{when(item.updatedAt)}</span>
              </span>
              {item.body && <span className="row-body">{item.body}</span>}
              {item.tags.length > 0 && (
                <span className="row-tags">
                  {item.tags.map((t) => `#${t}`).join(" ")}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
