// Pure, unit-testable helpers for the multi-project frontend. No React, no IPC.
// The tag *vocabulary* union is computed by the backend (active_tags_union) and
// its drop-and-reappear-on-unload behavior is exercised by tags.ts /
// recomputeTagFilter — so it is deliberately not duplicated here.

import type { Item, ProjectInfo } from "../types";

/** The loaded subset of the known projects — the app's live workspace. */
export function loadedProjects(known: ProjectInfo[]): ProjectInfo[] {
  return known.filter((p) => p.loaded);
}

/**
 * Composite React key / merge key for a list row. Two loaded projects can each
 * hold an item with the same id (ids are per-store UUIDs — unique in practice,
 * but the key must never collapse a genuine collision), so key by project AND
 * id. Matches the backend's per-project attribution.
 */
export function itemKey(item: Pick<Item, "id" | "projectId">): string {
  return `${item.projectId ?? ""}:${item.id}`;
}

// --- Monotonic request-token guard for in-flight list loads (step 13). A load
// captures the current token; its result is committed only if that token is
// still the latest when it resolves. A slow listItems that resolves after an
// unload (or after a newer load) therefore cannot repopulate the list from a
// closed/stale store — the race the single-DB app never had to solve. ---

/** The next monotonic token. */
export function nextToken(current: number): number {
  return current + 1;
}

/** Commit a load's result only if its captured token is still the latest, so
 *  the newest load always wins regardless of the order results resolve in. */
export function shouldCommit(captured: number, latest: number): boolean {
  return captured === latest;
}

/**
 * The project a NEW item is created into: the rail's project filter when it
 * names a specific *loaded* project, otherwise "" — meaning the editor must ask
 * for an explicit target (the "All projects" case, or a filter pointing at a
 * project that isn't loaded).
 */
export function resolveCreateTarget(projectFilter: string, loaded: ProjectInfo[]): string {
  if (!projectFilter) return "";
  return loaded.some((p) => p.id === projectFilter) ? projectFilter : "";
}
