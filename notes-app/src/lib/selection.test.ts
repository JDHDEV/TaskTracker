import { describe, it, expect } from "vitest";
import { captureSelection, isSelectionStale, spliceProposal } from "./selection";
import type { CapturedSelection } from "./selection";

describe("captureSelection", () => {
  it("returns null for a null range", () => {
    expect(captureSelection(null, "Hello world")).toBeNull();
  });

  it("returns null for a collapsed range (start === end)", () => {
    expect(captureSelection({ start: 3, end: 3 }, "Hello world")).toBeNull();
  });

  it("returns null for an inverted range (start > end)", () => {
    expect(captureSelection({ start: 5, end: 2 }, "Hello world")).toBeNull();
  });

  it("returns null for a range with a negative start", () => {
    const body = "Hello world";
    // end = body.length so a missing bounds check isn't masked by slice()'s
    // own negative-index wraparound coincidentally yielding an empty string.
    expect(captureSelection({ start: -1, end: body.length }, body)).toBeNull();
  });

  it("returns null for a range whose end exceeds body.length", () => {
    const body = "Hello world";
    expect(captureSelection({ start: 0, end: body.length + 1 }, body)).toBeNull();
  });

  it("returns null for a whitespace-only slice of spaces", () => {
    expect(captureSelection({ start: 0, end: 3 }, "   leading")).toBeNull();
  });

  it("returns null for a whitespace-only slice of newline/tab", () => {
    const body = "a\n\tb";
    expect(captureSelection({ start: 1, end: 3 }, body)).toBeNull();
  });

  it("returns {start, end, text} for an ordinary selection", () => {
    const body = "one two three";
    const sel = captureSelection({ start: 4, end: 7 }, body);
    expect(sel).toEqual({ start: 4, end: 7, text: "two" });
  });

  it("returns the correct selection at the very start of the body", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body);
    expect(sel).toEqual({ start: 0, end: 5, text: "Hello" });
    expect(sel?.text).toBe(body.slice(sel!.start, sel!.end));
  });

  it("returns the correct selection at the very end of the body", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 6, end: 11 }, body);
    expect(sel).toEqual({ start: 6, end: 11, text: "world" });
    expect(sel?.text).toBe(body.slice(sel!.start, sel!.end));
  });

  it("preserves a surrogate-pair emoji intact when the range sits exactly around it", () => {
    const EMOJI = String.fromCodePoint(0x1f600); // "😀", two UTF-16 code units
    const body = `pre ${EMOJI} post`;
    const start = body.indexOf(EMOJI);
    const end = start + EMOJI.length; // EMOJI.length === 2
    const sel = captureSelection({ start, end }, body);

    expect(sel).not.toBeNull();
    expect(sel!.text).toBe(body.slice(start, end));
    expect(sel!.text).toBe(EMOJI);
    expect(sel!.text.length).toBe(2); // both surrogate halves included
    expect(sel!.text.codePointAt(0)).toBe(EMOJI.codePointAt(0)); // decodes as one code point, not a lone surrogate
    expect(Array.from(sel!.text).length).toBe(1); // exactly one character, not two mangled halves
  });

  it("returns the correct text for a range spanning across a multibyte emoji plus surrounding text", () => {
    const EMOJI = String.fromCodePoint(0x1f600);
    const body = `pre ${EMOJI} post`;
    const sel = captureSelection({ start: 0, end: body.length }, body);
    expect(sel).toEqual({ start: 0, end: body.length, text: body });
    expect(sel!.text).toBe(body.slice(0, body.length));
  });
});

describe("isSelectionStale", () => {
  it("is false when the body still holds the captured text at the captured range", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body) as CapturedSelection;
    expect(isSelectionStale(body, sel)).toBe(false);
  });

  it("is true after text is inserted BEFORE the captured range, shifting it", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 6, end: 11 }, body) as CapturedSelection; // "world"
    const edited = "Hi " + body;
    expect(isSelectionStale(edited, sel)).toBe(true);
  });

  it("is true after a deletion INSIDE the captured range", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body) as CapturedSelection; // "Hello"
    const edited = "Hllo world"; // 'e' removed from within the range
    expect(isSelectionStale(edited, sel)).toBe(true);
  });

  it("is true after a same-length substitution INSIDE the captured range", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body) as CapturedSelection; // "Hello"
    const edited = "Hallo world"; // 'e' -> 'a', same overall length
    expect(isSelectionStale(edited, sel)).toBe(true);
  });
});

describe("spliceProposal", () => {
  it("replaces a range starting at 0", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body) as CapturedSelection;
    const result = spliceProposal(body, sel, "Hi");
    expect(result).toEqual({ ok: true, body: "Hi world", caret: { start: 0, end: 2 } });
  });

  it("replaces a range ending at body.length", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 6, end: 11 }, body) as CapturedSelection;
    const result = spliceProposal(body, sel, "earth");
    expect(result).toEqual({ ok: true, body: "Hello earth", caret: { start: 6, end: 11 } });
  });

  it("replaces a range in the middle, leaving surrounding text verbatim", () => {
    const body = "one two three";
    const sel = captureSelection({ start: 4, end: 7 }, body) as CapturedSelection;
    const result = spliceProposal(body, sel, "TWO");
    expect(result).toEqual({ ok: true, body: "one TWO three", caret: { start: 4, end: 7 } });
  });

  it("handles a proposal longer than the original selection", () => {
    const body = "a bug here";
    const sel = captureSelection({ start: 2, end: 5 }, body) as CapturedSelection; // "bug"
    const result = spliceProposal(body, sel, "really bad bug");
    expect(result).toEqual({
      ok: true,
      body: "a really bad bug here",
      caret: { start: 2, end: 2 + "really bad bug".length },
    });
  });

  it("handles a proposal shorter than the original selection", () => {
    const body = "a bug here";
    const sel = captureSelection({ start: 2, end: 5 }, body) as CapturedSelection; // "bug"
    const result = spliceProposal(body, sel, "ok");
    expect(result).toEqual({ ok: true, body: "a ok here", caret: { start: 2, end: 4 } });
  });

  it("handles an empty proposal, deleting the selection", () => {
    const body = "a bug here";
    const sel = captureSelection({ start: 2, end: 5 }, body) as CapturedSelection; // "bug"
    const result = spliceProposal(body, sel, "");
    expect(result).toEqual({ ok: true, body: "a  here", caret: { start: 2, end: 2 } });
  });

  it("preserves newlines and surrounding lines verbatim", () => {
    const body = "line1\nline2\nline3";
    const start = body.indexOf("line2");
    const end = start + "line2".length;
    const sel = captureSelection({ start, end }, body) as CapturedSelection;
    const result = spliceProposal(body, sel, "LINE_TWO");
    expect(result).toEqual({
      ok: true,
      body: "line1\nLINE_TWO\nline3",
      caret: { start, end: start + "LINE_TWO".length },
    });
  });

  it("sets caret to {start: sel.start, end: sel.start + proposal.length} on success", () => {
    const body = "abcdefgh";
    const sel = captureSelection({ start: 2, end: 5 }, body) as CapturedSelection; // "cde"
    const proposal = "PROPOSAL-TEXT";
    const result = spliceProposal(body, sel, proposal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caret).toEqual({ start: sel.start, end: sel.start + proposal.length });
    }
  });

  it("refuses with {ok:false, reason:'stale'} when the body changed under the captured range, without returning a body", () => {
    const body = "Hello world";
    const sel = captureSelection({ start: 0, end: 5 }, body) as CapturedSelection; // "Hello"
    const edited = "Hxllo world"; // stale: range content changed

    const result = spliceProposal(edited, sel, "Hi");

    expect(result).toEqual({ ok: false, reason: "stale" });
    expect(result.ok).toBe(false);
    expect("body" in result).toBe(false);
    expect("caret" in result).toBe(false);
    // strings are immutable, but assert explicitly that nothing under the
    // caller's feet changed: the constant used to capture the selection is
    // still exactly what it was before the refused splice.
    expect(body).toBe("Hello world");
  });
});

describe("RED evidence: guard vs. an unguarded splice", () => {
  it("RED evidence: an unguarded slice mis-splices on a stale body; the guard refuses", () => {
    const originalBody = "The quick brown fox jumps over the lazy dog.";
    const sel = captureSelection({ start: 10, end: 19 }, originalBody) as CapturedSelection;
    expect(sel.text).toBe("brown fox");

    // The user typed "Hello! " at the very front while a rework proposal for
    // "brown fox" was in flight. The captured indices [10, 19) no longer
    // point at "brown fox" — they now point partway into "quick br".
    const editedBody = "Hello! " + originalBody;
    const proposal = "red squirrel";

    // An unguarded splice (no staleness check) blindly trusts the stale
    // start/end and corrupts the text: it slices out the wrong span and
    // glues the proposal into the middle of unrelated words.
    const naiveResult = editedBody.slice(0, sel.start) + proposal + editedBody.slice(sel.end);

    // What a correct, non-stale splice targeting "brown fox" would have
    // produced, had the range been re-found at its real location.
    const freshStart = editedBody.indexOf("brown fox");
    const freshEnd = freshStart + "brown fox".length;
    const intendedResult =
      editedBody.slice(0, freshStart) + proposal + editedBody.slice(freshEnd);

    expect(naiveResult).not.toBe(intendedResult);
    // The mangled fragment: the tail of the proposal ("squirrel") glued
    // directly onto the leftover tail of "brown" ("own"), with no space —
    // text nobody typed and nobody asked for.
    expect(naiveResult).toContain("squirrelown");
    expect(naiveResult).toBe(
      "Hello! Thered squirrelown fox jumps over the lazy dog.",
    );

    // The guarded path detects the same staleness and refuses outright
    // instead of producing corrupted text.
    const guarded = spliceProposal(editedBody, sel, proposal);
    expect(guarded).toEqual({ ok: false, reason: "stale" });
  });
});
