import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  Draft,
  NewPrompt,
  ProjectInfo,
  Prompt,
  PromptSource,
  ProviderId,
  UpdatePrompt,
} from "../types";
import { aiRewriteStream, confirmDialog, copyToClipboard, onContextMenuAction } from "../lib/api";
import type { ContextMenuAction } from "../lib/contextMenu";
import { formatTimestamp, insertText } from "../lib/timestamp";
import { buildPromptDraft } from "../lib/drafts";
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
import { usePopover } from "../hooks/usePopover";
import AiBar from "./AiBar";
import PromptHistoryDialog from "./PromptHistoryDialog";

/** Imperative handle: lets the parent persist a background (non-active) prompt
 *  tab from the close-dirty "Save" branch (its buffer lives only here).
 *  Plan.15 adds the draft-backup verbs (see EditorHandle in Editor.tsx). */
export interface PromptEditorHandle {
  save: () => Promise<boolean>;
  applyDraft: (snapshot: Draft) => void;
  flushDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
}

interface Props {
  prompt: Prompt;
  isDraft: boolean;
  /** The loaded project catalog (from PromptsPage) — the move-target choices are
   *  the loaded projects other than this prompt's own. */
  loaded: ProjectInfo[];
  /** This tab's identity key — derives the tab/panel ARIA ids. */
  tabKey: string;
  /** The BARE on-disk draft-backup id (plan.15 D8): the prompt's UUID for a
   *  saved prompt, the minted UUID inside `prompt-draft-<uuid>` for a draft. */
  draftId: string;
  /** Boot-restore seed (D5): mounts the buffer from this snapshot, DIRTY.
   *  Consumed at mount only. */
  restoredDraft?: Draft | null;
  /** Orphan-restore handoff: the dead prompt's old draft file, deleted after
   *  this editor's first successful flush under its fresh id. */
  supersedesDraftId?: string | null;
  /** True when this tab is not the active one — the section is mounted but
   *  display:none (preserving its buffer/stream). Distinct from `active`. */
  hidden: boolean;
  /** Whether this is the visible, active prompt tab. Gates the window Ctrl+S
   *  listener so only the active editor saves (N editors stay mounted, and both
   *  pages are mounted at once — so this also folds in "Prompts page visible"). */
  active: boolean;
  /** Fires on dirty↔clean transitions only, driving the tab's unsaved dot. */
  onDirtyChange: (dirty: boolean) => void;
  onSave: (patch: UpdatePrompt) => Promise<boolean>;
  onCreate: (input: NewPrompt) => Promise<boolean>;
  /** Persists immediately (no version, no dirty state) — the reusable flag is
   *  prompt-level state, not a content edit. For a draft it just mutates the
   *  local draft object (PromptsPage decides which). */
  onToggleReusable: (reusable: boolean) => void;
  onDelete: () => void;
  /** Move this prompt to another loaded project. PromptsPage confirms, mutates,
   *  and clears the selection (mirroring onDelete). */
  onMove: (targetProjectId: string) => void;
  /** Widened for keyed (resolvable) validation toasts; transient sites still
   *  call it one-arg (assignable). */
  onError: (message: string, opts?: { key?: string }) => void;
  /** Clear a keyed toast the instant its condition is fixed. */
  onResolve: (key: string) => void;
  /** The owning-project name, shown as a persistent header label — set only in
   *  the All-projects scope, where this prompt may belong to a project other than
   *  the one being browsed. The Save and Mark-reusable paths have no confirmation
   *  dialog, so this label is their only in-context owner signal (§5 Q2). Null in
   *  a single-project scope (the owner is unambiguous). */
  ownerLabel?: string | null;
}

/** Detail pane for one prompt: title + body only (no status/priority/due/pin/
 *  archive/tags — those are item-only), a reusable toggle, History, Delete,
 *  and the AI enhance flow reused verbatim from Editor.tsx's rework, minus the
 *  R1 title-proposal half (prompts have no AI-generated titles). */
const PromptEditor = forwardRef<PromptEditorHandle, Props>(function PromptEditor(
  {
    prompt,
    isDraft,
    loaded,
    tabKey,
    draftId,
    restoredDraft = null,
    supersedesDraftId = null,
    hidden,
    active,
    onDirtyChange,
    onSave,
    onCreate,
    onToggleReusable,
    onDelete,
    onMove,
    onError,
    onResolve,
    ownerLabel,
  }: Props,
  ref,
) {
  // Plan.15 D3/D5: a boot-restored draft seeds the INITIAL buffer and the tab
  // mounts DIRTY; the reseed effect below is guarded so its mount pass can't
  // wipe this (see Editor.tsx for the full rationale).
  const [title, setTitle] = useState(restoredDraft ? restoredDraft.title : prompt.title);
  const [body, setBody] = useState(restoredDraft ? restoredDraft.body : prompt.body);
  const [dirty, setDirty] = useState(restoredDraft ? true : isDraft); // a fresh draft starts dirty
  const [proposal, setProposal] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Inline "Copied" feedback (plan.8), self-reverting; the timer is cleared on
  // unmount / prompt change so a stale revert never fires on a newer prompt.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  // Move-to-project popover (plan.8), reusing the shared popover discipline.
  const [showMove, setShowMove] = useState(false);
  const moveWrapper = useRef<HTMLSpanElement>(null);
  const movePanel = useRef<HTMLDivElement>(null);
  const moveTrigger = useRef<HTMLButtonElement>(null);
  usePopover(showMove, () => setShowMove(false), {
    wrapper: moveWrapper,
    panel: movePanel,
    trigger: moveTrigger,
  });
  // Move targets: every loaded project except this prompt's own.
  const otherLoaded = loaded.filter((p) => p.id !== prompt.projectId);
  // Backend-cancel handle for the in-flight stream (null when none).
  const stopRef = useRef<(() => void) | null>(null);
  // Blocks save re-entry (a second Ctrl+S while a save is in flight).
  const savingRef = useRef(false);

  // --- Draft backup (plan.15 step 16) — the Editor.tsx wiring, prompt-shaped:
  // a lastEditRef bumped at the edit() chokepoint, a per-render snapshot
  // closure (null when buffer == base), and the shared timing hook.
  const lastEditRef = useRef(0);
  const snapshotRef = useRef<() => Draft | null>(() => null);
  useEffect(() => {
    snapshotRef.current = () => {
      if (title === prompt.title && body === prompt.body) return null;
      return buildPromptDraft(draftId, prompt, {
        title,
        body,
        projectId: prompt.projectId ?? "",
      });
    };
  });
  const draftBackup = useDraftBackup({
    draftId,
    dirty,
    active,
    getSnapshot: snapshotRef,
    lastEditRef,
    supersedesDraftId,
  });

  // Rework on a selection (Plan 13) — the same plumbing as Editor.tsx: the live
  // range in a ref, one derived `selectionLength` state for the AiBar, the
  // request-time capture `selectionRework` that `Replace text` re-validates,
  // and a pending caret to re-select the splice after the controlled re-render.
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

  // Leave selection mode (does not touch an in-flight `selectionRework`).
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

  // Plan.16 D6: native context-menu action — same shape as Editor.tsx (act only
  // when THIS textarea is focused, read the live value/selection, insert via
  // edit() + pendingCaretRef so dirty flag and draft backup follow).
  function handleContextMenuAction(action: ContextMenuAction) {
    const ta = bodyRef.current;
    if (!ta || document.activeElement !== ta) return;
    if (action !== "insert-timestamp") return;
    const r = insertText(
      ta.value,
      { start: ta.selectionStart, end: ta.selectionEnd },
      formatTimestamp(new Date()),
    );
    if (!r) return;
    edit(setBody)(r.body);
    clearSelection();
    pendingCaretRef.current = { start: r.caret, end: r.caret };
  }
  const contextMenuRef = useRef(handleContextMenuAction);
  contextMenuRef.current = handleContextMenuAction;
  useEffect(() => onContextMenuAction((a) => contextMenuRef.current(a)), []);

  // Expose save() so the close-dirty "Save" branch can persist THIS prompt tab
  // even when it is a background (non-active) tab whose buffer lives only here.
  // applyDraft is the conflict bar's only way into a mounted clean editor (D4).
  useImperativeHandle(ref, () => ({
    save: () => save(),
    applyDraft: (snapshot: Draft) => {
      setTitle(snapshot.title);
      setBody(snapshot.body);
      setDirty(true);
      lastEditRef.current = Date.now();
    },
    flushDraft: () => draftBackup.flushNow(),
    discardDraft: () => draftBackup.discard(),
  }));

  // Surface dirty↔clean transitions to the parent tab strip (never per keystroke;
  // seeded to the initial value so there is no redundant mount fire).
  const reportedDirty = useRef(dirty);
  useEffect(() => {
    if (reportedDirty.current !== dirty) {
      reportedDirty.current = dirty;
      onDirtyChange(dirty);
    }
  }, [dirty, onDirtyChange]);

  // Plan.15 step 16 reseed guard — identical to Editor.tsx's: this effect also
  // runs on MOUNT, where it would wipe a restoredDraft-seeded buffer back to
  // saved content on the mount frame. Identity-compared (StrictMode-safe).
  const draftSeedRef = useRef(restoredDraft ? { id: prompt.id, isDraft } : null);

  // Re-seed local state from the prompt. PromptsPage keys this component by
  // draft-seq/selected-id, so most selections remount it; this effect covers
  // the residual same-instance updates. Navigating away mid-stream stops it.
  useEffect(() => {
    const seeded = draftSeedRef.current;
    if (seeded && seeded.id === prompt.id && seeded.isDraft === isDraft) {
      return () => {
        stopRef.current?.();
        stopRef.current = null;
        if (copiedTimer.current !== null) {
          window.clearTimeout(copiedTimer.current);
          copiedTimer.current = null;
        }
      };
    }
    draftSeedRef.current = null; // identity moved on — normal reseeds from here
    setTitle(prompt.title);
    setBody(prompt.body);
    setDirty(isDraft);
    setProposal(null);
    setStreaming(false);
    setAiBusy(false);
    setSaving(false);
    setCopied(false);
    setShowMove(false);
    savingRef.current = false;
    setSelectionRework(null);
    selRef.current = null;
    setSelectionLength(0);
    pendingCaretRef.current = null;
    return () => {
      stopRef.current?.();
      stopRef.current = null;
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = null;
      }
    };
  }, [prompt.id, isDraft]);

  // Resolve-on-condition (§5): clear the keyed "no text to rework" toast (#16)
  // when body text exists, and the "needs a title or text" toast the instant
  // either the title or the body becomes non-empty.
  useEffect(() => {
    if (body.trim()) onResolve("prompt-no-text");
    if (title.trim() || body.trim()) onResolve("prompt-empty");
  }, [title, body, onResolve]);

  async function copyBody() {
    try {
      await copyToClipboard(body);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 1500);
    } catch (err) {
      onError(String(err));
    }
  }

  // The single persistence path. Accepts an override so an accept can pass the
  // fresh proposal rather than rely on a not-yet-committed setState.
  async function save(overrides?: {
    body?: string;
    source?: PromptSource;
  }): Promise<boolean> {
    if (savingRef.current) return false; // re-entry guard
    savingRef.current = true;
    setSaving(true);
    try {
      const effectiveBody = overrides?.body ?? body;
      // The title is optional (plan.8), but a fully-blank prompt (empty title AND
      // empty body) is rejected. Guard it here with a KEYED, resolvable toast that
      // clears the instant a title or body exists (and can never linger past a
      // successful save) — rather than the backend's unkeyed error, which
      // persisted after the user fixed the field. The repository still enforces
      // the rule as the backstop.
      if (!title.trim() && !effectiveBody.trim()) {
        onError("Add a title or some text before saving.", { key: "prompt-empty" });
        return false;
      }
      if (isDraft) {
        const input: NewPrompt = {
          projectId: prompt.projectId ?? "",
          title,
          body: effectiveBody,
          reusable: prompt.reusable,
          // Provenance for the first version (§12): "aiEnhanced" when this save
          // is accepting an AI proposal on a not-yet-created draft, else manual.
          source: overrides?.source,
        };
        const created = await onCreate(input);
        if (created) {
          setDirty(false);
          draftBackup.clearAfterSave(); // the created prompt owns the content now
        }
        return created;
      }
      const saved = await onSave({
        title,
        body: effectiveBody,
        source: overrides?.source,
      });
      if (saved) {
        setDirty(false); // a rejected save stays dirty → "Save", not "Saved"
        draftBackup.clearAfterSave();
      }
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves — the identical path. Gated on `active` so only the
  // visible, active tab saves (every open tab keeps a mounted editor with this
  // window-level listener, and both pages are mounted at once).
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
    // Plan.15 D6: snapshot before an AI entry point. Fire-and-forget.
    void draftBackup.flushNow();
    // Selection mode is decided here from the tracked range (D7); only the
    // selected text is sent (§4 M7).
    const sel = captureSelection(selRef.current, body);
    const text = sel ? sel.text : body;
    if (!text.trim()) {
      onError("There is no text to rework yet.", { key: "prompt-no-text" });
      return;
    }
    stopRef.current?.(); // defensive: AiBar disables Rework while busy
    setAiBusy(true);
    setStreaming(true);
    setProposal(""); // instant empty card; tokens accumulate into it
    setSelectionRework(sel);

    // Per-request cancel flag lives in this closure, so a late chunk or the
    // settled promise from THIS request can't touch a newer request's card.
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
      if (cancelled) return; // user-initiated cancel → silent, card already cleared
      setProposal(finalText); // canonical, fully-accumulated text
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

  // Discard: stop the backend stream (if any), then clear the card. Wiring the
  // cancel here means discarding mid-stream actually halts the backend.
  function discardProposal() {
    stopRef.current?.();
    stopRef.current = null;
    setProposal(null);
    setSelectionRework(null);
    setStreaming(false);
    setAiBusy(false);
  }

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      // The buffered-edit chokepoint — the draft backup keys off it (plan.15 D6).
      lastEditRef.current = Date.now();
    };
  }

  // Revert unsaved title/body edits to the most recently saved version (the
  // `prompt` prop, which PromptsPage re-fetches after every save). Confirmed
  // because it throws away in-progress edits; only offered for a saved prompt —
  // a fresh draft has no saved version to revert to.
  function discardEdits() {
    void (async () => {
      const ok = await confirmDialog(
        "Discard unsaved changes and revert to the most recently saved version?",
      );
      if (!ok) return;
      setTitle(prompt.title);
      setBody(prompt.body);
      setDirty(false);
    })();
  }

  // The body moved under a pending selection proposal (D4): disabled eagerly,
  // re-validated on click.
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
      <header className="editor-head">
        <input
          className="title"
          value={title}
          placeholder="Prompt title"
          onChange={(e) => edit(setTitle)(e.target.value)}
        />
      </header>

      <div className="meta">
        <span className="meta-kind">prompt</span>
        {/* Persistent owner label in the All scope: this prompt may belong to a
            project other than the one being browsed, and Save/Mark-reusable have
            no confirmation, so this is the only in-context owner signal (§5 Q2). */}
        {ownerLabel && (
          <span className="row-project" title="Owning project — edits save back to it">
            {ownerLabel}
          </span>
        )}
        <button
          className={prompt.reusable ? "btn btn-quiet btn-reusable-on" : "btn btn-quiet"}
          aria-pressed={prompt.reusable}
          onClick={() => onToggleReusable(!prompt.reusable)}
        >
          {prompt.reusable ? "Unmark reusable" : "Mark reusable"}
        </button>
        {!isDraft && <span className="prompt-version">v{prompt.versionCount}</span>}
        <button className="btn btn-quiet" onClick={() => void copyBody()}>
          {copied ? "Copied" : "Copy to clipboard"}
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? "Copied to clipboard" : ""}
        </span>
        <span className="meta-spring" />
        {!isDraft && (
          <>
            <span className="move-popover" ref={moveWrapper}>
              <button
                className="btn btn-quiet"
                ref={moveTrigger}
                aria-haspopup="true"
                aria-expanded={showMove}
                disabled={otherLoaded.length === 0}
                title={
                  otherLoaded.length === 0
                    ? "Load another project to move this prompt into"
                    : undefined
                }
                onClick={() => setShowMove((o) => !o)}
              >
                Move to project…
              </button>
              {showMove && (
                <div className="popover popover-move" ref={movePanel}>
                  <span className="popover-label">MOVE TO</span>
                  <div className="popover-pills">
                    {otherLoaded.map((p) => (
                      <button
                        key={p.id}
                        className="popover-pill"
                        onClick={() => {
                          setShowMove(false);
                          onMove(p.id);
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </span>
            <button className="btn btn-quiet" onClick={() => setShowHistory(true)}>
              History
            </button>
            <button className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>

      <AiBar
        variant="prompt"
        busy={aiBusy}
        dirty={dirty}
        generatingTitle={false}
        saveBlocked={false}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
        onDiscard={isDraft ? undefined : discardEdits}
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
                // The ONLY splice site (§4 H4): into the captured range or not
                // at all. A partially-AI body is still `aiEnhanced`.
                const next = selectionRework
                  ? spliceProposal(body, selectionRework, proposal)
                  : { ok: true as const, body: proposal, caret: null };
                if (!next.ok) return;
                edit(setBody)(next.body);
                pendingCaretRef.current = next.caret;
                const ok = await save({ body: next.body, source: "aiEnhanced" });
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
        // Plan.16 D4: "Insert timestamp" surface (see Editor.tsx).
        data-menu-surface="body"
        placeholder="Write the prompt text here."
        onChange={(e) => {
          edit(setBody)(e.target.value);
          clearSelection(); // a manual edit invalidates the tracked offsets
        }}
        onSelect={trackSelection}
        onKeyUp={trackSelection}
        onMouseUp={trackSelection}
        // Plan.15 D6: leaving the field is a natural checkpoint — flush now.
        onBlur={() => void draftBackup.flushNow()}
        // F6 (D9): whole-line Ctrl+X/C/V on a collapsed selection.
        onKeyDown={(e) => {
          if (bodyRef.current) handleLineClipboardKeyDown(e, bodyRef.current);
        }}
        onPaste={(e) => {
          const ta = bodyRef.current;
          if (!ta) return;
          handleLinePaste(e, ta, (nextBody, caret) => {
            edit(setBody)(nextBody);
            clearSelection();
            pendingCaretRef.current = { start: caret, end: caret };
          });
        }}
      />

      {showHistory && (
        <PromptHistoryDialog
          promptId={prompt.id}
          onClose={() => setShowHistory(false)}
          onError={onError}
        />
      )}
    </section>
  );
});

export default PromptEditor;
