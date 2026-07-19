import { useEffect, useRef, useState } from "react";
import type { NewPrompt, Prompt, PromptSource, ProviderId, UpdatePrompt } from "../types";
import { aiRewriteStream } from "../lib/api";
import AiBar from "./AiBar";
import PromptHistoryDialog from "./PromptHistoryDialog";

interface Props {
  prompt: Prompt;
  isDraft: boolean;
  onSave: (patch: UpdatePrompt) => Promise<boolean>;
  onCreate: (input: NewPrompt) => Promise<boolean>;
  /** Persists immediately (no version, no dirty state) — the reusable flag is
   *  prompt-level state, not a content edit. For a draft it just mutates the
   *  local draft object (PromptsPage decides which). */
  onToggleReusable: (reusable: boolean) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}

/** Detail pane for one prompt: title + body only (no status/priority/due/pin/
 *  archive/tags — those are item-only), a reusable toggle, History, Delete,
 *  and the AI enhance flow reused verbatim from Editor.tsx's rework, minus the
 *  R1 title-proposal half (prompts have no AI-generated titles). */
export default function PromptEditor({
  prompt,
  isDraft,
  onSave,
  onCreate,
  onToggleReusable,
  onDelete,
  onError,
}: Props) {
  const [title, setTitle] = useState(prompt.title);
  const [body, setBody] = useState(prompt.body);
  const [dirty, setDirty] = useState(isDraft); // a fresh draft starts dirty
  const [proposal, setProposal] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Backend-cancel handle for the in-flight stream (null when none).
  const stopRef = useRef<(() => void) | null>(null);
  // Blocks save re-entry (a second Ctrl+S while a save is in flight).
  const savingRef = useRef(false);

  // Re-seed local state from the prompt. PromptsPage keys this component by
  // draft-seq/selected-id, so most selections remount it; this effect covers
  // the residual same-instance updates. Navigating away mid-stream stops it.
  useEffect(() => {
    setTitle(prompt.title);
    setBody(prompt.body);
    setDirty(isDraft);
    setProposal(null);
    setStreaming(false);
    setAiBusy(false);
    setSaving(false);
    savingRef.current = false;
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [prompt.id, isDraft]);

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
      if (!title.trim()) {
        onError("Give it a title before saving.");
        return false;
      }
      const effectiveBody = overrides?.body ?? body;
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
        if (created) setDirty(false);
        return created;
      }
      const saved = await onSave({
        title,
        body: effectiveBody,
        source: overrides?.source,
      });
      if (saved) setDirty(false); // a rejected save stays dirty → "Save", not "Saved"
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves — the identical path.
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
    stopRef.current?.(); // defensive: AiBar disables Rework while busy
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
      if (cancelled) return; // user-initiated cancel → silent, card already cleared
      setProposal(finalText); // canonical, fully-accumulated text
    } catch (err) {
      if (cancelled) return;
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
  // cancel here means discarding mid-stream actually halts the backend.
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

  return (
    <section className="editor">
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
        <button
          className={prompt.reusable ? "btn btn-quiet btn-reusable-on" : "btn btn-quiet"}
          aria-pressed={prompt.reusable}
          onClick={() => onToggleReusable(!prompt.reusable)}
        >
          {prompt.reusable ? "Unmark reusable" : "Mark reusable"}
        </button>
        {!isDraft && <span className="prompt-version">v{prompt.versionCount}</span>}
        <span className="meta-spring" />
        {!isDraft && (
          <>
            <button className="btn btn-quiet" onClick={() => setShowHistory(true)}>
              History
            </button>
            <button className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>

      {proposal !== null && (
        <div className="review" role="region" aria-label="AI rewrite proposal">
          <div className="review-head">
            <span className="review-mark">
              {streaming ? "Streaming…" : "Proposed rewrite"}
            </span>
            <button
              className="btn"
              disabled={streaming || saving}
              onClick={async () => {
                edit(setBody)(proposal);
                const ok = await save({ body: proposal, source: "aiEnhanced" });
                if (ok) setProposal(null);
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
        placeholder="Write the prompt text here."
        onChange={(e) => edit(setBody)(e.target.value)}
      />

      <AiBar
        variant="prompt"
        busy={aiBusy}
        dirty={dirty}
        generatingTitle={false}
        saveBlocked={false}
        onRework={(i, p) => void rework(i, p)}
        onSave={() => void save()}
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
}
