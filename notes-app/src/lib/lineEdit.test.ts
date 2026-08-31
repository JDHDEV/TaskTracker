import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleLineClipboardKeyDown,
  handleLinePaste,
  lineRangeAt,
  pasteLine,
  selectionForCopy,
  selectionForCut,
  setLastLineCopyForTest,
  type TextAreaLike,
} from "./lineEdit";

// Framework-free fakes: TextAreaLike is a plain mutable object whose
// setSelectionRange spy also writes back selectionStart/End, mirroring how a
// real textarea's selection changes when the native command runs. Key/paste
// events are plain object literals shaped to the module's structural types.
function makeTextArea(
  value: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): TextAreaLike {
  const ta = {
    value,
    selectionStart,
    selectionEnd,
    setSelectionRange: vi.fn((start: number, end: number) => {
      ta.selectionStart = start;
      ta.selectionEnd = end;
    }),
  };
  return ta;
}

const TEXT = "alpha\nbravo\ncharlie"; // lines at [0,5) [6,11) [12,19); text.length === 19

describe("lineRangeAt", () => {
  it("returns the line under a caret mid-line", () => {
    expect(lineRangeAt(TEXT, 8)).toEqual({ start: 6, end: 11 }); // mid "bravo"
  });

  it("returns the first line for a caret at 0", () => {
    expect(lineRangeAt(TEXT, 0)).toEqual({ start: 0, end: 5 });
  });

  it("returns the last line for a caret at the end of the text", () => {
    expect(lineRangeAt(TEXT, TEXT.length)).toEqual({ start: 12, end: 19 });
  });

  it("a caret sitting exactly ON a newline belongs to the PRECEDING line", () => {
    expect(lineRangeAt(TEXT, 5)).toEqual({ start: 0, end: 5 }); // the \n after "alpha"
    expect(lineRangeAt(TEXT, 11)).toEqual({ start: 6, end: 11 }); // the \n after "bravo"
  });

  it("returns a zero-length range for an empty line between two newlines", () => {
    const text = "alpha\n\nbravo";
    expect(lineRangeAt(text, 6)).toEqual({ start: 6, end: 6 });
  });

  it("returns the whole text as the single line of a single-line body", () => {
    expect(lineRangeAt("alpha", 2)).toEqual({ start: 0, end: 5 });
  });

  it("clamps a caret before the start of the text", () => {
    expect(lineRangeAt(TEXT, -5)).toEqual({ start: 0, end: 5 });
  });

  it("clamps a caret past the end of the text", () => {
    expect(lineRangeAt(TEXT, 1000)).toEqual({ start: 12, end: 19 });
  });
});

describe("selectionForCopy", () => {
  it("an interior line's copy selection includes its trailing newline", () => {
    expect(selectionForCopy(TEXT, 8)).toEqual({ start: 6, end: 12 }); // "bravo\n"
  });

  it("the last line's copy selection (no trailing newline) ends at text.length", () => {
    expect(selectionForCopy(TEXT, 15)).toEqual({ start: 12, end: 19 }); // "charlie"
  });
});

describe("selectionForCut", () => {
  it("an interior line's cut selection includes its trailing newline", () => {
    expect(selectionForCut(TEXT, 8)).toEqual({ start: 6, end: 12 }); // "bravo\n"
  });

  it("the last line (no trailing newline) borrows the PRECEDING newline instead", () => {
    expect(selectionForCut(TEXT, 15)).toEqual({ start: 11, end: 19 }); // "\ncharlie"
  });

  it("a single-line body cuts the whole [0, length) range", () => {
    expect(selectionForCut("alpha", 2)).toEqual({ start: 0, end: 5 });
  });

  it("an empty line between two newlines cuts exactly one newline character", () => {
    const text = "alpha\n\nbravo";
    const range = selectionForCut(text, 6);
    expect(range).toEqual({ start: 6, end: 7 });
    expect(text.slice(range.start, range.end)).toBe("\n");
  });
});

describe("pasteLine", () => {
  it("inserts a whole line above the caret's line and shifts the caret by the insert length", () => {
    const result = pasteLine(TEXT, 8, "NEWLINE");
    expect(result.body).toBe("alpha\nNEWLINE\nbravo\ncharlie");
    expect(result.caret).toBe(16); // 8 + "NEWLINE\n".length (8)
  });

  it("appends a trailing newline to a payload that lacks one", () => {
    const result = pasteLine(TEXT, 8, "NEWLINE");
    expect(result.body).toContain("NEWLINE\n");
  });

  it("sheds a leading newline (the newline borrowed by a last-line cut)", () => {
    const result = pasteLine(TEXT, 8, "\ncharlie");
    expect(result.body).toBe("alpha\ncharlie\nbravo\ncharlie");
    expect(result.body).not.toContain("\n\ncharlie");
  });

  it("pasting into a single-line body inserts the line above it", () => {
    const result = pasteLine("alpha", 2, "X\n");
    expect(result.body).toBe("X\nalpha");
    expect(result.caret).toBe(4); // 2 + "X\n".length (2)
  });
});

describe("handleLineClipboardKeyDown", () => {
  afterEach(() => {
    setLastLineCopyForTest(null);
    vi.useRealTimers();
  });

  it("a REAL (non-collapsed) selection is left completely untouched — highest-value regression check", () => {
    const ta = makeTextArea(TEXT, 6, 11); // "bravo" already selected
    handleLineClipboardKeyDown({ key: "x", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ta);

    expect(ta.setSelectionRange).not.toHaveBeenCalled();
    expect(ta.selectionStart).toBe(6);
    expect(ta.selectionEnd).toBe(11);
  });

  it("Ctrl+X on a collapsed selection selects the cut range and records it as the paste sentinel", () => {
    const ta = makeTextArea(TEXT, 8); // collapsed, mid "bravo"
    handleLineClipboardKeyDown({ key: "x", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ta);

    expect(ta.setSelectionRange).toHaveBeenCalledWith(6, 12);
    expect(ta.selectionStart).toBe(6);
    expect(ta.selectionEnd).toBe(12);

    // Sentinel recorded: a paste whose clipboard text equals the cut range intercepts.
    const pasteTa = makeTextArea(TEXT, 0);
    const applyEdit = vi.fn();
    const intercepted = handleLinePaste(
      { clipboardData: { getData: () => TEXT.slice(6, 12) }, preventDefault: vi.fn() },
      pasteTa,
      applyEdit,
    );
    expect(intercepted).toBe(true);
  });

  it("Ctrl+C selects the copy range and restores the collapsed caret after the 0-timer fires", () => {
    vi.useFakeTimers();
    const ta = makeTextArea(TEXT, 8); // collapsed, mid "bravo"

    handleLineClipboardKeyDown({ key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ta);

    expect(ta.setSelectionRange).toHaveBeenNthCalledWith(1, 6, 12);
    expect(ta.selectionStart).toBe(6);
    expect(ta.selectionEnd).toBe(12);

    vi.runAllTimers();

    expect(ta.setSelectionRange).toHaveBeenNthCalledWith(2, 8, 8);
    expect(ta.selectionStart).toBe(8);
    expect(ta.selectionEnd).toBe(8);
  });

  it("ignores a shift-modified Ctrl+X", () => {
    const ta = makeTextArea(TEXT, 8);
    handleLineClipboardKeyDown({ key: "x", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, ta);
    expect(ta.setSelectionRange).not.toHaveBeenCalled();
  });

  it("ignores an alt-modified Ctrl+C", () => {
    const ta = makeTextArea(TEXT, 8);
    handleLineClipboardKeyDown({ key: "c", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, ta);
    expect(ta.setSelectionRange).not.toHaveBeenCalled();
  });

  it("ignores an unrelated key even with Ctrl held", () => {
    const ta = makeTextArea(TEXT, 8);
    handleLineClipboardKeyDown({ key: "v", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ta);
    expect(ta.setSelectionRange).not.toHaveBeenCalled();
  });

  it("ignores a bare, unmodified 'x' keypress", () => {
    const ta = makeTextArea(TEXT, 8);
    handleLineClipboardKeyDown({ key: "x", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, ta);
    expect(ta.setSelectionRange).not.toHaveBeenCalled();
  });

  it("ignores an empty textarea value", () => {
    const ta = makeTextArea("", 0);
    handleLineClipboardKeyDown({ key: "x", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ta);
    expect(ta.setSelectionRange).not.toHaveBeenCalled();
  });
});

describe("handleLinePaste", () => {
  beforeEach(() => setLastLineCopyForTest(null));
  afterEach(() => setLastLineCopyForTest(null));

  it("sentinel match + collapsed caret: preventDefault, applyEdit gets pasteLine's result, returns true", () => {
    const payload = "NEWLINE\n";
    setLastLineCopyForTest(payload);

    const ta = makeTextArea(TEXT, 8);
    const applyEdit = vi.fn();
    const preventDefault = vi.fn();

    const result = handleLinePaste(
      { clipboardData: { getData: () => payload }, preventDefault },
      ta,
      applyEdit,
    );

    expect(result).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const expected = pasteLine(TEXT, 8, payload);
    expect(applyEdit).toHaveBeenCalledWith(expected.body, expected.caret);
  });

  it("sentinel mismatch: returns false, no preventDefault — native paste runs", () => {
    setLastLineCopyForTest("bravo\n");

    const ta = makeTextArea(TEXT, 8);
    const applyEdit = vi.fn();
    const preventDefault = vi.fn();

    const result = handleLinePaste(
      { clipboardData: { getData: () => "some other clipboard text" }, preventDefault },
      ta,
      applyEdit,
    );

    expect(result).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("a non-collapsed selection is never intercepted, even with a matching sentinel", () => {
    const payload = "bravo\n";
    setLastLineCopyForTest(payload);

    const ta = makeTextArea(TEXT, 6, 11);
    const applyEdit = vi.fn();
    const preventDefault = vi.fn();

    const result = handleLinePaste(
      { clipboardData: { getData: () => payload }, preventDefault },
      ta,
      applyEdit,
    );

    expect(result).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("null clipboardData is never intercepted", () => {
    setLastLineCopyForTest("bravo\n");

    const ta = makeTextArea(TEXT, 8);
    const applyEdit = vi.fn();
    const preventDefault = vi.fn();

    const result = handleLinePaste({ clipboardData: null, preventDefault }, ta, applyEdit);

    expect(result).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("an empty clipboard payload is never intercepted", () => {
    setLastLineCopyForTest("");

    const ta = makeTextArea(TEXT, 8);
    const applyEdit = vi.fn();
    const preventDefault = vi.fn();

    const result = handleLinePaste(
      { clipboardData: { getData: () => "" }, preventDefault },
      ta,
      applyEdit,
    );

    expect(result).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });
});
