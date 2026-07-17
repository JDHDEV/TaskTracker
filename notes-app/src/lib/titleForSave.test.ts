import { describe, expect, it, vi } from "vitest";
import { resolveTitleForSave } from "./titleForSave";

describe("resolveTitleForSave", () => {
  it("passes a non-empty title through (trimmed) and never calls generate", async () => {
    const generate = vi.fn();
    const result = await resolveTitleForSave("  Real title  ", "body", generate);
    expect(result).toEqual({ title: "Real title" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates from the body when the title is whitespace-only", async () => {
    const generate = vi.fn().mockResolvedValue("Generated title");
    const result = await resolveTitleForSave("   ", "the body text", generate);
    expect(generate).toHaveBeenCalledWith("the body text");
    expect(result).toEqual({ title: "Generated title" });
  });

  it("returns the both-empty error and never calls generate", async () => {
    const generate = vi.fn();
    const result = await resolveTitleForSave("  ", "   ", generate);
    expect(result).toEqual({ error: "Give it a title before saving." });
    expect(generate).not.toHaveBeenCalled();
  });

  it("maps a rejection to { error: String(err) } verbatim (missing-key copy)", async () => {
    const missingKey = "no API key saved for anthropic — add one in Settings";
    const generate = vi.fn().mockRejectedValue(missingKey);
    const result = await resolveTitleForSave("", "body", generate);
    expect(result).toEqual({ error: missingKey });
  });

  it("maps a rejection to { error: String(err) } verbatim (generic copy)", async () => {
    const generic = "couldn't generate a title — try again";
    const generate = vi.fn().mockRejectedValue(generic);
    const result = await resolveTitleForSave("", "body", generate);
    expect(result).toEqual({ error: generic });
  });
});
