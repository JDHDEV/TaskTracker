import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NewPrompt, ProjectInfo, Prompt, UpdatePrompt } from "../types";
import * as api from "../lib/api";
import { itemKey, nextToken, shouldCommit } from "../lib/projects";
import { displayTitle } from "../lib/prompts";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  hasTab,
  openTab,
  promoteTab,
  setDirty,
  setTabItem,
  type OpenTabsState,
} from "../lib/openTabs";
import PromptList from "./PromptList";
import PromptEditor, { type PromptEditorHandle } from "./PromptEditor";
import EditorTabs, { type EditorTabDescriptor } from "./EditorTabs";

interface Props {
  /** The loaded subset of the shared project catalog — the same value App
   *  computes for Worknotes. The rail scopes to one project, or to "All projects"
   *  ("" — reusable prompts fanned across every loaded store, each labeled with
   *  its owning project; plan.9). */
  loaded: ProjectInfo[];
  /** Whether the Prompts page is the visible one. Folded into each editor's
   *  `active` prop so a background prompt editor (this page hidden) never fires
   *  its window-level Ctrl+S — both pages are mounted at once. */
  pageActive: boolean;
  /** Bumped by App when a project is reloaded, so this page closes its own open
   *  prompt tabs of that project (reload keeps the project loaded, so the
   *  `loaded`-driven close effect below won't fire on its own). */
  reloadSignal: { projectId: string; n: number } | null;
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
  /** Report the set of owning projects across ALL open prompt tabs (not just the
   *  active one), so App's unload confirm warns before an unload closes any of
   *  them — including a dirty background prompt tab. */
  onOpenPromptsChange: (projectIds: string[]) => void;
  /** One-shot "send selection to prompt" seed from the Scratch page (Plan 13):
   *  opens a dirty draft tab in `projectId` pre-filled with `body` (title left
   *  empty — `displayTitle` derives a label). `n` distinguishes repeat sends;
   *  the prop starts null and is consumed by the effect below. */
  seed: { projectId: string; body: string; n: number } | null;
}

/** A blank local draft targeting `projectId` — mirrors src/lib/draft.ts's
 *  newDraft for items. `body` seeds the body only (send-to). Never sent over
 *  IPC directly (createPrompt takes a NewPrompt built from it at Save time). */
function newDraft(projectId: string, body = ""): Prompt {
  return {
    id: "",
    title: "",
    body,
    reusable: false,
    // Placeholder: the backend mints the real marker on Save (it is not sent).
    schemaVersion: "",
    createdAt: "",
    updatedAt: "",
    versionCount: 0,
    projectId,
  };
}

// Prompt tab keys are namespaced with a `prompt-` prefix so they can never
// collide with item-tab keys (both pages stay mounted, so both tab strips — and
// their derived ARIA DOM ids — live in the document at once, and both draft
// counters would otherwise mint an identical `draft-1`).
function promptTabKey(p: Prompt): string {
  return `prompt-${itemKey(p)}`;
}

export default function PromptsPage({
  loaded,
  pageActive,
  reloadSignal,
  onProjectsChanged,
  onError,
  onResolve,
  onOpenPromptsChange,
  seed,
}: Props) {
  const [projectId, setProjectId] = useState("");
  const [reusableOnly, setReusableOnly] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  // Open prompt tabs — the prompt-side mirror of App's item tabs. Each keeps a
  // mounted-hidden <PromptEditor>, so per-tab edits and in-flight rework survive
  // a switch; a draft gets a synthetic `prompt-draft-<seq>` key, promoted to the
  // created prompt's key on save.
  const [tabs, setTabs] = useState<OpenTabsState<Prompt>>(emptyTabs);
  const [draftSeq, setDraftSeq] = useState(0);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const editorRefs = useRef(new Map<string, PromptEditorHandle>());

  // Monotonic request token guarding loadPrompts, matching App's loadItems.
  const loadToken = useRef(0);

  // The scope defaults to "All projects" ("") and is preserved across loads. A
  // selection naming a now-unloaded project falls back to "" (All). Any open tab
  // whose owning project is no longer loaded is closed (it can't be saved
  // anywhere) — the unload confirm warned first. Adjacency/empty-state handling
  // lives in the closeTab reducer; the closed editors' save() handles drop with
  // them on unmount.
  useEffect(() => {
    setProjectId((current) =>
      current === "" || loaded.some((p) => p.id === current) ? current : "",
    );
    setTabs((s) => {
      const stillLoaded = (t: { item: Prompt }) =>
        loaded.some((p) => p.id === t.item.projectId);
      if (s.tabs.every(stillLoaded)) return s;
      let next = s;
      for (const t of s.tabs) if (!stillLoaded(t)) next = closeTab(next, t.key);
      return next;
    });
  }, [loaded]);

  // App bumps reloadSignal when a project is reloaded; close this page's SAVED
  // prompt tabs of that project (a draft isn't on disk, so a reload can't stale
  // it) so their stale buffers can't clobber the freshly-reloaded files.
  useEffect(() => {
    if (!reloadSignal) return;
    const pid = reloadSignal.projectId;
    setTabs((s) => {
      const affected = s.tabs.filter((t) => t.item.id !== "" && t.item.projectId === pid);
      if (affected.length === 0) return s;
      let next = s;
      for (const t of affected) next = closeTab(next, t.key);
      return next;
    });
  }, [reloadSignal]);

  // A "send selection to prompt" from the Scratch page: scope the rail to the
  // pad's project and open a seeded, dirty draft tab there. The null check first
  // makes the mount-time run (and StrictMode's double invoke) a no-op; a
  // re-render with the same `seed` object doesn't re-fire (App mints a fresh
  // object with `n + 1` per send).
  useEffect(() => {
    if (!seed) return;
    setProjectId(seed.projectId);
    const seq = draftSeq + 1;
    setDraftSeq(seq);
    setTabs((s) => openTab(s, `prompt-draft-${seq}`, newDraft(seed.projectId, seed.body), true));
  }, [seed]);

  // Move focus into the empty placeholder when the last prompt tab closes, so
  // focus doesn't drop to <body>.
  const emptyEditorRef = useRef<HTMLElement>(null);
  const hadTabsRef = useRef(false);
  useEffect(() => {
    const has = tabs.tabs.length > 0;
    if (hadTabsRef.current && !has) emptyEditorRef.current?.focus();
    hadTabsRef.current = has;
  }, [tabs.tabs.length]);

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

  const active = activeTab(tabs);
  // Rail highlight: the active tab's saved prompt id (a draft has "" → no row).
  const selectedId = active && active.item.id !== "" ? active.item.id : null;

  // A prompt's owning-project name. In the All scope a prompt may belong to a
  // project other than the one being browsed — mutations route by id to the true
  // owner (§4 High), so PromptEditor shows this as a persistent header label and
  // destructive confirmations name it (§5 Q2). Owner is always a loaded store.
  const ownerName = (id: string | null): string | null =>
    (id && loaded.find((p) => p.id === id)?.name) || null;
  // The owner label applies only to a SAVED prompt in the All scope — a draft
  // isn't owned by any store yet, so it never carries one.
  const ownerLabelFor = (p: Prompt): string | null =>
    projectId === "" && p.id !== "" ? ownerName(p.projectId) : null;

  // Report the set of owning projects across all open prompt tabs up to App (for
  // the unload confirm). A draft reports its target project; a saved prompt its
  // stamped owner. Stable reference while `tabs` is unchanged → no report churn.
  const openPromptProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tabs.tabs) if (t.item.projectId) ids.add(t.item.projectId);
    return Array.from(ids);
  }, [tabs]);
  useEffect(() => {
    onOpenPromptsChange(openPromptProjectIds);
  }, [openPromptProjectIds, onOpenPromptsChange]);

  const tabDescriptors = useMemo<EditorTabDescriptor[]>(
    // No status dot / pin on prompt tabs — titles only.
    () =>
      tabs.tabs.map((t) => ({
        key: t.key,
        title: displayTitle(t.item.title, t.item.body),
        dirty: t.isDirty,
      })),
    [tabs],
  );

  // After a refresh, re-sync each open (non-draft) prompt tab from the store BY
  // ID — not by diffing the scoped `prompts` list (a scope change would then
  // falsely close still-open tabs). A rejected getPrompt means it's gone → close;
  // otherwise refresh the snapshot (versionCount, reusable, owner) without
  // disturbing the mounted editor's local buffer (re-seed keys on prompt.id).
  const reconcilePromptTabs = useCallback(async () => {
    const open = tabsRef.current.tabs.filter((t) => t.item.id !== "");
    if (open.length === 0) return;
    const results = await Promise.all(
      open.map((t) =>
        api.getPrompt(t.item.id).then(
          (item): { key: string; item: Prompt | null } => ({ key: t.key, item }),
          (): { key: string; item: Prompt | null } => ({ key: t.key, item: null }),
        ),
      ),
    );
    setTabs((s) => {
      let next = s;
      for (const r of results) {
        if (!hasTab(next, r.key)) continue;
        if (r.item) {
          next = setTabItem(next, r.key, r.item);
        } else if (!next.tabs.find((t) => t.key === r.key)?.isDirty) {
          // Genuinely gone → close it, but never silently drop a DIRTY tab on a
          // (possibly transient) fetch failure — keep its unsaved edits.
          next = closeTab(next, r.key);
        }
      }
      return next;
    });
  }, []);

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await loadPrompts();
      // Keep the Manage-projects prompt counts current (a delete/move changes
      // them). Cheap COUNT(*)s; harmless when the count didn't change.
      onProjectsChanged();
      await reconcilePromptTabs();
      return true;
    } catch (err) {
      onError(String(err));
      return false;
    }
  }

  function openNewDraft() {
    if (!projectId) return; // All scope has no concrete create target
    const seq = draftSeq + 1;
    setDraftSeq(seq);
    setTabs((s) => openTab(s, `prompt-draft-${seq}`, newDraft(projectId), true));
  }

  // Rail click: open-or-activate (look the row up in `prompts` for its snapshot).
  function selectRow(id: string) {
    const p = prompts.find((x) => x.id === id);
    if (p) setTabs((s) => openTab(s, promptTabKey(p), p));
  }

  async function createFromDraft(draftKey: string, input: NewPrompt): Promise<boolean> {
    try {
      const created = await api.createPrompt(input);
      await loadPrompts();
      onProjectsChanged(); // a new prompt bumps this project's count
      setTabs((s) => promoteTab(s, draftKey, promptTabKey(created), created));
      return true;
    } catch (err) {
      onError(String(err));
      return false;
    }
  }

  function closeTabByKey(key: string) {
    setTabs((s) => closeTab(s, key));
    editorRefs.current.delete(key);
  }

  // Close × / Delete-key. Clean tab closes at once; a dirty draft offers
  // Discard/keep; a dirty saved prompt offers Cancel / Discard / Save (Save via
  // the tab's imperative save() handle). Never window.confirm.
  function requestCloseTab(key: string) {
    void (async () => {
      const tab = tabsRef.current.tabs.find((t) => t.key === key);
      if (!tab) return;
      if (tab.isDirty) {
        const title = displayTitle(tab.item.title, tab.item.body);
        if (tab.item.id === "") {
          if (!(await api.confirmDialog("Discard this unsaved prompt?"))) return;
        } else {
          // Two chained Yes/No prompts (api.confirmDialog → the plugin's ask(),
          // a Yes/No dialog) give the Cancel / Discard / Save choice.
          if (!(await api.confirmDialog(`"${title}" has unsaved changes. Close this tab?`)))
            return; // No → keep editing
          if (
            await api.confirmDialog(
              `Save your changes to "${title}" before closing? Yes saves and closes; No discards them.`,
            )
          ) {
            const saved = await editorRefs.current.get(key)?.save();
            if (!saved) return;
          }
        }
      }
      closeTabByKey(key);
    })();
  }

  function requestMovePrompt(key: string, prompt: Prompt, targetProjectId: string) {
    void (async () => {
      const target = loaded.find((p) => p.id === targetProjectId);
      // Name the OWNING project (the source) in the confirmation: in the All
      // scope this prompt may belong to a project other than the one browsed.
      if (
        !(await api.confirmDialog(
          `Move "${displayTitle(prompt.title, prompt.body)}" from "${
            ownerName(prompt.projectId) ?? "its project"
          }" to "${target?.name ?? "another project"}"? Its full version history moves with it.`,
        ))
      )
        return;
      const ok = await mutate(() => api.movePrompt(prompt.id, targetProjectId));
      // The prompt moved to a different project, so its tab key (which encodes
      // the old project) is stale — close it; re-open from the target if wanted.
      if (ok) closeTabByKey(key);
    })();
  }

  function requestDeletePrompt(key: string, prompt: Prompt) {
    void (async () => {
      // Name the owning project — a delete in the All scope acts on that
      // project's real files and full version history (§4 High / §5 Q2).
      if (
        !(await api.confirmDialog(
          `Delete "${displayTitle(prompt.title, prompt.body)}" from "${
            ownerName(prompt.projectId) ?? "its project"
          }"? This cannot be undone.`,
        ))
      )
        return;
      const ok = await mutate(() => api.deletePrompt(prompt.id));
      if (ok) closeTabByKey(key);
    })();
  }

  return (
    <div className="panes">
      <PromptList
        prompts={prompts}
        selectedId={selectedId}
        loaded={loaded}
        projectId={projectId}
        reusableOnly={reusableOnly}
        onSelect={selectRow}
        onProjectChange={setProjectId}
        onReusableOnly={setReusableOnly}
        onCreate={openNewDraft}
      />

      {tabs.tabs.length > 0 ? (
        <div className="editor-pane">
          <EditorTabs
            tabs={tabDescriptors}
            activeKey={tabs.activeKey}
            onActivate={(key) => setTabs((s) => activateTab(s, key))}
            onClose={requestCloseTab}
            onNew={openNewDraft}
            listLabel="Open prompts"
            newLabel="Open another prompt"
          />
          {tabs.tabs.map((t) => {
            const isDraft = t.item.id === "";
            return (
              <PromptEditor
                key={t.key}
                ref={(h) => {
                  if (h) editorRefs.current.set(t.key, h);
                  else editorRefs.current.delete(t.key);
                }}
                tabKey={t.key}
                hidden={t.key !== tabs.activeKey}
                active={pageActive && t.key === tabs.activeKey}
                prompt={t.item}
                isDraft={isDraft}
                loaded={loaded}
                onDirtyChange={(dirty) => setTabs((s) => setDirty(s, t.key, dirty))}
                onSave={(patch: UpdatePrompt) =>
                  mutate(() => api.updatePrompt(t.item.id, patch))
                }
                onCreate={(input) => createFromDraft(t.key, input)}
                onToggleReusable={(next) =>
                  isDraft
                    ? setTabs((s) => setTabItem(s, t.key, { ...t.item, reusable: next }))
                    : void mutate(() => api.updatePrompt(t.item.id, { reusable: next }))
                }
                ownerLabel={ownerLabelFor(t.item)}
                onMove={(targetProjectId) => requestMovePrompt(t.key, t.item, targetProjectId)}
                onDelete={() => requestDeletePrompt(t.key, t.item)}
                onError={onError}
                onResolve={onResolve}
              />
            );
          })}
        </div>
      ) : (
        <section className="editor editor-empty" tabIndex={-1} ref={emptyEditorRef}>
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
