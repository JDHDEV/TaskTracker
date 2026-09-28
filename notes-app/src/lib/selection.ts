// Pure, unit-testable selection helpers for "rework on a text selection" (Plan
// 13, Phase 1). No React, no IPC. Editor.tsx, PromptEditor.tsx and
// ScratchEditor.tsx capture a textarea's selectionStart/End into a
// SelectionRange, and route every decision — is there a usable selection, has
// the body moved under a pending proposal, where does the proposal land —
// through these three functions so the guard is testable in the node-env vitest
// setup rather than through the DOM.
//
// The one invariant that matters (Plan 13 §4 H4 / D4): a proposal is spliced
// into the body ONLY when the captured range still holds the exact text that
// was sent for rework. A body edited under a pending proposal never gets a
// misplaced splice — the accept is refused, never fuzzy-relocated and never
// downgraded to a whole-body replace.

/** A half-open [start, end) character range in a body string. */
export interface SelectionRange {
  start: number;
  end: number;
}

/** A range plus the exact text it held when captured — the fingerprint the
 *  accept path re-validates against. */
export interface CapturedSelection extends SelectionRange {
  text: string;
}

/**
 * Turn a raw textarea range into a usable selection, or null when there is
 * none: a null range, a collapsed or inverted range, a range outside
 * `[0, body.length]`, or a slice that is whitespace-only (a whitespace-only
 * selection is treated as "no selection", so Rework falls back to whole-body
 * mode — D7).
 */
export function captureSelection(
  range: SelectionRange | null,
  body: string,
): CapturedSelection | null {
  if (range === null) return null;
  const { start, end } = range;
  if (start >= end) return null;
  if (start < 0 || end > body.length) return null;
  const text = body.slice(start, end);
  if (text.trim() === "") return null;
  return { start, end, text };
}

/** True when the body no longer holds the captured text at the captured range. */
export function isSelectionStale(body: string, sel: CapturedSelection): boolean {
  return body.slice(sel.start, sel.end) !== sel.text;
}

/**
 * Split the body around a captured range for the selection highlight (plan 17
 * feature 4): `before + selected + after` always rejoins to `body` exactly.
 * Null when there is no selection or the range is stale (R-6): a highlight is
 * drawn only while the captured range still holds the captured text — it is
 * never re-searched or relocated (plan 13 D4), it simply disappears.
 */
export function selectionSegments(
  body: string,
  sel: CapturedSelection | null,
): { before: string; selected: string; after: string } | null {
  if (sel === null) return null;
  if (isSelectionStale(body, sel)) return null;
  return {
    before: body.slice(0, sel.start),
    selected: sel.text,
    after: body.slice(sel.end),
  };
}

/**
 * Which captured range the body highlight mirrors (plan 19 D2), written once
 * for the three editors: `confirming` (a selection-rework confirm dialog is
 * up) beats `pending` (an open proposal card's range — the splice target,
 * plan 13 H4 / plan 17 F5) beats `blurred` (the range the native selection
 * held when the textarea lost focus — a mirror of what Rework would act on,
 * since Chromium does not paint an unfocused textarea's selection). Every
 * argument is null when its source is inactive; the result may still be
 * stale against the live body — the caller checks that as before, and
 * `selectionSegments` draws nothing for a stale range (R-6). Trade-off: with
 * a card open for range A, a newly blurred range B is not marked until its
 * own confirm.
 */
export function pickHighlight(
  confirming: CapturedSelection | null,
  pending: CapturedSelection | null,
  blurred: CapturedSelection | null,
): CapturedSelection | null {
  return confirming ?? pending ?? blurred;
}

/**
 * Splice `proposal` over the captured range. Refuses (and leaves nothing
 * changed) when the range is stale. On success `caret` covers the inserted
 * text, so the caller can re-select it after the controlled-textarea update.
 */
export function spliceProposal(
  body: string,
  sel: CapturedSelection,
  proposal: string,
): { ok: true; body: string; caret: SelectionRange } | { ok: false; reason: "stale" } {
  if (isSelectionStale(body, sel)) return { ok: false, reason: "stale" };
  return {
    ok: true,
    body: body.slice(0, sel.start) + proposal + body.slice(sel.end),
    caret: { start: sel.start, end: sel.start + proposal.length },
  };
}
