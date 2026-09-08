// Pure, unit-testable helpers for the "Insert timestamp" context-menu item
// (Plan 16, D2/D3). No React, no IPC. The clock is always an argument — this
// module never reads `Date.now()` itself (the `formatWhen`/`isOverdue`
// convention), so the format is deterministic under test.

/**
 * `yyyy-mm-dd HH:mm` in LOCAL wall time, zero-padded, 24-hour, no seconds, no
 * offset, no trailing space. Built from the local Date parts (the
 * `localDateKey` template in dueDate.ts) — never `toISOString()` (UTC shift)
 * or `toLocale*` (locale-dependent bytes in git-tracked files).
 */
export function formatTimestamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Splice `text` over `[start, end)` of `body`: a non-empty range is replaced,
 * a collapsed one is a plain insert at the caret. `caret` is the collapsed
 * position right AFTER the inserted text (unlike `spliceProposal`, which
 * selects the insert). An inverted range is normalised; a range outside
 * `[0, body.length]` yields `null` so a caller acting on a stale buffer
 * (§4 MUST 8) changes nothing.
 */
export function insertText(
  body: string,
  range: { start: number; end: number },
  text: string,
): { body: string; caret: number } | null {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (start < 0 || end > body.length) return null;
  return {
    body: body.slice(0, start) + text + body.slice(end),
    caret: start + text.length,
  };
}
