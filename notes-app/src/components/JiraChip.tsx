import * as api from "../lib/api";
import { ticketLabel } from "../lib/jira";
import { useJiraEnrichment } from "../hooks/useJiraEnrichment";
import type { StatusCategory } from "../types";

interface Props {
  url: string;
  onError: (message: string) => void;
}

// Atlassian's coarse status bucket → the existing status-dot colors (zero new
// colors). The status word is also shown in text, so color is never the only
// signal (WCAG 1.4.1).
const DOT_CLASS: Record<StatusCategory, string> = {
  new: "dot-todo",
  indeterminate: "dot-doing",
  done: "dot-done",
};

// The JIRA link chip. It always opens the ticket in the default browser via the
// guarded api.openExternal — enrichment only decorates the label, and never
// changes the click behavior. Ticket title/status render as React text nodes
// (never HTML), so attacker-influenceable summary text can't inject markup.
export default function JiraChip({ url, onError }: Props) {
  const { state, meta, tooltip } = useJiraEnrichment(url);
  const enriched = state === "loaded" && meta !== null;

  return (
    <button
      className="jira-chip"
      title={tooltip ?? url}
      onClick={() => void api.openExternal(url).catch((e) => onError(String(e)))}
    >
      {enriched ? (
        <>
          <span className={`dot ${DOT_CLASS[meta.statusCategory]}`} aria-hidden="true" />
          <span className="jira-chip-text">
            {meta.key} — {meta.title || "(no summary)"}
            {meta.status ? ` · ${meta.status}` : ""}
          </span>
          <span aria-hidden="true"> ↗</span>
        </>
      ) : (
        ticketLabel(url)
      )}
    </button>
  );
}
