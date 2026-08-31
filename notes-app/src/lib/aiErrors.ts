// F5 (plan.14 D7): the "no API key" toast auto-dismisses when a key is saved.
// The backend's AppError serializes to a bare string, so the frontend cannot
// discriminate error kinds; instead, on any AI failure the provider's key
// PRESENCE is checked post-hoc (a boolean — never key material, S-6) and the
// toast is keyed by provider when absent, so SettingsDialog's onKeySaved can
// dismiss exactly that toast the moment a key lands.

import type { ProviderId } from "../types";
import { hasApiKey as apiHasApiKey } from "./api";

/** The stable toast key for a provider's missing-key error. Takes a plain
 *  string (not ProviderId): the JIRA token reuses the shape with "atlassian",
 *  which is not an AI provider and must not join the ProviderId union. */
export function missingKeyToastKey(provider: string): string {
  return `missing-key:${provider}`;
}

/**
 * Surface an AI failure as a toast. If `provider` has no stored key the push is
 * keyed `missing-key:<provider>` (so saving a key dismisses it, and repeats
 * replace in place); otherwise it is a plain unkeyed error. Accepts a raw
 * rejection or an already-stringified message (both flow through `String`).
 * A failed presence check falls back to an unkeyed push — never a throw.
 */
export async function reportAiError(
  provider: ProviderId,
  err: unknown,
  onError: (message: string, opts?: { key?: string }) => void,
  checkKey: (provider: ProviderId) => Promise<boolean> = apiHasApiKey,
): Promise<void> {
  const message = String(err);
  let present: boolean;
  try {
    present = await checkKey(provider);
  } catch {
    present = true; // presence unknown → don't key it
  }
  if (present) onError(message);
  else onError(message, { key: missingKeyToastKey(provider) });
}
