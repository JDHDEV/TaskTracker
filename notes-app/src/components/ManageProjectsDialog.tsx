import { useEffect, useState } from "react";
import type { ProjectWithCount } from "../types";
import { createProject, deleteProject, listProjects, renameProject } from "../lib/api";

interface Props {
  onClose: () => void;
  onChanged: () => void; // cascade-refresh App (list/selects/counts)
  onError: (message: string) => void;
}

export default function ManageProjectsDialog({ onClose, onChanged, onError }: Props) {
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");

  async function load() {
    try {
      const rows = await listProjects();
      setProjects(rows);
      setNames(Object.fromEntries(rows.map((p) => [p.id, p.name])));
    } catch (err) {
      onError(String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function commitRename(p: ProjectWithCount) {
    const name = (names[p.id] ?? "").trim();
    if (!name || name === p.name) {
      // Nothing to do — restore the field to the persisted name.
      setNames((n) => ({ ...n, [p.id]: p.name }));
      return;
    }
    try {
      await renameProject(p.id, name);
      await load();
      onChanged();
    } catch (err) {
      onError(String(err));
      await load(); // reset the optimistic input
    }
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createProject(name);
      setNewName("");
      await load();
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  }

  async function remove(id: string) {
    try {
      await deleteProject(id);
      await load();
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog dialog-projects"
        role="dialog"
        aria-label="Manage projects"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Manage projects</h2>
        <p className="dialog-note">
          Rename a project inline. A project can be removed only when no notes or
          tasks are assigned to it.
        </p>

        {projects.length === 0 && <p className="dialog-note">No projects yet.</p>}

        {projects.map((p) => (
          <div key={p.id} className="project-row">
            <input
              className="project-name"
              value={names[p.id] ?? ""}
              aria-label={`Rename ${p.name}`}
              onChange={(e) =>
                setNames((n) => ({ ...n, [p.id]: e.target.value }))
              }
              onBlur={() => void commitRename(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <span className="project-count">
              {p.itemCount} {p.itemCount === 1 ? "ITEM" : "ITEMS"}
            </span>
            <button
              className="btn btn-danger"
              disabled={p.itemCount >= 1}
              onClick={() => void remove(p.id)}
            >
              Remove
            </button>
          </div>
        ))}

        <div className="project-add-row">
          <input
            className="project-name"
            placeholder="New project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button className="btn" onClick={() => void add()}>
            Add project
          </button>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
