// The draft-backup timing hook (plan.15 step 10): TIMING ONLY — the snapshot
// shapes and schedule logic live in src/lib/drafts.ts (pure, vitest-covered),
// the IPC in src/lib/api.ts. One instance per mounted editor, item, prompt,
// and scratch alike; there is deliberately NO `active`/`hidden` gate on the
// periodic tick (D7: background tabs keep mounted editors with dirty buffers,
// and the crash promise covers them too).
//
// Every write is fire-and-forget (never blocks a keystroke) and serialized
// through a per-editor DraftQueue so a delete enqueued after a flush can never
// lose to it. There is NO unmount flush — deliberately: every unmount is
// preceded by a path that already settled the draft (save cleared it, discard
// deleted it, unload/reload swept it), so a late unmount flush could only
// resurrect a draft those paths just removed.

import { useEffect, useRef, type RefObject } from "react";
import type { Draft } from "../types";
import * as api from "../lib/api";
import {
  DraftQueue,
  isUuid,
  registerFlushable,
  shouldFlush,
  unregisterFlushable,
} from "../lib/drafts";

/** How often the schedule is re-checked. Half the idle window, so the 1 s idle
 *  / 5 s max-wait cadence (drafts.ts) is honored within ±500 ms. */
const TICK_MS = 500;

/** The imperative surface the owning editor re-exposes on its EditorHandle. */
export interface DraftBackupHandle {
  /** Snapshot + persist now if dirty and there are unflushed edits — used on
   *  blur, tab/page switch, before AI calls, and by the window-close flush.
   *  Never touches canonical files (D2: backup, not autosave). */
  flushNow: () => Promise<void>;
  /** Permanently stop this editor's backups and delete its draft, ordered
   *  behind any in-flight write — the buffer-discarding paths (discard-close,
   *  item delete) call this BEFORE unmounting so a straggler tick can never
   *  resurrect the draft (§8 async-ordering rule). */
  discard: () => Promise<void>;
  /** Delete the draft after a successful save (ordered behind in-flight
   *  flushes). Unlike discard, the editor stays live — later edits back up
   *  again. */
  clearAfterSave: () => void;
}

interface Options {
  /** The BARE on-disk draft id (D8) — the entity's UUID for a saved item/
   *  prompt, the project UUID for scratch, the minted UUID inside a
   *  `draft-<uuid>` tab key. Anything that fails isUuid disables the hook
   *  (writes would be silently rejected server-side otherwise). */
  draftId: string;
  dirty: boolean;
  /** The visible-active flag — used ONLY to flush on the active→inactive
   *  transition (tab/page switch), never to gate the periodic tick (D7). */
  active: boolean;
  /** Ref to a snapshot closure, reassigned by the editor every render: returns
   *  the Draft to persist, or null when buffer == base (the hook then deletes
   *  any existing draft instead — D6). */
  getSnapshot: RefObject<() => Draft | null>;
  /** Ref bumped (Date.now()) at the editor's edit() chokepoint. */
  lastEditRef: RefObject<number>;
  /** Orphan-restore handoff (step 13): the dead entity's old draft file to
   *  delete after THIS editor's first successful flush under its fresh id —
   *  deleting it eagerly would lose the content if the app dies first. */
  supersedesDraftId?: string | null;
}

export function useDraftBackup({
  draftId,
  dirty,
  active,
  getSnapshot,
  lastEditRef,
  supersedesDraftId,
}: Options): DraftBackupHandle {
  const disabled = !isUuid(draftId);

  // One serialized queue per editor instance, lazily created. Never recreated:
  // draftId is fixed for an instance's lifetime (a draft→saved promotion
  // changes the tab key, which remounts the editor).
  const queueRef = useRef<DraftQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new DraftQueue(
      (draft) => api.saveDraft(draft),
      (id) => api.deleteDraft(id),
    );
  }
  const queue = queueRef.current;

  const lastFlushRef = useRef(Date.now());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const supersedesRef = useRef<string | null>(supersedesDraftId ?? null);

  // Stable across renders so registry entries and listeners never go stale.
  const doFlushRef = useRef<() => Promise<void>>(async () => {});
  doFlushRef.current = async () => {
    lastFlushRef.current = Date.now();
    const snapshot = getSnapshot.current();
    if (snapshot === null) {
      // Buffer == base: a stale draft on disk would restore an edit the user
      // already reverted — delete instead of write (D6).
      void queue.delete(draftId);
      return;
    }
    const ok = await queue.save(snapshot);
    if (ok && supersedesRef.current) {
      // First successful flush under the new identity: the dead entity's old
      // draft is now redundant (step 13's orphan handoff).
      const old = supersedesRef.current;
      supersedesRef.current = null;
      void queue.delete(old);
    }
  };

  const flushNow = async (): Promise<void> => {
    if (disabled || !dirtyRef.current) return;
    if (lastEditRef.current <= lastFlushRef.current) return; // nothing new
    await doFlushRef.current();
  };
  const flushNowRef = useRef(flushNow);
  flushNowRef.current = flushNow;

  // Periodic tick, gated on dirty only (D7 — no active/hidden gate).
  useEffect(() => {
    if (disabled || !dirty) return;
    const timer = window.setInterval(() => {
      if (shouldFlush(lastEditRef.current, lastFlushRef.current, Date.now())) {
        void doFlushRef.current();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
    // lastEditRef is a ref (stable identity) — listed for lint honesty only.
  }, [disabled, dirty, lastEditRef]);

  // Flush when this editor stops being the visible, active one (tab switch,
  // page switch) — the tick would catch it anyway, but the user's mental
  // checkpoint is "I left that tab", so honor it promptly (D6).
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current && !active) void flushNowRef.current();
    prevActiveRef.current = active;
  }, [active]);

  // Window blur (alt-tab away) — same checkpoint reasoning.
  useEffect(() => {
    if (disabled) return;
    const onBlur = () => void flushNowRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [disabled]);

  // Phase 6 flush-on-close registry. The cleanup deliberately does NOT
  // queue.close() (post-review, frontend HIGH): under StrictMode's dev
  // double-invoke this cleanup runs BETWEEN two setups on the SAME queue
  // instance (refs survive the probe), and close() is permanent — it silently
  // disabled every draft save for the editor's whole life in dev, the exact
  // build the manual smoke script runs. close() belongs to discard(); the
  // straggler-resurrection cases the unmount seal once covered are already
  // handled by the queue-ORDERED delete in clearAfterSave (a pending save and
  // the delete share one FIFO chain) and by the explicit discard() every
  // buffer-discarding path calls before unmounting.
  useEffect(() => {
    if (disabled) return;
    registerFlushable(draftId, () => flushNowRef.current());
    return () => unregisterFlushable(draftId);
  }, [disabled, draftId]);

  // A pending superseded file (orphan restore) is settled by whichever comes
  // first: the first successful flush (above), a save, or a discard — without
  // this, saving a restored orphan before its first flush would leave the dead
  // item's old draft behind to re-offer stale content on the next boot.
  const takeSuperseded = (): string | null => {
    const old = supersedesRef.current;
    supersedesRef.current = null;
    return old;
  };

  return {
    flushNow,
    discard: async () => {
      queue.close();
      if (disabled) return;
      const old = takeSuperseded();
      if (old) void queue.delete(old);
      await queue.delete(draftId);
    },
    clearAfterSave: () => {
      if (disabled) return;
      // Suppress the tick window between save-success and the dirty=false
      // re-render: unflushed pre-save edits could otherwise enqueue a save
      // AFTER the delete below and resurrect the just-cleared draft. (Any
      // post-save edit bumps lastEditRef past this and flushes normally.)
      lastFlushRef.current = Date.now();
      const old = takeSuperseded();
      if (old) void queue.delete(old);
      void queue.delete(draftId);
    },
  };
}
