import { useEffect, useState } from "react";
import type { TicketMeta } from "../types";
import { getJiraConfig, getJiraTicket, hasJiraToken } from "../lib/api";

export type EnrichmentState =
  | "idle" // no URL to enrich
  | "unconfigured" // no token or no site set — chip shows the plain label
  | "loading"
  | "loaded"
  | "error"; // lookup failed — plain label, chip still opens the browser

export interface Enrichment {
  state: EnrichmentState;
  meta: TicketMeta | null;
  tooltip: string | undefined;
}

// Session cache so re-selecting an item (or the editor remounting) doesn't
// refetch a ticket we already have — this is the "no per-render refetch" guard.
// A single desktop window, so a plain module map is enough; enrichment is
// on-demand only, with no background TTL refresh (see plan §12).
const cache = new Map<string, TicketMeta>();

// Enrichment epoch + subscribers. Saving JIRA settings (a Settings-overlay
// action that does NOT remount the editor) bumps the epoch so an already-open
// chip re-evaluates instead of staying stuck on its plain/unconfigured label.
let epoch = 0;
const listeners = new Set<() => void>();

/** Clear cached tickets and force every mounted chip to re-enrich. Call after
 *  the JIRA connection or token changes. */
export function invalidateJiraEnrichment(): void {
  cache.clear();
  epoch += 1;
  listeners.forEach((l) => l());
}

const DEBOUNCE_MS = 400;

function loadedTooltip(t: TicketMeta): string {
  const title = t.title || "(no summary)";
  return t.status ? `${t.key} — ${title} · ${t.status}` : `${t.key} — ${title}`;
}

/**
 * Fetch/cache/debounce a JIRA URL's ticket metadata. The chip stays a quiet
 * fallback on every failure: an unconfigured connection, a keyless URL, or any
 * lookup error all leave it showing the plain ticket label — never an alarm,
 * and it always opens the browser regardless of state.
 */
export function useJiraEnrichment(url: string): Enrichment {
  const trimmed = url.trim();
  const cached = cache.get(trimmed) ?? null;
  // Seed from cache so a remount with a known ticket paints enriched with no
  // loading flash.
  const [state, setState] = useState<EnrichmentState>(cached ? "loaded" : "idle");
  const [meta, setMeta] = useState<TicketMeta | null>(cached);
  const [tooltip, setTooltip] = useState<string | undefined>(
    cached ? loadedTooltip(cached) : undefined,
  );
  // Re-runs the enrichment effect when settings change mid-session.
  const [epochState, setEpochState] = useState(epoch);

  useEffect(() => {
    const notify = () => setEpochState(epoch);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);

  useEffect(() => {
    if (!trimmed) {
      setState("idle");
      setMeta(null);
      setTooltip(undefined);
      return;
    }
    const hit = cache.get(trimmed);
    if (hit) {
      setState("loaded");
      setMeta(hit);
      setTooltip(loadedTooltip(hit));
      return;
    }

    let cancelled = false;
    // Label is unchanged while loading (the chip renders the plain label in
    // every non-loaded state) — no layout shift, just a tooltip cue.
    setState("loading");
    setMeta(null);
    setTooltip("Loading ticket…");

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [tokenPresent, config] = await Promise.all([
            hasJiraToken(),
            getJiraConfig(),
          ]);
          if (cancelled) return;
          if (!tokenPresent || !config) {
            // Expected, quiet state — not an error. No network call was made.
            setState("unconfigured");
            setTooltip(undefined);
            return;
          }
          const ticket = await getJiraTicket(trimmed);
          if (cancelled) return;
          cache.set(trimmed, ticket);
          setState("loaded");
          setMeta(ticket);
          setTooltip(loadedTooltip(ticket));
        } catch {
          if (cancelled) return;
          // No key in the URL, rate-limited, auth failure, network — all degrade
          // to the plain label. The specific reason isn't surfaced on the chip.
          setState("error");
          setTooltip("Couldn't load ticket details");
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, epochState]);

  return { state, meta, tooltip };
}
