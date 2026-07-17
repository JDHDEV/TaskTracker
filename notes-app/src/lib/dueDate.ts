// Pure due-date helpers. DOM-free and unit-tested, mirroring jira.ts.
//
// A due date is a single calendar day. On the wire it is stored as RFC 3339
// TEXT at UTC midnight (`yyyy-mm-ddT00:00:00Z`) to stay consistent with the
// "RFC 3339 TEXT end to end" convention. Every comparison and format here works
// on the calendar-date PARTS (the leading yyyy-mm-dd), never by parsing the
// full timestamp through `new Date(iso)` — that would shift the day by the
// viewer's timezone (the classic UTC-parse off-by-one).

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `yyyy-mm-dd` prefix of a stored dueAt, or `""` when absent/unparseable.
 * Feeds a native `<input type="date">` value.
 */
export function toDateInputValue(dueAt: string | null | undefined): string {
  if (!dueAt) return "";
  const day = dueAt.slice(0, 10);
  return DATE_ONLY.test(day) ? day : "";
}

/**
 * A `yyyy-mm-dd` input value → the RFC 3339 wire value (UTC midnight). An empty
 * or malformed input yields `""` so the caller can clear the field (empty
 * clears over IPC); it never coerces `""` into a bogus date.
 */
export function fromDateInputValue(value: string): string {
  return DATE_ONLY.test(value) ? `${value}T00:00:00Z` : "";
}

/** The local-zone calendar-day key (`yyyy-mm-dd`) of a Date. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * "Jul 20"-style label from a stored dueAt; `""` when absent/unparseable. Built
 * from the date parts (constructed as a local Date, no UTC parse) so the day
 * never drifts by timezone. Reuses the same month/day formatting as the row
 * timestamp.
 */
export function formatDueDate(dueAt: string | null | undefined): string {
  const day = toDateInputValue(dueAt);
  if (!day) return "";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * True when the due calendar day is strictly before `now`'s local calendar day.
 * `now` is always passed in — this never reads the clock itself, keeping it
 * pure and testable. Today is NOT overdue; absent/unparseable dueAt → false.
 * Does not consider task status: the caller suppresses the overdue cue on done
 * tasks (a finished task is never late).
 */
export function isOverdue(dueAt: string | null | undefined, now: Date): boolean {
  const day = toDateInputValue(dueAt);
  if (!day) return false;
  return day < localDateKey(now);
}
