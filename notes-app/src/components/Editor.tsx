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
import { aiRewriteStream } from "../lib/api";
import { fromDateInputValue, toDateInputValue } from "../lib/dueDate";
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
  // Backend-cancel handle for the in-flight stream (null when none). Held in a
  // ref so navigation/discard can stop a zombie stream without a re-render.
  const stopRef = useRef<(() => void) | null>(null);

  // Re-seed local state from the item. App.tsx keys this component by
  // draft-seq/selected-id, so most selections remount it; this effect covers
  // the residual same-instance updates. Either way the cleanup below runs
  // (React runs effect cleanup on unmount and on dep-change alike), so a stream
  // in flight is always stopped when the editor moves off its item.
  useEffect(() => {
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
    setStreaming(false);
    setAiBusy(false);
    // Navigating away mid-stream must kill the backend stream, not just the
    // card — the cleanup marks the in-flight request cancelled and cancels it.
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [item.id, isDraft]);

  async function save() {
    if (!title.trim()) {
      onError("Give it a title before saving.");
      return;
    }
    const isTask = item.kind === "task";
    if (isDraft) {
      const input: NewItem = {
        kind: item.kind,
        title: title.trim(),
        body,
        status: isTask ? status : undefined,
        priority: isTask ? priority : undefined,
        dueAt: isTask ? fromDateInputValue(dueAt) || undefined : undefined,
        tags,
        projectId: projectId || undefined,
        jiraUrl: jiraUrl.trim() || undefined,
      };
      const created = await onCreate(input);
      if (created) setDirty(false);
      return;
    }
    const saved = await onSave({
      title: title.trim(),
      body,
      status: isTask ? status : undefined,
      priority: isTask ? priority : undefined,
      // "" clears; a task-only field, so notes send undefined (unchanged).
      dueAt: isTask ? (dueAt ? fromDateInputValue(dueAt) : "") : undefined,
      tags,
      projectId, // "" clears the assignment (D7 UpdateItem semantics)
      jiraUrl: jiraUrl.trim(), // "" clears
    });
    if (saved) setDirty(false); // a rejected save stays dirty → "Save", not "Saved"
  }

  // Ctrl+S / Cmd+S saves.
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

    // Per-request cancel flag lives in this closure, so a late chunk or the
    // settled promise from THIS request can't touch a newer request's card.
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

    try {
      const finalText = await result;
      if (cancelled) return;
      setProposal(finalText); // canonical, fully-accumulated text
    } catch (err) {
      if (cancelled) return; // user-initiated cancel → silent, card already cleared
      setProposal(null);
      onError(String(err));
    } finally {
      if (!cancelled) {
        setStreaming(false);
        setAiBusy(false);
        if (stopRef.current === stop) stopRef.current = null;
      }
    }
  }

  // Discard: stop the backend stream (if any), then clear the card. Wiring the
  // cancel here means discarding mid-stream actually halts the backend, not
  // just the display.
  function discardProposal() {
    stopRef.current?.();
    stopRef.current = null;
    setProposal(null);
    setStreaming(false);
    setAiBusy(false);
  }

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
    };
  }

  const released = item.kind === "task" && status === "done";

  return (
    <section className="editor">
      <header className="editor-head">
        <input
          className="title"
          value={title}
          placeholder={item.kind === "task" ? "Task title" : "Note title"}
          onChange={(e) => edit(setTitle)(e.target.value)}
        />
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

      {proposal !== null && (
        <div className="review" role="region" aria-label="AI rewrite proposal">
          <div className="review-head">
            <span className="review-mark">
              {streaming ? "Streaming…" : "Proposed rewrite"}
            </span>
            <button
              className="btn"
              disabled={streaming}
              onClick={() => {
                edit(setBody)(proposal);
                setProposal(null);
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
            {streaming ? "Streaming rewrite" : "Rewrite ready"}
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
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
      />
    </section>
  );
}
