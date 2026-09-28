// Plan 18 (D10, R-6/R-7): the keyboard + mouse path for Back/Forward over one
// tab strip. Alt+ArrowLeft / Alt+ArrowRight and the mouse back/forward buttons
// (buttons 3/4) call the owner's navigate callbacks. One hook per tab owner;
// it NAVIGATES only while `enabled` — that owner's page is the visible one AND
// it has tabs — but it SWALLOWS the chord and the buttons unconditionally, so
// the webview's own Back/Forward never sees them even on an empty strip or a
// held key (R-7). All three page bodies stay mounted, so the `enabled` gate is
// what keeps a hidden strip's history from moving (the same `active` /
// `pageActive` discipline as the Ctrl+S listeners).
//
// The history is in memory only: nothing calls pushState, so the webview's
// own Back is a no-op today; `preventDefault()` on the keydown and on both
// mousedown/mouseup of buttons 3/4 keeps it that way (Chromium navigates on
// the mouseup). No navigation on auto-repeat, mid-IME-composition, while a
// modal dialog (`[aria-modal="true"]`) is open, or when something OTHER than a
// sibling hook already handled the event (D10). Callbacks are read through a
// ref so the listeners, registered once, never go stale.

import { useEffect, useRef } from "react";
import { navFromKey, navFromMouse, type NavDirection } from "../lib/navHistory";

interface Options {
  enabled: boolean;
  onBack: () => void;
  onForward: () => void;
}

// Events one of the three sibling hooks has already prevented. A later sibling
// must not read that `defaultPrevented` as "someone else handled it" — only a
// foreign handler's preventDefault suppresses navigation.
const swallowed = new WeakSet<Event>();

function swallow(e: Event): boolean {
  const foreign = e.defaultPrevented && !swallowed.has(e);
  e.preventDefault();
  swallowed.add(e);
  return foreign;
}

export function useBackForwardKeys({ enabled, onBack, onForward }: Options): void {
  const state = useRef({ enabled, onBack, onForward });
  state.current = { enabled, onBack, onForward };

  useEffect(() => {
    function fire(dir: NavDirection) {
      const s = state.current;
      if (!s.enabled) return;
      // No navigation while any in-app modal is up (R-8); the native confirm
      // dialogs block the webview's input entirely, so they need no check.
      if (document.querySelector('[aria-modal="true"]')) return;
      (dir === "back" ? s.onBack : s.onForward)();
    }
    function onKeyDown(e: KeyboardEvent) {
      // The chord regardless of repeat/composition — swallowed either way.
      const chord = navFromKey({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      });
      if (!chord) return;
      const foreign = swallow(e);
      if (foreign || e.repeat || e.isComposing) return;
      fire(chord);
    }
    function onMouseDown(e: MouseEvent) {
      if (navFromMouse(e)) swallow(e);
    }
    function onMouseUp(e: MouseEvent) {
      const dir = navFromMouse(e);
      if (!dir) return;
      // `swallow` reads THIS mouseup's defaultPrevented (the paired mousedown
      // is a different Event object) before preventing it.
      if (swallow(e)) return;
      fire(dir);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}
