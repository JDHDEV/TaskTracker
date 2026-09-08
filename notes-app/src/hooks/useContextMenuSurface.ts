// Plan.16 D4: ONE document-level focus tracker that tells Rust which kind of
// field has keyboard focus, so the native context-menu hook
// (src-tauri/src/context_menu.rs) knows whether to append the app's items.
// Used once, in App.tsx. Publishing on focus changes — not on the
// `contextmenu` event — is deliberate: a focus change precedes a right-click
// by far more than an IPC round-trip, whereas a publish on `contextmenu`
// would race WebView2's ContextMenuRequested.

import { useEffect } from "react";
import * as api from "../lib/api";
import { surfaceOf, type MenuSurface } from "../lib/contextMenu";

export function useContextMenuSurface(): void {
  useEffect(() => {
    // Only changes are published, so focus wandering between non-surface
    // elements costs no IPC. The initial "none" IS published (one IPC per
    // mount) so Rust never keeps a stale value from a previous document —
    // after a dev reload the hook restarts at "none" while Rust would still
    // hold the last surface (security review, plan.16 §12).
    let last: MenuSurface = "none";
    // Fail-soft: a rejected publish only means the menu shows no app items
    // until the next focus change — never worth a toast.
    void api.setContextMenuSurface(last).catch(() => {});
    function publish(target: EventTarget | null) {
      const next = surfaceOf(target instanceof HTMLElement ? target : null);
      if (next === last) return;
      last = next;
      void api.setContextMenuSurface(next).catch(() => {});
    }
    const onFocusIn = (e: FocusEvent) => publish(e.target);
    // On focusout, relatedTarget is the element GAINING focus (null when focus
    // leaves the document entirely); its own focusin follows and dedupes.
    const onFocusOut = (e: FocusEvent) => publish(e.relatedTarget);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}
