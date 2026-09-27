import { useId, useMemo, useState, type ReactNode } from "react";
import { changeCounts, diffWords, sideSegments, type DiffOp } from "../lib/diff";
import { getReviewLayout, setReviewLayout, type ReviewLayout } from "../lib/reviewLayout";

interface Props {
  /** The mono uppercase badge text ("Streaming…", "Proposed rewrite", …). The
   *  editor computes it — this card never decides what state it is in. */
  chipLabel: string;
  /** The region's accessible name ("AI rewrite proposal", …). */
  ariaLabel: string;
  /** The proposal text, accumulated while streaming. `null` means the card
   *  has no body half (the item editor's title-only state): the Replace button
   *  and the body are omitted. */
  proposal: string | null;
  streaming: boolean;
  /** The request-time original (D7): the selection's text for a selection
   *  rework, the whole body at request time otherwise. Null = nothing to diff
   *  against (the card shows the plain proposal). */
  original: string | null;
  /** The body moved since a whole-text rework was requested — Replace text
   *  will overwrite those edits. Informational; Replace stays enabled. */
  editedSinceRequest: boolean;
  /** Disables `Replace text` (streaming, saving, or a stale selection range). */
  replaceDisabled: boolean;
  /** Tooltip on `Replace text` (the stale-range hint). */
  replaceTitle?: string;
  /** Accept the proposal. The editor owns the splice — the ONLY splice site is
   *  `spliceProposal` inside the editor's own handler (plan 13 H4); this card
   *  never touches the body. */
  onReplaceText: () => void;
  onDiscard: () => void;
  /** The sr-only `role="status"` text. The editor computes its own priority
   *  ladder (the item editor has four states); the card never reorders it —
   *  it only appends the change counts once a diff exists. */
  statusMessage: string;
  /** Optional slot rendered under the body — the item editor's proposed-title
   *  row. */
  children?: ReactNode;
}

const TOO_LARGE_NOTE = "Too long to compare — showing the proposal only.";
const EDITED_NOTE = "Edited since this rewrite was requested — Replace text overwrites those edits.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Render diff ops as text nodes with <ins>/<del> marks (R-4: JSX children
 *  only, never HTML). Each mark carries an sr-only prefix so a screen reader
 *  hears the change; `ins`/`del` may not be named with aria-label (ARIA 1.2),
 *  and the prefix is `user-select: none` so copying the card never picks it
 *  up. */
function renderOps(ops: DiffOp[]): ReactNode[] {
  return ops.map((op, i) => {
    if (op.type === "equal") return op.text;
    if (op.type === "insert") {
      return (
        <ins key={i} className="rv-ins">
          <span className="sr-only">added: </span>
          {op.text}
        </ins>
      );
    }
    return (
      <del key={i} className="rv-del">
        <span className="sr-only">removed: </span>
        {op.text}
      </del>
    );
  });
}

/** The shared presentational AI review card (plan 17 Phase 0, diffed in
 *  Phase 3). The signature highlighter-marked annotation every editor shows a
 *  proposal in: markup and class names are the pre-extraction inline card's,
 *  written once so the three editors cannot drift. All state and every
 *  decision (chip, aria label, disabled reasons, status ladder, the accept
 *  splice) stay in the editors; this component renders what it is handed, and
 *  owns only the review presentation: the diff memo (computed once, after the
 *  stream is done — R-5), the inline / side-by-side layout toggle (persisted
 *  through reviewLayout.ts), the marks, the two notes and the count suffix. */
export default function ReviewCard({
  chipLabel,
  ariaLabel,
  proposal,
  streaming,
  original,
  editedSinceRequest,
  replaceDisabled,
  replaceTitle,
  onReplaceText,
  onDiscard,
  statusMessage,
  children,
}: Props) {
  const [layout, setLayout] = useState<ReviewLayout>(getReviewLayout);
  const labelBase = useId();

  // Never diff per streamed chunk: only a finished proposal against the
  // request-time original, memoised on exactly those inputs.
  const diff = useMemo(
    () =>
      streaming || proposal === null || original === null
        ? null
        : diffWords(original, proposal),
    [original, proposal, streaming],
  );
  const ops = diff !== null && diff.kind === "ok" ? diff.ops : null;
  const counts = ops !== null ? changeCounts(ops) : null;

  function pickLayout(next: ReviewLayout) {
    setLayout(next);
    setReviewLayout(next);
  }

  const status =
    counts !== null
      ? `${statusMessage} — ${plural(counts.additions, "addition", "additions")}, ${plural(counts.deletions, "deletion", "deletions")}`
      : statusMessage;

  return (
    <div className="review" role="region" aria-label={ariaLabel}>
      <div className="review-head">
        <span className="review-mark">{chipLabel}</span>
        {proposal !== null && (
          <button
            className="btn btn-quiet"
            aria-pressed={layout === "split"}
            onClick={() => pickLayout(layout === "split" ? "inline" : "split")}
          >
            Side by side
          </button>
        )}
        {proposal !== null && (
          <button
            className="btn"
            disabled={replaceDisabled}
            title={replaceTitle}
            onClick={onReplaceText}
          >
            Replace text
          </button>
        )}
        <button className="btn btn-quiet" onClick={onDiscard}>
          Discard
        </button>
      </div>
      {/* Every scrolling body is keyboard-reachable (tabIndex) — the plain one
          while streaming / too-large included — and the split container needs
          a role for its name to count (ARIA forbids naming a bare div). */}
      {proposal !== null && ops === null && (
        <pre className="review-body" tabIndex={0}>
          {proposal}
        </pre>
      )}
      {proposal !== null && ops !== null && layout === "inline" && (
        <pre className="review-body" tabIndex={0}>
          {renderOps(ops)}
        </pre>
      )}
      {proposal !== null && ops !== null && layout === "split" && (
        <div
          className="review-split"
          role="group"
          tabIndex={0}
          aria-label="Original and proposed text"
        >
          <div className="review-col" role="group" aria-labelledby={`${labelBase}-orig`}>
            <span className="review-col-label" id={`${labelBase}-orig`}>
              ORIGINAL
            </span>
            <pre className="review-col-text">{renderOps(sideSegments(ops, "original"))}</pre>
          </div>
          <div className="review-col" role="group" aria-labelledby={`${labelBase}-prop`}>
            <span className="review-col-label" id={`${labelBase}-prop`}>
              PROPOSED
            </span>
            <pre className="review-col-text">{renderOps(sideSegments(ops, "proposal"))}</pre>
          </div>
        </div>
      )}
      {diff !== null && diff.kind === "too-large" && (
        <p className="review-note">{TOO_LARGE_NOTE}</p>
      )}
      {proposal !== null && !streaming && editedSinceRequest && (
        <p className="review-note">{EDITED_NOTE}</p>
      )}
      {children}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
