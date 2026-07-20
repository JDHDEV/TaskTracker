import type { ProjectInfo, Prompt } from "../types";
import { displayTitle, formatWhen } from "../lib/prompts";

interface Props {
  prompts: Prompt[];
  selectedId: string | null;
  loaded: ProjectInfo[];
  projectId: string;
  reusableOnly: boolean;
  onSelect: (id: string) => void;
  onProjectChange: (id: string) => void;
  onReusableOnly: (on: boolean) => void;
  onCreate: () => void;
}

const FILTERS: { id: boolean; label: string }[] = [
  { id: false, label: "All" },
  { id: true, label: "Reusable only" },
];

export default function PromptList({
  prompts,
  selectedId,
  loaded,
  projectId,
  reusableOnly,
  onSelect,
  onProjectChange,
  onReusableOnly,
  onCreate,
}: Props) {
  const now = new Date(); // one clock read per render, like ItemList
  const canCreate = projectId !== "";
  return (
    <aside className="rail">
      <div className="rail-actions">
        <button className="btn" disabled={!canCreate} onClick={onCreate}>
          New prompt
        </button>
      </div>

      <select
        className="select rail-select"
        value={projectId}
        aria-label="Choose project"
        onChange={(e) => onProjectChange(e.target.value)}
      >
        {loaded.length === 0 && <option value="">No projects loaded</option>}
        {loaded.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="chips" role="tablist" aria-label="Filter by reusable">
        {FILTERS.map((f) => (
          <button
            key={String(f.id)}
            role="tab"
            aria-selected={reusableOnly === f.id}
            className={reusableOnly === f.id ? "chip chip-on" : "chip"}
            onClick={() => onReusableOnly(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="list">
        {prompts.length === 0 && (
          <li className="list-empty">
            {!canCreate
              ? "No projects loaded — open or create one to start."
              : "Nothing here yet — create your first prompt."}
          </li>
        )}
        {prompts.map((p) => (
          <li key={p.id}>
            <button
              className={p.id === selectedId ? "row row-on" : "row"}
              onClick={() => onSelect(p.id)}
            >
              <span className="row-top">
                <span className="row-title">{displayTitle(p.title, p.body)}</span>
                {p.reusable && <span className="pill pill-on">REUSABLE</span>}
                <span className="row-when">{formatWhen(p.updatedAt, now)}</span>
              </span>
              {p.body && <span className="row-body">{p.body}</span>}
              <span className="row-version">v{p.versionCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
