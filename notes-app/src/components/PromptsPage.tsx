import { useCallback, useEffect, useRef, useState } from "react";
import type { NewPrompt, ProjectInfo, Prompt, UpdatePrompt } from "../types";
import * as api from "../lib/api";
import { nextToken, shouldCommit } from "../lib/projects";
import { displayTitle } from "../lib/prompts";
import PromptList from "./PromptList";
import PromptEditor from "./PromptEditor";

interface Props {
  /** The loaded subset of the shared project catalog — the same value App
   *  computes for Worknotes. The rail scopes to one project, or to "All projects"
   *  ("" — reusable prompts fanned across every loaded store, each labeled with
   *  its owning project; plan.9). */
  loaded: ProjectInfo[];
  /** Ask App to re-fetch the project catalog after a prompt mutation, so the
   *  Manage-projects prompt counts stay current (a create/delete changes one
   *  project's count; a move changes two). Mirrors how the item side refreshes
   *  the catalog through App's mutate. */
  onProjectsChanged: () => void;
  /** Widened for keyed (resolvable) validation toasts; transient sites still
   *  call it one-arg (assignable). */
  onError: (message: string, opts?: { key?: string }) => void;
  /** Clear a keyed toast on resolution — threaded down to PromptEditor. */
  onResolve: (key: string) => void;
  /** Report the owning project of the prompt currently open here (null when
   *  none), so App's unload confirm can warn before an unload closes it — App
   *  otherwise tracks only the Worknotes item selection. */
  onOpenPromptChange: (projectId: string | null) => void;
}

/** A blank local draft targeting `projectId` — mirrors src/lib/draft.ts's
 *  newDraft for items. Never sent over IPC directly (createPrompt takes a
 *  NewPrompt built from it at Save time). */
function newDraft(projectId: string): Prompt {
  return {
    id: "",
    title: "",
    body: "",
    reusable: false,
    createdAt: "",
    updatedAt: "",
    versionCount: 0,
    projectId,
  };
}

export default function PromptsPage({
  loaded,
  onProjectsChanged,
  onError,
  onResolve,
  onOpenPromptChange,
}: Props) {
  const [projectId, setProjectId] = useState("");
  const [reusableOnly, setReusableOnly] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Prompt | null>(null);
  const [draftSeq, setDraftSeq] = useState(0); // per-draft remount key

  // Monotonic request token guarding loadPrompts, matching App's loadItems.
  const loadToken = useRef(0);

  // The scope defaults to "All projects" ("") and is preserved across loads. A
  // selection naming a now-unloaded project falls back to "" (All) — the same
  // reset the Worknotes rail's project filter does on unload — never to a stale
  // id, and "" is never coerced off onto the first loaded project.
  useEffect(() => {
    setProjectId((current) =>
      current === "" || loaded.some((p) => p.id === current) ? current : "",
    );
    // Drop a draft whose target project was unloaded — it can't be saved
    // anywhere, so it must not linger open (the unload confirm warned first).
    setDraft((d) => (d && !loaded.some((p) => p.id === d.projectId) ? null : d));
  }, [loaded]);

  const loadPrompts = useCallback(async () => {
    const token = (loadToken.current = nextToken(loadToken.current));
    // All scope with nothing loaded → nothing to fan out over; skip the IPC and
    // let the rail show its "No projects loaded" empty state.
    if (projectId === "" && loaded.length === 0) {
      setPrompts([]);
      return;
    }
    try {
      // All scope ("") → reusable-only cross-store fan-out (no projectId: the
      // backend forces reusable-only and stamps each row's TRUE owner). A
      // specific project → the single-store path with the reusable chip.
      const filter =
        projectId === ""
          ? { reusableOnly: true }
          : { projectId, reusableOnly: reusableOnly || undefined };
      const result = await api.listPrompts(filter);
      if (shouldCommit(token, loadToken.current)) setPrompts(result);
    } catch (err) {
      if (shouldCommit(token, loadToken.current)) onError(String(err));
    }
  }, [projectId, reusableOnly, loaded.length, onError]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  // selected resolves to the draft first, matching App's item draft pattern.
  // The reusable filter is applied SERVER-side by listPrompts (authoritative,
  // index-backed — matching how ItemList's filters work), so no client re-filter.
  const selected = draft ?? prompts.find((p) => p.id === selectedId) ?? null;

  // A selected prompt's owning-project name. In the All scope it may differ from
  // the project the user thinks they are in — mutations route by id to the true
  // owner (§4 High), so PromptEditor shows this as a persistent header label and
  // the destructive confirmations name it (§5 Q2). Null in a single-project scope
  // (the owner is unambiguous there). Owner is always a loaded store, so it
  // resolves; `?? "its project"` is a defensive fallback for the confirmations.
  const ownerName = (id: string | null): string | null =>
    (id && loaded.find((p) => p.id === id)?.name) || null;
  // Owner label applies only to a SAVED prompt in the All scope — a draft isn't
  // owned by any store yet, so it never carries one (even if the scope is flipped
  // to All while a single-project draft is open).
  const ownerLabel =
    projectId === "" && draft === null && selected ? ownerName(selected.projectId) : null;

  // Report the open prompt's owning project up to App (for the unload confirm).
  // A draft reports its target project; a saved prompt its stamped owner.
  const openPromptProject = selected ? selected.projectId : null;
  useEffect(() => {
    onOpenPromptChange(openPromptProject);
  }, [openPromptProject, onOpenPromptChange]);

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await loadPrompts();
      // Keep the Manage-projects prompt counts current (a delete/move changes
      // them). Cheap COUNT(*)s; harmless when the count didn't change.
      onProjectsChanged();
      return true;
    } catch (err) {
      onError(String(err));
      return false;
    }
  }

  function openNewDraft() {
    if (!projectId) return;
    setDraft(newDraft(projectId));
    setDraftSeq((s) => s + 1);
    setSelectedId(null);
  }

  function selectRow(id: string) {
    setDraft(null); // a rail click always exits the draft
    setSelectedId(id);
  }

  async function createFromDraft(input: NewPrompt): Promise<boolean> {
    try {
      const created = await api.createPrompt(input);
      setDraft(null);
      await loadPrompts();
      onProjectsChanged(); // a new prompt bumps this project's count
      setSelectedId(created.id);
      return true;
    } catch (err) {
      onError(String(err));
      return false;
    }
  }

  return (
    <div className="panes">
      <PromptList
        prompts={prompts}
        selectedId={draft ? null : selectedId}
        loaded={loaded}
        projectId={projectId}
        reusableOnly={reusableOnly}
        onSelect={selectRow}
        onProjectChange={setProjectId}
        onReusableOnly={setReusableOnly}
        onCreate={openNewDraft}
      />

      {selected ? (
        <PromptEditor
          key={draft ? `draft-${draftSeq}` : selected.id}
          prompt={selected}
          isDraft={draft !== null}
          loaded={loaded}
          onSave={(patch: UpdatePrompt) =>
            mutate(() => api.updatePrompt(selected.id, patch))
          }
          onCreate={(input) => createFromDraft(input)}
          onToggleReusable={(next) =>
            draft
              ? setDraft((d) => (d ? { ...d, reusable: next } : d))
              : void mutate(() => api.updatePrompt(selected.id, { reusable: next }))
          }
          ownerLabel={ownerLabel}
          onMove={(targetProjectId) => {
            void (async () => {
              const target = loaded.find((p) => p.id === targetProjectId);
              // Name the OWNING project (the source) in the confirmation: in the
              // All scope this prompt may belong to a project other than the one
              // the user is browsing (§5 Q2).
              if (
                !(await api.confirmDialog(
                  `Move "${displayTitle(selected.title, selected.body)}" from "${
                    ownerName(selected.projectId) ?? "its project"
                  }" to "${target?.name ?? "another project"}"? Its full version history moves with it.`,
                ))
              )
                return;
              await mutate(async () => {
                await api.movePrompt(selected.id, targetProjectId);
                setSelectedId(null);
              });
            })();
          }}
          onDelete={() => {
            void (async () => {
              // Name the owning project — a delete in the All scope acts on that
              // project's real files and full version history (§4 High / §5 Q2).
              if (
                !(await api.confirmDialog(
                  `Delete "${displayTitle(selected.title, selected.body)}" from "${
                    ownerName(selected.projectId) ?? "its project"
                  }"? This cannot be undone.`,
                ))
              )
                return;
              await mutate(async () => {
                await api.deletePrompt(selected.id);
                setSelectedId(null);
              });
            })();
          }}
          onError={onError}
          onResolve={onResolve}
        />
      ) : (
        <section className="editor editor-empty">
          <p>
            {loaded.length === 0
              ? "No projects loaded — open or create one to start."
              : "Select a prompt on the left, or create one to start."}
          </p>
        </section>
      )}
    </div>
  );
}
