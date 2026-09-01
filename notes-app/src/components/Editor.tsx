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
  Item,
  NewItem,
  Priority,
  ProjectInfo,
  ProviderId,
  Status,
  UpdateItem,
} from "../types";
import { aiGenerateTitle, aiRewriteStream } from "../lib/api";
import { buildItemDraft, bufferEqualsItem, type ItemBuffer } from "../lib/drafts";
import { useDraftBackup } from "../hooks/useDraftBackup";
import { reportAiError } from "../lib/aiErrors";
import { getPreferredProvider } from "../lib/aiProvider";
import { fromDateInputValue, toDateInputValue } from "../lib/dueDate";
import { resolveTitleForSave } from "../lib/titleForSave";
import { isRedundantTitle } from "../lib/titleProposal";
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
import EditorTags from "./EditorTags";
import JiraRow from "./JiraRow";

/** Imperative handle: lets the parent persist a background (mounted-hidden,
 *  non-active) tab from the close-dirty "Save" branch — its buffer lives only in
 *  this instance's local state and is otherwise unreachable. Plan.15 adds the
 *  draft-backup verbs: `applyDraft` is the ONLY way content enters an
 *  already-mounted clean editor (the conflict bar's "Restore unsaved edits" —
 *  the reseed effect fires only on [item.id, isDraft] changes); `flushDraft`
 *  snapshots without any of save()'s behavior (no item write, no R4 AI title —
 *  the window-close flush depends on that); `discardDraft` permanently stops
 *  backups and deletes the draft, ordered behind in-flight writes, so the
 *  buffer-discarding paths can never be raced by a straggler snapshot. */
export interface EditorHandle {
  save: () => Promise<boolean>;
  applyDraft: (snapshot: Draft) => void;
  flushDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
}

interface Props {
  item: Item;
  isDraft: boolean;
  loaded: ProjectInfo[];
  activeTags: string[];
  /** This tab's identity key — derives the tab/panel ARIA ids. */
  tabKey: string;
  /** The BARE on-disk draft-backup id (plan.15 D8): the item's UUID for a
   *  saved item, the minted UUID inside the `draft-<uuid>` tab key for a new
   *  draft — never the prefixed tab key itself. */
  draftId: string;
  /** Boot-restore seed (D5): when set, the buffer mounts from this snapshot,
   *  DIRTY — the one narrow exception to "restored tabs open clean". Consumed
   *  at mount only; later prop changes are ignored. */
  restoredDraft?: Draft | null;
  /** Orphan-restore handoff (step 13): the dead item's old draft file, deleted
   *  only after this editor's first successful flush under its fresh id. */
  supersedesDraftId?: string | null;
  /** True when this tab is not the active one in its page — the section is
   *  mounted but display:none (preserving its edit buffer/stream). Distinct from
   *  `active`, which also requires this page to be the visible one. */
  hidden: boolean;
  /** Whether this is the visible, active tab (active tab AND its page visible).
   *  Gates the window Ctrl+S listener so only ONE editor saves across both the
   *  N mounted item tabs and the N mounted prompt tabs. */
  active: boolean;
  /** Fires on dirty↔clean transitions only (not per keystroke), so the tab strip
   *  can show the unsaved dot without re-rendering sibling editors. */
  onDirtyChange: (dirty: boolean) => void;
  onSave: (patch: UpdateItem) => Promise<boolean>;
  /** F1 (D1): persist a SAVED task's status immediately — a field-scoped patch
   *  like Pin/Archive, never the buffered save() path (S-1). Resolves false on
   *  a rejected patch so the select can revert. Drafts keep the buffered path. */
  onStatusChange?: (status: Status) => Promise<boolean>;
  onCreate: (input: NewItem) => Promise<boolean>;
  /** Draft only: report the chosen target project up so App's unload-eviction
   *  check reflects the live selection (not just the value seeded at creation). */
  onTargetChange?: (projectId: string) => void;
  onDuplicate: () => void;
  /** F7 (D8): convert this saved NOTE into a task — one-way; App confirms via
   *  api.confirmDialog and mutates. Rendered for saved notes only; disabled
   *  while dirty (the buffer isn't part of the conversion). NOTE a coupling:
   *  the re-seed effect keys on [item.id, isDraft], so after conversion the
   *  local status/priority/dueAt state keeps its note-time fallback seeds
   *  ("todo"/"normal"/"") — correct only because those equal the server-side
   *  conversion defaults. If convert_note_to_task's defaults ever change,
   *  re-sync here. */
  onConvertToTask?: () => void;
  /** F7 (D8): seed a dirty, unsaved prompt draft on the Prompts page with this
   *  note's on-screen title+body. The note itself is untouched. */
  onCreatePromptFromNote?: (title: string, body: string) => void;
  onArchive: (archived: boolean) => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  /** Widened for keyed (resolvable) validation toasts: a stable `key` lets the
   *  same toast replace-in-place and be cleared on resolution. The transient AI
   *  failure sites still call it one-arg (assignable). */
  onError: (message: string, opts?: { key?: string }) => void;
  /** Clear a keyed toast the instant its condition is fixed (paired with the
   *  keyed `onError` pushes below). */
  onResolve: (key: string) => void;
}

// Lifecycle order (todo → doing → testing → done); only "done" is released.
const STATUSES: Status[] = ["todo", "doing", "testing", "done"];
const PRIORITIES: Priority[] = ["low", "normal", "high"];

const Editor = forwardRef<EditorHandle, Props>(function Editor(
  {
    item,
    isDraft,
    loaded,
    activeTags,
    tabKey,
    draftId,
    restoredDraft = null,
    supersedesDraftId = null,
    hidden,
    active,
    onDirtyChange,
    onSave,
    onStatusChange,
    onCreate,
    onTargetChange,
    onDuplicate,
    onConvertToTask,
    onCreatePromptFromNote,
    onArchive,
    onPin,
    onDelete,
    onError,
    onResolve,
  }: Props,
  ref,
) {
  // Plan.15 D3/D5: a boot-restored draft seeds the INITIAL buffer (state
  // initializers, not an effect — so the restored content is never on screen a
  // frame late) and the tab mounts DIRTY. `restoredDraft` is read here once;
  // the reseed effect below is guarded so its mount pass can't wipe this.
  const [title, setTitle] = useState(restoredDraft ? restoredDraft.title : item.title);
  const [body, setBody] = useState(restoredDraft ? restoredDraft.body : item.body);
  const [status, setStatus] = useState<Status>(
    restoredDraft ? (restoredDraft.status ?? "todo") : (item.status ?? "todo"),
  );
  const [priority, setPriority] = useState<Priority>(
    restoredDraft ? (restoredDraft.priority ?? "normal") : (item.priority ?? "normal"),
  );
  // Holds the input's yyyy-mm-dd string, not the RFC 3339 wire value (a draft
  // snapshot captures this buffer form verbatim).
  const [dueAt, setDueAt] = useState(
    restoredDraft ? restoredDraft.dueAt : toDateInputValue(item.dueAt),
  );
  const [tags, setTags] = useState<string[]>(restoredDraft ? restoredDraft.tags : item.tags);
  const [projectId, setProjectId] = useState(
    restoredDraft ? restoredDraft.projectId : (item.projectId ?? ""),
  );
  const [jiraUrl, setJiraUrl] = useState(
    restoredDraft ? restoredDraft.jiraUrl : (item.jiraUrl ?? ""),
  );
  // A fresh draft starts dirty (DESIGN.md:65); a restored buffer mounts dirty
  // (D3 — restore is visible, never silent).
  const [dirty, setDirty] = useState(restoredDraft ? true : isDraft);
  const [proposal, setProposal] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  // R1: a proposed title from the last rework, and whether one is still being
  // generated. The card carries a TITLE row while either is set.
  const [proposedTitle, setProposedTitle] = useState<string | null>(null);
  const [titlePending, setTitlePending] = useState(false);
  // R4: an empty-title save is generating a title (Save reads "Generating title…").
  const [generatingTitle, setGeneratingTitle] = useState(false);
  // The "Suggest title" header button is generating a title on demand.
  const [suggestingTitle, setSuggestingTitle] = useState(false);
  // Backend-cancel handle for the in-flight stream (null when none). Held in a
  // ref so navigation/discard can stop a zombie stream without a re-render.
  const stopRef = useRef<(() => void) | null>(null);
  // Blocks save re-entry (a second Ctrl+S while an R4 generation is in flight).
  const savingRef = useRef(false);
  // Drives disabling the accept/save controls while a save() runs, so a second
  // click surfaces as a disabled control rather than a silent guarded no-op.
  const [saving, setSaving] = useState(false);
  // F1 (D1): a status auto-save patch in flight. Disables the status select so
  // rapid flips can't fire overlapping IPC calls with undefined resolution
  // order against reconcileTabs.
  const [statusPatchPending, setStatusPatchPending] = useState(false);
  // Flipped false once this editor instance moves off its item (unmount / item
  // switch). An in-flight R4 save() checks it after the async title call and
  // abandons rather than persisting to — or navigating away from — a stale item.
  const aliveRef = useRef(true);
  // Live mirror of `title`. R4's async continuation closed over the pre-await
  // (empty) title, so it consults this ref to detect a title the user typed
  // mid-generation and prefer it over the generated one.
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // --- Draft backup (plan.15 step 11) --------------------------------------
  // Bumped at the edit() chokepoint; the hook's schedule reads it. A ref, so a
  // keystroke never adds render work beyond what edit() already does.
  const lastEditRef = useRef(0);
  // Snapshot closure, reassigned every render so the hook's ticks always read
  // the live buffer (the titleRef mirror pattern, widened to every buffered
  // field). Returns null when buffer == base — the hook then deletes any
  // draft on disk instead of writing one (D6).
  const snapshotRef = useRef<() => Draft | null>(() => null);
  useEffect(() => {
    snapshotRef.current = () => {
      const isTask = item.kind === "task";
      const buffer: ItemBuffer = {
        title,
        body,
        status: isTask ? status : null,
        priority: isTask ? priority : null,
        dueAt: isTask ? dueAt : "",
        tags,
        projectId,
        jiraUrl,
      };
      if (bufferEqualsItem(buffer, item)) return null;
      return buildItemDraft(draftId, item, buffer);
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

  // Rework on a selection (Plan 13). The live textarea range lives in a ref
  // (selectionStart/End persist across the blur caused by clicking the AiBar);
  // `selectionLength` is the one derived state the AiBar renders, set only when
  // the length actually changes. `selectionRework` is the range+text captured
  // at request time — the fingerprint `Replace text` re-validates before it
  // splices. `pendingCaretRef` carries the inserted range across the controlled
  // re-render so the splice can be re-selected in the textarea.
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

  // Leave selection mode: forget the range and collapse the visible highlight to
  // the caret. Does NOT touch `selectionRework` — a proposal already in flight
  // keeps the range it was captured for.
  function clearSelection() {
    selRef.current = null;
    setSelectionLength(0);
    const ta = bodyRef.current;
    if (ta) {
      const pos = ta.selectionEnd;
      ta.setSelectionRange(pos, pos);
    }
  }

  // After a splice, re-select the inserted text once the controlled textarea has
  // re-rendered with the new body (a plain setSelectionRange before the commit
  // would be clamped against the OLD value).
  useLayoutEffect(() => {
    const c = pendingCaretRef.current;
    if (c && bodyRef.current) {
      pendingCaretRef.current = null;
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(c.start, c.end);
    }
  }, [body]);

  // Expose save() so the close-dirty "Save" branch can persist THIS tab even
  // when it is a background (non-active) tab whose buffer lives only here. No
  // deps: the factory re-runs each render, so the handle always calls the latest
  // save closure. applyDraft is the conflict bar's only way into a mounted
  // clean editor (D4); flushDraft/discardDraft are the plan.15 backup verbs.
  useImperativeHandle(ref, () => ({
    save: () => save(),
    applyDraft: (snapshot: Draft) => {
      setTitle(snapshot.title);
      setBody(snapshot.body);
      if (item.kind === "task") {
        setStatus(snapshot.status ?? "todo");
        setPriority(snapshot.priority ?? "normal");
        setDueAt(snapshot.dueAt);
      }
      setTags([...snapshot.tags]);
      setJiraUrl(snapshot.jiraUrl);
      // No setProjectId: a saved item's project is fixed (v1), and the
      // conflict bar exists only for saved items.
      setDirty(true);
      lastEditRef.current = Date.now();
    },
    flushDraft: () => draftBackup.flushNow(),
    discardDraft: () => draftBackup.discard(),
  }));

  // Surface dirty↔clean transitions to the parent tab strip. `dirty` only flips
  // on real transitions (setDirty(true) on an already-dirty editor is a no-op),
  // and the ref guard makes this fire ONLY on a change — never per keystroke,
  // even though onDirtyChange's identity may change each render. Seeded to the
  // initial value so there is no redundant mount fire (the parent seeds the
  // tab's dirty bit itself when it opens the tab).
  const reportedDirty = useRef(dirty);
  useEffect(() => {
    if (reportedDirty.current !== dirty) {
      reportedDirty.current = dirty;
      onDirtyChange(dirty);
    }
  }, [dirty, onDirtyChange]);

  // Resolve-on-condition (§5): clear a keyed validation toast the instant its
  // condition is fixed — a project is chosen (#9), or body text exists (#11/#13)
  // — not on the next retry. A dismissKey for an absent/expired key is a no-op.
  useEffect(() => {
    if (projectId) onResolve("item-project");
  }, [projectId, onResolve]);
  useEffect(() => {
    if (body.trim()) {
      onResolve("editor-no-text");
      onResolve("editor-no-title-src");
    }
  }, [body, onResolve]);

  // Plan.15 step 11 reseed guard: this [item.id, isDraft] effect ALSO runs on
  // first mount, where it would overwrite a restoredDraft-seeded buffer with
  // saved content and reset dirty on the very frame the tab mounts — defeating
  // the entire restore path. Skip the reseed while this instance is still on
  // the identity that consumed the restored draft. Identity-compared rather
  // than a consume-once flag so StrictMode's dev double-invoke (which re-runs
  // the effect on the SAME identity) can't take the reseed branch on its
  // second pass; a genuine identity change resumes normal reseeding.
  const draftSeedRef = useRef(restoredDraft ? { id: item.id, isDraft } : null);

  // Re-seed local state from the item. App.tsx keys this component by
  // draft-seq/selected-id, so most selections remount it; this effect covers
  // the residual same-instance updates. Either way the cleanup below runs
  // (React runs effect cleanup on unmount and on dep-change alike), so a stream
  // in flight is always stopped when the editor moves off its item.
  useEffect(() => {
    const seeded = draftSeedRef.current;
    if (seeded && seeded.id === item.id && seeded.isDraft === isDraft) {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        stopRef.current?.();
        stopRef.current = null;
      };
    }
    draftSeedRef.current = null; // identity moved on — normal reseeds from here
    aliveRef.current = true; // (re-)arm; StrictMode's dev remount runs cleanup first
    setTitle(item.title);
    setBody(item.body);
    setStatus(item.status ?? "todo");
    setPriority(item.priority ?? "normal");
    setDueAt(toDateInputValue(item.dueAt));
    setTags(item.tags);
    setProjectId(item.projectId ?? "");
    setJiraUrl(item.jiraUrl ?? "");
    setDirty(isDraft);
    setProposal(null);
    setProposedTitle(null);
    setStreaming(false);
    setTitlePending(false);
    setAiBusy(false);
    setGeneratingTitle(false);
    setSuggestingTitle(false);
    setSaving(false);
    setStatusPatchPending(false);
    savingRef.current = false;
    setSelectionRework(null);
    selRef.current = null;
    setSelectionLength(0);
    pendingCaretRef.current = null;
    // Navigating away mid-stream must kill the backend stream, not just the
    // card — the cleanup marks the in-flight request cancelled (body OR the
    // R1 title phase) and cancels it, and flags a pending R4 save() as stale so
    // its late result is dropped instead of persisted to the item just left.
    return () => {
      aliveRef.current = false;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [item.id, isDraft]);

  // The single persistence path (R2/R3/R4 all route through here). Accepts
  // explicit overrides so an accept can pass the fresh value rather than rely
  // on a not-yet-committed setState — the stale-closure hazard that would
  // otherwise silently persist the pre-accept value. Returns whether it saved.
  async function save(overrides?: {
    title?: string;
    body?: string;
  }): Promise<boolean> {
    if (savingRef.current) return false; // re-entry guard
    // The symmetric half of D1's overlap guard: the status select is disabled
    // while a save runs, and a save must not start while a status patch is in
    // flight — otherwise flip-then-Ctrl+S races two updateItem calls with
    // undefined resolution order against reconcileTabs.
    if (statusPatchPending) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      // A new draft must target a project store before it can be created (items
      // are created INTO a project — this guard precedes any AI title call).
      if (isDraft && !projectId) {
        onError("Choose a project for this item before saving.", { key: "item-project" });
        return false;
      }
      const effectiveBody = overrides?.body ?? body;
      const requestedTitle = overrides?.title ?? title;
      const needsGeneration = !requestedTitle.trim();

      // R4: empty title + body → generate; both empty → the existing error;
      // non-empty → passthrough (no AI call).
      const resolved = await resolveTitleForSave(
        requestedTitle,
        effectiveBody,
        (text) => {
          setGeneratingTitle(true);
          return aiGenerateTitle(getPreferredProvider(), text);
        },
      );
      setGeneratingTitle(false);
      // Navigated to another item while the title generated → abandon silently
      // rather than persist to (or yank selection back toward) the item we left.
      if (!aliveRef.current) return false;
      if ("error" in resolved) {
        if (needsGeneration && effectiveBody.trim()) {
          // The error came from the R4 title generation — an AI failure, so key
          // it by provider when no key is stored (F5; the message is already
          // stringified by resolveTitleForSave).
          await reportAiError(getPreferredProvider(), resolved.error, onError);
        } else {
          onError(resolved.error);
        }
        return false; // save aborted; item stays dirty
      }

      let effectiveTitle = resolved.title;
      if (needsGeneration) {
        // The user may have typed a real title while generation ran; the
        // closure's `title` is the stale empty value, so read the live ref and
        // prefer the user's title over the generated one.
        const typedNow = titleRef.current.trim();
        if (typedNow) effectiveTitle = typedNow;
        setTitle(effectiveTitle); // populate the field visibly
      }

      const isTask = item.kind === "task";
      if (isDraft) {
        const input: NewItem = {
          kind: item.kind,
          title: effectiveTitle,
          body: effectiveBody,
          status: isTask ? status : undefined,
          priority: isTask ? priority : undefined,
          dueAt: isTask ? fromDateInputValue(dueAt) || undefined : undefined,
          tags,
          projectId, // the chosen target store (required; guarded above)
          jiraUrl: jiraUrl.trim() || undefined,
        };
        const created = await onCreate(input);
        if (created) {
          setDirty(false);
          // The item now owns the content — the backup is redundant, and
          // keeping it would re-offer stale text on the next boot (§4.3).
          draftBackup.clearAfterSave();
        }
        return created;
      }
      const saved = await onSave({
        title: effectiveTitle,
        body: effectiveBody,
        status: isTask ? status : undefined,
        priority: isTask ? priority : undefined,
        // "" clears; a task-only field, so notes send undefined (unchanged).
        dueAt: isTask ? (dueAt ? fromDateInputValue(dueAt) : "") : undefined,
        tags,
        // No projectId: items do not move between projects in v1.
        jiraUrl: jiraUrl.trim(), // "" clears
      });
      if (saved) {
        setDirty(false); // a rejected save stays dirty → "Save", not "Saved"
        draftBackup.clearAfterSave(); // the saved item owns the content now
      }
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves — the identical path, R4 generation included. Gated on
  // `active`: every open tab keeps a mounted editor (each with this window-level
  // listener), so without the gate one Ctrl+S would fire N concurrent saves. The
  // effect re-registers every render (no deps), so `active` is always current.
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
    // Plan.15 D6: snapshot before an AI entry point — a crash mid-stream must
    // not lose the text the rework was asked about. Fire-and-forget.
    void draftBackup.flushNow();
    // Selection mode is decided HERE, from the tracked range, never from live
    // DOM in a click handler (D7). Only the selected text is sent (§4 M7).
    const sel = captureSelection(selRef.current, body);
    const text = sel ? sel.text : body;
    if (!text.trim()) {
      onError("There is no text to rework yet.", { key: "editor-no-text" });
      return;
    }
    stopRef.current?.(); // defensive: the AiBar disables Rework while busy, so
    // this can't re-enter mid-stream today — but a future caller might.
    setAiBusy(true);
    setStreaming(true);
    setProposal(""); // instant empty card; tokens accumulate into it
    setProposedTitle(null); // a fresh rework supersedes any prior title proposal
    setTitlePending(false);
    setSelectionRework(sel);

    // Per-request cancel flag lives in this closure, so a late chunk or the
    // settled promise from THIS request can't touch a newer request's card.
    // It also guards the R1 title phase below.
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

    let finalText: string;
    try {
      finalText = await result;
      if (cancelled) return; // user-initiated cancel → silent, card already cleared
      setProposal(finalText); // canonical, fully-accumulated text
      setStreaming(false);
    } catch (err) {
      if (cancelled) return;
      setProposal(null);
      setStreaming(false);
      setAiBusy(false);
      if (stopRef.current === stop) stopRef.current = null;
      await reportAiError(provider, err, onError);
      return;
    }

    // A selection rework is an editing operation on a fragment, not a
    // re-authoring — a title proposed from a fragment would be wrong, so the R1
    // phase is skipped (D6). R4 (empty-title on Save) is untouched.
    if (sel) {
      setAiBusy(false);
      if (stopRef.current === stop) stopRef.current = null;
      return;
    }

    // R1: propose a title from the PROPOSED body. This call OUTLIVES the body
    // stream, so aiBusy/stopRef stay live through it — otherwise a second
    // Rework starting the instant the body settled would begin with a no-op
    // stopRef and this call's stale title could land on the new card. Keeping
    // `cancelled`/`stopRef` live lets a superseding Rework (or discard, or
    // navigation) abandon this pending title cleanly.
    setTitlePending(true);
    try {
      const generated = await aiGenerateTitle(provider, finalText);
      if (cancelled) return;
      proposeTitle(generated); // skipped silently if it matches the title exactly
    } catch {
      if (cancelled) return;
      // D5: a title suggestion is ancillary — failure is silent, no toast.
    } finally {
      if (!cancelled) {
        setTitlePending(false);
        setAiBusy(false);
        if (stopRef.current === stop) stopRef.current = null;
      }
    }
  }

  // Every generated title (a rework's R1 proposal and the Suggest title button)
  // funnels through here. A suggestion that exactly matches the current title is
  // nothing to approve, so it is skipped silently — no card row, no prompt.
  // Reads the live title via titleRef (the closure's `title` may be stale after
  // an await).
  function proposeTitle(generated: string) {
    if (isRedundantTitle(generated, titleRef.current)) return;
    setProposedTitle(generated);
  }

  // Suggest title (header button): generate a title from the body on demand and
  // route it through proposeTitle for approval. Independent of Rework, so it
  // carries its own pending state; it reuses stopRef/the cancelled pattern so a
  // superseding rework/suggest, a discard, or navigating away abandons it.
  async function suggestTitle() {
    if (suggestingTitle) return; // already running
    if (!body.trim()) {
      onError("There is no text to generate a title from.", { key: "editor-no-title-src" });
      return;
    }
    void draftBackup.flushNow(); // plan.15 D6: snapshot before an AI entry point
    stopRef.current?.(); // supersede any in-flight rework/suggest
    const provider = getPreferredProvider();
    setSuggestingTitle(true);
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      setSuggestingTitle(false); // release the button when superseded/navigated away
    };
    stopRef.current = stop;
    try {
      const generated = await aiGenerateTitle(provider, body);
      if (cancelled) return;
      proposeTitle(generated); // skipped silently if it matches the title exactly
    } catch (err) {
      if (cancelled) return;
      // An explicit action surfaces its failure (unlike R1) — keyed when the
      // provider has no stored key (F5).
      await reportAiError(provider, err, onError);
    } finally {
      if (!cancelled) {
        setSuggestingTitle(false);
        if (stopRef.current === stop) stopRef.current = null;
      }
    }
  }

  // Discard: stop the backend stream (if any) and abandon a pending title call,
  // then clear both halves of the card. Wiring the cancel here means discarding
  // mid-stream actually halts the backend, not just the display.
  function discardProposal() {
    stopRef.current?.();
    stopRef.current = null;
    setProposal(null);
    setProposedTitle(null);
    setSelectionRework(null);
    setStreaming(false);
    setTitlePending(false);
    setAiBusy(false);
  }

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      // The single chokepoint every buffered edit passes through — the draft
      // backup's schedule keys off this timestamp (plan.15 D6).
      lastEditRef.current = Date.now();
    };
  }

  // F1 (D1): a saved task's status persists immediately, like Pin/Archive —
  // optimistic set WITHOUT edit() (a persisted flip is not an unsaved change,
  // so the dirty frame stays honest), then a field-scoped patch; revert on
  // failure. A draft keeps the buffered path (no IPC until Create). Never
  // routes through save() — that path can fire an AI title call (S-1).
  async function changeStatus(next: Status) {
    if (isDraft || !onStatusChange) {
      edit(setStatus)(next);
      return;
    }
    const prev = status;
    setStatus(next);
    setStatusPatchPending(true);
    try {
      const ok = await onStatusChange(next);
      if (!ok) setStatus(prev); // failed patch → the select reverts
    } finally {
      setStatusPatchPending(false);
    }
  }

  const released = item.kind === "task" && status === "done";
  const cardOpen = proposal !== null || proposedTitle !== null || titlePending;
  // The body moved under a pending selection proposal → the splice would land in
  // the wrong place. Disabled eagerly here and re-validated on click (D4).
  const stale = selectionRework !== null && isSelectionStale(body, selectionRework);

  return (
    <section
      // F3 (D2): frame the pane while there are unsaved changes. Supplementary
      // to the tab dot and Save label (WCAG 1.4.1); a status auto-save never
      // sets dirty, so the frame stays honest.
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
          placeholder={item.kind === "task" ? "Task title" : "Note title"}
          onChange={(e) => edit(setTitle)(e.target.value)}
        />
        <button
          className="btn btn-quiet"
          disabled={suggestingTitle || aiBusy}
          onClick={() => void suggestTitle()}
        >
          {suggestingTitle ? "Suggesting…" : "Suggest title"}
        </button>
        {!isDraft && (
          <button className="btn btn-quiet" onClick={onDuplicate}>
            Duplicate metadata
          </button>
        )}
        {!isDraft && item.kind === "note" && (
          <>
            <button
              className="btn btn-quiet"
              disabled={dirty || saving}
              title={dirty ? "Save or discard your changes first" : undefined}
              onClick={() => onConvertToTask?.()}
            >
              Convert to task
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => onCreatePromptFromNote?.(title, body)}
            >
              Create prompt from note
            </button>
          </>
        )}
      </header>

      <div className="meta">
        <span className="meta-kind">{item.kind}</span>
        {item.kind === "task" && (
          <select
            className="select"
            value={status}
            aria-label="Task status"
            // Disabled while a save/title-generation is in flight (the save
            // closure already captured `status`) or while a previous status
            // patch is still resolving (D1).
            disabled={saving || generatingTitle || statusPatchPending}
            onChange={(e) => void changeStatus(e.target.value as Status)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {item.kind === "task" && (
          <select
            className="select"
            value={priority}
            aria-label="Task priority"
            onChange={(e) => edit(setPriority)(e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p === "normal" ? "normal priority" : `${p} priority`}
              </option>
            ))}
          </select>
        )}
        {item.kind === "task" && (
          <label className="due-field">
            <span className="due-label">DUE</span>
            <input
              type="date"
              className="due-input"
              value={dueAt}
              aria-label="Due date"
              onChange={(e) => edit(setDueAt)(e.target.value)}
            />
          </label>
        )}
        {isDraft ? (
          // A new item is created INTO a project; the target is required and
          // chosen here (seeded from the rail filter when it names one).
          <select
            className="select"
            value={projectId}
            aria-label="Project"
            onChange={(e) => {
              edit(setProjectId)(e.target.value);
              onTargetChange?.(e.target.value);
            }}
          >
            <option value="" disabled>
              Choose a project…
            </option>
            {loaded.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          // Items do not move between projects in v1 — read-only indicator.
          <select
            className="select"
            value={projectId}
            aria-label="Project"
            disabled
            title="Items stay in the project they were created in"
          >
            {loaded.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <EditorTags
          tags={tags}
          activeTags={activeTags}
          released={released}
          onChange={edit(setTags)}
        />
        <span className="meta-spring" />
        {!isDraft && (
          <>
            <button
              className={item.pinned ? "btn btn-quiet btn-pinned" : "btn btn-quiet"}
              onClick={() => onPin(!item.pinned)}
            >
              {item.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => onArchive(!item.archived)}
            >
              {item.archived ? "Unarchive" : "Archive"}
            </button>
            <button className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>

      <JiraRow url={jiraUrl} onChange={edit(setJiraUrl)} onError={onError} />

      <AiBar
        busy={aiBusy}
        dirty={dirty}
        generatingTitle={generatingTitle}
        saveBlocked={isDraft && !projectId}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
        selectionLength={selectionLength}
        onClearSelection={clearSelection}
      />

      {cardOpen && (
        <div
          className="review"
          role="region"
          aria-label={
            proposal !== null
              ? selectionRework
                ? "AI selection rewrite proposal"
                : "AI rewrite proposal"
              : "AI title proposal"
          }
        >
          <div className="review-head">
            <span className="review-mark">
              {streaming
                ? "Streaming…"
                : proposal !== null
                  ? selectionRework
                    ? "Proposed rewrite (selection)"
                    : "Proposed rewrite"
                  : "Proposed title"}
            </span>
            {proposal !== null && (
              <button
                className="btn"
                disabled={streaming || saving || stale}
                title={stale ? "The selected text changed — discard and rework again." : undefined}
                onClick={async () => {
                  // The ONLY splice site (§4 H4): a selection proposal lands in
                  // its captured range or not at all — never whole-body, never
                  // re-found. A whole-text proposal replaces the body as before.
                  const next = selectionRework
                    ? spliceProposal(body, selectionRework, proposal)
                    : { ok: true as const, body: proposal, caret: null };
                  if (!next.ok) return;
                  edit(setBody)(next.body);
                  pendingCaretRef.current = next.caret;
                  const ok = await save({ body: next.body });
                  if (ok) {
                    setProposal(null); // clear only the body half on success
                    setSelectionRework(null);
                  }
                }}
              >
                Replace text
              </button>
            )}
            <button className="btn btn-quiet" onClick={discardProposal}>
              Discard
            </button>
          </div>
          {proposal !== null && <pre className="review-body">{proposal}</pre>}
          {(proposedTitle !== null || titlePending) && (
            <div className="review-title">
              <span className="review-title-label">TITLE</span>
              <span className="review-title-text">
                {titlePending ? "Generating…" : proposedTitle}
              </span>
              <button
                className="btn"
                disabled={titlePending || proposedTitle === null || saving}
                onClick={async () => {
                  if (proposedTitle === null) return;
                  edit(setTitle)(proposedTitle);
                  const ok = await save({ title: proposedTitle });
                  if (ok) setProposedTitle(null); // clear only the title half
                }}
              >
                Replace title
              </button>
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {streaming
              ? "Streaming rewrite"
              : titlePending
                ? "Generating title"
                : proposedTitle !== null
                  ? "Title proposed"
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
        placeholder="Write here. Use a rework when it's rough."
        onChange={(e) => {
          edit(setBody)(e.target.value);
          // A manual edit invalidates the tracked offsets. (React's onChange
          // does not fire for a programmatic setBody, so a splice never clears
          // its own re-selection.)
          clearSelection();
        }}
        onSelect={trackSelection}
        onKeyUp={trackSelection}
        onMouseUp={trackSelection}
        // Plan.15 D6: leaving the body field is a natural checkpoint — flush
        // the pending snapshot rather than wait out the idle window.
        onBlur={() => void draftBackup.flushNow()}
        // F6 (D9): whole-line Ctrl+X/C on a collapsed selection ride the
        // native path via selection expansion; line-paste is the one
        // programmatic insert (edit() + pendingCaretRef, not natively undoable).
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
    </section>
  );
});

export default Editor;
