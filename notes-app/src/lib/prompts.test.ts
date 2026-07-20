import { describe, it, expect } from "vitest";
import { displayTitle, formatWhen, sourceLabel } from "./prompts";

describe("sourceLabel", () => {
  it("labels a manual version", () => {
    expect(sourceLabel("manual")).toBe("manual");
  });

  it("labels an AI-enhanced version", () => {
    expect(sourceLabel("aiEnhanced")).toBe("AI enhanced");
  });
});

describe("displayTitle", () => {
  it("passes a non-empty title through", () => {
    expect(displayTitle("My prompt", "some body")).toBe("My prompt");
  });

  it("trims a title before returning it", () => {
    expect(displayTitle("  Spaced  ", "body")).toBe("Spaced");
  });

  it("falls back to the first non-blank body line when the title is empty", () => {
    expect(displayTitle("", "first line\nsecond line")).toBe("first line");
  });

  it("treats a whitespace-only title as empty and derives from the body", () => {
    expect(displayTitle("   ", "derive me")).toBe("derive me");
  });

  it("skips leading blank lines in the body (not a naive split)", () => {
    expect(displayTitle("", "\n\n   \nreal first line")).toBe("real first line");
  });

  it("truncates a long derived line to 60 chars", () => {
    const long = "x".repeat(100);
    expect(displayTitle("", long)).toBe("x".repeat(60));
  });

  it("returns 'Untitled' when both title and body are empty", () => {
    expect(displayTitle("", "")).toBe("Untitled");
    expect(displayTitle("   ", "   \n  ")).toBe("Untitled");
  });
});

describe("formatWhen", () => {
  it("shows a time for a timestamp on the same day as `now`", () => {
    const now = new Date("2026-07-18T20:00:00");
    const iso = new Date("2026-07-18T14:32:00").toISOString();
    expect(formatWhen(iso, now)).toBe(
      new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  });

  it("shows a short date for a timestamp on a different day", () => {
    const now = new Date("2026-07-18T20:00:00");
    const iso = new Date("2026-07-10T09:00:00").toISOString();
    expect(formatWhen(iso, now)).toBe(
      new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
  });
});
