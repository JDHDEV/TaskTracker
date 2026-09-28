import { useId, useRef, useState } from "react";
import type { ProviderId } from "../types";
import { getPreferredProvider, setPreferredProvider } from "../lib/aiProvider";
import { shouldSubmitOnKey } from "../lib/rework";

interface Props {
  busy: boolean;
  dirty: boolean;
  /** R4: an empty-title save is generating a title — Save is disabled and
   *  reads "Generating title…" for the duration. */
  generatingTitle: boolean;
  /** A new draft with no project chosen yet — Save is blocked until one is
   *  picked (a new item must be created into a specific project store). */
  saveBlocked: boolean;
  /** Which preset instruction chips to show. Items keep their original four;
   *  prompts (plan.7) get a prompt-engineering-flavored set. Defaults "item"
   *  so every existing caller is unaffected. */
  variant?: "item" | "prompt";
  /** Plan 17 (D2/D3): the instruction box is CONTROLLED by the editor, which
   *  owns the value, its reset on reseed, and the clear-on-accept rule — the
   *  bar never empties it on submit, so a discarded rework leaves the
   *  instruction in place. */
  instruction: string;
  onInstructionChange: (value: string) => void;
  onRework: (instruction: string, provider: ProviderId) => void;
  onSave: () => void;
  /** Prompt editor only (plan.9): revert unsaved title/body edits to the most
   *  recently saved version. When provided, a Discard button appears left of
   *  Save; the item editor leaves it undefined. */
  onDiscard?: () => void;
  /** Plan 13: the length of the body text currently selected. When positive,
   *  the label reads "Rework selection with" and a count + `Whole text` override
   *  appear, so the implicit selection mode is visible and escapable. */
  selectionLength?: number;
  /** Clear the selection mode (collapse the highlight) — the `Whole text` button. */
  onClearSelection?: () => void;
}

const ITEM_PRESETS = [
  "Tighten this up",
  "Fix grammar and spelling",
  "Make it more professional",
  "Turn into bullet points",
];

const PROMPT_PRESETS = [
  "Make it more specific",
  "Add clear constraints",
  "Clarify the ask",
  "Tighten this up",
];

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "GPT" },
];

/** UX-only ceiling on the instruction box; the backend's byte cap (R-1) is
 *  the enforcement. 2 000 UTF-16 units stay under 8 KiB at 4 bytes/char. */
const INSTRUCTION_MAX_LENGTH = 2000;

export default function AiBar({
  busy,
  dirty,
  generatingTitle,
  saveBlocked,
  variant = "item",
  instruction,
  onInstructionChange,
  onRework,
  onSave,
  onDiscard,
  selectionLength,
  onClearSelection,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(getPreferredProvider);
  const presets = variant === "prompt" ? PROMPT_PRESETS : ITEM_PRESETS;
  const hasSelection = typeof selectionLength === "number" && selectionLength > 0;
  const customRef = useRef<HTMLTextAreaElement>(null);
  // Every open tab keeps its AiBar mounted, so the hint's id must be unique
  // per instance — a literal id would be duplicated across tabs.
  const hintId = useId();

  function pickProvider(next: ProviderId) {
    setProvider(next);
    setPreferredProvider(next);
  }

  function submitCustom() {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    // Deliberately no clear here (D3): the editor decides after Replace text.
    onRework(trimmed, provider);
  }

  // A preset chip fills the box (DESIGN.md: chips fill, they don't submit) and
  // moves focus into it with the caret at the end. The DOM value is set first
  // so the caret range is valid before React commits the same string.
  function pickPreset(preset: string) {
    onInstructionChange(preset);
    const ta = customRef.current;
    if (ta) {
      ta.value = preset;
      ta.focus();
      ta.setSelectionRange(preset.length, preset.length);
    }
  }

  return (
    <div className="aibar">
      <span className="aibar-label">
        {hasSelection ? "Rework selection with" : "Rework with"}
      </span>
      <select
        className="select"
        value={provider}
        aria-label="AI provider"
        onChange={(e) => pickProvider(e.target.value as ProviderId)}
      >
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      {presets.map((preset) => (
        <button key={preset} className="chip" onClick={() => pickPreset(preset)}>
          {preset}
        </button>
      ))}

      <textarea
        ref={customRef}
        rows={1}
        className="aibar-custom"
        placeholder="Or type your own instruction…"
        aria-label="Rework instruction"
        aria-describedby={hintId}
        maxLength={INSTRUCTION_MAX_LENGTH}
        value={instruction}
        // Editable while busy (plan 17 §12 F14 — D2's readOnly dropped): the
        // item editor stays busy through its title phase after the body
        // stream, and a read-only box silently ate anything typed then.
        // Enter is ignored while busy (shouldSubmitOnKey) and the Rework
        // button is disabled, so nothing can submit mid-stream; the request
        // already captured its own instruction (reworkRequest, D4).
        onChange={(e) => onInstructionChange(e.target.value)}
        onKeyDown={(e) => {
          if (
            shouldSubmitOnKey(
              {
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.keyCode,
              },
              instruction,
              busy,
            )
          ) {
            e.preventDefault();
            submitCustom();
          }
        }}
      />
      <span id={hintId} className="sr-only">
        Enter to rework, Shift+Enter for a new line
      </span>
      <button
        className="btn"
        disabled={busy || !instruction.trim()}
        onClick={submitCustom}
      >
        {busy ? "Working…" : "Rework"}
      </button>
      {hasSelection && (
        <>
          <span className="aibar-note">{selectionLength} characters selected</span>
          <button className="btn btn-quiet" onClick={onClearSelection}>
            Whole text
          </button>
        </>
      )}
      {onDiscard && (
        <button
          className="btn btn-quiet"
          disabled={!dirty || generatingTitle}
          title="Revert to the most recently saved version"
          onClick={onDiscard}
        >
          Discard
        </button>
      )}
      <button
        className="btn btn-save"
        disabled={!dirty || generatingTitle || saveBlocked}
        title={saveBlocked ? "Choose a project first" : undefined}
        onClick={onSave}
      >
        {generatingTitle ? "Generating title…" : dirty ? "Save" : "Saved"}
      </button>
    </div>
  );
}
