import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { ProviderId } from "../types";
import { aiRewriteStream } from "../lib/api";
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
import SelectionMenu, { type SendDestination } from "./SelectionMenu";

/** One project's scratch pad: the owning project and the pad text as last
 *  read from / saved to its `scratch.md`. */
export interface ScratchDoc {
  projectId: string;
  body: string;
}

/** Imperative handle: lets ScratchPage persist a background (non-active) pad
 *  tab from the close-dirty "Save" branch (its buffer lives only here). */
export interface ScratchEditorHandle {
  save: () => Promise<boolean>;
}

interface Props {
  doc: ScratchDoc;
  /** This tab's identity key — derives the tab/panel ARIA ids. */
  tabKey: string;
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
 *  and no R4), the body textarea with rework-on-selection, and the right-click
 *  `SelectionMenu` for a non-empty selection. */
const ScratchEditor = forwardRef<ScratchEditorHandle, Props>(function ScratchEditor(
  { doc, tabKey, hidden, active, onDirtyChange, onSave, onSendTo, onError, onResolve }: Props,
  ref,
) {
  const [body, setBody] = useState(doc.body);
  const [dirty, setDirty] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Backend-cancel handle for the in-flight stream (null when none).
  const stopRef = useRef<(() => void) | null>(null);
  // Blocks save re-entry (a second Ctrl+S while a save is in flight).
  const savingRef = useRef(false);

  // Rework on a selection — the same plumbing as Editor/PromptEditor.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const selRef = useRef<SelectionRange | null>(null);
  const [selectionLength, setSelectionLength] = useState(0);
  const [selectionRework, setSelectionRework] = useState<CapturedSelection | null>(null);
  const pendingCaretRef = useRef<SelectionRange | null>(null);

  // Context menu: open at the pointer for a non-empty selection. The selection
  // it acts on is captured at right-click time (the highlight is lost when
  // focus moves into the menu; the offsets are not).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuSelRef = useRef<CapturedSelection | null>(null);

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

  useImperativeHandle(ref, () => ({ save: () => save() }));

  const reportedDirty = useRef(dirty);
  useEffect(() => {
    if (reportedDirty.current !== dirty) {
      reportedDirty.current = dirty;
      onDirtyChange(dirty);
    }
  }, [dirty, onDirtyChange]);

  // Re-seed when the tab is (re)opened for a project. A successful Save updates
  // `doc.body` with the same projectId, so this deliberately does NOT re-fire
  // then (it would clobber edits typed during the save). Navigating away
  // mid-stream stops the backend stream.
  useEffect(() => {
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
    setMenu(null);
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
      if (saved) setDirty(false); // a rejected save stays dirty → "Save"
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
  }

  // Right-click: a non-empty, non-whitespace selection opens the custom menu;
  // anything else falls through to the native WebView2 menu (the field's only
  // Cut/Copy/Paste path). Shift+F10 / the ContextMenu key fire the same event.
  function onContextMenu(e: MouseEvent<HTMLTextAreaElement>) {
    const ta = bodyRef.current;
    if (!ta) return;
    const sel = captureSelection({ start: ta.selectionStart, end: ta.selectionEnd }, body);
    if (sel === null) return;
    e.preventDefault();
    menuSelRef.current = sel;
    setMenu({ x: e.clientX, y: e.clientY });
  }

  // Every close path (action, Escape, outside mousedown) restores focus AND the
  // range — usePopover only refocuses the trigger.
  function closeMenu() {
    setMenu(null);
    const sel = menuSelRef.current;
    const ta = bodyRef.current;
    if (ta) {
      ta.focus();
      if (sel) ta.setSelectionRange(sel.start, sel.end);
    }
  }

  function sendTo(dest: SendDestination) {
    const sel = menuSelRef.current;
    closeMenu();
    if (sel) onSendTo(dest, sel.text);
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
        placeholder="Scratch space for this project. Select text and right-click to send it somewhere."
        onChange={(e) => {
          edit(e.target.value);
          clearSelection(); // a manual edit invalidates the tracked offsets
        }}
        onSelect={trackSelection}
        onKeyUp={trackSelection}
        onMouseUp={trackSelection}
        onContextMenu={onContextMenu}
        // F6 (D9): whole-line Ctrl+X/C/V on a collapsed selection. The native
        // right-click menu path is untouched — this is keyboard-only.
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

      <SelectionMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        anchor={bodyRef}
        onClose={closeMenu}
        onSendTo={sendTo}
      />
    </section>
  );
});

export default ScratchEditor;
