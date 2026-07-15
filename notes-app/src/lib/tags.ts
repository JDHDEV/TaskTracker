// Pure tag helpers. Tag normalization is 100% frontend-owned (D9): the backend
// stores tags verbatim, so the editor's `new tag` input is the only place a tag
// is cleaned. The rail filter never normalizes — it picks from already-clean
// active tags returned by the backend.

/** trim → lowercase → strip a single leading '#'. Returns "" if nothing remains. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "").trim();
}

/** Normalize `raw` and append it to `tags`, de-duping. Empty input is ignored. */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (!tag || tags.includes(tag)) return tags;
  return [...tags, tag];
}

/**
 * Prune a selected tag-filter set against the current active-tag vocabulary,
 * preserving the selected order. When the tag lifecycle releases a tag (its
 * last active reference finishes or is archived), it drops out of `vocab`, so
 * any selected filter badge for it is removed here — reproducing the
 * DESIGN.md tag-lifecycle badge-drop.
 */
export function recomputeTagFilter(selected: string[], vocab: string[]): string[] {
  return selected.filter((t) => vocab.includes(t));
}
