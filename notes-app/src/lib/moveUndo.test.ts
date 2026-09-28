import { describe, it, expect } from "vitest";
import { isUndoKey, restoreMove, type MoveRecord } from "./moveUndo";

// Fixture: "hello brave world" with "brave " (offsets 6–12) moved out, leaving
// "hello world".
const MOVE: MoveRecord = { start: 6, text: "brave ", bodyAfter: "hello world" };

describe("restoreMove", () => {
  it("reinserts the moved text at its original offset while the pad is unchanged since the move", () => {
    expect(restoreMove("hello world", MOVE)).toEqual({
      body: "hello brave world",
      caret: { start: 6, end: 12 },
    });
  });

  it("selects exactly the restored text (caret spans [start, start + text.length))", () => {
    const r = restoreMove("hello world", MOVE);
    expect(r?.body.slice(r.caret.start, r.caret.end)).toBe("brave ");
  });

  it("returns null once the pad has been edited after the move (body no longer matches bodyAfter)", () => {
    expect(restoreMove("hello world!", MOVE)).toBeNull();
    expect(restoreMove("hello", MOVE)).toBeNull();
  });

  it("returns null when there is no move to restore", () => {
    expect(restoreMove("hello world", null)).toBeNull();
  });

  it("restores a move from the very start of the body", () => {
    const move: MoveRecord = { start: 0, text: "alpha\n", bodyAfter: "beta" };
    expect(restoreMove("beta", move)).toEqual({
      body: "alpha\nbeta",
      caret: { start: 0, end: 6 },
    });
  });

  it("restores a move that emptied the body (whole text sent)", () => {
    const move: MoveRecord = { start: 0, text: "everything", bodyAfter: "" };
    expect(restoreMove("", move)).toEqual({
      body: "everything",
      caret: { start: 0, end: 10 },
    });
  });

  it("restores a multi-line move at the end of the body, trailing newline included", () => {
    const move: MoveRecord = { start: 4, text: "two\nthree\n", bodyAfter: "one\n" };
    expect(restoreMove("one\n", move)).toEqual({
      body: "one\ntwo\nthree\n",
      caret: { start: 4, end: 14 },
    });
  });

  it("never mutates its inputs", () => {
    const move = Object.freeze({ ...MOVE });
    expect(() => restoreMove("hello world", move)).not.toThrow();
    expect(move).toEqual(MOVE);
  });
});

describe("isUndoKey", () => {
  const base = { key: "z", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it("is true for Ctrl+Z and Cmd+Z, upper or lower case", () => {
    expect(isUndoKey({ ...base, ctrlKey: true })).toBe(true);
    expect(isUndoKey({ ...base, metaKey: true })).toBe(true);
    expect(isUndoKey({ ...base, ctrlKey: true, key: "Z" })).toBe(true);
  });

  it("is false for redo (Ctrl+Shift+Z, Ctrl+Y), Alt combos and an unmodified z", () => {
    expect(isUndoKey({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isUndoKey({ ...base, ctrlKey: true, key: "y" })).toBe(false);
    expect(isUndoKey({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isUndoKey(base)).toBe(false);
  });
});
