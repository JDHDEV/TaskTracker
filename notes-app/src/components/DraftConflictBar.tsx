// Plan.15 D4: the draft-recovery conflict bar. Shown above an editor whose
// item changed on disk since its recovered unsaved edits were captured
// (baseUpdatedAt mismatch) — the tab opened CLEAN on the disk content, the
// draft file is kept, and the user makes an explicit two-button choice:
// "Keep saved version" deletes the draft; "Restore unsaved edits" seeds the
// buffer via the editor's imperative applyDraft handle and marks it dirty.
// Never api.confirmDialog (that is binary Yes/No; this needs two NAMED
// actions), and never an auto-restore — the app has no undo, so a stale
// buffer silently restored + Ctrl+S would clobber newer content.
//
// Styled like JiraRow (hairline, no icons, sentence case). Both actions are
// native buttons — keyboard-reachable and focusable by default.

interface Props {
  /** The item's display title, for the one-line explanation. */
  title: string;
  /** Mirrors the owning editor's hidden state (background tab). */
  hidden: boolean;
  /** Delete the kept draft; the saved version stands. */
  onKeep: () => void;
  /** Seed the buffer from the draft (applyDraft) and mark the tab dirty. */
  onRestore: () => void;
}

export default function DraftConflictBar({ title, hidden, onKeep, onRestore }: Props) {
  return (
    <div
      className="draft-conflict"
      role="group"
      aria-label={`Recovered unsaved edits for "${title}"`}
      hidden={hidden}
    >
      <span className="draft-conflict-text">
        {`"${title}" changed on disk since your unsaved edits.`}
      </span>
      <button className="btn btn-quiet" onClick={onKeep}>
        Keep saved version
      </button>
      <button className="btn" onClick={onRestore}>
        Restore unsaved edits
      </button>
    </div>
  );
}
