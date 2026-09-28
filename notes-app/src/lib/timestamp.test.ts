import { describe, it, expect } from "vitest";
import { formatTimestamp, insertText } from "./timestamp";

describe("formatTimestamp", () => {
  it("zero-pads single-digit month and day", () => {
    expect(formatTimestamp(new Date(2026, 0, 5, 9, 5))).toBe("2026-01-05 09:05");
  });

  it("zero-pads hour and minute", () => {
    expect(formatTimestamp(new Date(2026, 8, 5, 4, 3))).toBe("2026-09-05 04:03");
  });

  it("midnight renders 00:00", () => {
    expect(formatTimestamp(new Date(2026, 8, 5, 0, 0))).toBe("2026-09-05 00:00");
  });

  it("end of day renders 23:59", () => {
    expect(formatTimestamp(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59");
  });

  it("seconds are dropped, never rounded", () => {
    expect(formatTimestamp(new Date(2026, 8, 5, 10, 15, 45))).toBe("2026-09-05 10:15");
  });

  it("seconds and milliseconds just under the next minute are still dropped, not rounded", () => {
    expect(formatTimestamp(new Date(2026, 8, 5, 10, 15, 59, 999))).toBe("2026-09-05 10:15");
  });

  it("renders a four-digit year with two-digit month/day", () => {
    expect(formatTimestamp(new Date(2026, 9, 12, 14, 32))).toBe("2026-10-12 14:32");
  });

  it("zero-pads single-digit March", () => {
    expect(formatTimestamp(new Date(2026, 2, 3, 8, 7))).toBe("2026-03-03 08:07");
  });

  it("zero-pads single-digit July", () => {
    expect(formatTimestamp(new Date(2026, 6, 15, 9, 0))).toBe("2026-07-15 09:00");
  });

  it("matches the fixed-width pattern with no trailing whitespace", () => {
    const result = formatTimestamp(new Date(2026, 8, 5, 10, 15));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(result.length).toBe(16);
  });
});

describe("insertText", () => {
  it("inserts at a collapsed caret mid-body", () => {
    expect(insertText("hello world", { start: 5, end: 5 }, "X")).toEqual({
      body: "helloX world",
      caret: 6,
    });
  });

  it("inserts at offset 0", () => {
    expect(insertText("abc", { start: 0, end: 0 }, "Z")).toEqual({
      body: "Zabc",
      caret: 1,
    });
  });

  it("inserts at body.length (append)", () => {
    expect(insertText("abc", { start: 3, end: 3 }, "!")).toEqual({
      body: "abc!",
      caret: 4,
    });
  });

  it("inserts into an empty body", () => {
    expect(insertText("", { start: 0, end: 0 }, "2026-09-05 14:32")).toEqual({
      body: "2026-09-05 14:32",
      caret: 16,
    });
  });

  it("replaces a non-empty selection", () => {
    expect(insertText("hello world", { start: 6, end: 11 }, "there")).toEqual({
      body: "hello there",
      caret: 11,
    });
  });

  it("normalises an inverted range (start > end) before splicing", () => {
    expect(insertText("hello world", { start: 11, end: 6 }, "there")).toEqual({
      body: "hello there",
      caret: 11,
    });
  });

  it("places the caret collapsed AFTER the inserted text", () => {
    const result = insertText("hello world", { start: 5, end: 5 }, "XYZ");
    expect(result).toEqual({ body: "helloXYZ world", caret: 8 });
  });

  it("returns null when end exceeds body.length", () => {
    expect(insertText("abc", { start: 0, end: 4 }, "x")).toBeNull();
  });

  it("returns null for a negative start", () => {
    expect(insertText("abc", { start: -1, end: 1 }, "x")).toBeNull();
  });

  it("treats \\r as an ordinary character in a CRLF body", () => {
    expect(insertText("a\r\nb", { start: 1, end: 1 }, "X")).toEqual({
      body: "aX\r\nb",
      caret: 2,
    });
  });

  it("inserts after the CRLF sequence", () => {
    expect(insertText("a\r\nb", { start: 3, end: 3 }, "X")).toEqual({
      body: "a\r\nXb",
      caret: 4,
    });
  });

  it("inserting an empty string is a no-op splice that still deletes the selection", () => {
    expect(insertText("abc", { start: 1, end: 2 }, "")).toEqual({
      body: "ac",
      caret: 1,
    });
  });
});

// Plan 18 (D6, R-2): the scratch-pad "send selection" cut goes through
// insertText(body, range, "") as its fallback when execCommand("delete")
// returns false. These cases pin the deletion behaviour specifically.
describe("insertText — deletion (text === \"\")", () => {
  it("removes exactly [start, end) mid-body, with caret === start", () => {
    expect(insertText("hello world", { start: 6, end: 11 }, "")).toEqual({
      body: "hello ",
      caret: 6,
    });
  });

  it("normalises an inverted range before deleting", () => {
    expect(insertText("hello world", { start: 11, end: 6 }, "")).toEqual({
      body: "hello ",
      caret: 6,
    });
  });

  it("returns null for an out-of-bounds range (end past body.length)", () => {
    expect(insertText("abc", { start: 0, end: 4 }, "")).toBeNull();
  });

  it("returns null for a negative start", () => {
    expect(insertText("abc", { start: -1, end: 2 }, "")).toBeNull();
  });

  it("deletes the whole body: start 0, end body.length -> empty string, caret 0", () => {
    expect(insertText("hello", { start: 0, end: 5 }, "")).toEqual({
      body: "",
      caret: 0,
    });
  });

  it("a collapsed range (start === end) deletes nothing and leaves the caret in place", () => {
    expect(insertText("hello", { start: 2, end: 2 }, "")).toEqual({
      body: "hello",
      caret: 2,
    });
  });

  it("removes a multi-line span including its trailing newline", () => {
    expect(insertText("one\ntwo\nthree", { start: 4, end: 8 }, "")).toEqual({
      body: "one\nthree",
      caret: 4,
    });
  });

  it("removes a span that starts mid-line and ends mid-line, spanning an internal newline", () => {
    expect(insertText("abc\ndef\nghi", { start: 1, end: 9 }, "")).toEqual({
      body: "ahi",
      caret: 1,
    });
  });
});
