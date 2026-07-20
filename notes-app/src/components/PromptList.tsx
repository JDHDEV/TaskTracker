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
  // "" is the All-projects scope (plan.9): reusable prompts fanned across every
  // loaded store. New prompt needs a concrete target, so it stays disabled there.
  const allScope = projectId === "";
  const canCreate = !allScope;
  // In the All scope the fan-out is reusable-only, so the chip pair is forced on
  // "Reusable only" and disabled (the state value is irrelevant while All).
  const effectiveReusable = allScope ? true : reusableOnly;
  // Resolve a row's owning-project name (shown only in the All scope, where a
  // row's origin would otherwise be ambiguous). Mirrors ItemList's projectName.
  const projectName = new Map(loaded.map((p) => [p.id, p.name]));
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
        aria-label="Filter by project"
        onChange={(e) => onProjectChange(e.target.value)}
      >
        {/* Exactly one value="" option: an inert "No projects loaded" when the
            catalog has no loaded store, else the All-projects scope. */}
        {loaded.length === 0 ? (
          <option value="">No projects loaded</option>
        ) : (
          <option value="">All projects</option>
        )}
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
            aria-selected={effectiveReusable === f.id}
            className={effectiveReusable === f.id ? "chip chip-on" : "chip"}
            disabled={allScope}
            title={allScope ? "The All-projects view shows reusable prompts only" : undefined}
            onClick={() => onReusableOnly(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="list">
        {prompts.length === 0 && (
          <li className="list-empty">
            {loaded.length === 0
              ? "No projects loaded — open or create one to start."
              : allScope
                ? "No reusable prompts in any loaded project yet."
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
              {/* Owning-project label — only in the All scope, where a row's
                  origin is otherwise ambiguous (mutations route by id to the
                  true owner, so the owner must be visible; §4 High / §5 Q2). */}
              {allScope && p.projectId && (
                <span className="row-project">{projectName.get(p.projectId) ?? "Unknown project"}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
