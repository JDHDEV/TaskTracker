import { useEffect, useRef, useState } from "react";
import type { PromptVersion } from "../types";
import * as api from "../lib/api";
import { formatWhen, sourceLabel } from "../lib/prompts";

interface Props {
  promptId: string;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Version history, newest-first (the backend already returns it that way).
 *  Loads on open; Escape or the scrim closes it, and focus lands on `Close`
 *  when it opens (this dialog is new, so it gets this discipline from the
 *  start — the older dialogs are unchanged). */
export default function PromptHistoryDialog({ promptId, onClose, onError }: Props) {
  const [versions, setVersions] = useState<PromptVersion[] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
        aria-label="Prompt history"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>History</h2>

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
                <div className="version-title">{v.title}</div>
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
