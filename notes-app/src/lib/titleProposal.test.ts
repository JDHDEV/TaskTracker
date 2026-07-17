import { describe, expect, it } from "vitest";
import { isRedundantTitle } from "./titleProposal";

describe("isRedundantTitle", () => {
  it("is true when the generated title exactly equals the current title", () => {
    expect(isRedundantTitle("Cutover checklist", "Cutover checklist")).toBe(true);
  });

  it("is false when they differ at all", () => {
    expect(isRedundantTitle("Cutover checklist", "Cutover plan")).toBe(false);
  });

  it("is exact — case differences are NOT a match", () => {
    expect(isRedundantTitle("cutover checklist", "Cutover checklist")).toBe(false);
  });

  it("is exact — trailing/leading whitespace differences are NOT a match", () => {
    expect(isRedundantTitle("Cutover checklist", "Cutover checklist ")).toBe(false);
  });

  it("treats two empty strings as a match", () => {
    expect(isRedundantTitle("", "")).toBe(true);
  });
});
