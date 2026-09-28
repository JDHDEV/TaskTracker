import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Draft, ProviderId } from "../types";
import { aiRewriteStream, confirmDialog, onContextMenuAction } from "../lib/api";
import {
  sendDestinationOf,
  type ContextMenuAction,
  type SendDestination,
} from "../lib/contextMenu";
import { formatTimestamp, insertText } from "../lib/timestamp";
import { isUndoKey, restoreMove, type MoveRecord } from "../lib/moveUndo";
import { buildScratchDraft, contentHash } from "../lib/drafts";
import { useDraftBackup } from "../hooks/useDraftBackup";
import { reportAiError } from "../lib/aiErrors";
import { handleLineClipboardKeyDown, handleLinePaste } from "../lib/lineEdit";
import { selectionConfirmMessage, shouldClearInstruction } from "../lib/rework";
import { tabDomId, tabPanelDomId } from "../lib/openTabs";
import {
  captureSelection,
  isSelectionStale,
  pickHighlight,
  spliceProposal,
  type CapturedSelection,
  type SelectionRange,
} from "../lib/selection";
import AiBar from "./AiBar";
import ReviewCard from "./ReviewCard";
import SelectionBackdrop from "./SelectionBackdrop";

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
  /** True only when persisted AND clean afterwards (plan 19 D0, §12). */
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
   *  project. A MOVE (plan 18 D6, superseding plan 13 D5's copy): the editor
   *  has already removed `text` from the pad and the pad is dirty; Ctrl+Z in
   *  the pad puts it back (the pad's own move record, see `lastMoveRef`);
   *  nothing is written until the destination's own Save (and the pad's
   *  `scratch.md` until the pad's own Save). */
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
  // Plan 19 (D0): edit sequence — save() marks clean only if it is unchanged
  // since the save began (see Editor.tsx).
  const editSeqRef = useRef(0);
  const lastSaveKeptDirtyRef = useRef(false); // reported by the handle's save() (§12)
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
  // `focus: false` (plan 18) places the caret WITHOUT pulling focus back — the
  // scratch-move fallback sets it while the page is switching away.
  const pendingCaretRef = useRef<(SelectionRange & { focus?: boolean }) | null>(null);
  // Plan 18 (§12): the last "send selection to…" move, so Ctrl+Z in the pad
  // can put the text back even after typing in the destination (the window
  // shares one native undo stack). Stale — and ignored — once the pad's body
  // differs from what the move left; cleared on reseed.
  const lastMoveRef = useRef<MoveRecord | null>(null);

  // Plan 17 (D2–D5) — the Editor.tsx wiring: controlled instruction (+ live
  // ref mirror), the request-time capture `reworkRequest`, and the
  // selection-confirm range + guard (kept apart from `selectionRework` so an
  // open card is never disturbed by a cancelled confirm — see Editor.tsx).
  const [instruction, setInstruction] = useState("");
  const instructionRef = useRef(instruction);
  useEffect(() => {
    instructionRef.current = instruction;
  }, [instruction]);
  const [reworkRequest, setReworkRequest] = useState<{
    original: string;
    instruction: string;
  } | null>(null);
  const [confirmingSel, setConfirmingSel] = useState<CapturedSelection | null>(null);
  const confirmingRef = useRef(false);
  // Plan 19 (D1): the range held when the body lost focus — the lowest-
  // precedence highlight source; cleared on focus, by clearSelection and by
  // the reseed (see Editor.tsx).
  const [blurSel, setBlurSel] = useState<CapturedSelection | null>(null);
  // The selection-highlight mirror (Phase 4), scroll-synced from the textarea.
  const hlRef = useRef<HTMLDivElement>(null);

  function trackSelection() {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    selRef.current = start === end ? null : { start, end };
    const len = captureSelection(selRef.current, body)?.text.length ?? 0;
    if (len !== selectionLength) setSelectionLength(len);
  }

  function syncHighlightScroll() {
    if (hlRef.current && bodyRef.current) hlRef.current.scrollTop = bodyRef.current.scrollTop;
  }

  function clearSelection() {
    selRef.current = null;
    setSelectionLength(0);
    setBlurSel(null);
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
      if (c.focus !== false) bodyRef.current.focus();
      bodyRef.current.setSelectionRange(c.start, c.end);
    }
  }, [body]);

  // Plan.16 D6: a native context-menu item was chosen while THIS pad is the
  // focused textarea (hidden pads stay mounted, so activeElement targets).
  // "Insert timestamp" rides edit() + pendingCaretRef like a line paste. The
  // send-to items re-read the LIVE selection at action time (bounds-checked,
  // whitespace-only rejected — the same gate as a selection rework), REMOVE it
  // from the pad, then hand the text up — a move, not a copy (plan 18 D6,
  // superseding plan 13 D5). The removal is a native `execCommand("delete")`
  // on the still-focused textarea: its `input` event runs the ordinary
  // onChange → edit() + clearSelection() path (dirty flag, draft backup) while
  // the textarea's own undo stack survives, so Ctrl+Z in the pad puts the text
  // back (R-2). It runs BEFORE onSendTo because the hand-off hides the pad and
  // moves focus in the same batch — and the hand-off cannot fail (both
  // destinations are synchronous state updates, R-1). Nothing on disk changes
  // until the pad's own Save. If execCommand reports failure the state path
  // takes over with a caret that does not pull focus back.
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
    // Exactly the captured range (captureSelection read it from ta.value).
    ta.setSelectionRange(sel.start, sel.end);
    const removed = document.execCommand("delete");
    // execCommand is synchronous: on success ta.value is already the cut body.
    let bodyAfter: string | null = removed ? ta.value : null;
    if (!removed) {
      const r = insertText(ta.value, sel, "");
      if (r) {
        edit(r.body);
        clearSelection();
        pendingCaretRef.current = { start: r.caret, end: r.caret, focus: false };
        bodyAfter = r.body;
      }
    }
    if (bodyAfter !== null) lastMoveRef.current = { start: sel.start, text: sel.text, bodyAfter };
    onSendTo(dest, sel.text);
  }
  const contextMenuRef = useRef(handleContextMenuAction);
  contextMenuRef.current = handleContextMenuAction;
  useEffect(() => onContextMenuAction((a) => contextMenuRef.current(a)), []);

  useImperativeHandle(ref, () => ({
    save: async () => (await save()) && !lastSaveKeptDirtyRef.current,
    applyDraft: (snapshot: Draft) => {
      setBody(snapshot.body);
      // Plan 19 (R-8): a programmatic body change invalidates the tracked offsets
      clearSelection();
      setDirty(true);
      lastEditRef.current = Date.now();
      editSeqRef.current += 1; // Plan 19 (D0): a restore is a buffered change too
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
    setBlurSel(null);
    setSelectionLength(0);
    pendingCaretRef.current = null;
    lastMoveRef.current = null;
    // Deliberately NOT `setInstruction("")` — a pad instance never changes
    // project, so the only pass here is the mount (plan 17 §12 F13).
    setReworkRequest(null);
    setConfirmingSel(null);
    confirmingRef.current = false;
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
    const seqAtSave = editSeqRef.current; // Plan 19 (D0)
    setSaving(true);
    try {
      const saved = await onSave(overrides?.body ?? body);
      // Plan 19 (D0): an edit landed while the save was running — stay dirty,
      // keep the backup; the next save persists it.
      lastSaveKeptDirtyRef.current = saved && editSeqRef.current !== seqAtSave;
      if (saved && !lastSaveKeptDirtyRef.current) {
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
    const sel = captureSelection(selRef.current, body);
    const text = sel ? sel.text : body;
    if (!text.trim()) {
      onError("There is no text to rework yet.", { key: "scratch-no-text" });
      return;
    }
    // Plan 17 D5: confirm a SELECTION rework before the draft flush and any
    // IPC (Cancel changes nothing); highlight behind the dialog; re-check the
    // range after OK; reset the guard on every exit path (see Editor.tsx).
    if (sel) {
      if (confirmingRef.current) return;
      confirmingRef.current = true;
      setConfirmingSel(sel);
      try {
        const msg = selectionConfirmMessage(sel.text.length, instruction);
        const ok = await confirmDialog(msg.message, {
          okLabel: msg.okLabel,
          cancelLabel: msg.cancelLabel,
          kind: "info",
        });
        if (!ok) return;
        if (isSelectionStale(bodyRef.current?.value ?? body, sel)) {
          onError("The selected text changed — select it again.", {
            key: "scratch-selection-changed",
          });
          return;
        }
      } catch (err) {
        onError(String(err));
        return;
      } finally {
        confirmingRef.current = false;
        setConfirmingSel(null);
      }
    }
    void draftBackup.flushNow(); // plan.15 D6: snapshot before an AI entry point
    stopRef.current?.();
    setAiBusy(true);
    setStreaming(true);
    setProposal("");
    setSelectionRework(sel);
    // Plan 17 D4: the request-time original + the instruction that was sent.
    setReworkRequest({ original: text, instruction });

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
      // Plan 17 step 6: a failed stream leaves no selection mode behind.
      setSelectionRework(null);
      setReworkRequest(null);
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
    setReworkRequest(null); // the instruction stays in the box (D3)
    setStreaming(false);
    setAiBusy(false);
  }

  function edit(value: string) {
    setBody(value);
    setDirty(true);
    // The buffered-edit chokepoint — the draft backup keys off it (plan.15 D6).
    lastEditRef.current = Date.now();
    editSeqRef.current += 1;
  }

  const stale = selectionRework !== null && isSelectionStale(body, selectionRework);
  // Plan 17 D6 / R-6: the highlight mirror shows only while the range is valid
  // and a selection rework is confirming or pending — or, plan 19 (D2), while
  // the body is unfocused with a tracked range (see Editor.tsx).
  const highlightSel = pickHighlight(
    confirmingSel,
    proposal !== null ? selectionRework : null,
    blurSel,
  );
  const showHighlight = highlightSel !== null && !isSelectionStale(body, highlightSel);
  useLayoutEffect(() => {
    if (showHighlight) syncHighlightScroll();
  }, [showHighlight]);

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
        instruction={instruction}
        onInstructionChange={setInstruction}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
        selectionLength={selectionLength}
        onClearSelection={clearSelection}
      />

      {proposal !== null && (
        <ReviewCard
          ariaLabel={selectionRework ? "AI selection rewrite proposal" : "AI rewrite proposal"}
          chipLabel={
            streaming
              ? "Streaming…"
              : selectionRework
                ? "Proposed rewrite (selection)"
                : "Proposed rewrite"
          }
          proposal={proposal}
          streaming={streaming}
          original={reworkRequest?.original ?? null}
          editedSinceRequest={
            selectionRework === null && reworkRequest !== null && body !== reworkRequest.original
          }
          replaceDisabled={streaming || saving || stale}
          replaceTitle={stale ? "The selected text changed — discard and rework again." : undefined}
          onReplaceText={async () => {
            // The ONLY splice site (§4 H4): into the captured range or not at all.
            const next = selectionRework
              ? spliceProposal(body, selectionRework, proposal)
              : { ok: true as const, body: proposal, caret: null };
            if (!next.ok) return;
            edit(next.body);
            pendingCaretRef.current = next.caret;
            // Plan 19 (R-8): a programmatic body change invalidates the tracked
            // offsets (the selection splice re-selects via pendingCaretRef).
            if (next.caret === null) clearSelection();
            const ok = await save({ body: next.body });
            if (ok) {
              setProposal(null);
              setSelectionRework(null);
              // D3: empty the box only while it still holds the sent
              // instruction (read live — the closure predates the save).
              if (
                reworkRequest &&
                shouldClearInstruction(instructionRef.current, reworkRequest.instruction)
              ) {
                setInstruction("");
              }
              setReworkRequest(null);
            }
          }}
          onDiscard={discardProposal}
          statusMessage={
            streaming
              ? "Streaming rewrite"
              : selectionRework
                ? "Selection rewrite ready"
                : "Rewrite ready"
          }
        />
      )}

      {/* Permanent wrapper (plan 17 D6) — see Editor.tsx. */}
      <div className="body-wrap">
        {showHighlight && (
          <SelectionBackdrop body={body} sel={highlightSel} hlRef={hlRef} />
        )}
        <textarea
          className={showHighlight ? "body body-transparent" : "body"}
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
          onScroll={syncHighlightScroll}
          // Plan 19 (D1): focus back → the native selection paints again.
          onFocus={() => setBlurSel(null)}
          // Plan.15 D6: leaving the field is a natural checkpoint — flush now.
          // Plan 19 (D1): then re-read the live range and keep it marked.
          onBlur={() => {
            void draftBackup.flushNow();
            trackSelection();
            setBlurSel(captureSelection(selRef.current, body));
          }}
          // F6 (D9): whole-line Ctrl+X/C/V on a collapsed selection — keyboard
          // only. Right-click is WebView2's own menu, which carries the app's
          // items ("Insert timestamp", the send-to entries) injected from Rust
          // (plan.16); the app draws no menu of its own.
          onKeyDown={(e) => {
            const ta = bodyRef.current;
            if (!ta) return;
            // Plan 18 (§12): Ctrl+Z after a "send selection to…" move puts the
            // moved text back from the pad's own record while the pad is
            // unchanged since — native undo alone would first unwind whatever
            // was typed in the destination (one undo stack per window). A
            // stale record yields null and the key falls through to native undo.
            if (isUndoKey(e)) {
              const r = restoreMove(ta.value, lastMoveRef.current);
              if (r) {
                e.preventDefault();
                lastMoveRef.current = null;
                edit(r.body);
                clearSelection();
                pendingCaretRef.current = r.caret; // re-select the restored text
                return;
              }
            }
            handleLineClipboardKeyDown(e, ta);
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
      </div>
    </section>
  );
});

export default ScratchEditor;
