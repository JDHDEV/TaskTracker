import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { ABOUT } from "../lib/about";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
}

/** Product identity + build version — the "which build am I running?" answer for
 *  a shipped .exe. Follows PromptHistoryDialog's discipline: Escape or the scrim
 *  closes it, and focus lands on `Close` when it opens. No focus trap (the app
 *  has none). */
export default function AboutDialog({ onClose, onError }: Props) {
  const [version, setVersion] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  // The .catch is required (unlike SettingsDialog's load): a failed version read
  // must degrade to an empty version, never an unhandled rejection.
  useEffect(() => {
    api.getAppVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="About worknotes"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{ABOUT.name}</h2>
        <p className="dialog-note">Version {version}</p>
        <p className="dialog-note">{ABOUT.tagline}</p>
        <button
          className="btn btn-quiet"
          onClick={() =>
            void api.openExternal(ABOUT.repoUrl).catch((e) => onError(String(e)))
          }
        >
          View on GitHub
        </button>

        <div className="dialog-foot">
          <button ref={closeRef} className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
