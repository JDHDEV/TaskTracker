import { useEffect, useState } from "react";
import type { ProviderId } from "../types";
import { hasApiKey, setApiKey } from "../lib/api";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
}

const PROVIDERS: { id: ProviderId; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "console.anthropic.com" },
  { id: "openai", label: "OpenAI (GPT)", hint: "platform.openai.com" },
];

export default function SettingsDialog({ onClose, onError }: Props) {
  const [present, setPresent] = useState<Record<ProviderId, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    anthropic: "",
    openai: "",
  });

  useEffect(() => {
    void (async () => {
      const [anthropic, openai] = await Promise.all([
        hasApiKey("anthropic"),
        hasApiKey("openai"),
      ]);
      setPresent({ anthropic, openai });
    })();
  }, []);

  async function saveKey(id: ProviderId) {
    try {
      await setApiKey(id, drafts[id]);
      setPresent((p) => ({ ...p, [id]: drafts[id].trim().length > 0 }));
      setDrafts((d) => ({ ...d, [id]: "" }));
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="API keys"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>API keys</h2>
        <p className="dialog-note">
          Keys are stored in the Windows credential manager on this machine.
          They are used for rework requests and are never shown again here.
        </p>

        {PROVIDERS.map((p) => (
          <div key={p.id} className="keyrow">
            <div className="keyrow-name">
              {p.label}
              <span className={present[p.id] ? "pill pill-on" : "pill"}>
                {present[p.id] ? "key saved" : "no key"}
              </span>
            </div>
            <div className="keyrow-form">
              <input
                type="password"
                className="keyrow-input"
                placeholder={`Paste key from ${p.hint} (empty removes)`}
                value={drafts[p.id]}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                }
              />
              <button className="btn" onClick={() => void saveKey(p.id)}>
                Save key
              </button>
            </div>
          </div>
        ))}

        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
