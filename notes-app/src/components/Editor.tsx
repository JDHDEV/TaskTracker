import { useEffect, useRef, useState } from "react";
import type {
  Item,
  NewItem,
  Priority,
  ProjectWithCount,
  ProviderId,
  Status,
  UpdateItem,
} from "../types";
import { aiGenerateTitle, aiRewriteStream } from "../lib/api";
import { getPreferredProvider } from "../lib/aiProvider";
import { fromDateInputValue, toDateInputValue } from "../lib/dueDate";
import { resolveTitleForSave } from "../lib/titleForSave";
import { isRedundantTitle } from "../lib/titleProposal";
import AiBar from "./AiBar";
import EditorTags from "./EditorTags";
import JiraRow from "./JiraRow";

interface Props {
  item: Item;
  isDraft: boolean;
  projects: ProjectWithCount[];
  activeTags: string[];
  onSave: (patch: UpdateItem) => Promise<boolean>;
  onCreate: (input: NewItem) => Promise<boolean>;
  onDuplicate: () => void;
  onArchive: (archived: boolean) => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}

const STATUSES: Status[] = ["todo", "doing", "done"];
const PRIORITIES: Priority[] = ["low", "normal", "high"];

export default function Editor({
  item,
  isDraft,
  projects,
  activeTags,
  onSave,
  onCreate,
  onDuplicate,
  onArchive,
  onPin,
  onDelete,
  onError,
}: Props) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [status, setStatus] = useState<Status>(item.status ?? "todo");
  const [priority, setPriority] = useState<Priority>(item.priority ?? "normal");
  // Holds the input's yyyy-mm-dd string, not the RFC 3339 wire value.
  const [dueAt, setDueAt] = useState(toDateInputValue(item.dueAt));
  const [tags, setTags] = useState<string[]>(item.tags);
  const [projectId, setProjectId] = useState(item.projectId ?? "");
  const [jiraUrl, setJiraUrl] = useState(item.jiraUrl ?? "");
  const [dirty, setDirty] = useState(isDraft); // a fresh draft starts dirty (DESIGN.md:65)
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

  // Re-seed local state from the item. App.tsx keys this component by
  // draft-seq/selected-id, so most selections remount it; this effect covers
  // the residual same-instance updates. Either way the cleanup below runs
  // (React runs effect cleanup on unmount and on dep-change alike), so a stream
  // in flight is always stopped when the editor moves off its item.
  useEffect(() => {
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
    savingRef.current = false;
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
    savingRef.current = true;
    setSaving(true);
    try {
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
        onError(resolved.error);
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
          projectId: projectId || undefined,
          jiraUrl: jiraUrl.trim() || undefined,
        };
        const created = await onCreate(input);
        if (created) setDirty(false);
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
        projectId, // "" clears the assignment (D7 UpdateItem semantics)
        jiraUrl: jiraUrl.trim(), // "" clears
      });
      if (saved) setDirty(false); // a rejected save stays dirty → "Save", not "Saved"
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves — the identical path, R4 generation included.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function rework(instruction: string, provider: ProviderId) {
    if (!body.trim()) {
      onError("There is no text to rework yet.");
      return;
    }
    stopRef.current?.(); // defensive: the AiBar disables Rework while busy, so
    // this can't re-enter mid-stream today — but a future caller might.
    setAiBusy(true);
    setStreaming(true);
    setProposal(""); // instant empty card; tokens accumulate into it
    setProposedTitle(null); // a fresh rework supersedes any prior title proposal
    setTitlePending(false);

    // Per-request cancel flag lives in this closure, so a late chunk or the
    // settled promise from THIS request can't touch a newer request's card.
    // It also guards the R1 title phase below.
    let cancelled = false;
    const requestId = crypto.randomUUID();
    const { result, cancel } = aiRewriteStream(
      { requestId, provider, text: body, instruction },
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
      onError(String(err));
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
      onError("There is no text to generate a title from.");
      return;
    }
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
      onError(String(err)); // an explicit action surfaces its failure (unlike R1)
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
    setStreaming(false);
    setTitlePending(false);
    setAiBusy(false);
  }

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
    };
  }

  const released = item.kind === "task" && status === "done";
  const cardOpen = proposal !== null || proposedTitle !== null || titlePending;

  return (
    <section className="editor">
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
      </header>

      <div className="meta">
        <span className="meta-kind">{item.kind}</span>
        {item.kind === "task" && (
          <select
            className="select"
            value={status}
            aria-label="Task status"
            onChange={(e) => edit(setStatus)(e.target.value as Status)}
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
        <select
          className="select"
          value={projectId}
          aria-label="Project"
          onChange={(e) => edit(setProjectId)(e.target.value)}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
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

      {cardOpen && (
        <div
          className="review"
          role="region"
          aria-label={proposal !== null ? "AI rewrite proposal" : "AI title proposal"}
        >
          <div className="review-head">
            <span className="review-mark">
              {streaming
                ? "Streaming…"
                : proposal !== null
                  ? "Proposed rewrite"
                  : "Proposed title"}
            </span>
            {proposal !== null && (
              <button
                className="btn"
                disabled={streaming || saving}
                onClick={async () => {
                  edit(setBody)(proposal);
                  const ok = await save({ body: proposal });
                  if (ok) setProposal(null); // clear only the body half on success
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
                  : "Rewrite ready"}
          </span>
        </div>
      )}

      <textarea
        className="body"
        value={body}
        placeholder="Write here. Select a rework below when it's rough."
        onChange={(e) => edit(setBody)(e.target.value)}
      />

      <AiBar
        busy={aiBusy}
        dirty={dirty}
        generatingTitle={generatingTitle}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
      />
    </section>
  );
}
