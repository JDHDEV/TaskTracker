import { useEffect, useState } from "react";
import type { ProviderId } from "../types";
import {
  getJiraConfig,
  hasApiKey,
  hasJiraToken,
  setApiKey,
  setJiraConfig,
  setJiraToken,
} from "../lib/api";
import { invalidateJiraEnrichment } from "../hooks/useJiraEnrichment";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  /** Fires after a NON-EMPTY key/token saved successfully (an empty save is a
   *  delete and must not fire). Typed `string`, not ProviderId: it also carries
   *  "atlassian" for the JIRA token, which is not an AI provider. Presence-only
   *  — the key material itself never leaves this dialog (S-6). */
  onKeySaved?: (provider: string) => void;
}

const PROVIDERS: { id: ProviderId; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "console.anthropic.com" },
  { id: "openai", label: "OpenAI (GPT)", hint: "platform.openai.com" },
];

export default function SettingsDialog({ onClose, onError, onKeySaved }: Props) {
  const [present, setPresent] = useState<Record<ProviderId, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    anthropic: "",
    openai: "",
  });

  // JIRA connection: base URL + email are non-secret (prefilled from storage);
  // the token is write-only (a draft field + a presence pill), mirroring the
  // API-key rows.
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraTokenDraft, setJiraTokenDraft] = useState("");
  const [jiraTokenPresent, setJiraTokenPresent] = useState(false);

  useEffect(() => {
    void (async () => {
      const [anthropic, openai, config, tokenPresent] = await Promise.all([
        hasApiKey("anthropic"),
        hasApiKey("openai"),
        getJiraConfig(),
        hasJiraToken(),
      ]);
      setPresent({ anthropic, openai });
      if (config) {
        setJiraBaseUrl(config.baseUrl);
        setJiraEmail(config.email);
      }
      setJiraTokenPresent(tokenPresent);
    })();
  }, []);

  async function saveKey(id: ProviderId) {
    try {
      await setApiKey(id, drafts[id]);
      // Presence re-checked through the boolean-only API (S-6): the pill and
      // the onKeySaved signal are driven by hasApiKey after the save, never by
      // inspecting the draft string. An empty save deletes the key → false →
      // no dismiss.
      const saved = await hasApiKey(id);
      setPresent((p) => ({ ...p, [id]: saved }));
      setDrafts((d) => ({ ...d, [id]: "" }));
      if (saved) onKeySaved?.(id);
    } catch (err) {
      onError(String(err));
    }
  }

  async function saveJiraConnection() {
    try {
      await setJiraConfig({ baseUrl: jiraBaseUrl.trim(), email: jiraEmail.trim() });
      // Refresh any chip already on screen for a linked item (the editor didn't
      // remount — this dialog is an overlay).
      invalidateJiraEnrichment();
    } catch (err) {
      onError(String(err));
    }
  }

  async function saveJiraToken() {
    try {
      await setJiraToken(jiraTokenDraft);
      // Same presence-only re-check as saveKey (S-6).
      const saved = await hasJiraToken();
      setJiraTokenPresent(saved);
      setJiraTokenDraft("");
      invalidateJiraEnrichment();
      if (saved) onKeySaved?.("atlassian");
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Settings</h2>
        <p className="dialog-note">
          Keys and the JIRA token are stored in the Windows credential manager on
          this machine. They are used for requests and are never shown again here.
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

        <div className="keyrow keyrow-jira">
          <div className="keyrow-name">
            JIRA
            <span className={jiraTokenPresent ? "pill pill-on" : "pill"}>
              {jiraTokenPresent ? "token saved" : "no token"}
            </span>
          </div>
          <p className="dialog-note">
            Enrich ticket chips with live title and status. The site URL and email
            are not secret; the API token is stored like the keys above.
          </p>
          <div className="keyrow-form">
            <input
              className="keyrow-input"
              placeholder="Site URL, e.g. https://your-team.atlassian.net"
              aria-label="JIRA site URL"
              value={jiraBaseUrl}
              onChange={(e) => setJiraBaseUrl(e.target.value)}
            />
            <input
              className="keyrow-input"
              placeholder="Account email"
              aria-label="JIRA account email"
              value={jiraEmail}
              onChange={(e) => setJiraEmail(e.target.value)}
            />
            <button className="btn" onClick={() => void saveJiraConnection()}>
              Save connection
            </button>
          </div>
          <div className="keyrow-form">
            <input
              type="password"
              className="keyrow-input"
              placeholder="Paste API token from id.atlassian.net (empty removes)"
              aria-label="JIRA API token"
              value={jiraTokenDraft}
              onChange={(e) => setJiraTokenDraft(e.target.value)}
            />
            <button className="btn" onClick={() => void saveJiraToken()}>
              Save token
            </button>
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
