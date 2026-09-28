/// <reference types="vite/client" />
import css from "../styles.css?raw";
import { PALETTES, type PaletteId } from "./palettes";
import { describe, expect, it } from "vitest";

// Stylesheet palette-completeness guard (plan 18 D7 / step 21).
//
// styles.css names a palette id inside a selector in three shapes: a TOKEN
// BLOCK (`:root[data-palette="<id>"] { --bg: …; … }`, no descendant), a
// per-palette OVERRIDE that shares a selector shape across several ids (e.g.
// the `.btn:not(…)` dark fill chain, or `.review-mark`), sometimes written as
// one comma-separated rule and sometimes as several single-id rules — both
// must be treated as the same "group". This file parses the real stylesheet
// (via Vite's `?raw` import — no `fs`, no `@types/node`) instead of matching
// fixed line numbers, so it keeps failing correctly as the file changes.

interface Rule {
  selector: string;
  body: string;
}

// Strip CSS block comments (may span lines) before any other parsing.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Recursively pull every `selector { body }` block out of `text`, tracking
 *  brace depth so a nested block (`@media (…) { .foo { … } }`) doesn't break
 *  the split: the outer "rule" is collected (its @media prelude never carries
 *  a palette id, so it's harmless) and its body is walked again for the real
 *  rule(s) nested inside it. */
function extractRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let selectorStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const selector = text.slice(selectorStart, i);
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(i + 1, j - 1);
    rules.push({ selector, body });
    rules.push(...extractRules(body));
    i = j;
    selectorStart = j;
  }
  return rules;
}

/** Split a selector list on top-level commas only (depth-tracked, so a comma
 *  inside `:not(a, b)` — not used today, but kept generic — never splits). */
function splitTopLevelCommas(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Collapse whitespace/newlines to single spaces and trim, so a selector
 *  written across two lines (the `.btn:not(…)` chain) normalises to the same
 *  text as its single-line siblings and groups with them. */
function normalize(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

const ID_RE = /\[data-palette="([^"]+)"\]/;
const TOKEN_BLOCK_RE = /^:root\[data-palette="([^"]+)"\]$/;
const PROP_RE = /(--[a-zA-Z0-9-]+)\s*:/g;
const PLACEHOLDER = '[data-palette="§"]'; // §, unlikely to collide with real CSS

const rules = extractRules(stripComments(css));

/** canonical group key (selector with its id blanked out) -> every id seen there */
const groups = new Map<string, Set<string>>();
/** palette id -> the custom-property names its `:root[data-palette="id"]` block declares */
const tokenBlocks = new Map<string, Set<string>>();
/** every `[data-palette="…"]` id found anywhere in the stylesheet */
const allIds = new Set<string>();

for (const rule of rules) {
  for (const rawSelector of splitTopLevelCommas(rule.selector)) {
    const selector = normalize(rawSelector);
    const match = selector.match(ID_RE);
    if (!match) continue;
    const id = match[1];
    allIds.add(id);

    const groupKey = selector.replace(`[data-palette="${id}"]`, PLACEHOLDER);
    const ids = groups.get(groupKey) ?? new Set<string>();
    ids.add(id);
    groups.set(groupKey, ids);

    if (TOKEN_BLOCK_RE.test(selector)) {
      const names = new Set<string>();
      for (const m of rule.body.matchAll(PROP_RE)) names.add(m[1]);
      tokenBlocks.set(id, names);
    }
  }
}

const DARK: PaletteId[] = PALETTES.filter((p) => p.polarity === "dark").map((p) => p.id);
const LIGHT: PaletteId[] = PALETTES.filter((p) => p.polarity === "light").map((p) => p.id);
const KNOWN: PaletteId[] = PALETTES.map((p) => p.id);

// Groups that exist ONLY for hc-dark by design (a boundary/ring color the
// other dark palettes don't need) — their dark-id set is exactly {"hc-dark"},
// never empty and never the full DARK set. Named explicitly so any OTHER
// partial dark set still fails assertion (b).
const HC_ONLY_ALLOWLIST = new Set<string>([
  ':root[data-palette="§"] .etab-x', // the base close-button, NOT .etab-x:hover
  ':root[data-palette="§"] .pin',
  ':root[data-palette="§"] .etab-unsaved',
]);

function darkIdsOf(ids: Set<string>): PaletteId[] {
  return DARK.filter((id) => ids.has(id));
}

describe("PALETTES / DARK derivation sanity", () => {
  it("finds at least one light and more than one dark palette", () => {
    expect(LIGHT.length).toBeGreaterThan(0);
    expect(DARK.length).toBeGreaterThan(1);
  });
});

describe("assertion (a): every non-original palette owns a token block", () => {
  const idsRequiringBlock = KNOWN.filter((id) => id !== "original");

  it.each(idsRequiringBlock)('declares :root[data-palette="%s"] { … }', (id) => {
    expect(tokenBlocks.has(id), `missing :root[data-palette="${id}"] token block`).toBe(true);
  });
});

describe("assertion (b): every dark-override group is empty, complete, or hc-only", () => {
  const entries = [...groups.entries()];

  it.each(entries)("group %s", (groupKey, ids) => {
    const dark = darkIdsOf(ids);
    if (dark.length === 0) return; // a light-only or unrelated group: fine

    if (HC_ONLY_ALLOWLIST.has(groupKey)) {
      expect(
        dark.slice().sort(),
        `group "${groupKey}" is HC-only and must contain exactly hc-dark, found: ${dark.join(", ")}`,
      ).toEqual(["hc-dark"]);
      return;
    }

    const missing = DARK.filter((id) => !ids.has(id));
    expect(
      missing,
      `group "${groupKey}" is missing dark ids: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the pre-existing mixed .btn-save group (v2-light beside every dark id)", () => {
    const key = [...groups.keys()].find((k) => k.endsWith(".btn-save"));
    expect(key, "no .btn-save group was found").toBeDefined();
    const ids = groups.get(key!)!;
    expect(ids.has("v2-light"), ".btn-save lost its v2-light Save-label fix").toBe(true);
    expect(darkIdsOf(ids).sort()).toEqual([...DARK].sort());
  });
});

describe("assertion (c): no id outside PALETTES appears anywhere", () => {
  it("every [data-palette] id in the stylesheet is a known PaletteId", () => {
    const unknown = [...allIds].filter((id) => !KNOWN.includes(id as PaletteId));
    expect(unknown, `unknown palette id(s) in styles.css: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("assertion (d): parser self-check (not a vacuous pass)", () => {
  it("finds at least 6 groups with a non-empty dark id set", () => {
    const nonEmpty = [...groups.values()].filter((ids) => darkIdsOf(ids).length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(6);
  });

  it("groups the multi-line .btn:not(…) fill chain with its single-line siblings", () => {
    const key = [...groups.keys()].find(
      (k) => k.includes(".btn:not(.btn-quiet)") && !k.includes(":hover"),
    );
    expect(key, "the .btn:not(…) fill chain group was not found at all").toBeDefined();
    const ids = groups.get(key!)!;
    expect(
      darkIdsOf(ids).sort(),
      `.btn:not(…) fill chain has dark ids [${[...ids].join(", ")}], expected all of [${DARK.join(", ")}]`,
    ).toEqual([...DARK].sort());
  });
});

describe("assertion (e): token blocks declare a consistent set of custom properties", () => {
  // v2-light is the one palette block that declares exactly the base set (no
  // --hl-fill override), so it — not a hardcoded count — is the base list.
  const base = tokenBlocks.get("v2-light");

  it("found the v2-light token block to derive the base token set from", () => {
    expect(base).toBeDefined();
    expect(base!.size).toBeGreaterThan(0);
  });

  it.each(KNOWN.filter((id) => id !== "original"))("%s declares every base token", (id) => {
    const names = tokenBlocks.get(id);
    expect(names, `no token block for ${id}`).toBeDefined();
    for (const name of base!) {
      expect(names!.has(name), `${id} is missing base token ${name}`).toBe(true);
    }
  });

  const v2DarkNames = tokenBlocks.get("v2-dark");

  it.each(DARK.filter((id) => id !== "v2-dark"))(
    "%s (dark) declares the same token names as v2-dark (incl. --hl-fill)",
    (id) => {
      expect(v2DarkNames).toBeDefined();
      const names = tokenBlocks.get(id);
      expect(names, `no token block for ${id}`).toBeDefined();
      expect([...names!].sort()).toEqual([...v2DarkNames!].sort());
    },
  );
});
