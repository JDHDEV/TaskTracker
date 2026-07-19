// Pure, unit-testable helpers for the Prompts page. No React, no IPC — mirrors
// the src/lib/projects.ts convention.

import type { PromptSource } from "../types";

/** Human label for a version's origin, shown in the history dialog. */
export function sourceLabel(source: PromptSource): string {
  return source === "aiEnhanced" ? "AI enhanced" : "manual";
}

/** Formats an RFC 3339 timestamp for display — a short time when `iso` falls
 *  on the same calendar day as `now`, else a short date. Matches ItemList's
 *  `when()` helper, but takes `now` as an explicit argument (never reads the
 *  system clock itself) so it stays deterministic and unit-testable. */
export function formatWhen(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
