// Pure, unit-testable helpers for the Prompts page. No React, no IPC — mirrors
// the src/lib/projects.ts convention.

import type { PromptSource } from "../types";

/** Human label for a version's origin, shown in the history dialog. */
export function sourceLabel(source: PromptSource): string {
  return source === "aiEnhanced" ? "AI enhanced" : "manual";
}

/** The label to show for a prompt or version whose title may be empty (plan.8:
 *  the title is optional). Prefers the trimmed title; falls back to the first
 *  non-blank line of the body (truncated to 60 chars, guarding a body that leads
 *  with blank lines); finally "Untitled" so a row/label is never blank. Pure —
 *  the result is rendered only as a React text node (never HTML). */
export function displayTitle(title: string, body: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return firstLine.slice(0, 60);
  return "Untitled";
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
