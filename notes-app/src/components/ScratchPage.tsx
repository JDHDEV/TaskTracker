import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Draft, Kind, ProjectInfo } from "../types";
import * as api from "../lib/api";
import { classifyScratchRestore, sanitizeDraft } from "../lib/drafts";
import { writeSession, type ScratchSlice } from "../lib/session";
import DraftConflictBar from "./DraftConflictBar";
import {
  activateTab,
  activeTab,
  closeTab,
  closeTabs,
  dirtyCount,
  dirtyKeys,
  emptyTabs,
  navigateTab,
  openTab,
  resetHistory,
  setDirty,
  setTabItem,
  type OpenTabsState,
} from "../lib/openTabs";
import { canBack, canForward, type NavDirection } from "../lib/navHistory";
import { runCloseAll } from "../lib/closeAll";
import { useBackForwardKeys } from "../hooks/useBackForwardKeys";
import EditorTabs, { focusTabFromShortcut, type EditorTabDescriptor } from "./EditorTabs";
import ScratchEditor, { type ScratchDoc, type ScratchEditorHandle } from "./ScratchEditor";
import type { SendDestination } from "../lib/contextMenu";

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
  /** Auto-expiring notice (plan.15 D3: the restore toast is informational). */
  onNotice: (message: string, opts?: { key?: string }) => void;
  onResolve: (key: string) => void;
  /** Report the projects with an open pad tab, so App's unload/reload confirms
   *  can warn before closing one (including a dirty background pad). */
  onOpenScratchChange: (projectIds: string[]) => void;
  /** Plan 17 feature 7: how many open pad tabs carry unsaved edits — the
   *  Scratch page-tab badge. Fires on count changes only. */
  onDirtyCountChange: (n: number) => void;
  /** "Send selection to…" destinations. Both open an UNSAVED, pre-filled draft
   *  targeting the pad's own project and issue no write (D5, §4 L3). */
  onSendToItem: (kind: Kind, projectId: string, body: string) => void;
  onSendToPrompt: (projectId: string, body: string) => void;
  /** F4 (D10): this page's slice of the stored session (null = nothing to
   *  restore), and the go signal (App flips it after the first loadMeta). */
  session: ScratchSlice | null;
  sessionReady: boolean;
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
  onNotice,
  onResolve,
  onOpenScratchChange,
  onDirtyCountChange,
  onSendToItem,
  onSendToPrompt,
  session,
  sessionReady,
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

  // F4 (D10) restore, once, when App signals the loaded catalog is known: open
  // a pad tab per persisted project id still loaded (fetching each scratch.md;
  // failures dropped silently — unlike a rail click, a restore has no one to
  // toast at yet), then re-activate the persisted pad. Restored tabs open
  // clean. `sessionRestored` gates the writer below.
  const restoredRef = useRef(false);
  const [sessionRestored, setSessionRestored] = useState(false);

  // Plan.15 restore bookkeeping (see App.tsx): consumed-once snapshot seeds
  // and the conflict-bar state. Scratch has no orphan case, so no superseded
  // map — the draftId is the project UUID itself.
  const restoredDraftsRef = useRef(new Map<string, Draft>());
  const [conflicts, setConflicts] = useState<Map<string, Draft>>(new Map());
  useEffect(() => {
    for (const key of Array.from(restoredDraftsRef.current.keys()))
      if (!tabs.tabs.some((t) => t.key === key)) restoredDraftsRef.current.delete(key);
    setConflicts((m) => {
      if (![...m.keys()].some((key) => !tabs.tabs.some((t) => t.key === key))) return m;
      const next = new Map(m);
      for (const key of Array.from(next.keys()))
        if (!tabs.tabs.some((t) => t.key === key)) next.delete(key);
      return next;
    });
  }, [tabs]);

  useEffect(() => {
    if (!sessionReady || restoredRef.current) return;
    restoredRef.current = true;
    const s = session;
    const ids = (s?.projectIds ?? []).filter((id) => loaded.some((p) => p.id === id));
    void (async () => {
      const results = await Promise.all(
        ids.map((id) =>
          api.getScratch(id).then(
            (body): ScratchDoc | null => ({ projectId: id, body }),
            (): ScratchDoc | null => null,
          ),
        ),
      );

      // Plan.15 step 17: union in the scratch-surface draft backups. The
      // conflict key is a content hash (scratch has no updatedAt): equal body
      // → clean; hash matches current content → restore; else the D4 bar. A
      // pad we can't read is skipped — never restore over unknown content.
      const drafts = await api.listDrafts().then(
        (list) => list.map(sanitizeDraft).filter((d): d is Draft => d !== null),
        (): Draft[] => [],
      );
      const outcomes = await Promise.all(
        drafts
          .filter((d) => d.surface === "scratch")
          .map(async (d) => {
            const projectLoaded = loaded.some((p) => p.id === d.projectId);
            const current = projectLoaded
              ? await api.getScratch(d.projectId).then(
                  (body): string | null => body,
                  (): string | null => null,
                )
              : null;
            return { draft: d, current, outcome: classifyScratchRestore(d, current, projectLoaded) };
          }),
      );
      const toOpen: Array<{ key: string; doc: ScratchDoc; dirty: boolean }> = [];
      const newConflicts = new Map<string, Draft>();
      let restoredCount = 0;
      for (const { draft, current, outcome } of outcomes) {
        const key = scratchTabKey(draft.projectId);
        switch (outcome) {
          case "skip":
          case "orphan": // unreachable for scratch; keep the switch exhaustive
            break;
          case "clean":
            void api.deleteDraft(draft.draftId).catch(() => {});
            break;
          case "restore": {
            restoredDraftsRef.current.set(key, draft);
            toOpen.push({ key, doc: { projectId: draft.projectId, body: current ?? "" }, dirty: true });
            restoredCount += 1;
            break;
          }
          case "conflict": {
            newConflicts.set(key, draft);
            toOpen.push({ key, doc: { projectId: draft.projectId, body: current ?? "" }, dirty: false });
            break;
          }
        }
      }

      setTabs((prev) => {
        let next = prev;
        for (const doc of results) {
          if (doc) next = openTab(next, scratchTabKey(doc.projectId), doc);
        }
        for (const entry of toOpen) {
          next = openTab(next, entry.key, entry.doc, entry.dirty);
          if (entry.dirty) next = setDirty(next, entry.key, true);
        }
        if (s?.activeProjectId) {
          const key = scratchTabKey(s.activeProjectId);
          if (next.tabs.some((t) => t.key === key)) next = activateTab(next, key);
        }
        // Plan 18: the replayed opens are not a walk the user took — start
        // the Back/Forward history at the restored active pad.
        return resetHistory(next);
      });
      if (newConflicts.size > 0) {
        setConflicts(newConflicts);
        onNotice(
          `${newConflicts.size} scratch pad${newConflicts.size === 1 ? "" : "s"} changed on disk since your unsaved edits — open the tab to choose.`,
          { key: "scratch-draft-conflicts" },
        );
      }
      if (restoredCount > 0) {
        onNotice(
          `Restored unsaved edits to ${restoredCount} scratch pad${restoredCount === 1 ? "" : "s"}.`,
          { key: "scratch-draft-restore" },
        );
      }
      setSessionRestored(true);
    })();
  }, [sessionReady, session, loaded, onNotice]);

  // F4 persistence: this page's slice, debounced ~300 ms; project ids only.
  const openPadProjectIds = useMemo(() => tabs.tabs.map((t) => t.item.projectId), [tabs]);
  useEffect(() => {
    if (!sessionRestored) return;
    const t = window.setTimeout(() => {
      writeSession({
        scratch: {
          projectIds: openPadProjectIds,
          activeProjectId: activeTab(tabs)?.item.projectId ?? null,
        },
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [sessionRestored, openPadProjectIds, tabs]);

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

  // Plan 17 feature 7 (D9): dirty pad tabs (keyed `scratch-<projectId>`, the
  // rail's row key) and their count for the page-tab badge.
  const scratchDirtyKeys = useMemo(() => dirtyKeys(tabs), [tabs]);
  const scratchDirtyN = useMemo(() => dirtyCount(tabs), [tabs]);
  useEffect(() => {
    onDirtyCountChange(scratchDirtyN);
  }, [scratchDirtyN, onDirtyCountChange]);

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

  // Plan 18 "Close all" for the pad strip — App.tsx's flow, pad-shaped (D1/D2,
  // R-4/R-5): Q1, then Q2 Save/Discard for the dirty pads. A pad is never a
  // never-saved draft (one pad per project, always backed by scratch.md), so
  // the per-draft confirm is unreachable and answers "keep" if it ever fires.
  const closingAllRef = useRef(false);
  function requestCloseAll() {
    if (closingAllRef.current) return;
    closingAllRef.current = true;
    void (async () => {
      try {
        const open = tabsRef.current.tabs;
        const { closed, kept } = await runCloseAll({
          tabs: open.map((t) => ({ key: t.key, isDirty: t.isDirty, isDraft: false })),
          confirm: api.confirmDialog,
          save: async (k) => (await editorRefs.current.get(k)?.save()) ?? false,
          discard: async (k) => {
            await editorRefs.current.get(k)?.discardDraft();
          },
          activate: (k) => setTabs((s) => activateTab(s, k)),
          confirmDraft: () => Promise.resolve(false),
        });
        if (closed.length === 0) return; // cancelled, or nothing could close
        setTabs((s) => closeTabs(s, closed));
        closed.forEach((k) => editorRefs.current.delete(k));
        if (kept.length > 0) {
          onNotice(
            `${kept.length} tab${kept.length === 1 ? "" : "s"} stayed open: unsaved or save failed.`,
            { key: "close-all-kept" },
          );
        }
      } finally {
        closingAllRef.current = false;
      }
    })();
  }

  // Plan 18 Back/Forward over this strip (see App.tsx); the shortcut hook is
  // enabled only while the Scratch page is visible with pads open.
  function navigateHistory(dir: NavDirection, fromShortcut: boolean) {
    if (closingAllRef.current) return; // R-8
    const preview = navigateTab(tabsRef.current, dir);
    if (preview === tabsRef.current) return;
    setTabs((s) => navigateTab(s, dir));
    if (fromShortcut && preview.activeKey) focusTabFromShortcut(preview.activeKey);
  }
  useBackForwardKeys({
    enabled: pageActive && tabs.tabs.length > 0,
    onBack: () => navigateHistory("back", true),
    onForward: () => navigateHistory("forward", true),
  });

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
          // (a successful save cleared the draft backup itself)
        } else {
          // Plan.15 §4.3: the Discard branch clears the on-disk backup too.
          await editorRefs.current.get(key)?.discardDraft();
        }
      }
      closeTabByKey(key);
    })();
  }

  // Plan 18 D6 (supersedes plan.13 D5): a MOVE — the pad's own editor removed
  // the text before calling this. Disclose it (the native menu labels still
  // read "New … from selection"); the toast shows on the destination page.
  function sendTo(projectId: string, dest: SendDestination, text: string) {
    if (dest === "prompt") onSendToPrompt(projectId, text);
    else onSendToItem(dest, projectId, text);
    onNotice(
      "Moved the selection out of the scratch pad — it stays unsaved; Ctrl+Z in the pad puts the text back.",
      { key: "scratch-moved" },
    );
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
                  {scratchDirtyKeys.has(scratchTabKey(p.id)) && (
                    <>
                      <span className="etab-unsaved" aria-hidden="true" title="Unsaved changes" />
                      <span className="sr-only">, unsaved changes</span>
                    </>
                  )}
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
            onCloseAll={requestCloseAll}
            closeAllLabel="Close all open scratch pads"
            onBack={() => navigateHistory("back", false)}
            onForward={() => navigateHistory("forward", false)}
            canBack={canBack(tabs.history)}
            canForward={canForward(tabs.history)}
          />
          {tabs.tabs.map((t) => {
            const conflict = conflicts.get(t.key);
            return (
              <Fragment key={t.key}>
              {conflict && (
                <DraftConflictBar
                  title={`${projectName(t.item.projectId)} scratch pad`}
                  hidden={t.key !== tabs.activeKey}
                  onKeep={() => {
                    void api.deleteDraft(conflict.draftId).catch(() => {});
                    setConflicts((m) => {
                      const next = new Map(m);
                      next.delete(t.key);
                      return next;
                    });
                  }}
                  onRestore={() => {
                    editorRefs.current.get(t.key)?.applyDraft(conflict);
                    setConflicts((m) => {
                      const next = new Map(m);
                      next.delete(t.key);
                      return next;
                    });
                  }}
                />
              )}
              <ScratchEditor
                ref={(h) => {
                  if (h) editorRefs.current.set(t.key, h);
                  else editorRefs.current.delete(t.key);
                }}
                tabKey={t.key}
                restoredDraft={restoredDraftsRef.current.get(t.key) ?? null}
                hidden={t.key !== tabs.activeKey}
                active={pageActive && t.key === tabs.activeKey}
                doc={t.item}
                onDirtyChange={(dirty) => setTabs((s) => setDirty(s, t.key, dirty))}
                onSave={(body) => savePad(t.key, t.item.projectId, body)}
                onSendTo={(dest, text) => sendTo(t.item.projectId, dest, text)}
                onError={onError}
                onResolve={onResolve}
              />
              </Fragment>
            );
          })}
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
