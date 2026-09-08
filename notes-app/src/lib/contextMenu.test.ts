import { describe, it, expect } from "vitest";
import {
  parseContextMenuAction,
  sendDestinationOf,
  surfaceOf,
} from "./contextMenu";

describe("parseContextMenuAction", () => {
  it('accepts "insert-timestamp" and returns it unchanged', () => {
    expect(parseContextMenuAction("insert-timestamp")).toBe("insert-timestamp");
  });

  it('accepts "send-note" and returns it unchanged', () => {
    expect(parseContextMenuAction("send-note")).toBe("send-note");
  });

  it('accepts "send-task" and returns it unchanged', () => {
    expect(parseContextMenuAction("send-task")).toBe("send-task");
  });

  it('accepts "send-prompt" and returns it unchanged', () => {
    expect(parseContextMenuAction("send-prompt")).toBe("send-prompt");
  });

  it("rejects an empty string", () => {
    expect(parseContextMenuAction("")).toBeNull();
  });

  it("rejects a case-mismatched id", () => {
    expect(parseContextMenuAction("Insert-Timestamp")).toBeNull();
  });

  it("rejects an id with trailing whitespace", () => {
    expect(parseContextMenuAction("insert-timestamp ")).toBeNull();
  });

  it('rejects an unknown-but-plausible id ("send-scratch")', () => {
    expect(parseContextMenuAction("send-scratch")).toBeNull();
  });

  it('rejects an unrelated id ("delete-all")', () => {
    expect(parseContextMenuAction("delete-all")).toBeNull();
  });

  it("rejects a number", () => {
    expect(parseContextMenuAction(42)).toBeNull();
  });

  it("rejects an object payload", () => {
    expect(parseContextMenuAction({ action: "insert-timestamp" })).toBeNull();
  });

  it("rejects an array payload", () => {
    expect(parseContextMenuAction(["insert-timestamp"])).toBeNull();
  });

  it("rejects null", () => {
    expect(parseContextMenuAction(null)).toBeNull();
  });

  it("rejects undefined", () => {
    expect(parseContextMenuAction(undefined)).toBeNull();
  });

  it("rejects a boolean", () => {
    expect(parseContextMenuAction(true)).toBeNull();
  });
});

describe("sendDestinationOf", () => {
  it('maps "send-note" to "note"', () => {
    expect(sendDestinationOf("send-note")).toBe("note");
  });

  it('maps "send-task" to "task"', () => {
    expect(sendDestinationOf("send-task")).toBe("task");
  });

  it('maps "send-prompt" to "prompt"', () => {
    expect(sendDestinationOf("send-prompt")).toBe("prompt");
  });

  it('maps "insert-timestamp" to null (not a send destination)', () => {
    expect(sendDestinationOf("insert-timestamp")).toBeNull();
  });
});

describe("surfaceOf", () => {
  it('reads dataset.menuSurface "body" as "body"', () => {
    expect(surfaceOf({ dataset: { menuSurface: "body" } })).toBe("body");
  });

  it('reads dataset.menuSurface "scratch" as "scratch"', () => {
    expect(surfaceOf({ dataset: { menuSurface: "scratch" } })).toBe("scratch");
  });

  it("returns 'none' when dataset has no menuSurface key", () => {
    expect(surfaceOf({ dataset: {} })).toBe("none");
  });

  it("returns 'none' when the element has no dataset at all", () => {
    expect(surfaceOf({})).toBe("none");
  });

  it("returns 'none' for an unrecognised surface value (\"title\")", () => {
    expect(surfaceOf({ dataset: { menuSurface: "title" } })).toBe("none");
  });

  it("returns 'none' for a case-mismatched surface value (\"Body\")", () => {
    expect(surfaceOf({ dataset: { menuSurface: "Body" } })).toBe("none");
  });

  it("returns 'none' for an empty-string surface value", () => {
    expect(surfaceOf({ dataset: { menuSurface: "" } })).toBe("none");
  });

  it("returns 'none' for a null element", () => {
    expect(surfaceOf(null)).toBe("none");
  });
});
