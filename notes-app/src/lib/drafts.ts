// Draft backups (plan.15): the PURE half of the capture/restore machinery —
// snapshot shapes, buffer==base tests, restore classification, and the flush
// schedule — all IPC-free and vitest-covered. The timing hook that consumes
// this lives in src/hooks/useDraftBackup.ts; the IPC wrappers in src/lib/api.ts.
//
// NOT to be confused with src/lib/draft.ts (singular), which is the older
// "blank new-item template" concern (newDraft/duplicateDraft). This module is
// the unsaved-buffer snapshot/recovery concern; the two are deliberately
// separate files.

import type { Draft, DraftSurface, Item, Kind, Priority, Status } from "../types";
import { toDateInputValue } from "./dueDate";

/** Snapshot when the buffer has been idle this long (D6: a periodic tick, not
 *  a trailing debounce — a keystroke-reset debounce starves during continuous
 *  typing, the exact case crash recovery exists for). */
export const DRAFT_IDLE_MS = 1000;

/** ...but never wait longer than this between snapshots while edits continue. */
export const DRAFT_MAX_WAIT_MS = 5000;

/** What boot restore should do with one draft record (the five D5 branches):
 *  - "skip": owning project not loaded — keep the file, restore nothing.
 *  - "clean": buffer == saved content — delete the draft, open clean (self-
 *    heals a crash between save and draft-delete, and type-then-revert).
 *  - "restore": seed the buffer, open the tab dirty (primary path; also every
 *    never-saved draft, which has no base to conflict with).
 *  - "conflict": the entity changed underneath (baseUpdatedAt mismatch) — open
 *    CLEAN on disk content, keep the draft, show the two-button bar (D4).
 *  - "orphan": the owning entity is gone — reopen as a new draft tab (D5). */
export type RestoreOutcome = "skip" | "clean" | "restore" | "conflict" | "orphan";

/** The buffered fields of one item editor, exactly as the editor holds them
 *  (dueAt is the yyyy-mm-dd input string, not the wire value). */
export interface ItemBuffer {
  title: string;
  body: string;
  status: Status | null;
  priority: Priority | null;
  dueAt: string;
  tags: string[];
  projectId: string;
  jiraUrl: string;
}

const DRAFT_KEY_PREFIX = "draft-";
const PROMPT_DRAFT_KEY_PREFIX = "prompt-draft-";

/** An 8-4-4-4-12 hex UUID — the frontend mirror of the backend's `is_uuid`
 *  gate (D8): draft filenames derive ONLY from ids that pass this, and writes
 *  are fire-and-forget, so a prefixed tab key slipping through as a draftId
 *  would fail silently server-side. */
export function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

/** The items-page tab key for a never-saved draft: `draft-<uuid>`. The BARE
 *  uuid is the on-disk draftId; only tab keys carry the prefix (so session.ts
 *  tabKeyId keeps skipping draft keys — they have no ":"). */
export function draftTabKey(draftId: string): string {
  return `${DRAFT_KEY_PREFIX}${draftId}`;
}

/** The prompts-page equivalent: `prompt-draft-<uuid>`. */
export function promptDraftTabKey(draftId: string): string {
  return `${PROMPT_DRAFT_KEY_PREFIX}${draftId}`;
}

/** The bare draftId inside a `draft-<uuid>` / `prompt-draft-<uuid>` tab key,
 *  or null for anything else (saved-item keys, garbage, a non-UUID remainder).
 *  The longer prefix is tried first — `prompt-draft-…` must never be read as a
 *  `draft-…` key with a garbage remainder. */
export function draftIdFromTabKey(key: string): string | null {
  const bare = key.startsWith(PROMPT_DRAFT_KEY_PREFIX)
    ? key.slice(PROMPT_DRAFT_KEY_PREFIX.length)
    : key.startsWith(DRAFT_KEY_PREFIX)
      ? key.slice(DRAFT_KEY_PREFIX.length)
      : null;
  return bare !== null && isUuid(bare) ? bare : null;
}

/** The flush schedule (D6), with an injectable clock: flush when there are
 *  edits newer than the last flush AND (the buffer has been idle ≥
 *  DRAFT_IDLE_MS, OR the last flush is ≥ DRAFT_MAX_WAIT_MS old — the max-wait
 *  keeps continuous typing flushing). Never fires with nothing new to write. */
export function shouldFlush(lastEditAt: number, lastFlushAt: number, now: number): boolean {
  if (lastEditAt <= lastFlushAt) return false;
  return now - lastEditAt >= DRAFT_IDLE_MS || now - lastFlushAt >= DRAFT_MAX_WAIT_MS;
}

/** The base-content fingerprint an item/prompt draft records alongside
 *  baseUpdatedAt (post-review F13): a hand-edited file changes content WITHOUT
 *  bumping its updated_at frontmatter (Notepad doesn't know to), so the
 *  timestamp alone is blind to it — the hash of the base title+body closes
 *  that gap at restore time. */
function baseContentHash(title: string, body: string): string {
  return contentHash(`${title}\n${body}`);
}

/** Assemble an item-surface Draft from an editor buffer. `base` is the tab's
 *  item (the saved item, or the draft template for a never-saved draft — its
 *  id "" and updatedAt "" flow through as entityId/baseUpdatedAt, with no
 *  content fingerprint). `v` and `savedAt` are backend-owned; placeholders
 *  here. */
export function buildItemDraft(
  draftId: string,
  base: Pick<Item, "id" | "kind" | "updatedAt" | "title" | "body">,
  buffer: ItemBuffer,
): Draft {
  return {
    v: 1,
    draftId,
    surface: "item",
    projectId: buffer.projectId,
    entityId: base.id,
    kind: base.kind,
    baseUpdatedAt: base.updatedAt,
    baseHash: base.id ? baseContentHash(base.title, base.body) : "",
    savedAt: "",
    title: buffer.title,
    status: buffer.status,
    priority: buffer.priority,
    dueAt: buffer.dueAt,
    tags: [...buffer.tags],
    jiraUrl: buffer.jiraUrl,
    body: buffer.body,
  };
}

/** Assemble a prompt-surface Draft (prompts buffer title+body only). */
export function buildPromptDraft(
  draftId: string,
  base: { id: string; updatedAt: string; title: string; body: string },
  buffer: { title: string; body: string; projectId: string },
): Draft {
  return {
    v: 1,
    draftId,
    surface: "prompt",
    projectId: buffer.projectId,
    entityId: base.id,
    kind: null,
    baseUpdatedAt: base.updatedAt,
    baseHash: base.id ? baseContentHash(base.title, base.body) : "",
    savedAt: "",
    title: buffer.title,
    status: null,
    priority: null,
    dueAt: "",
    tags: [],
    jiraUrl: "",
    body: buffer.body,
  };
}

/** Assemble a scratch-surface Draft: draftId = the project's UUID (one pad per
 *  project), conflict-keyed by baseHash (scratch has no updatedAt). */
export function buildScratchDraft(projectId: string, baseHash: string, body: string): Draft {
  return {
    v: 1,
    draftId: projectId,
    surface: "scratch",
    projectId,
    entityId: "",
    kind: null,
    baseUpdatedAt: "",
    baseHash,
    savedAt: "",
    title: "",
    status: null,
    priority: null,
    dueAt: "",
    tags: [],
    jiraUrl: "",
    body,
  };
}

function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** Field-by-field buffer == base test for an item editor (D6: skip the write
 *  when equal — and delete any existing draft). Kind-gated like everything
 *  else: a note ignores status/priority/dueAt; a task compares them with the
 *  editor's own seeding defaults (status "todo", priority "normal", dueAt via
 *  toDateInputValue). */
export function bufferEqualsItem(buffer: ItemBuffer, item: Item): boolean {
  if (buffer.title !== item.title) return false;
  if (buffer.body !== item.body) return false;
  if (!tagsEqual(buffer.tags, item.tags)) return false;
  if (buffer.jiraUrl !== (item.jiraUrl ?? "")) return false;
  if (buffer.projectId !== (item.projectId ?? "")) return false;
  if (item.kind === "task") {
    if ((buffer.status ?? "todo") !== (item.status ?? "todo")) return false;
    if ((buffer.priority ?? "normal") !== (item.priority ?? "normal")) return false;
    if (buffer.dueAt !== toDateInputValue(item.dueAt)) return false;
  }
  return true;
}

/** The item-buffer projection of a draft record — the same shape the editor
 *  captured, for re-running bufferEqualsItem at restore time. */
function itemBufferOf(draft: Draft): ItemBuffer {
  return {
    title: draft.title,
    body: draft.body,
    status: draft.status,
    priority: draft.priority,
    dueAt: draft.dueAt,
    tags: draft.tags,
    projectId: draft.projectId,
    jiraUrl: draft.jiraUrl,
  };
}

/** Classify one item-surface draft for restore (the D5 matrix; see
 *  RestoreOutcome). `item` is the api.getItem result for draft.entityId (null
 *  = gone/unreachable); `projectLoaded` is whether draft.projectId names a
 *  loaded project ("" counts as loaded — project-less drafts always restore).
 *  An item found in a DIFFERENT project than the draft's is refused as an
 *  orphan (§4.5: never bind a draft across projects). */
export function classifyRestore(draft: Draft, item: Item | null, projectLoaded: boolean): RestoreOutcome {
  if (draft.projectId && !projectLoaded) return "skip";
  if (!draft.entityId) return "restore"; // never-saved: no base to compare against
  if (!item) return "orphan";
  if (draft.projectId !== (item.projectId ?? "")) return "orphan";
  if (bufferEqualsItem(itemBufferOf(draft), item)) return "clean";
  if (draft.baseUpdatedAt !== item.updatedAt) return "conflict";
  // F13: a matching timestamp is not proof the content is unchanged — a
  // hand-edited file keeps its updated_at. The base-content fingerprint
  // catches that; a record without one (baseHash "") degrades to the
  // timestamp-only rule rather than misclassifying.
  if (draft.baseHash && draft.baseHash !== baseContentHash(item.title, item.body)) {
    return "conflict";
  }
  return "restore";
}

/** The prompt-surface equivalent (prompts compare title+body, keyed on the
 *  prompt's derived updatedAt). */
export function classifyPromptRestore(
  draft: Draft,
  prompt: { id: string; title: string; body: string; updatedAt: string; projectId: string | null } | null,
  projectLoaded: boolean,
): RestoreOutcome {
  if (draft.projectId && !projectLoaded) return "skip";
  if (!draft.entityId) return "restore";
  if (!prompt) return "orphan";
  if (draft.projectId !== (prompt.projectId ?? "")) return "orphan";
  if (draft.title === prompt.title && draft.body === prompt.body) return "clean";
  if (draft.baseUpdatedAt !== prompt.updatedAt) return "conflict";
  // F13 — see classifyRestore: the fingerprint catches hand-edits that never
  // bumped the derived updatedAt.
  if (draft.baseHash && draft.baseHash !== baseContentHash(prompt.title, prompt.body)) {
    return "conflict";
  }
  return "restore";
}

/** The scratch-surface equivalent: `currentBody` is the live getScratch result
 *  (null = unreadable → "skip", never restore over a pad we couldn't read).
 *  Equal body → "clean"; baseHash matches the current content → "restore";
 *  otherwise "conflict". Scratch has no orphan case (a missing file is an
 *  empty pad, not a dead entity). */
export function classifyScratchRestore(
  draft: Draft,
  currentBody: string | null,
  projectLoaded: boolean,
): RestoreOutcome {
  if (draft.projectId && !projectLoaded) return "skip";
  if (currentBody === null) return "skip";
  if (draft.body === currentBody) return "clean";
  if (draft.baseHash === contentHash(currentBody)) return "restore";
  return "conflict";
}

function fnv1a(text: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cheap content fingerprint for the scratch conflict test: length + two
 *  independent 32-bit FNV-1a passes, hex. NOT cryptographic — it only gates a
 *  UI affordance (the conflict bar), and the failure mode of a collision is a
 *  missed warning, never data loss (the draft file is kept either way). */
export function contentHash(text: string): string {
  return `${text.length.toString(16)}-${fnv1a(text, 0x811c9dc5).toString(16)}-${fnv1a(text, 0x01234567).toString(16)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function plainString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Strings only, deduped — anything else silently dropped (session.ts rule). */
function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string" && entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

const SURFACES = ["item", "prompt", "scratch"] as const;
const KINDS = ["note", "task"] as const;
const STATUSES = ["todo", "doing", "testing", "done"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;

/** Whitelist-validate one record from api.listDrafts before it drives restore
 *  (session.ts discipline applied to drafts): unknown version, non-UUID
 *  draftId, unknown surface, or non-string title/body ⇒ discard the record
 *  (null); enum-ish fields fall back (kind/status/priority → null), plain
 *  string fields default to "", tags to a deduped string list. */
export function sanitizeDraft(v: unknown): Draft | null {
  if (!isRecord(v)) return null;
  if (v.v !== 1) return null;
  if (typeof v.draftId !== "string" || !isUuid(v.draftId)) return null;
  const surface = oneOfOrNull(v.surface, SURFACES);
  if (surface === null) return null;
  // Title and body are the irreplaceable content — a record that lost them is
  // not worth "restoring" as empty text; discard it whole.
  if (typeof v.title !== "string" || typeof v.body !== "string") return null;
  return {
    v: 1,
    draftId: v.draftId,
    surface: surface as DraftSurface,
    projectId: plainString(v.projectId),
    entityId: plainString(v.entityId),
    kind: oneOfOrNull<Kind>(v.kind, KINDS),
    baseUpdatedAt: plainString(v.baseUpdatedAt),
    baseHash: plainString(v.baseHash),
    savedAt: plainString(v.savedAt),
    title: v.title,
    status: oneOfOrNull<Status>(v.status, STATUSES),
    priority: oneOfOrNull<Priority>(v.priority, PRIORITIES),
    dueAt: plainString(v.dueAt),
    tags: stringList(v.tags),
    jiraUrl: plainString(v.jiraUrl),
    body: v.body,
  };
}

/** Serialized draft IPC for one editor: saves and deletes run strictly in
 *  enqueue order, so a delete enqueued after a flush can never lose to it
 *  (§8: "a snapshot must never land after the delete and resurrect").
 *  `close()` makes queued-but-not-started SAVES no-ops (a closing editor must
 *  never resurrect its draft) while DELETES still run (always safe). Ops are
 *  injected so vitest can drive the ordering with fakes; failures resolve
 *  false and never break the chain. */
export class DraftQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly saveOp: (draft: Draft) => Promise<void>,
    private readonly deleteOp: (draftId: string) => Promise<void>,
  ) {}

  /** Enqueue a snapshot write. Resolves true only if the write ran and succeeded. */
  save(draft: Draft): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed) return false;
      try {
        await this.saveOp(draft);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Enqueue a draft delete (runs even after close). Resolves true on success. */
  delete(draftId: string): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await this.deleteOp(draftId);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Stop future saves (deletes still pass). Idempotent. */
  close(): void {
    this.closed = true;
  }

  /** Resolves when everything enqueued so far has settled. */
  settle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    // `op` never rejects (both callers swallow), so the chain never breaks.
    const next = this.chain.then(op);
    this.chain = next;
    return next;
  }
}

// --- Flush registry (Phase 6 flush-on-close) ---------------------------------
// Every mounted editor's flushDraft registers here (keyed by draftId) so the
// window-close handler can flush ALL dirty buffers — item, prompt, and scratch
// editors live in different component trees and are otherwise unreachable from
// one listener. Module-level by design: one window, one registry.

const flushables = new Map<string, () => Promise<void>>();

/** Register (or replace) a flushable for `key`. */
export function registerFlushable(key: string, flush: () => Promise<void>): void {
  flushables.set(key, flush);
}

/** Remove `key` (unmount). Unknown key is a no-op. */
export function unregisterFlushable(key: string): void {
  flushables.delete(key);
}

/** Flush every registered editor, settling even if some fail (a failed backup
 *  must never block the window from closing — Rust times out regardless). */
export async function flushAllDrafts(): Promise<void> {
  await Promise.all(
    Array.from(flushables.values(), (flush) =>
      flush().catch(() => {
        /* a failed backup never blocks the close */
      }),
    ),
  );
}
