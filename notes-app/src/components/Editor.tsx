import { useEffect, useState } from "react";
import type {
  Item,
  NewItem,
  Priority,
  ProjectWithCount,
  ProviderId,
  Status,
  UpdateItem,
} from "../types";
import { aiRewrite } from "../lib/api";
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
  const [aiBusy, setAiBusy] = useState(false);

  // Reset the draft when a different item is selected. (Drafts remount via a
  // per-draftSeq key, so this covers persisted → persisted transitions.)
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
    setAiBusy(true);
    try {
      const result = await aiRewrite({ provider, text: body, instruction });
      setProposal(result);
    } catch (err) {
      onError(String(err));
    } finally {
      setAiBusy(false);
    }
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
            <span className="review-mark">Proposed rewrite</span>
            <button
              className="btn"
              onClick={() => {
                edit(setBody)(proposal);
                setProposal(null);
              }}
            >
              Replace text
            </button>
            <button className="btn btn-quiet" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
          <pre className="review-body">{proposal}</pre>
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
