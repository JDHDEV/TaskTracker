import { useEffect, useMemo, useRef, useState } from "react";
import type { Kind, ProjectInfo } from "../types";
import * as api from "../lib/api";
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  openTab,
  setDirty,
  setTabItem,
  type OpenTabsState,
} from "../lib/openTabs";
import EditorTabs, { type EditorTabDescriptor } from "./EditorTabs";
import ScratchEditor, { type ScratchDoc, type ScratchEditorHandle } from "./ScratchEditor";
import type { SendDestination } from "./SelectionMenu";

interface Props {
  /** The loaded subset of the project catalog — one pad per loaded project. */
  loaded: ProjectInfo[];
  /** Whether the Scratch page is the visible one — folded into each editor's
   *  `active` so a hidden pad never fires its window-level Ctrl+S. */
  pageActive: boolean;
  /** Bumped by App when a project is reloaded (the same signal PromptsPage
   *  consumes): close that project's pad tab so a stale buffer can't clobber the
   *  freshly-pulled `scratch.md` — a re-click re-fetches it. */
  reloadSignal: { projectId: string; n: number } | null;
  onError: (message: string, opts?: { key?: string }) => void;
  onResolve: (key: string) => void;
  /** Report the projects with an open pad tab, so App's unload/reload confirms
   *  can warn before closing one (including a dirty background pad). */
  onOpenScratchChange: (projectIds: string[]) => void;
  /** "Send selection to…" destinations. Both open an UNSAVED, pre-filled draft
   *  targeting the pad's own project and issue no write (D5, §4 L3). */
  onSendToItem: (kind: Kind, projectId: string, body: string) => void;
  onSendToPrompt: (projectId: string, body: string) => void;
}

// Scratch tab keys are namespaced so they can never collide with item/prompt
// tab keys (all three strips are mounted at once, and their ARIA ids share the
// document).
function scratchTabKey(projectId: string): string {
  return `scratch-${projectId}`;
}

/** The Scratch page (Plan 13, D2): a rail of loaded projects, the shared tab
 *  strip (no "+": one pad per project), and N mounted-hidden `ScratchEditor`s
 *  so an in-flight rework survives a tab switch. Shaped on PromptsPage. */
export default function ScratchPage({
  loaded,
  pageActive,
  reloadSignal,
  onError,
  onResolve,
  onOpenScratchChange,
  onSendToItem,
  onSendToPrompt,
}: Props) {
  const [tabs, setTabs] = useState<OpenTabsState<ScratchDoc>>(emptyTabs);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const editorRefs = useRef(new Map<string, ScratchEditorHandle>());
  // Projects whose pad is being fetched. A ref, not state: the guard must be
  // checked synchronously in the click handler so a double-click on a rail row
  // can never race two fetches (and two tabs) for the same project.
  const loadingRef = useRef(new Set<string>());
  // Latest `loaded`, read after the fetch await: a project unloaded while its
  // pad was in flight must not get a tab on the late resolve.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  // Close any pad whose project is no longer loaded (it can't be saved
  // anywhere) — the unload confirm warned first.
  useEffect(() => {
    setTabs((s) => {
      const stillLoaded = (t: { item: ScratchDoc }) =>
        loaded.some((p) => p.id === t.item.projectId);
      if (s.tabs.every(stillLoaded)) return s;
      let next = s;
      for (const t of s.tabs) if (!stillLoaded(t)) next = closeTab(next, t.key);
      return next;
    });
  }, [loaded]);

  // A reload re-read the project's files; the pad on disk may have changed, so
  // close its tab (a re-click fetches the pulled content).
  useEffect(() => {
    if (!reloadSignal) return;
    const key = scratchTabKey(reloadSignal.projectId);
    setTabs((s) => closeTab(s, key));
  }, [reloadSignal]);

  const emptyEditorRef = useRef<HTMLElement>(null);
  const hadTabsRef = useRef(false);
  useEffect(() => {
    const has = tabs.tabs.length > 0;
    if (hadTabsRef.current && !has) emptyEditorRef.current?.focus();
    hadTabsRef.current = has;
  }, [tabs.tabs.length]);

  const active = activeTab(tabs);
  const activeProjectId = active?.item.projectId ?? null;

  const openScratchProjectIds = useMemo(
    () => tabs.tabs.map((t) => t.item.projectId),
    [tabs],
  );
  useEffect(() => {
    onOpenScratchChange(openScratchProjectIds);
  }, [openScratchProjectIds, onOpenScratchChange]);

  const projectName = (id: string): string =>
    loaded.find((p) => p.id === id)?.name ?? "Scratch";

  const tabDescriptors = useMemo<EditorTabDescriptor[]>(
    () =>
      tabs.tabs.map((t) => ({
        key: t.key,
        title: projectName(t.item.projectId),
        dirty: t.isDirty,
      })),
    // `loaded` is a dep because the tab title is the (renameable) project name.
    [tabs, loaded],
  );

  // Rail click: activate an open pad, or fetch the file and open a tab. A
  // failed read opens NO tab (toast only) — an empty editor over an unreadable
  // file would be saved over it on the first Save (§4 M3, D9).
  function selectProject(id: string) {
    const key = scratchTabKey(id);
    if (tabsRef.current.tabs.some((t) => t.key === key)) {
      setTabs((s) => activateTab(s, key));
      return;
    }
    if (loadingRef.current.has(id)) return;
    loadingRef.current.add(id);
    // Keyed per project, so a later success on project B never dismisses a
    // still-valid failure toast for project A.
    const toastKey = `scratch-load-failed-${id}`;
    void (async () => {
      try {
        const body = await api.getScratch(id);
        if (!loadedRef.current.some((p) => p.id === id)) return; // unloaded meanwhile
        onResolve(toastKey);
        setTabs((s) => openTab(s, key, { projectId: id, body }));
      } catch (err) {
        onError(String(err), { key: toastKey });
      } finally {
        loadingRef.current.delete(id);
      }
    })();
  }

  async function savePad(key: string, projectId: string, body: string): Promise<boolean> {
    try {
      await api.setScratch(projectId, body);
      setTabs((s) => setTabItem(s, key, { projectId, body }));
      return true;
    } catch (err) {
      onError(String(err));
      return false; // the editor stays dirty
    }
  }

  function closeTabByKey(key: string) {
    setTabs((s) => closeTab(s, key));
    editorRefs.current.delete(key);
  }

  // Close × / Delete-key. A clean tab closes at once; a dirty pad offers
  // Cancel / Discard / Save via two chained Yes/No dialogs (never window.confirm).
  function requestCloseTab(key: string) {
    void (async () => {
      const tab = tabsRef.current.tabs.find((t) => t.key === key);
      if (!tab) return;
      if (tab.isDirty) {
        const title = `${projectName(tab.item.projectId)} scratch pad`;
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
      closeTabByKey(key);
    })();
  }

  function sendTo(projectId: string, dest: SendDestination, text: string) {
    if (dest === "prompt") onSendToPrompt(projectId, text);
    else onSendToItem(dest, projectId, text);
  }

  return (
    <div className="panes">
      <aside className="rail">
        <p className="rail-note">
          Saved as scratch.md in the project folder and committed with it.
        </p>
        <ul className="list">
          {loaded.length === 0 && (
            <li className="list-empty">No projects loaded — open or create one to start.</li>
          )}
          {loaded.map((p) => (
            <li key={p.id}>
              <button
                className={p.id === activeProjectId ? "row row-on" : "row"}
                aria-current={p.id === activeProjectId ? "true" : undefined}
                onClick={() => selectProject(p.id)}
              >
                <span className="row-top">
                  <span className="row-title">{p.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {tabs.tabs.length > 0 ? (
        <div className="editor-pane">
          <EditorTabs
            tabs={tabDescriptors}
            activeKey={tabs.activeKey}
            onActivate={(key) => setTabs((s) => activateTab(s, key))}
            onClose={requestCloseTab}
            listLabel="Open scratch pads"
          />
          {tabs.tabs.map((t) => (
            <ScratchEditor
              key={t.key}
              ref={(h) => {
                if (h) editorRefs.current.set(t.key, h);
                else editorRefs.current.delete(t.key);
              }}
              tabKey={t.key}
              hidden={t.key !== tabs.activeKey}
              active={pageActive && t.key === tabs.activeKey}
              doc={t.item}
              onDirtyChange={(dirty) => setTabs((s) => setDirty(s, t.key, dirty))}
              onSave={(body) => savePad(t.key, t.item.projectId, body)}
              onSendTo={(dest, text) => sendTo(t.item.projectId, dest, text)}
              onError={onError}
              onResolve={onResolve}
            />
          ))}
        </div>
      ) : (
        <section className="editor editor-empty" tabIndex={-1} ref={emptyEditorRef}>
          <p>
            {loaded.length === 0
              ? "No projects loaded — open or create one to start."
              : "Pick a project on the left to open its scratch pad."}
          </p>
        </section>
      )}
    </div>
  );
}
