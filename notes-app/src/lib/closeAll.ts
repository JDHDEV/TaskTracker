// Pure/injectable "Close all" sequencer for one editor tab strip (Plan 18,
// D1/D2, security R-4). No React, no IPC: the dialog, save, discard and
// activate verbs are passed in, so the dialog branching is unit-tested with
// fakes in the node-env vitest setup. The three tab owners (App items,
// PromptsPage, ScratchPage) each call runCloseAll with their own
// api.confirmDialog + editor handles and then fold the result into the pure
// closeTabs reducer.
//
// Consent rules (D2): clean tabs close silently. If anything is dirty there is
// ONE aggregate confirm (Q1 — Cancel changes nothing), then ONE Save/Discard
// choice for the dirty SAVED tabs (Q2), then each never-saved draft is brought
// to the front and gets the existing "Discard this unsaved …?" confirm. Drafts
// are never bulk-destroyed and never bulk-saved (a draft save may need a
// target project and fires an AI title call). A failed save keeps its tab; a
// kept tab is never discarded.

/** What the sequencer needs to know about one open tab. */
export interface CloseAllTab {
  key: string;
  isDirty: boolean;
  /** Never saved (entity id ""): only Discard/keep applies, per tab. */
  isDraft: boolean;
}

export interface CloseAllPlan {
  /** Close silently. */
  clean: string[];
  /** Dirty tabs with a saved version: Q2 decides save vs discard for all. */
  dirtySaved: string[];
  /** Dirty never-saved drafts: one Discard confirm each, in tab order. */
  drafts: string[];
}

/** Partition the strip; every list keeps tab order. */
export function planCloseAll(tabs: readonly CloseAllTab[]): CloseAllPlan {
  const plan: CloseAllPlan = { clean: [], dirtySaved: [], drafts: [] };
  for (const t of tabs) {
    if (!t.isDirty) plan.clean.push(t.key);
    else if (t.isDraft) plan.drafts.push(t.key);
    else plan.dirtySaved.push(t.key);
  }
  return plan;
}

/** Q1 — the aggregate confirm; states the counts (never a list of titles). */
export function closeAllQuestion(total: number, unsaved: number): string {
  const tabs = total === 1 ? "1 tab" : `${total} tabs`;
  const have = unsaved === 1 ? "1 has" : `${unsaved} have`;
  return `Close all ${tabs}? ${have} unsaved changes.`;
}

/** Q2 — Save/Discard for the dirty saved tabs (Yes/No dialog wording). */
export function saveAllQuestion(unsaved: number): string {
  return unsaved === 1
    ? "Save the 1 unsaved tab before closing? Yes saves and closes; No discards it."
    : `Save the ${unsaved} unsaved tabs before closing? Yes saves and closes; No discards them.`;
}

export interface CloseAllDeps {
  tabs: readonly CloseAllTab[];
  /** api.confirmDialog (or a fake): a Yes/No dialog with optional labels. */
  confirm: (
    message: string,
    opts?: { okLabel?: string; cancelLabel?: string },
  ) => Promise<boolean>;
  /** The tab's imperative save; false (or a throw) keeps the tab open. */
  save: (key: string) => Promise<boolean>;
  /** The tab's imperative discardDraft (seal the queue, then delete). */
  discard: (key: string) => Promise<void>;
  /** Bring a draft to the front before its confirm. */
  activate: (key: string) => void;
  /** The per-draft "Discard this unsaved …?" confirm. */
  confirmDraft: (key: string) => Promise<boolean>;
}

export interface CloseAllResult {
  /** Keys to close, in tab order. */
  closed: string[];
  /** Keys that stay open (cancelled, failed save, or a kept draft), in tab order. */
  kept: string[];
}

/**
 * Run the D2 flow. Order: Q1, then the whole dirty-saved flow (Q2 + every
 * save/discard), then the per-draft loop in tab order — the bulk questions
 * are answered before any draft is brought to the front.
 */
export async function runCloseAll(deps: CloseAllDeps): Promise<CloseAllResult> {
  const all = deps.tabs.map((t) => t.key);
  const plan = planCloseAll(deps.tabs);
  const unsaved = plan.dirtySaved.length + plan.drafts.length;
  if (unsaved === 0) return { closed: all, kept: [] };

  const q1 = await deps.confirm(closeAllQuestion(all.length, unsaved), {
    okLabel: "Close all",
    cancelLabel: "Cancel",
  });
  if (!q1) return { closed: [], kept: all };

  const closed = new Set<string>(plan.clean);
  const kept = new Set<string>();

  if (plan.dirtySaved.length > 0) {
    if (await deps.confirm(saveAllQuestion(plan.dirtySaved.length))) {
      for (const key of plan.dirtySaved) {
        let ok = false;
        try {
          ok = await deps.save(key);
        } catch {
          ok = false;
        }
        if (ok) closed.add(key);
        else kept.add(key); // save failed → stays open, edits intact
      }
    } else {
      for (const key of plan.dirtySaved) {
        await deps.discard(key);
        closed.add(key);
      }
    }
  }

  for (const key of plan.drafts) {
    deps.activate(key);
    if (await deps.confirmDraft(key)) {
      await deps.discard(key);
      closed.add(key);
    } else {
      kept.add(key);
    }
  }

  return {
    closed: all.filter((k) => closed.has(k)),
    kept: all.filter((k) => kept.has(k)),
  };
}
