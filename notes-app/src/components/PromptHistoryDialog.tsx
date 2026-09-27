import { useEffect, useId, useRef, useState } from "react";
import type { PromptVersion } from "../types";
import * as api from "../lib/api";
import { displayTitle, formatWhen, sourceLabel } from "../lib/prompts";

interface Props {
  promptId: string;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Version history, newest-first (the backend already returns it that way).
 *  Loads on open; Escape or the scrim closes it, and focus lands on `Close`
 *  when it opens (this dialog is new, so it gets this discipline from the
 *  start — the older dialogs are unchanged). Plan 17 (1b, D13): an
 *  `aiEnhanced` version that carries the instruction behind its accepted
 *  rewrite shows it in an INSTRUCTION row — a text node with `dir="auto"`
 *  (R-4/R-13), never HTML, never altered; the caller returns focus to the
 *  History button on close. */
export default function PromptHistoryDialog({ promptId, onClose, onError }: Props) {
  const [versions, setVersions] = useState<PromptVersion[] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listPromptVersions(promptId);
        if (!cancelled) setVersions(result);
      } catch (err) {
        if (!cancelled) {
          onError(String(err));
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promptId, onError, onClose]);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const now = new Date();

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog dialog-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={headingId}>History</h2>
        <p className="dialog-note">
          Accepted-rewrite instructions are saved with the prompt's history in the project
          folder.
        </p>

        {versions === null && <p className="dialog-note">Loading…</p>}
        {versions !== null && versions.length === 0 && (
          <p className="dialog-note">No versions yet.</p>
        )}
        {versions !== null && versions.length > 0 && (
          <ul className="version-list">
            {versions.map((v) => (
              <li key={v.id} className="version-row">
                <div className="version-head">
                  <span className={v.source === "aiEnhanced" ? "pill pill-on" : "pill"}>
                    {sourceLabel(v.source)}
                  </span>
                  <span className="version-when">{formatWhen(v.createdAt, now)}</span>
                </div>
                <div className="version-title">{displayTitle(v.title, v.body)}</div>
                {v.source === "aiEnhanced" && v.instruction && (
                  <div className="version-instruction">
                    <span className="version-instruction-label">INSTRUCTION</span>
                    <span className="version-instruction-text" dir="auto">
                      {v.instruction}
                    </span>
                  </div>
                )}
                <pre className="version-body">{v.body}</pre>
              </li>
            ))}
          </ul>
        )}

        <div className="dialog-foot">
          <button ref={closeRef} className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
