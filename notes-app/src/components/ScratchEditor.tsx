import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Draft, ProviderId } from "../types";
import { aiRewriteStream, onContextMenuAction } from "../lib/api";
import {
  sendDestinationOf,
  type ContextMenuAction,
  type SendDestination,
} from "../lib/contextMenu";
import { formatTimestamp, insertText } from "../lib/timestamp";
import { buildScratchDraft, contentHash } from "../lib/drafts";
import { useDraftBackup } from "../hooks/useDraftBackup";
import { reportAiError } from "../lib/aiErrors";
import { handleLineClipboardKeyDown, handleLinePaste } from "../lib/lineEdit";
import { tabDomId, tabPanelDomId } from "../lib/openTabs";
import {
  captureSelection,
  isSelectionStale,
  spliceProposal,
  type CapturedSelection,
  type SelectionRange,
} from "../lib/selection";
import AiBar from "./AiBar";

/** One project's scratch pad: the owning project and the pad text as last
 *  read from / saved to its `scratch.md`. */
export interface ScratchDoc {
  projectId: string;
  body: string;
}

/** Imperative handle: lets ScratchPage persist a background (non-active) pad
 *  tab from the close-dirty "Save" branch (its buffer lives only here).
 *  Plan.15 adds the draft-backup verbs (see EditorHandle in Editor.tsx). */
export interface ScratchEditorHandle {
  save: () => Promise<boolean>;
  applyDraft: (snapshot: Draft) => void;
  flushDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
}

interface Props {
  doc: ScratchDoc;
  /** This tab's identity key — derives the tab/panel ARIA ids. */
  tabKey: string;
  /** Boot-restore seed (plan.15 D5): mounts the buffer from this snapshot,
   *  DIRTY. Consumed at mount only. The scratch draftId is the project UUID
   *  (doc.projectId), so no separate prop is needed. */
  restoredDraft?: Draft | null;
  /** Mounted but display:none (preserving its buffer/stream). */
  hidden: boolean;
  /** The visible, active pad tab (active tab AND the Scratch page visible) —
   *  gates the window Ctrl+S listener so only ONE editor saves across the item,
   *  prompt, and scratch tabs that are all mounted at once. */
  active: boolean;
  /** Fires on dirty↔clean transitions only, driving the tab's unsaved dot. */
  onDirtyChange: (dirty: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
  /** "Send selection to…": open a pre-filled draft of `dest` in the pad's own
   *  project. Copy, not cut — the pad text is untouched, and nothing is written
   *  until the destination's own Save (D5). */
  onSendTo: (dest: SendDestination, text: string) => void;
  onError: (message: string, opts?: { key?: string }) => void;
  onResolve: (key: string) => void;
}

/** The title-less pad editor: AiBar (explicit Save, D3), the review card (the
 *  proposal half only — copied from PromptEditor; a pad has no title, so no R1
 *  and no R4), and the body textarea with rework-on-selection. Right-click is
 *  the native WebView2 menu, carrying the send-to items and "Insert timestamp"
 *  injected from Rust (plan.16). */
const ScratchEditor = forwardRef<ScratchEditorHandle, Props>(function ScratchEditor(
  {
    doc,
    tabKey,
    restoredDraft = null,
    hidden,
    active,
    onDirtyChange,
    onSave,
    onSendTo,
    onError,
    onResolve,
  }: Props,
  ref,
) {
  // Plan.15 D3/D5: a boot-restored draft seeds the INITIAL buffer, dirty; the
  // reseed effect below is guarded so its mount pass can't wipe this.
  const [body, setBody] = useState(restoredDraft ? restoredDraft.body : doc.body);
  const [dirty, setDirty] = useState(restoredDraft !== null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Backend-cancel handle for the in-flight stream (null when none).
  const stopRef = useRef<(() => void) | null>(null);
  // Blocks save re-entry (a second Ctrl+S while a save is in flight).
  const savingRef = useRef(false);

  // --- Draft backup (plan.15 step 16) — the shared wiring, scratch-shaped:
  // draftId = the project UUID (one pad, one draft per project); the conflict
  // key is a content hash of the base (scratch has no updatedAt).
  const lastEditRef = useRef(0);
  const snapshotRef = useRef<() => Draft | null>(() => null);
  useEffect(() => {
    snapshotRef.current = () => {
      if (body === doc.body) return null;
      return buildScratchDraft(doc.projectId, contentHash(doc.body), body);
    };
  });
  const draftBackup = useDraftBackup({
    draftId: doc.projectId,
    dirty,
    active,
    getSnapshot: snapshotRef,
    lastEditRef,
  });

  // Rework on a selection — the same plumbing as Editor/PromptEditor.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const selRef = useRef<SelectionRange | null>(null);
  const [selectionLength, setSelectionLength] = useState(0);
  const [selectionRework, setSelectionRework] = useState<CapturedSelection | null>(null);
  const pendingCaretRef = useRef<SelectionRange | null>(null);

  function trackSelection() {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    selRef.current = start === end ? null : { start, end };
    const len = captureSelection(selRef.current, body)?.text.length ?? 0;
    if (len !== selectionLength) setSelectionLength(len);
  }

  function clearSelection() {
    selRef.current = null;
    setSelectionLength(0);
    const ta = bodyRef.current;
    if (ta) {
      const pos = ta.selectionEnd;
      ta.setSelectionRange(pos, pos);
    }
  }

  useLayoutEffect(() => {
    const c = pendingCaretRef.current;
    if (c && bodyRef.current) {
      pendingCaretRef.current = null;
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(c.start, c.end);
    }
  }, [body]);

  // Plan.16 D6: a native context-menu item was chosen while THIS pad is the
  // focused textarea (hidden pads stay mounted, so activeElement targets).
  // "Insert timestamp" rides edit() + pendingCaretRef like a line paste. The
  // send-to items re-read the LIVE selection at action time (bounds-checked,
  // whitespace-only rejected — the same gate as a selection rework) and hand
  // the text up; copy, not cut, and nothing is written until the destination's
  // own Save (plan.13 D5).
  function handleContextMenuAction(action: ContextMenuAction) {
    const ta = bodyRef.current;
    if (!ta || document.activeElement !== ta) return;
    if (action === "insert-timestamp") {
      const r = insertText(
        ta.value,
        { start: ta.selectionStart, end: ta.selectionEnd },
        formatTimestamp(new Date()),
      );
      if (!r) return;
      edit(r.body);
      clearSelection();
      pendingCaretRef.current = { start: r.caret, end: r.caret };
      return;
    }
    const dest = sendDestinationOf(action);
    if (dest === null) return;
    const sel = captureSelection({ start: ta.selectionStart, end: ta.selectionEnd }, ta.value);
    if (!sel) return;
    onSendTo(dest, sel.text);
  }
  const contextMenuRef = useRef(handleContextMenuAction);
  contextMenuRef.current = handleContextMenuAction;
  useEffect(() => onContextMenuAction((a) => contextMenuRef.current(a)), []);

  useImperativeHandle(ref, () => ({
    save: () => save(),
    applyDraft: (snapshot: Draft) => {
      setBody(snapshot.body);
      setDirty(true);
      lastEditRef.current = Date.now();
    },
    flushDraft: () => draftBackup.flushNow(),
    discardDraft: () => draftBackup.discard(),
  }));

  const reportedDirty = useRef(dirty);
  useEffect(() => {
    if (reportedDirty.current !== dirty) {
      reportedDirty.current = dirty;
      onDirtyChange(dirty);
    }
  }, [dirty, onDirtyChange]);

  // Plan.15 step 16 reseed guard — identical to Editor.tsx's: this effect also
  // runs on MOUNT, where it would wipe a restoredDraft-seeded buffer back to
  // the pad's saved content. Identity-compared (StrictMode-safe).
  const draftSeedRef = useRef(restoredDraft ? doc.projectId : null);

  // Re-seed when the tab is (re)opened for a project. A successful Save updates
  // `doc.body` with the same projectId, so this deliberately does NOT re-fire
  // then (it would clobber edits typed during the save). Navigating away
  // mid-stream stops the backend stream.
  useEffect(() => {
    if (draftSeedRef.current === doc.projectId) {
      return () => {
        stopRef.current?.();
        stopRef.current = null;
      };
    }
    draftSeedRef.current = null; // identity moved on — normal reseeds from here
    setBody(doc.body);
    setDirty(false);
    setProposal(null);
    setStreaming(false);
    setAiBusy(false);
    setSaving(false);
    savingRef.current = false;
    setSelectionRework(null);
    selRef.current = null;
    setSelectionLength(0);
    pendingCaretRef.current = null;
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [doc.projectId]);

  // Resolve-on-condition: clear the keyed "no text" toast once text exists.
  useEffect(() => {
    if (body.trim()) onResolve("scratch-no-text");
  }, [body, onResolve]);

  async function save(overrides?: { body?: string }): Promise<boolean> {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await onSave(overrides?.body ?? body);
      if (saved) {
        setDirty(false); // a rejected save stays dirty → "Save"
        draftBackup.clearAfterSave(); // scratch.md owns the content now
      }
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S — gated on `active` so exactly one editor saves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (!active) return;
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function rework(instruction: string, provider: ProviderId) {
    void draftBackup.flushNow(); // plan.15 D6: snapshot before an AI entry point
    const sel = captureSelection(selRef.current, body);
    const text = sel ? sel.text : body;
    if (!text.trim()) {
      onError("There is no text to rework yet.", { key: "scratch-no-text" });
      return;
    }
    stopRef.current?.();
    setAiBusy(true);
    setStreaming(true);
    setProposal("");
    setSelectionRework(sel);

    let cancelled = false;
    const requestId = crypto.randomUUID();
    const { result, cancel } = aiRewriteStream(
      { requestId, provider, text, instruction },
      (delta) => {
        if (cancelled) return;
        setProposal((prev) => (prev ?? "") + delta);
      },
    );
    const stop = () => {
      cancelled = true;
      cancel();
    };
    stopRef.current = stop;

    try {
      const finalText = await result;
      if (cancelled) return;
      setProposal(finalText);
    } catch (err) {
      if (cancelled) return;
      setProposal(null);
      await reportAiError(provider, err, onError); // keyed when no key stored (F5)
    } finally {
      if (!cancelled) {
        setStreaming(false);
        setAiBusy(false);
        if (stopRef.current === stop) stopRef.current = null;
      }
    }
  }

  function discardProposal() {
    stopRef.current?.();
    stopRef.current = null;
    setProposal(null);
    setSelectionRework(null);
    setStreaming(false);
    setAiBusy(false);
  }

  function edit(value: string) {
    setBody(value);
    setDirty(true);
    // The buffered-edit chokepoint — the draft backup keys off it (plan.15 D6).
    lastEditRef.current = Date.now();
  }

  const stale = selectionRework !== null && isSelectionStale(body, selectionRework);

  return (
    <section
      // F3 (D2): frame the pane while there are unsaved changes.
      className={dirty ? "editor is-dirty" : "editor"}
      role="tabpanel"
      hidden={hidden}
      id={tabPanelDomId(tabKey)}
      aria-labelledby={tabDomId(tabKey)}
    >
      <AiBar
        busy={aiBusy}
        dirty={dirty}
        generatingTitle={false}
        saveBlocked={false}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
        selectionLength={selectionLength}
        onClearSelection={clearSelection}
      />

      {proposal !== null && (
        <div
          className="review"
          role="region"
          aria-label={selectionRework ? "AI selection rewrite proposal" : "AI rewrite proposal"}
        >
          <div className="review-head">
            <span className="review-mark">
              {streaming
                ? "Streaming…"
                : selectionRework
                  ? "Proposed rewrite (selection)"
                  : "Proposed rewrite"}
            </span>
            <button
              className="btn"
              disabled={streaming || saving || stale}
              title={stale ? "The selected text changed — discard and rework again." : undefined}
              onClick={async () => {
                // The ONLY splice site (§4 H4): into the captured range or not at all.
                const next = selectionRework
                  ? spliceProposal(body, selectionRework, proposal)
                  : { ok: true as const, body: proposal, caret: null };
                if (!next.ok) return;
                edit(next.body);
                pendingCaretRef.current = next.caret;
                const ok = await save({ body: next.body });
                if (ok) {
                  setProposal(null);
                  setSelectionRework(null);
                }
              }}
            >
              Replace text
            </button>
            <button className="btn btn-quiet" onClick={discardProposal}>
              Discard
            </button>
          </div>
          <pre className="review-body">{proposal}</pre>
          <span className="sr-only" role="status" aria-live="polite">
            {streaming
              ? "Streaming rewrite"
              : selectionRework
                ? "Selection rewrite ready"
                : "Rewrite ready"}
          </span>
        </div>
      )}

      <textarea
        className="body"
        ref={bodyRef}
        value={body}
        // Plan.16 D4: the pad surface — "Insert timestamp" plus, on a
        // non-empty selection, the three send-to items, all on the native menu.
        data-menu-surface="scratch"
        placeholder="Scratch space for this project. Select text and right-click to send it somewhere."
        onChange={(e) => {
          edit(e.target.value);
          clearSelection(); // a manual edit invalidates the tracked offsets
        }}
        onSelect={trackSelection}
        onKeyUp={trackSelection}
        onMouseUp={trackSelection}
        // Plan.15 D6: leaving the field is a natural checkpoint — flush now.
        onBlur={() => void draftBackup.flushNow()}
        // F6 (D9): whole-line Ctrl+X/C/V on a collapsed selection — keyboard
        // only. Right-click is WebView2's own menu, which carries the app's
        // items ("Insert timestamp", the send-to entries) injected from Rust
        // (plan.16); the app draws no menu of its own.
        onKeyDown={(e) => {
          if (bodyRef.current) handleLineClipboardKeyDown(e, bodyRef.current);
        }}
        onPaste={(e) => {
          const ta = bodyRef.current;
          if (!ta) return;
          handleLinePaste(e, ta, (nextBody, caret) => {
            edit(nextBody);
            clearSelection();
            pendingCaretRef.current = { start: caret, end: caret };
          });
        }}
      />
    </section>
  );
});

export default ScratchEditor;
