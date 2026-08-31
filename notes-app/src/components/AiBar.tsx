import { useState } from "react";
import type { ProviderId } from "../types";
import { getPreferredProvider, setPreferredProvider } from "../lib/aiProvider";

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

export default function AiBar({
  busy,
  dirty,
  generatingTitle,
  saveBlocked,
  variant = "item",
  onRework,
  onSave,
  onDiscard,
  selectionLength,
  onClearSelection,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(getPreferredProvider);
  const [custom, setCustom] = useState("");
  const presets = variant === "prompt" ? PROMPT_PRESETS : ITEM_PRESETS;
  const hasSelection = typeof selectionLength === "number" && selectionLength > 0;

  function pickProvider(next: ProviderId) {
    setProvider(next);
    setPreferredProvider(next);
  }

  function submitCustom() {
    const instruction = custom.trim();
    if (!instruction) return;
    onRework(instruction, provider);
    setCustom("");
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
        <button key={preset} className="chip" onClick={() => setCustom(preset)}>
          {preset}
        </button>
      ))}

      <input
        className="aibar-custom"
        placeholder="Or type your own instruction…"
        value={custom}
        disabled={busy}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submitCustom()}
      />
      <button
        className="btn"
        disabled={busy || !custom.trim()}
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
