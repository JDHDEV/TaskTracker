import { describe, it, expect } from "vitest";
import {
  tokenize,
  diffWords,
  sideSegments,
  changeCounts,
  MAX_TOKENS,
  MAX_D,
  MAX_CHARS,
} from "./diff";
import type { DiffOp, DiffResult } from "./diff";

// A tiny inline deterministic PRNG (mulberry32) for the seeded loops below —
// no new dependency (plan 17 R-17), just a reproducible sequence so a failure
// is always re-runnable from its printed seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rand: () => number, maxExclusive: number): number {
  return Math.floor(rand() * maxExclusive);
}

function okOps(r: DiffResult): DiffOp[] {
  if (r.kind !== "ok") throw new Error("expected an ok diff, got too-large");
  return r.ops;
}

describe("tokenize", () => {
  it("keeps a plain word as one token", () => {
    expect(tokenize("hello")).toEqual(["hello"]);
  });

  it("keeps a run of non-newline whitespace as one token", () => {
    expect(tokenize("a  b")).toEqual(["a", "  ", "b"]);
  });

  it("gives each newline its own token", () => {
    expect(tokenize("a\nb\nc")).toEqual(["a", "\n", "b", "\n", "c"]);
  });

  it("treats a CRLF pair as one token, not two", () => {
    expect(tokenize("a\r\nb")).toEqual(["a", "\r\n", "b"]);
  });

  it("gives a lone \\r (no following \\n) its own token", () => {
    expect(tokenize("a\rb")).toEqual(["a", "\r", "b"]);
  });

  it("includes a tab inside a surrounding whitespace run as part of that one token", () => {
    expect(tokenize("a\t \tb")).toEqual(["a", "\t \t", "b"]);
  });

  it("tokenizes punctuation as single characters, one token each", () => {
    expect(tokenize("a,b.")).toEqual(["a", ",", "b", "."]);
  });

  it("keeps an apostrophe word whole (don't)", () => {
    expect(tokenize("don't")).toEqual(["don't"]);
  });

  it("keeps a word with multiple interior apostrophes whole (rock'n'roll)", () => {
    expect(tokenize("rock'n'roll")).toEqual(["rock'n'roll"]);
  });

  it("keeps a word whole with a curly apostrophe (’)", () => {
    expect(tokenize("don’t")).toEqual(["don’t"]);
  });

  it("splits a LEADING quote off as its own token (not part of the following word)", () => {
    expect(tokenize("'hello")).toEqual(["'", "hello"]);
  });

  it("keeps a run of CJK characters together as one word token", () => {
    const tokens = tokenize("你好世界"); // 你好世界
    expect(tokens).toEqual(["你好世界"]);
  });

  it("splits CJK text around punctuation into separate tokens", () => {
    const tokens = tokenize("你好，世界"); // 你好，世界
    expect(tokens).toEqual(["你好", "，", "世界"]);
  });

  it("keeps an emoji surrogate pair as one token, not two lone surrogate halves", () => {
    const EMOJI = String.fromCodePoint(0x1f600);
    const tokens = tokenize(`hi ${EMOJI} bye`);
    expect(tokens).toEqual(["hi", " ", EMOJI, " ", "bye"]);
    expect(tokens[2].length).toBe(2); // both UTF-16 units, one token
  });

  it("returns [] for an empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("rejoin invariant: hand-picked cases always rejoin to the input", () => {
    const cases = [
      "",
      "hello",
      "a  b",
      "a\nb\nc",
      "a\r\nb",
      "a\rb",
      "a\t \tb",
      "a,b.",
      "don't",
      "rock'n'roll",
      "don’t",
      "'hello",
      "你好世界",
      `hi ${String.fromCodePoint(0x1f600)} bye`,
      "line1\nline2\r\nline3\rline4",
      "  leading and trailing whitespace  ",
    ];
    for (const s of cases) {
      expect(tokenize(s).join("")).toBe(s);
    }
  });

  it("rejoin invariant: a seeded loop of ~200 random strings over a mixed alphabet", () => {
    const EMOJI = String.fromCodePoint(0x1f600);
    const CJK = "你"; // 你
    const alphabet = [
      "a",
      "b",
      "c",
      "z",
      "0",
      "9",
      " ",
      "\t",
      "\n",
      "\r",
      ",",
      ".",
      "!",
      "?",
      "'",
      "’",
      EMOJI,
      CJK,
    ];
    const rand = mulberry32(20260926);
    for (let i = 0; i < 200; i += 1) {
      const len = pickInt(rand, 40);
      let s = "";
      for (let j = 0; j < len; j += 1) s += alphabet[pickInt(rand, alphabet.length)];
      expect(tokenize(s).join(""), `seed case #${i}: ${JSON.stringify(s)}`).toBe(s);
    }
  });
});

describe("diffWords", () => {
  it("identical strings produce exactly one equal op", () => {
    const r = diffWords("same text", "same text");
    expect(r).toEqual({ kind: "ok", ops: [{ type: "equal", text: "same text" }] });
  });

  it("empty original to non-empty proposal produces exactly one insert op", () => {
    const r = diffWords("", "X");
    expect(r).toEqual({ kind: "ok", ops: [{ type: "insert", text: "X" }] });
  });

  it("non-empty original to empty proposal produces exactly one delete op", () => {
    const r = diffWords("X", "");
    expect(r).toEqual({ kind: "ok", ops: [{ type: "delete", text: "X" }] });
  });

  it("both sides empty produces no ops", () => {
    expect(diffWords("", "")).toEqual({ kind: "ok", ops: [] });
  });

  it("coalesces two adjacent deleted words into ONE delete op", () => {
    const r = diffWords("one two three four", "one four");
    expect(okOps(r)).toEqual([
      { type: "equal", text: "one " },
      { type: "delete", text: "two three " },
      { type: "equal", text: "four" },
    ]);
  });

  it("orders delete before insert within a change run, never insert first", () => {
    // "the quick brown fox" -> "the slow brown dog": two single-word
    // replacements, each surrounded by equal runs.
    const r = diffWords("the quick brown fox", "the slow brown dog");
    expect(okOps(r)).toEqual([
      { type: "equal", text: "the " },
      { type: "delete", text: "quick" },
      { type: "insert", text: "slow" },
      { type: "equal", text: " brown " },
      { type: "delete", text: "fox" },
      { type: "insert", text: "dog" },
    ]);
  });

  it("known minimal case: a single mid-sentence word swap", () => {
    const r = diffWords("I like cats", "I like dogs");
    expect(okOps(r)).toEqual([
      { type: "equal", text: "I like " },
      { type: "delete", text: "cats" },
      { type: "insert", text: "dogs" },
    ]);
  });

  it("folds a whitespace-only equal run BETWEEN two changes into both sides (one delete, one insert)", () => {
    // "foo bar" -> "baz qux": every word differs; the single space between
    // them is the only common token, and it is whitespace-only, so it must
    // not survive as its own 'equal' — it is folded into both flanking spans.
    const r = diffWords("foo bar", "baz qux");
    expect(okOps(r)).toEqual([
      { type: "delete", text: "foo bar" },
      { type: "insert", text: "baz qux" },
    ]);
  });

  it("does NOT fold a newline-only equal run between two changes (line structure survives)", () => {
    const r = diffWords("line1\nline2", "LINE1\nLINE2");
    expect(okOps(r)).toEqual([
      { type: "delete", text: "line1" },
      { type: "insert", text: "LINE1" },
      { type: "equal", text: "\n" },
      { type: "delete", text: "line2" },
      { type: "insert", text: "LINE2" },
    ]);
  });

  it("rejoin invariants over a seeded loop of ~300 random edited pairs (via sideSegments)", () => {
    const words = [
      "the",
      "quick",
      "brown",
      "fox",
      "jumps",
      "over",
      "lazy",
      "dog",
      "a",
      "small",
      "note",
      "about",
      "tasks",
      "today",
    ];
    const rand = mulberry32(4200);

    function randomBase(): string {
      const n = 3 + pickInt(rand, 15); // 3..17 words
      const picked: string[] = [];
      for (let i = 0; i < n; i += 1) picked.push(words[pickInt(rand, words.length)]);
      return picked.join(" ");
    }

    function randomEdit(base: string): string {
      const tokens = base.split(" ");
      const editCount = 1 + pickInt(rand, 3);
      for (let e = 0; e < editCount; e += 1) {
        if (tokens.length === 0) {
          tokens.push(words[pickInt(rand, words.length)]);
          continue;
        }
        const op = pickInt(rand, 3);
        const idx = pickInt(rand, tokens.length);
        if (op === 0) tokens.splice(idx, 0, words[pickInt(rand, words.length)]); // insert
        else if (op === 1) tokens.splice(idx, 1); // delete
        else tokens[idx] = words[pickInt(rand, words.length)]; // substitute
      }
      return tokens.join(" ");
    }

    for (let i = 0; i < 300; i += 1) {
      const a = randomBase();
      const b = randomEdit(a);
      const r = diffWords(a, b);
      const label = `seed pair #${i}: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`;
      expect(r.kind, label).toBe("ok");
      const ops = okOps(r);
      const originalRejoin = sideSegments(ops, "original")
        .map((op) => op.text)
        .join("");
      const proposalRejoin = sideSegments(ops, "proposal")
        .map((op) => op.text)
        .join("");
      expect(originalRejoin, label).toBe(a);
      expect(proposalRejoin, label).toBe(b);
    }
  });

  it("cap boundary: exactly MAX_TOKENS tokens per side (after trim) still returns ok", () => {
    // Boundary sentinels differ at both ends so common-prefix/suffix trimming
    // removes nothing; a shared filler character in the middle keeps the
    // edit distance tiny (well under MAX_D) so Myers actually completes
    // instead of hitting the D cap. Total length on each side === MAX_TOKENS.
    const filler = "."; // one punctuation token per repetition
    const fillerCount = MAX_TOKENS - 2; // + 1 start sentinel + 1 end sentinel = MAX_TOKENS
    const a = "(" + filler.repeat(fillerCount) + ")";
    const b = "[" + filler.repeat(fillerCount) + "]";
    expect(tokenize(a).length).toBe(MAX_TOKENS);
    expect(tokenize(b).length).toBe(MAX_TOKENS);

    const r = diffWords(a, b);
    expect(r.kind).toBe("ok");
  });

  it("cap boundary: MAX_TOKENS + 1 tokens per side (after trim) returns too-large", () => {
    const filler = "."; // one punctuation token per repetition
    const fillerCount = MAX_TOKENS - 1; // one more filler token -> MAX_TOKENS + 1 total
    const a = "(" + filler.repeat(fillerCount) + ")";
    const b = "[" + filler.repeat(MAX_TOKENS - 2) + "]";
    expect(tokenize(a).length).toBe(MAX_TOKENS + 1);

    const r = diffWords(a, b);
    expect(r).toEqual({ kind: "too-large" });
  });

  it("MAX_D: ~1200 fully-disjoint single-character tokens per side (D ≈ 2400 > MAX_D) returns too-large", () => {
    expect(MAX_D).toBeLessThan(2400);
    function disjointRun(startOffset: number, count: number): string {
      let s = "";
      for (let i = 0; i < count; i += 1) s += String.fromCodePoint(0xe000 + startOffset + i);
      return s;
    }
    const a = disjointRun(0, 1200);
    const b = disjointRun(1200, 1200); // completely different code points: zero overlap
    expect(tokenize(a).length).toBe(1200); // under MAX_TOKENS, so only MAX_D can reject this
    expect(tokenize(b).length).toBe(1200);

    const r = diffWords(a, b);
    expect(r).toEqual({ kind: "too-large" });
  });

  it("adversarial timing: 5000-vs-5000 all-distinct words finishes in well under 2000ms", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `alpha${i}`).join(" ");
    const b = Array.from({ length: 5000 }, (_, i) => `beta${i}`).join(" ");
    const t0 = performance.now();
    const r = diffWords(a, b);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r.kind === "ok" || r.kind === "too-large").toBe(true); // must terminate cleanly either way
  });

  it("adversarial timing: 5000-vs-5000 with one token repeated finishes in well under 2000ms", () => {
    const a = Array(5000).fill("same").join(" ");
    const b = Array(5000).fill("different").join(" ");
    const t0 = performance.now();
    const r = diffWords(a, b);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r.kind === "ok" || r.kind === "too-large").toBe(true);
  });

  it("adversarial timing: two 4 MiB strings finish in well under 2000ms (over MAX_CHARS, bail immediately)", () => {
    const big1 = "x".repeat(4 * 1024 * 1024);
    const big2 = "y".repeat(4 * 1024 * 1024);
    expect(big1.length).toBeGreaterThan(MAX_CHARS);
    const t0 = performance.now();
    const r = diffWords(big1, big2);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r).toEqual({ kind: "too-large" });
  });

  it("MAX_CHARS + 1 characters returns too-large without hanging", () => {
    const over = "z".repeat(MAX_CHARS + 1);
    const t0 = performance.now();
    const r = diffWords(over, "z");
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r).toEqual({ kind: "too-large" });
  });
});

describe("sideSegments", () => {
  it("the original side never contains an insert op", () => {
    const ops = okOps(diffWords("the quick brown fox", "the slow brown dog"));
    const original = sideSegments(ops, "original");
    expect(original.some((op) => op.type === "insert")).toBe(false);
  });

  it("the proposal side never contains a delete op", () => {
    const ops = okOps(diffWords("the quick brown fox", "the slow brown dog"));
    const proposal = sideSegments(ops, "proposal");
    expect(proposal.some((op) => op.type === "delete")).toBe(false);
  });

  it("the original side rejoins to the original text (equal + delete)", () => {
    const a = "the quick brown fox";
    const b = "the slow brown dog";
    const ops = okOps(diffWords(a, b));
    const original = sideSegments(ops, "original")
      .map((op) => op.text)
      .join("");
    expect(original).toBe(a);
  });

  it("the proposal side rejoins to the proposal text (equal + insert)", () => {
    const a = "the quick brown fox";
    const b = "the slow brown dog";
    const ops = okOps(diffWords(a, b));
    const proposal = sideSegments(ops, "proposal")
      .map((op) => op.text)
      .join("");
    expect(proposal).toBe(b);
  });
});

describe("changeCounts", () => {
  it("counts coalesced insert/delete SPANS, not words: the fox/dog case has 2 additions and 2 deletions", () => {
    const ops = okOps(diffWords("the quick brown fox", "the slow brown dog"));
    expect(changeCounts(ops)).toEqual({ additions: 2, deletions: 2 });
  });

  it("counts a multi-word coalesced delete as ONE deletion span, not one per word", () => {
    const ops = okOps(diffWords("one two three four", "one four"));
    expect(changeCounts(ops)).toEqual({ additions: 0, deletions: 1 });
  });

  it("identical text has zero additions and zero deletions", () => {
    const ops = okOps(diffWords("same text", "same text"));
    expect(changeCounts(ops)).toEqual({ additions: 0, deletions: 0 });
  });
});
