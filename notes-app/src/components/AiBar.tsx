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
  onRework: (instruction: string, provider: ProviderId) => void;
  onSave: () => void;
}

const PRESETS = [
  "Tighten this up",
  "Fix grammar and spelling",
  "Make it more professional",
  "Turn into bullet points",
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
  onRework,
  onSave,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(getPreferredProvider);
  const [custom, setCustom] = useState("");

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
      <span className="aibar-label">Rework with</span>
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

      {PRESETS.map((preset) => (
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
