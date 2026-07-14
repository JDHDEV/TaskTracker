import { useState } from "react";
import type { ProviderId } from "../types";

interface Props {
  busy: boolean;
  onRework: (instruction: string, provider: ProviderId) => void;
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

export default function AiBar({ busy, onRework }: Props) {
  const [provider, setProvider] = useState<ProviderId>(
    () => (localStorage.getItem("provider") as ProviderId) || "anthropic",
  );
  const [custom, setCustom] = useState("");

  function pickProvider(next: ProviderId) {
    setProvider(next);
    localStorage.setItem("provider", next);
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
        <button
          key={preset}
          className="chip"
          disabled={busy}
          onClick={() => onRework(preset, provider)}
        >
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
    </div>
  );
}
