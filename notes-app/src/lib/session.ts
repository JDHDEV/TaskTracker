// F4 (plan.14 D10): session restore — WHAT was open, never content. The blob
// holds identifiers only: the visible page, open tab keys + the active key per
// page, and the worknotes filters. Deliberately NOT persisted (S-4): body or
// title text, drafts (no persistable identity), dirty flags, the search text,
// and `ProjectInfo.path` — WebView2 localStorage is unencrypted, lives outside
// any project directory, and is not swept by `Delete files`, so content here
// would outlive the project it came from.
//
// Reading is corruption-proof (S-5), following the palettes.ts whitelist-
// fallback pattern applied to a structure: the blob is versioned (`v: 1`;
// unknown versions are discarded whole), every field is independently
// validated with a deterministic fallback, tab lists are string-only, deduped,
// and capped, and any parse/storage failure yields `null` — the caller then
// boots to defaults. Restored ids are additionally re-validated against the
// backend (api.getItem/getPrompt/getScratch) by the restore wiring before they
// enter state; a garbage enum can never reach `ListFilter` over IPC.

const KEY = "session";

/** Hard cap per tab list — a hand-grown blob can't fan out unbounded fetches. */
export const MAX_SESSION_TABS = 20;

/** Cap on the restored tag-filter list — same magnitude as the tab cap but a
 *  distinct concept (tags are re-validated against the live vocabulary too). */
const MAX_SESSION_TAGS = 20;

const PAGES = ["worknotes", "prompts", "scratch"] as const;
const KINDS = ["all", "note", "task"] as const;
const STATUSES = ["all", "todo", "doing", "testing", "done"] as const;
const SORTS = ["updated", "created", "priority", "status"] as const;

export type SessionPage = (typeof PAGES)[number];

export interface SessionFilters {
  kind: (typeof KINDS)[number];
  statusFilter: (typeof STATUSES)[number];
  sort: (typeof SORTS)[number];
  /** Validated against the LOADED projects at restore time, not here. */
  projectFilter: string;
  /** Validated against the live tag vocabulary at restore time. */
  tags: string[];
}

export interface WorknotesSlice {
  tabKeys: string[];
  activeKey: string | null;
  filters: SessionFilters;
}

export interface PromptsSlice {
  tabKeys: string[];
  activeKey: string | null;
  projectId: string;
  reusableOnly: boolean;
}

export interface ScratchSlice {
  projectIds: string[];
  activeProjectId: string | null;
}

export interface Session {
  v: 1;
  page: SessionPage;
  worknotes: WorknotesSlice;
  prompts: PromptsSlice;
  scratch: ScratchSlice;
}

/** The boot-to-defaults session — also the merge base for the first write. */
export function emptySession(): Session {
  return {
    v: 1,
    page: "worknotes",
    worknotes: {
      tabKeys: [],
      activeKey: null,
      filters: { kind: "all", statusFilter: "all", sort: "updated", projectFilter: "", tags: [] },
    },
    prompts: { tabKeys: [], activeKey: null, projectId: "", reusableOnly: false },
    scratch: { projectIds: [], activeProjectId: null },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

/** Strings only, deduped, capped — anything else silently dropped. */
function stringList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string" && entry && !out.includes(entry)) {
      out.push(entry);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** An active key must name a member of its own tab list, else null. */
function keyIn(v: unknown, keys: string[]): string | null {
  return typeof v === "string" && keys.includes(v) ? v : null;
}

function plainString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readFilters(v: unknown): SessionFilters {
  const r = isRecord(v) ? v : {};
  return {
    kind: oneOf(r.kind, KINDS, "all"),
    statusFilter: oneOf(r.statusFilter, STATUSES, "all"),
    sort: oneOf(r.sort, SORTS, "updated"),
    projectFilter: plainString(r.projectFilter),
    tags: stringList(r.tags, MAX_SESSION_TAGS),
  };
}

function readWorknotes(v: unknown): WorknotesSlice {
  const r = isRecord(v) ? v : {};
  const tabKeys = stringList(r.tabKeys, MAX_SESSION_TABS);
  return { tabKeys, activeKey: keyIn(r.activeKey, tabKeys), filters: readFilters(r.filters) };
}

function readPrompts(v: unknown): PromptsSlice {
  const r = isRecord(v) ? v : {};
  const tabKeys = stringList(r.tabKeys, MAX_SESSION_TABS);
  return {
    tabKeys,
    activeKey: keyIn(r.activeKey, tabKeys),
    projectId: plainString(r.projectId),
    reusableOnly: r.reusableOnly === true,
  };
}

function readScratch(v: unknown): ScratchSlice {
  const r = isRecord(v) ? v : {};
  const projectIds = stringList(r.projectIds, MAX_SESSION_TABS);
  return {
    projectIds,
    activeProjectId: keyIn(r.activeProjectId, projectIds),
  };
}

/** The stored session, fully validated/normalized — or `null` for anything
 *  unreadable, unparseable, or of an unknown version (boot to defaults). */
export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1) return null;
    return {
      v: 1,
      page: oneOf(parsed.page, PAGES, "worknotes"),
      worknotes: readWorknotes(parsed.worknotes),
      prompts: readPrompts(parsed.prompts),
      scratch: readScratch(parsed.scratch),
    };
  } catch {
    return null;
  }
}

/** Merge `patch` onto the stored session (or the defaults) and persist. Each
 *  page writes only its own slice, so three debounced writers can't clobber
 *  each other. Best-effort: storage failures (quota, unavailable) are
 *  swallowed — session persistence must never break the app (S-5). */
export function writeSession(patch: Partial<Omit<Session, "v">>): void {
  try {
    const base = readSession() ?? emptySession();
    const next: Session = { ...base, ...patch, v: 1 };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // QuotaExceededError / storage disabled — silently skip.
  }
}

/** The item/prompt id inside a persisted tab key (`<projectId>:<id>` or
 *  `prompt-<projectId>:<id>`): the part after the first ":". Null for a key
 *  with no ":" or an empty id (draft keys, garbage) — never fetch on those. */
export function tabKeyId(key: string): string | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const id = key.slice(i + 1);
  return id ? id : null;
}
