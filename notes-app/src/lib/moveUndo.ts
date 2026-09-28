// Plan 18, post-smoke fix (§12): the scratch pad's own "put the moved text
// back" for a "send selection to…" move. No React, no DOM.
//
// Why native undo is not enough: Chromium keeps ONE undo stack per window,
// not per field. The move deletes natively (so Ctrl+Z right afterwards works),
// but as soon as the user types in the destination draft those keystrokes sit
// ABOVE the pad's delete, and Ctrl+Z in the pad unwinds them first — the smoke
// pass saw "nothing came back". So the pad remembers its last move and, while
// its body is still exactly what the move left behind, Ctrl+Z reinserts the
// text itself. Once the pad is edited again the record is stale (the body no
// longer matches) and Ctrl+Z is the ordinary native undo.

import type { SelectionRange } from "./selection";

/** What a move removed, and the pad body it left behind. */
export interface MoveRecord {
  /** Offset the removed text started at (the collapsed caret after the cut). */
  start: number;
  /** The exact text that left the pad. */
  text: string;
  /** The pad body immediately after the removal — the "unchanged since" key. */
  bodyAfter: string;
}

/**
 * Reinsert the moved text when `body` is still exactly `move.bodyAfter`;
 * `caret` selects the restored text. Null when there is no record or the pad
 * has been edited since (the caller then lets native undo run).
 */
export function restoreMove(
  body: string,
  move: MoveRecord | null,
): { body: string; caret: SelectionRange } | null {
  if (move === null || body !== move.bodyAfter) return null;
  return {
    body: body.slice(0, move.start) + move.text + body.slice(move.start),
    caret: { start: move.start, end: move.start + move.text.length },
  };
}

/** Ctrl+Z / Cmd+Z only — not Shift (redo), not Alt, not Ctrl+Y. */
export function isUndoKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z";
}
