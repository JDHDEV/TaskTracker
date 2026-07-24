// The selected color palette, persisted in localStorage. A palette bundles an
// accent family AND a neutral set and declares its polarity (light/dark). It is
// applied to <html> as two attributes set atomically: data-palette (accent +
// neutrals — the authoritative token source) and data-theme (polarity, which
// the legacy [data-theme="dark"] rules still key on). Mirrors aiProvider.ts: a
// whitelist-validated persisted enum with a deterministic fallback, so a stale
// or garbage stored id can never reach the DOM attribute (or a CSS selector).

export type Polarity = "light" | "dark";

export type PaletteId =
  | "original"
  | "v2-light"
  | "v2-dark"
  | "neon-noir"
  | "claude-terminal";

export interface Palette {
  id: PaletteId;
  label: string;
  polarity: Polarity;
}

// The complete, ordered set the picker shows — the entire palette vocabulary
// after Plan 11. The legacy yellow-accent "Original dark" is deliberately gone;
// there is no code path to it. Each entry's polarity feeds the atomic data-theme
// write, so it MUST match the token block's neutral family in styles.css.
export const PALETTES: readonly Palette[] = [
  { id: "original", label: "Original", polarity: "light" },
  { id: "v2-light", label: "Gray + teal (light)", polarity: "light" },
  { id: "v2-dark", label: "Gray + teal (dark)", polarity: "dark" },
  { id: "neon-noir", label: "Neon noir", polarity: "dark" },
  { id: "claude-terminal", label: "Claude terminal", polarity: "dark" },
];

const KEY = "palette";
const DEFAULT: PaletteId = "original";

/** Whether `id` is one of the five known palettes — the whitelist gate that
 *  every persisted/attribute-bound value passes through. */
export function isPaletteId(id: string | null): id is PaletteId {
  return id !== null && PALETTES.some((p) => p.id === id);
}

/** The polarity (data-theme value) of a known palette. */
export function polarityOf(id: PaletteId): Polarity {
  // Non-null: id is a PaletteId, so it always resolves in PALETTES.
  return PALETTES.find((p) => p.id === id)!.polarity;
}

/** The stored palette id, or `"original"` when unset or unrecognized. */
export function getStoredPalette(): PaletteId {
  const stored = localStorage.getItem(KEY);
  return isPaletteId(stored) ? stored : DEFAULT;
}

/** Persist the selected palette id. */
export function setStoredPalette(id: PaletteId): void {
  localStorage.setItem(KEY, id);
}
