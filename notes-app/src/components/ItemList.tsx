import type { Item, Kind, ProjectInfo, Sort, Status } from "../types";
import { formatDueDate, isOverdue } from "../lib/dueDate";
import { itemKey } from "../lib/projects";
import TagFilter from "./TagFilter";

export type KindFilter = "all" | Kind;
export type StatusFilter = "all" | Status;

interface Props {
  items: Item[];
  selectedId: string | null;
  kind: KindFilter;
  search: string;
  tagFilter: string[];
  projectFilter: string;
  statusFilter: StatusFilter;
  sort: Sort;
  loaded: ProjectInfo[];
  activeTags: string[];
  onSelect: (id: string) => void;
  onKind: (kind: KindFilter) => void;
  onSearch: (query: string) => void;
  onTagFilter: (tags: string[]) => void;
  onProjectFilter: (id: string) => void;
  onStatusFilter: (status: StatusFilter) => void;
  onSort: (sort: Sort) => void;
  onCreate: (kind: Kind) => void;
}

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "note", label: "Notes" },
  { id: "task", label: "Tasks" },
];

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "todo", label: "todo" },
  { id: "doing", label: "doing" },
  { id: "testing", label: "testing" },
  { id: "done", label: "done" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "updated", label: "Sort: updated" },
  { id: "created", label: "Sort: created" },
  { id: "priority", label: "Sort: priority" },
  { id: "status", label: "Sort: status" },
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
  kind,
  search,
  tagFilter,
  projectFilter,
  statusFilter,
  sort,
  loaded,
  activeTags,
  onSelect,
  onKind,
  onSearch,
  onTagFilter,
  onProjectFilter,
  onStatusFilter,
  onSort,
  onCreate,
}: Props) {
  const now = new Date(); // one clock read per render; overdue is a same-day check
  const canCreate = loaded.length > 0;
  // Show a per-row project label only when more than one project is loaded —
  // otherwise every row shares the same project and the label is just noise.
  const showProjectLabels = loaded.length > 1;
  const projectName = new Map(loaded.map((p) => [p.id, p.name]));
  return (
    <aside className="rail">
      <div className="rail-actions">
        <button className="btn" disabled={!canCreate} onClick={() => onCreate("note")}>
          New note
        </button>
        <button className="btn" disabled={!canCreate} onClick={() => onCreate("task")}>
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

      <TagFilter
        selected={tagFilter}
        activeTags={activeTags}
        onChange={onTagFilter}
      />

      <div className="chips" role="tablist" aria-label="Filter by kind">
        {KINDS.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={kind === f.id}
            className={kind === f.id ? "chip chip-on" : "chip"}
            onClick={() => onKind(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <select
        className="select rail-select"
        value={projectFilter}
        aria-label="Filter by project"
        onChange={(e) => onProjectFilter(e.target.value)}
      >
        <option value="">All projects</option>
        {loaded.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="rail-select-pair">
        <select
          className="select"
          value={statusFilter}
          aria-label="Filter by status"
          onChange={(e) => onStatusFilter(e.target.value as StatusFilter)}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={sort}
          aria-label="Sort order"
          onChange={(e) => onSort(e.target.value as Sort)}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <ul className="list">
        {items.length === 0 && (
          <li className="list-empty">
            {!canCreate
              ? "No projects loaded — open or create one to start."
              : search
                ? "No matches. Try fewer words."
                : "Nothing here yet — create your first note."}
          </li>
        )}
        {items.map((item) => {
          const released = item.kind === "task" && item.status === "done";
          // A finished task is never late; only tasks carry a due date.
          const overdue = !released && isOverdue(item.dueAt, now);
          const project =
            showProjectLabels && item.projectId
              ? projectName.get(item.projectId)
              : undefined;
          return (
            <li key={itemKey(item)}>
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
                  {item.kind === "task" && item.dueAt && (
                    <span className={overdue ? "row-due row-due-over" : "row-due"}>
                      due {formatDueDate(item.dueAt)}
                      {overdue && " · overdue"}
                    </span>
                  )}
                  <span className="row-when">{when(item.updatedAt)}</span>
                </span>
                {item.body && <span className="row-body">{item.body}</span>}
                {item.tags.length > 0 && (
                  <span
                    className={released ? "row-tags row-tags-released" : "row-tags"}
                  >
                    {item.tags.map((t) => `#${t}`).join(" ")}
                  </span>
                )}
                {project && <span className="row-project">{project}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
