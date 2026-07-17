// The R4 decision — "what title should this save use?" — extracted as a pure,
// dependency-injected function so the highest-value behavior is unit-testable
// without React or a Tauri mock (the AI call is the injected `generate`). The
// Editor's save() delegates the empty-title branch here.

/**
 * Resolve the title to save with:
 *  - a non-empty title passes through (trimmed), `generate` is never called;
 *  - an empty title with a non-empty body calls `generate(body)` and returns
 *    the generated title, mapping a rejection to `{ error: String(err) }`
 *    (so the missing-key and generic copies both surface verbatim);
 *  - both empty returns the existing `Give it a title before saving.` error and
 *    never calls `generate`.
 * Emptiness is `!trim()`, so a single-space title counts as empty (D11).
 */
export async function resolveTitleForSave(
  title: string,
  body: string,
  generate: (text: string) => Promise<string>,
): Promise<{ title: string } | { error: string }> {
  const trimmed = title.trim();
  if (trimmed) return { title: trimmed };
  if (!body.trim()) return { error: "Give it a title before saving." };
  try {
    return { title: await generate(body) };
  } catch (err) {
    return { error: String(err) };
  }
}
