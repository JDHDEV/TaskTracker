import JiraChip from "./JiraChip";

interface Props {
  url: string;
  onChange: (url: string) => void;
  onError: (message: string) => void;
}

// JIRA reference row: a mono URL field plus the link chip. The chip (a <button>,
// never an <a href> the webview could follow) opens the ticket in the default
// browser and, when JIRA is configured, enriches its label with live ticket
// title/status — see JiraChip / useJiraEnrichment.
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
      {trimmed && <JiraChip url={trimmed} onError={onError} />}
    </div>
  );
}
