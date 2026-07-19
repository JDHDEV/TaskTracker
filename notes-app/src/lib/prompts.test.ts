import { describe, it, expect } from "vitest";
import { formatWhen, sourceLabel } from "./prompts";

describe("sourceLabel", () => {
  it("labels a manual version", () => {
    expect(sourceLabel("manual")).toBe("manual");
  });

  it("labels an AI-enhanced version", () => {
    expect(sourceLabel("aiEnhanced")).toBe("AI enhanced");
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
