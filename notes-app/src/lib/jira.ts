// Pure JIRA-link helpers. Both are DOM-free and unit-tested.

/**
 * True only for a parseable http/https URL with a non-empty host. Used by
 * `openExternal` before it ever hands a URL to the OS opener.
 *
 * The protocol allow-list is the load-bearing control — it rejects the real
 * risk (`javascript:`/`file:`/`data:`). The host check is defense-in-depth:
 * for the special schemes we allow, WHATWG `URL` never yields an empty host
 * (an empty authority either throws, e.g. `https://`, or absorbs the next path
 * segment, e.g. `https:///browse/PLAT-1` → host `browse`), so this branch does
 * not itself reject any parsed http(s) URL. It is kept to satisfy the stated
 * guard contract and to stay robust if the webview's URL parser differs.
 */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

// Anchored, linear pattern — no nested/adjacent unbounded quantifiers, bounded
// to the (short) last path segment, so a pathological URL cannot drive
// quadratic matching (plan §4 ReDoS note).
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Label for the JIRA chip: the uppercased ticket key from the URL's last path
 * segment plus " ↗" (e.g. `PLAT-142 ↗`), or `Open ticket ↗` when the URL has
 * no key-shaped last segment or doesn't parse.
 */
export function ticketLabel(url: string): string {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    if (TICKET_KEY.test(last)) return `${last.toUpperCase()} ↗`;
  } catch {
    // fall through to the generic label
  }
  return "Open ticket ↗";
}
