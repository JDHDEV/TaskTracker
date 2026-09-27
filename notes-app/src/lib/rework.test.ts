import { describe, it, expect } from "vitest";
import { shouldSubmitOnKey, shouldClearInstruction, selectionConfirmMessage } from "./rework";
import type { SubmitKey } from "./rework";

// A bare, non-composing Enter with a non-blank value and no busy rework.
function baseKey(overrides: Partial<SubmitKey> = {}): SubmitKey {
  return { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...overrides };
}

describe("shouldSubmitOnKey", () => {
  it("submits on a bare Enter with a non-blank value and no busy rework", () => {
    expect(shouldSubmitOnKey(baseKey(), "fix the typo", false)).toBe(true);
  });

  it("does not submit on Shift+Enter (inserts a newline instead)", () => {
    expect(shouldSubmitOnKey(baseKey({ shiftKey: true }), "fix the typo", false)).toBe(false);
  });

  it("does not submit while an IME composition is in progress (nativeEvent.isComposing)", () => {
    expect(shouldSubmitOnKey(baseKey({ isComposing: true }), "fix the typo", false)).toBe(false);
  });

  it("does not submit when keyCode === 229 (legacy IME signal), even if isComposing reads false", () => {
    expect(shouldSubmitOnKey(baseKey({ keyCode: 229 }), "fix the typo", false)).toBe(false);
  });

  it("does not submit on a non-Enter key", () => {
    expect(shouldSubmitOnKey(baseKey({ key: "a" }), "fix the typo", false)).toBe(false);
  });

  it("does not submit an empty value", () => {
    expect(shouldSubmitOnKey(baseKey(), "", false)).toBe(false);
  });

  it("does not submit a whitespace-only value", () => {
    expect(shouldSubmitOnKey(baseKey(), "   \t  ", false)).toBe(false);
  });

  it("does not submit while a rework is already busy", () => {
    expect(shouldSubmitOnKey(baseKey(), "fix the typo", true)).toBe(false);
  });
});

describe("shouldClearInstruction", () => {
  it("clears when the box still holds exactly the sent instruction", () => {
    expect(shouldClearInstruction("fix the typo", "fix the typo")).toBe(true);
  });

  it("clears when box and sent differ only by surrounding whitespace", () => {
    expect(shouldClearInstruction("  fix the typo  ", "fix the typo")).toBe(true);
    expect(shouldClearInstruction("fix the typo", "  fix the typo  ")).toBe(true);
    expect(shouldClearInstruction("\nfix the typo\t", "  fix the typo  ")).toBe(true);
  });

  it("does not clear when the box was edited while the proposal was pending", () => {
    expect(shouldClearInstruction("fix the typo, then reword it", "fix the typo")).toBe(false);
  });

  it("does not clear when the sent instruction is empty", () => {
    expect(shouldClearInstruction("", "")).toBe(false);
  });

  it("does not clear when the sent instruction is whitespace-only", () => {
    expect(shouldClearInstruction("   ", "   ")).toBe(false);
  });
});

describe("selectionConfirmMessage", () => {
  it("uses the plural noun and states the count for a multi-character selection", () => {
    const { message } = selectionConfirmMessage(42, "");
    expect(message.startsWith("Rework only the 42 selected characters?")).toBe(true);
  });

  it("uses the singular noun 'character' when count === 1", () => {
    const { message } = selectionConfirmMessage(1, "");
    expect(message.startsWith("Rework only the 1 selected character?")).toBe(true);
    expect(message).not.toContain("1 selected characters");
  });

  it("always returns the fixed okLabel and cancelLabel", () => {
    const { okLabel, cancelLabel } = selectionConfirmMessage(5, "make it terser");
    expect(okLabel).toBe("Rework selection");
    expect(cancelLabel).toBe("Cancel");
  });

  it("appends a second 'Instruction: \"...\"' line when an instruction is given", () => {
    const { message } = selectionConfirmMessage(5, "make it terser");
    expect(message).toBe('Rework only the 5 selected characters?\nInstruction: "make it terser"');
  });

  it("adds no second line for an empty instruction", () => {
    const { message } = selectionConfirmMessage(5, "");
    expect(message).toBe("Rework only the 5 selected characters?");
    expect(message).not.toContain("\n");
  });

  it("adds no second line for a whitespace-only instruction", () => {
    const { message } = selectionConfirmMessage(5, "   \n\t  ");
    expect(message).toBe("Rework only the 5 selected characters?");
  });

  it("collapses internal newlines and whitespace runs in the instruction to one space", () => {
    const { message } = selectionConfirmMessage(5, "make it   terser\n\nand punchier");
    expect(message).toBe(
      'Rework only the 5 selected characters?\nInstruction: "make it terser and punchier"',
    );
  });

  it("truncates an instruction of exactly 80 code points to itself, unmodified (boundary: not > 80)", () => {
    const exact80 = "a".repeat(80);
    const { message } = selectionConfirmMessage(3, exact80);
    expect(message).toBe(`Rework only the 3 selected characters?\nInstruction: "${exact80}"`);
    expect(message).not.toContain("…");
  });

  it("truncates an 81-code-point instruction to 80 chars plus an ellipsis", () => {
    const chars81 = "b".repeat(81);
    const { message } = selectionConfirmMessage(3, chars81);
    const expectedShown = "b".repeat(80) + "…";
    expect(message).toBe(`Rework only the 3 selected characters?\nInstruction: "${expectedShown}"`);
  });

  it("truncates a 100-char instruction to its first 80 characters plus an ellipsis", () => {
    const long = "x".repeat(100);
    const { message } = selectionConfirmMessage(7, long);
    const expectedShown = "x".repeat(80) + "…";
    expect(message).toContain(`Instruction: "${expectedShown}"`);
    // Never the full untruncated text.
    expect(message).not.toContain("x".repeat(81));
  });

  it("counts CODE POINTS, not UTF-16 code units, when truncating (multi-unit emoji)", () => {
    const EMOJI = String.fromCodePoint(0x1f600); // 2 UTF-16 code units, 1 code point
    // 90 code points, 180 UTF-16 units: a length check on `.length` would see
    // 180 (>> 80) and a naive `.slice(0, 80)` would only keep 40 whole emoji
    // (80 units / 2) — half of what the code-point rule keeps.
    const ninetyEmoji = EMOJI.repeat(90);
    const { message } = selectionConfirmMessage(2, ninetyEmoji);

    const instructionMatch = message.match(/Instruction: "([\s\S]*)"$/);
    expect(instructionMatch).not.toBeNull();
    const shown = instructionMatch![1];
    expect(shown.endsWith("…")).toBe(true);
    const shownEmojiOnly = shown.slice(0, -1); // drop the ellipsis
    expect(Array.from(shownEmojiOnly).length).toBe(80); // 80 CODE POINTS kept
    expect(shownEmojiOnly).toBe(EMOJI.repeat(80)); // not 40 (the UTF-16-unit answer)
  });

  it("does NOT truncate when the code-point count is <= 80 even though the UTF-16 length is > 80", () => {
    const EMOJI = String.fromCodePoint(0x1f600);
    // 50 code points, 100 UTF-16 units: a `.length > 80` check (UTF-16 units)
    // would wrongly truncate this; the correct code-point check must not.
    const fiftyEmoji = EMOJI.repeat(50);
    expect(fiftyEmoji.length).toBe(100);
    expect(Array.from(fiftyEmoji).length).toBe(50);

    const { message } = selectionConfirmMessage(2, fiftyEmoji);
    expect(message).toBe(`Rework only the 2 selected characters?\nInstruction: "${fiftyEmoji}"`);
    expect(message).not.toContain("…");
  });

  it("the message never contains the selected text: the signature has no parameter for it", () => {
    // selectionConfirmMessage(count: number, instruction: string) — there is no
    // third "selectedText" (or "body") parameter, so the confidential selected
    // text simply cannot reach the message. Assert the property directly: for
    // a representative selected-text sample, no message this function can
    // produce contains it.
    const secretSelectedText = "TOP SECRET do not leak this selected span 12345";
    const { message } = selectionConfirmMessage(secretSelectedText.length, "reword this");
    expect(message).not.toContain(secretSelectedText);
    expect(message).not.toContain("TOP SECRET");
  });
});
