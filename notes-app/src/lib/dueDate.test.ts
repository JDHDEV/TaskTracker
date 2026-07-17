import { describe, it, expect } from "vitest";
import {
  toDateInputValue,
  fromDateInputValue,
  formatDueDate,
  isOverdue,
} from "./dueDate";

describe("toDateInputValue", () => {
  it("returns the yyyy-mm-dd prefix of a stored dueAt", () => {
    expect(toDateInputValue("2026-07-20T00:00:00Z")).toBe("2026-07-20");
  });

  it("passes through a bare date-only string unchanged", () => {
    expect(toDateInputValue("2026-07-20")).toBe("2026-07-20");
  });

  it("returns '' for null/undefined without throwing", () => {
    expect(() => toDateInputValue(null)).not.toThrow();
    expect(toDateInputValue(null)).toBe("");
    expect(toDateInputValue(undefined)).toBe("");
  });

  it("returns '' for an empty string (never coerces to a date)", () => {
    expect(toDateInputValue("")).toBe("");
  });

  it("returns '' for a malformed date prefix", () => {
    expect(toDateInputValue("not-a-date")).toBe("");
    expect(toDateInputValue("2026/07/20")).toBe("");
  });
});

describe("fromDateInputValue", () => {
  it("converts a yyyy-mm-dd input into the RFC 3339 wire value at UTC midnight", () => {
    expect(fromDateInputValue("2026-07-20")).toBe("2026-07-20T00:00:00Z");
  });

  it("round-trips through toDateInputValue", () => {
    const wire = fromDateInputValue("2026-07-20");
    expect(toDateInputValue(wire)).toBe("2026-07-20");
  });

  it("returns '' for an empty input (never coerces '' to a bogus date)", () => {
    expect(fromDateInputValue("")).toBe("");
  });

  it("returns '' for a malformed input", () => {
    expect(fromDateInputValue("07/20/2026")).toBe("");
    expect(fromDateInputValue("2026-7-20")).toBe("");
  });
});

describe("formatDueDate", () => {
  it("formats a known RFC 3339 dueAt as a short month/day label", () => {
    expect(formatDueDate("2026-07-20T00:00:00Z")).toBe(
      new Date(2026, 6, 20).toLocaleDateString([], { month: "short", day: "numeric" })
    );
  });

  it("formats a bare date-only stored value identically to the full timestamp", () => {
    expect(formatDueDate("2026-07-20")).toBe(formatDueDate("2026-07-20T00:00:00Z"));
  });

  it("returns '' for null/undefined/empty without throwing", () => {
    expect(() => formatDueDate(null)).not.toThrow();
    expect(formatDueDate(null)).toBe("");
    expect(formatDueDate(undefined)).toBe("");
    expect(formatDueDate("")).toBe("");
  });

  it("returns '' for a malformed dueAt without throwing", () => {
    expect(() => formatDueDate("garbage")).not.toThrow();
    expect(formatDueDate("garbage")).toBe("");
  });
});

describe("isOverdue", () => {
  it("is true when the due day is strictly before now's local calendar day", () => {
    const now = new Date(2026, 6, 15, 9, 0); // Jul 15, 2026, 09:00 local
    expect(isOverdue("2026-07-14T00:00:00Z", now)).toBe(true);
  });

  it("today-boundary: due day equal to now's local day is NOT overdue", () => {
    const now = new Date(2026, 6, 15, 9, 0); // Jul 15, 2026, local
    expect(isOverdue("2026-07-15T00:00:00Z", now)).toBe(false);
  });

  it("is false for a future due day", () => {
    const now = new Date(2026, 6, 15, 9, 0);
    expect(isOverdue("2026-07-16T00:00:00Z", now)).toBe(false);
  });

  it("flips from true to false as now crosses the due day boundary", () => {
    const dueAt = "2026-07-15T00:00:00Z";
    const dayAfter = new Date(2026, 6, 16, 0, 0); // now is a day later → overdue
    const sameDay = new Date(2026, 6, 15, 23, 59); // now is same local day → not overdue
    expect(isOverdue(dueAt, dayAfter)).toBe(true);
    expect(isOverdue(dueAt, sameDay)).toBe(false);
  });

  it("is false for null/undefined/empty/malformed dueAt", () => {
    const now = new Date(2026, 6, 15, 9, 0);
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
    expect(isOverdue("", now)).toBe(false);
    expect(isOverdue("garbage", now)).toBe(false);
  });

  it("does not read the system clock — the same dueAt flips solely with the passed-in now", () => {
    const dueAt = "2026-07-15T00:00:00Z";
    const before = new Date(2026, 6, 14, 12, 0);
    const after = new Date(2026, 6, 16, 12, 0);
    expect(isOverdue(dueAt, before)).toBe(false);
    expect(isOverdue(dueAt, after)).toBe(true);
  });
});
