// In-house word-level diff for the AI review card (plan 17 D7). Pure, no
// dependency, node-testable. `ReviewCard` renders `diffWords(original,
// proposal)` as text nodes with <ins>/<del> marks — never HTML (R-4) — and only
// once a stream has finished, memoised on its two inputs (R-5).
//
// Shape: tokenize both sides (each newline its own token, a whitespace run one
// token, words whole, punctuation single), trim the common prefix and suffix,
// run Myers' O((N+M)·D) shortest-edit search on the middle keeping only the
// per-step frontier windows (memory O(D²)), then tidy the ops for display.
// Everything is bounded (R-5): a per-side character cap before tokenizing, a
// per-side token cap after trimming, and a maximum edit distance — past any of
// them the result is `too-large` and the card falls back to the plain proposal.

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

export type DiffResult = { kind: "ok"; ops: DiffOp[] } | { kind: "too-large" };

/** Tokens per side after prefix/suffix trimming; above this the diff bails. */
export const MAX_TOKENS = 5000;
/** Maximum edit distance Myers is allowed to search before bailing. */
export const MAX_D = 1000;
/** Characters per side before tokenizing (a 4 MiB body never gets tokenized). */
export const MAX_CHARS = 256 * 1024;

// One alternative per token class, tried in order at the current position
// (sticky): CRLF, LF, a run of non-newline whitespace, a word (letters, marks,
// digits, with interior apostrophes so "don't" stays whole), or a single other
// character (punctuation, symbols, emoji). No nested unbounded quantifiers —
// the apostrophe group must consume an apostrophe per iteration, so the match
// is linear in the input.
const TOKEN = /\r\n|\n|[^\S\r\n]+|[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]/uy;

/** Split `text` into display tokens. Invariant: `tokens.join("") === text`. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (m !== null && m[0].length > 0) {
      tokens.push(m[0]);
      i += m[0].length;
    } else {
      // Nothing above matches here (a lone `\r`, an unpaired surrogate): take
      // one code unit so the tokens still rejoin to the input exactly.
      tokens.push(text[i]);
      i += 1;
    }
  }
  return tokens;
}

/**
 * Word-level diff of `a` (original) → `b` (proposal). `ok` ops rejoin to each
 * side: equal + delete = `a`, equal + insert = `b`. Adjacent ops of one type
 * are coalesced, every change run lists its deletion before its insertion, and
 * a run of plain spaces/tabs that only separates two changes is folded into
 * both so the marks do not alternate word by word.
 */
export function diffWords(a: string, b: string): DiffResult {
  if (a.length > MAX_CHARS || b.length > MAX_CHARS) return { kind: "too-large" };
  const ta = tokenize(a);
  const tb = tokenize(b);

  // Common prefix and suffix are equal by construction — keep them out of the
  // search (the suffix never overlaps the prefix).
  const maxPrefix = Math.min(ta.length, tb.length);
  let prefix = 0;
  while (prefix < maxPrefix && ta[prefix] === tb[prefix]) prefix += 1;
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    ta[ta.length - 1 - suffix] === tb[tb.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const midA = ta.slice(prefix, ta.length - suffix);
  const midB = tb.slice(prefix, tb.length - suffix);
  if (midA.length > MAX_TOKENS || midB.length > MAX_TOKENS) return { kind: "too-large" };

  const mid = myers(midA, midB);
  if (mid === null) return { kind: "too-large" };

  let raw: DiffOp[] = [];
  if (prefix > 0) raw.push({ type: "equal", text: ta.slice(0, prefix).join("") });
  raw = raw.concat(mid);
  if (suffix > 0) raw.push({ type: "equal", text: ta.slice(ta.length - suffix).join("") });
  return { kind: "ok", ops: normalize(raw) };
}

/**
 * Myers' shortest edit script over two token arrays. Returns one op per token
 * (uncoalesced), or null once the edit distance would exceed `MAX_D`. The
 * frontier `v` is copied per step as a window over k ∈ [-(d+1), d+1] — the only
 * cells the backtrack reads — so the trace costs O(D²), not O(D·(N+M)).
 */
function myers(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ type: "insert" as const, text }));
  if (m === 0) return a.map((text) => ({ type: "delete" as const, text }));

  const max = n + m;
  const limit = Math.min(max, MAX_D);
  const offset = max + 1; // v[offset + k] holds the furthest x on diagonal k
  const v = new Int32Array(2 * max + 3);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= limit && !found; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // move down: an insertion
      } else {
        x = v[offset + k - 1] + 1; // move right: a deletion
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;

  // Walk the trace backwards from (n, m) to (0, 0), emitting ops in reverse.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const w = trace[d];
    const base = d + 1; // w[k + base] is v[k] as it stood before step d
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && w[k - 1 + base] < w[k + 1 + base])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = w[prevK + base];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "insert", text: b[prevY] });
      else ops.push({ type: "delete", text: a[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

/** Merge adjacent ops of the same type; drop empty ones. */
function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (op.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ type: op.type, text: op.text });
  }
  return out;
}

/** Plain spaces/tabs only — newlines stay as equal runs so line structure
 *  survives in the marked-up view. */
function isFoldableGap(text: string): boolean {
  return /^[^\S\r\n]+$/.test(text);
}

/** Display tidy-up: fold separating whitespace, order deletes before inserts
 *  within each change run, coalesce. Both rejoin invariants are preserved —
 *  a folded gap is emitted as BOTH a deletion and an insertion of itself. */
function normalize(raw: DiffOp[]): DiffOp[] {
  const ops = coalesce(raw);
  const folded: DiffOp[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const between =
      i > 0 && i < ops.length - 1 && ops[i - 1].type !== "equal" && ops[i + 1].type !== "equal";
    if (op.type === "equal" && between && isFoldableGap(op.text)) {
      folded.push({ type: "delete", text: op.text }, { type: "insert", text: op.text });
    } else {
      folded.push(op);
    }
  }
  const out: DiffOp[] = [];
  let del = "";
  let ins = "";
  const flush = () => {
    if (del !== "") out.push({ type: "delete", text: del });
    if (ins !== "") out.push({ type: "insert", text: ins });
    del = "";
    ins = "";
  };
  for (const op of folded) {
    if (op.type === "equal") {
      flush();
      out.push(op);
    } else if (op.type === "delete") {
      del += op.text;
    } else {
      ins += op.text;
    }
  }
  flush();
  return coalesce(out);
}

/** One side's view of a diff: the original shows equal + deleted text, the
 *  proposal equal + inserted text. Each side rejoins to its own input. */
export function sideSegments(ops: DiffOp[], side: "original" | "proposal"): DiffOp[] {
  const drop = side === "original" ? "insert" : "delete";
  return ops.filter((op) => op.type !== drop);
}

/** How many inserted and deleted spans a diff carries (for the status line). */
export function changeCounts(ops: DiffOp[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "insert") additions += 1;
    else if (op.type === "delete") deletions += 1;
  }
  return { additions, deletions };
}
