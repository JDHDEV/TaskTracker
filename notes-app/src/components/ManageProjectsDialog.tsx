import { useRef, useState } from "react";
import type { ProjectInfo } from "../types";
import {
  confirmDialog,
  createProject,
  deleteProjectFiles,
  forgetProject,
  loadProject,
  openProject,
  pickProjectFolder,
  revealProjectFolder,
} from "../lib/api";

interface Props {
  /** The catalog (known projects) from App — the single source of truth. */
  projects: ProjectInfo[];
  onClose: () => void;
  /** Refresh App's list/selects/counts after any catalog change. */
  onChanged: () => void;
  /** Unload goes through App so it can confirm + announce when the open item
   *  belongs to the target project. Returns a promise so the dialog can hold its
   *  busy lock (and block re-entrant clicks) for the round-trip. */
  onUnload: (project: ProjectInfo) => Promise<void>;
  /** Reload likewise goes through App: it confirms + evicts when an open item
   *  from this project would be staled by re-reading files, and surfaces any
   *  per-file import warnings. */
  onReload: (project: ProjectInfo) => Promise<void>;
  onError: (message: string) => void;
}

export default function ManageProjectsDialog({
  projects,
  onClose,
  onChanged,
  onUnload,
  onReload,
  onError,
}: Props) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // Native file dialogs escape React focus management — restore focus to the
  // trigger after the picker promise settles (usePopover's discipline).
  const openRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  async function withBusy(action: () => Promise<void>, restore: HTMLButtonElement | null) {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
      // Defer past the commit that re-enables the button — .focus() is a no-op
      // on a still-disabled control, so restore on the next frame.
      if (restore) requestAnimationFrame(() => restore.focus());
    }
  }

  function handleOpen() {
    void withBusy(async () => {
      const dir = await pickProjectFolder();
      if (!dir) return; // cancelled
      await openProject(dir);
      onChanged();
    }, openRef.current);
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name) {
      onError("Enter a project name first.");
      return;
    }
    void withBusy(async () => {
      const dir = await pickProjectFolder();
      if (!dir) return; // cancelled
      await createProject(dir, name);
      setNewName("");
      onChanged();
    }, createRef.current);
  }

  function handleLoad(p: ProjectInfo) {
    void withBusy(async () => {
      await loadProject(p.id);
      onChanged();
    }, null);
  }

  function handleOpenFolder(p: ProjectInfo) {
    // Reveal-only: no catalog change, so no onChanged() refresh. Errors (a stale
    // path that no longer exists) surface through onError. Restores focus itself
    // is unnecessary — no dialog is opened.
    void withBusy(async () => {
      await revealProjectFolder(p.id);
    }, null);
  }

  function handleForget(p: ProjectInfo) {
    void withBusy(async () => {
      await forgetProject(p.id);
      onChanged();
    }, null);
  }

  function handleDeleteFiles(p: ProjectInfo) {
    void (async () => {
      const ok = await confirmDialog(
        `Permanently delete the files for "${p.name}"?\n\n${p.path}\n\nThis cannot be undone.`,
      );
      if (!ok) return;
      await withBusy(async () => {
        await deleteProjectFiles(p.id);
        onChanged();
      }, null);
    })();
  }

  const anyLoaded = projects.some((p) => p.loaded);

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
          A project is a folder on disk. Load projects to work in them; unloading
          closes a project without touching its files. Forgetting removes it from
          this list; deleting files is permanent.
        </p>

        {projects.length === 0 ? (
          <p className="dialog-note">
            No projects yet. Create a new one or open an existing folder to start.
          </p>
        ) : (
          !anyLoaded && (
            <p className="dialog-note">No projects are loaded.</p>
          )
        )}

        <ul className="project-list">
          {projects.map((p) => {
            const count = p.itemCount ?? 0;
            const promptCount = p.promptCount ?? 0;
            return (
              <li key={p.id} className="project-row">
                <div className="project-ident">
                  <span className="project-name-text">{p.name}</span>
                  <span className="project-path" title={p.path}>
                    {p.path}
                  </span>
                </div>
                <span className={p.loaded ? "project-state project-state-on" : "project-state"}>
                  {p.loaded
                    ? `${count} ITEM${count === 1 ? "" : "S"} · ${promptCount} PROMPT${
                        promptCount === 1 ? "" : "S"
                      }`
                    : "UNLOADED"}
                </span>
                <div className="project-actions">
                  {/* Open the project's folder in the OS file manager. Available
                      regardless of loaded state (revealing a folder needs no open
                      store); the id-keyed Rust command resolves + is_dir()-checks
                      the path server-side (plan.8 H1). */}
                  <button
                    className="btn btn-quiet"
                    disabled={busy}
                    aria-label={`Open folder for ${p.name}`}
                    title="Open this project's folder"
                    onClick={() => handleOpenFolder(p)}
                  >
                    Open folder
                  </button>
                  {p.loaded ? (
                    <>
                      <button
                        className="btn btn-quiet"
                        disabled={busy}
                        title="Re-read this project's files from disk (after a git pull / sync)"
                        aria-label={`Reload ${p.name}`}
                        onClick={() => void withBusy(() => onReload(p), null)}
                      >
                        Reload
                      </button>
                      <button
                        className="btn btn-quiet"
                        disabled={busy}
                        aria-label={`Unload ${p.name}`}
                        onClick={() => void withBusy(() => onUnload(p), null)}
                      >
                        Unload
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn"
                      disabled={busy}
                      aria-label={`Load ${p.name}`}
                      onClick={() => handleLoad(p)}
                    >
                      Load
                    </button>
                  )}
                  <button
                    className="btn btn-quiet btn-forget"
                    disabled={busy || p.loaded}
                    title={p.loaded ? "Unload the project first" : "Remove from this list; files kept"}
                    aria-label={`Forget ${p.name}`}
                    onClick={() => handleForget(p)}
                  >
                    Forget
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={busy || p.loaded}
                    title={p.loaded ? "Unload the project first" : "Delete the project's files permanently"}
                    aria-label={`Delete files for ${p.name}`}
                    onClick={() => handleDeleteFiles(p)}
                  >
                    Delete files
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="project-add-row">
          <input
            className="project-name"
            placeholder="New project name"
            value={newName}
            disabled={busy}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <button ref={createRef} className="btn" disabled={busy} onClick={handleCreate}>
            Create in folder…
          </button>
          <button ref={openRef} className="btn btn-quiet" disabled={busy} onClick={handleOpen}>
            Open project…
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
