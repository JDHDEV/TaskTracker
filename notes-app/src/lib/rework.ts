// Pure, unit-testable helpers for the AI bar's rework instruction (plan 17,
// Phase 1). No React, no IPC. AiBar.tsx routes its Enter handling through
// `shouldSubmitOnKey`; the three editors decide with `shouldClearInstruction`
// whether an accepted proposal empties the box, and build the selection-rework
// confirm copy with `selectionConfirmMessage` — so the retention rule (D3) and
// the confirm's "never the selected text" rule (R-7) are testable in the
// node-env vitest setup rather than through the DOM.

/** The structural subset of a keyboard event the submit decision needs. */
export interface SubmitKey {
  key: string;
  shiftKey: boolean;
  /** `e.nativeEvent.isComposing` — an IME composition is in progress. */
  isComposing: boolean;
  /** Legacy IME signal: some engines report Enter-during-composition as 229. */
  keyCode: number;
}

/**
 * Whether a key press in the instruction box submits the rework: only a bare
 * Enter (no Shift — that inserts a newline), outside an IME composition
 * (R-18: a half-typed instruction is never sent), with a non-blank value and
 * no rework already running.
 */
export function shouldSubmitOnKey(e: SubmitKey, value: string, busy: boolean): boolean {
  if (busy) return false;
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return value.trim() !== "";
}

/**
 * The retention rule (D3): the box is emptied after a successful `Replace text`
 * ONLY when it still holds the instruction that produced the proposal. A new
 * instruction typed while the proposal was pending is kept; an empty sent
 * instruction (defensive — the bar never sends one) never clears anything.
 */
export function shouldClearInstruction(boxValue: string, sentInstruction: string): boolean {
  const sent = sentInstruction.trim();
  if (sent === "") return false;
  return boxValue.trim() === sent;
}

/** Longest instruction preview the confirm dialog quotes (code points). */
const INSTRUCTION_PREVIEW_CHARS = 80;

/**
 * The native confirm shown before a SELECTION rework (D5). Names the character
 * count and, when present, the instruction (whitespace collapsed, truncated
 * with an ellipsis) — never the selected text itself (R-7): the signature has
 * no parameter for it, so it cannot leak into a dialog.
 */
export function selectionConfirmMessage(
  count: number,
  instruction: string,
): { message: string; okLabel: string; cancelLabel: string } {
  const noun = count === 1 ? "character" : "characters";
  let message = `Rework only the ${count} selected ${noun}?`;
  const collapsed = instruction.replace(/\s+/g, " ").trim();
  if (collapsed !== "") {
    const chars = Array.from(collapsed);
    const shown =
      chars.length > INSTRUCTION_PREVIEW_CHARS
        ? `${chars.slice(0, INSTRUCTION_PREVIEW_CHARS).join("")}…`
        : collapsed;
    message += `\nInstruction: "${shown}"`;
  }
  return { message, okLabel: "Rework selection", cancelLabel: "Cancel" };
}
