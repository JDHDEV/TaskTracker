// The preferred AI provider, persisted in localStorage. Shared by AiBar (its
// select seed + write) and Editor (which needs the provider for R1/R4 title
// calls without lifting AiBar's state up). Keeping the key + fallback in one
// place means the two readers can never drift apart.

import type { ProviderId } from "../types";

const KEY = "provider";
const DEFAULT: ProviderId = "anthropic";

/** The stored provider, or `"anthropic"` when unset or unrecognized. */
export function getPreferredProvider(): ProviderId {
  return localStorage.getItem(KEY) === "openai" ? "openai" : DEFAULT;
}

/** Persist the preferred provider. */
export function setPreferredProvider(id: ProviderId): void {
  localStorage.setItem(KEY, id);
}
