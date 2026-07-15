import * as api from "../lib/api";
import { ticketLabel } from "../lib/jira";

interface Props {
  url: string;
  onChange: (url: string) => void;
  onError: (message: string) => void;
}

// JIRA reference row: a mono URL field plus a link chip (a <button>, never an
// <a href> the webview could follow) that opens the ticket in the default
// browser via the guarded api.openExternal.
export default function JiraRow({ url, onChange, onError }: Props) {
  const trimmed = url.trim();
  return (
    <div className="jira-row">
      <span className="jira-label">JIRA</span>
      <input
        className="jira-input"
        value={url}
        placeholder="Paste JIRA ticket URL (empty removes)"
        aria-label="JIRA ticket URL"
        onChange={(e) => onChange(e.target.value)}
      />
      {trimmed && (
        <button
          className="jira-chip"
          title={url}
          onClick={() => void api.openExternal(trimmed).catch((e) => onError(String(e)))}
        >
          {ticketLabel(trimmed)}
        </button>
      )}
    </div>
  );
}
