// The review card's layout preference (plan 17 D8), persisted in localStorage.
// Mirrors aiProvider.ts / palettes.ts: a whitelist-validated persisted enum with
// a deterministic fallback, so a stale or garbage stored value can never reach
// a className (R-15). Every storage access is wrapped — a private window or
// blocked site data must never break the card.

export type ReviewLayout = "inline" | "split";

const KEY = "reviewLayout";
const DEFAULT: ReviewLayout = "inline";

/** Whether `v` is one of the two known layouts — the whitelist gate. */
export function isReviewLayout(v: unknown): v is ReviewLayout {
  return v === "inline" || v === "split";
}

/** The stored layout, or `"inline"` when unset, unrecognized, or unreadable. */
export function getReviewLayout(): ReviewLayout {
  try {
    const stored = localStorage.getItem(KEY);
    return isReviewLayout(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Persist the layout. Best-effort: a storage failure is silently skipped. */
export function setReviewLayout(layout: ReviewLayout): void {
  try {
    localStorage.setItem(KEY, layout);
  } catch {
    // QuotaExceededError / storage disabled — the choice just doesn't persist.
  }
}
