// The one rule shared by every AI title-generation path (the Suggest title
// button and a rework's proposed title): a suggestion identical to the current
// title is a no-op the user should never be asked to approve, so it is skipped
// silently. Kept pure and colocated-tested so the "matches exactly" contract is
// unit-checkable without React.

/**
 * True when a freshly generated title exactly matches the current one — meaning
 * there is nothing to propose or approve, so the caller displays no proposal.
 * Exact string equality (the feature's "matches the existing title exactly").
 */
export function isRedundantTitle(generated: string, current: string): boolean {
  return generated === current;
}
