// Pure allowlists for the native context-menu integration (Plan 16). The menu
// itself is WebView2's own, augmented from Rust (src-tauri/src/context_menu.rs);
// this module owns the frontend half of the contract: the action ids Rust
// emits, the surface names the frontend publishes, and the mapping to the
// existing "Send selection to…" destinations. No React, no IPC.
//
// Static ids — never user text. Both parsers reject anything outside their
// literal allowlist (§4 MUST 1/3, SHOULD 10/11).

/** Where a scratch-pad selection is sent (moved here from SelectionMenu.tsx). */
export type SendDestination = "note" | "task" | "prompt";

/** The static action ids Rust emits on the `context-menu-action` event. */
export type ContextMenuAction = "insert-timestamp" | "send-note" | "send-task" | "send-prompt";

/** Which kind of field has focus, as published to Rust: a body textarea on an
 *  item/prompt editor, the scratch pad, or anything else. */
export type MenuSurface = "none" | "body" | "scratch";

const ACTIONS: readonly ContextMenuAction[] = [
  "insert-timestamp",
  "send-note",
  "send-task",
  "send-prompt",
];

/** Validate an event payload: exactly one of the four ids, else `null`. */
export function parseContextMenuAction(payload: unknown): ContextMenuAction | null {
  return (ACTIONS as readonly unknown[]).includes(payload) ? (payload as ContextMenuAction) : null;
}

/** The send-to destination an action targets; `null` for non-send actions. */
export function sendDestinationOf(action: ContextMenuAction): SendDestination | null {
  switch (action) {
    case "send-note":
      return "note";
    case "send-task":
      return "task";
    case "send-prompt":
      return "prompt";
    default:
      return null;
  }
}

/**
 * The surface of a (possibly) focused element, read from the app-rendered
 * `data-menu-surface` attribute. Structural parameter so it is node-testable;
 * anything but the two known values — including a missing dataset or a null
 * element — is `"none"`.
 */
export function surfaceOf(el: { dataset?: { menuSurface?: string } } | null): MenuSurface {
  const v = el?.dataset?.menuSurface;
  return v === "body" || v === "scratch" ? v : "none";
}
