// F6 (plan.14 D9): Ctrl+X/C/V act on the whole current line when nothing is
// selected — the VS Code habit, in the three body textareas only (S-7: a
// no-selection Ctrl+C in the masked API-key input must never copy the secret).
//
// Cut/copy ride the NATIVE path: the keydown handler only expands the
// selection to the line and lets the native command act on it, so dirty
// tracking (the cut flows through onChange) and native undo stay intact, and
// no clipboard READ capability is added. Only line-PASTE is programmatic: the
// paste handler intercepts iff the clipboard text equals the module-level
// `lastLineCopy` sentinel — that one insert is not natively undoable (accepted
// in D9, the spliceProposal precedent). A clipboard overwritten by another app
// mismatches the sentinel and degrades to a fully native paste.
//
// Framework-free and DOM-free by structural typing (TextAreaLike/event
// shapes), so the whole module — handlers included — is node-env testable.
// `\r` handling decision: textarea values are already `\n`-normalized by the
// browser, so `\r` is treated as an ordinary character, never a line break.

export interface TextAreaLike {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
}

interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface PasteEventLike {
  clipboardData: { getData(format: string): string } | null;
  preventDefault(): void;
}

/** [start, end) of the line containing `caret`, excluding the trailing `\n`.
 *  A caret sitting ON a `\n` (offset of the newline itself) belongs to the
 *  line that newline terminates — the preceding line (VS Code convention). */
export function lineRangeAt(text: string, caret: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const start = text.lastIndexOf("\n", at - 1) + 1; // at===0 → lastIndexOf(-1) === -1 → 0
  const nl = text.indexOf("\n", at);
  return { start, end: nl === -1 ? text.length : nl };
}

/** The selection a no-selection COPY expands to: the line plus its trailing
 *  `\n` when it has one (so pasting reproduces a whole line). The last line
 *  has none — the payload then gets its `\n` back in `pasteLine`. */
export function selectionForCopy(text: string, caret: number): { start: number; end: number } {
  const { start, end } = lineRangeAt(text, caret);
  return { start, end: end < text.length ? end + 1 : end };
}

/** The selection a no-selection CUT expands to: line plus trailing `\n`; for
 *  the LAST line (no trailing `\n`) the PRECEDING `\n` is borrowed instead, so
 *  cutting it never leaves a dangling empty last line (VS Code behavior). */
export function selectionForCut(text: string, caret: number): { start: number; end: number } {
  const { start, end } = lineRangeAt(text, caret);
  if (end < text.length) return { start, end: end + 1 };
  return { start: Math.max(0, start - 1), end };
}

/** Insert `payload` as a whole line ABOVE the caret's line. A leading `\n`
 *  (the borrowed newline of a last-line cut) is shed and exactly one trailing
 *  `\n` is ensured, so the insert is always one full line. The caret keeps its
 *  position within the original line (now shifted down). */
export function pasteLine(
  text: string,
  caret: number,
  payload: string,
): { body: string; caret: number } {
  const line = payload.startsWith("\n") ? payload.slice(1) : payload;
  const insert = line.endsWith("\n") ? line : line + "\n";
  const { start } = lineRangeAt(text, caret);
  const at = Math.max(0, Math.min(caret, text.length));
  return {
    body: text.slice(0, start) + insert + text.slice(start),
    caret: at + insert.length,
  };
}

// The payload of the last no-selection line copy/cut. Module-level and
// in-process only: it never reads the clipboard — the paste handler compares
// the EVENT's clipboard text against it, so a stale sentinel simply mismatches.
let lastLineCopy: string | null = null;

/** Test seam: reset/inspect the sentinel without driving a copy. */
export function setLastLineCopyForTest(value: string | null): void {
  lastLineCopy = value;
}

/**
 * Keydown half of D9. On bare Ctrl/Cmd+X/C with a COLLAPSED selection: expand
 * the selection to the whole line, record the sentinel, and DO NOT prevent
 * default — the native command cuts/copies the now-selected range (native
 * undo preserved; a cut flows through the normal onChange). After a copy the
 * caret is restored on a 0-timer — a later task, safely after the native
 * command has read the selection (a microtask checkpoint can run BEFORE the
 * default action, which would collapse the selection too early). Any real
 * selection, other key, or empty body: fully native, untouched.
 */
export function handleLineClipboardKeyDown(e: KeyEventLike, ta: TextAreaLike): void {
  const k = e.key.toLowerCase();
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (k !== "x" && k !== "c")) return;
  if (ta.selectionStart !== ta.selectionEnd) return; // real selection → native
  const text = ta.value;
  if (text === "") return;
  const caret = ta.selectionStart;
  const range = k === "x" ? selectionForCut(text, caret) : selectionForCopy(text, caret);
  lastLineCopy = text.slice(range.start, range.end);
  ta.setSelectionRange(range.start, range.end);
  if (k === "c") {
    setTimeout(() => ta.setSelectionRange(caret, caret), 0);
  }
}

/**
 * Paste half of D9. Intercepts iff the caret is collapsed AND the event's
 * clipboard text equals the sentinel — then inserts it as a whole line above
 * the caret's line through `applyEdit` (the editor routes it via edit() +
 * clearSelection() + pendingCaretRef). Returns whether it intercepted; every
 * other case (selection, mismatch, empty, no clipboardData) stays native.
 */
export function handleLinePaste(
  e: PasteEventLike,
  ta: TextAreaLike,
  applyEdit: (body: string, caret: number) => void,
): boolean {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const payload = e.clipboardData?.getData("text/plain") ?? "";
  if (payload === "" || lastLineCopy === null || payload !== lastLineCopy) return false;
  e.preventDefault();
  const next = pasteLine(ta.value, ta.selectionStart, payload);
  applyEdit(next.body, next.caret);
  return true;
}
