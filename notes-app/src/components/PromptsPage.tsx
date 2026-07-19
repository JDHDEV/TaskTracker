import { useCallback, useEffect, useRef, useState } from "react";
import type { NewPrompt, ProjectInfo, Prompt, UpdatePrompt } from "../types";
import * as api from "../lib/api";
import { nextToken, shouldCommit } from "../lib/projects";
import PromptList from "./PromptList";
import PromptEditor from "./PromptEditor";

interface Props {
  /** The loaded subset of the shared project catalog — the same value App
   *  computes for Worknotes. Prompts are viewed one project at a time (the
   *  backend requires a projectId), so there is no "All projects" option. */
  loaded: ProjectInfo[];
  onError: (message: string) => void;
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

export default function PromptsPage({ loaded, onError }: Props) {
  const [projectId, setProjectId] = useState("");
  const [reusableOnly, setReusableOnly] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Prompt | null>(null);
  const [draftSeq, setDraftSeq] = useState(0); // per-draft remount key

  // Monotonic request token guarding loadPrompts, matching App's loadItems.
  const loadToken = useRef(0);

  // Default (and re-anchor) the selected project to the first loaded one; if
  // the current selection is no longer loaded, fall back the same way the
  // Worknotes rail resets its project filter when a project is unloaded.
  useEffect(() => {
    setProjectId((current) =>
      loaded.some((p) => p.id === current) ? current : (loaded[0]?.id ?? ""),
    );
  }, [loaded]);

  const loadPrompts = useCallback(async () => {
    const token = (loadToken.current = nextToken(loadToken.current));
    if (!projectId) {
      setPrompts([]);
      return;
    }
    try {
      const result = await api.listPrompts({
        projectId,
        reusableOnly: reusableOnly || undefined,
      });
      if (shouldCommit(token, loadToken.current)) setPrompts(result);
    } catch (err) {
      if (shouldCommit(token, loadToken.current)) onError(String(err));
    }
  }, [projectId, reusableOnly, onError]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  // selected resolves to the draft first, matching App's item draft pattern.
  // The reusable filter is applied SERVER-side by listPrompts (authoritative,
  // index-backed — matching how ItemList's filters work), so no client re-filter.
  const selected = draft ?? prompts.find((p) => p.id === selectedId) ?? null;

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await loadPrompts();
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
          onSave={(patch: UpdatePrompt) =>
            mutate(() => api.updatePrompt(selected.id, patch))
          }
          onCreate={(input) => createFromDraft(input)}
          onToggleReusable={(next) =>
            draft
              ? setDraft((d) => (d ? { ...d, reusable: next } : d))
              : void mutate(() => api.updatePrompt(selected.id, { reusable: next }))
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
                await api.deletePrompt(selected.id);
                setSelectedId(null);
              });
            })();
          }}
          onError={onError}
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
