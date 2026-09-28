import { memo, useEffect, useRef, type KeyboardEvent } from "react";
import { tabDomId, tabPanelDomId } from "../lib/openTabs";
import { wheelToScrollLeft } from "../lib/tabWheel";

/** One tab's presentation data. `title` is user-controlled text and is rendered
 *  as a JSX child (never via an HTML attribute or dangerouslySetInnerHTML).
 *  `dotClass` is a controlled status-dot class the parent builds from a fixed
 *  enum (e.g. "dot dot-doing") — omitted for notes and prompts. */
export interface EditorTabDescriptor {
  key: string;
  title: string;
  pinned?: boolean;
  dotClass?: string;
  dotTitle?: string;
  dirty: boolean;
  /** Plan 19: a never-saved entity (id "") — never eligible for `Close
   *  saved`, whatever `dirty` says, so the button's predicate matches
   *  `planCloseSaved` (closeAll.ts) exactly. */
  isDraft: boolean;
}

interface Props {
  tabs: EditorTabDescriptor[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Open a new draft tab. Optional: the scratch strip has no "new" (one pad per
   *  project), so it omits this and the `+` button is not rendered. */
  onNew?: () => void;
  /** aria-label for the tablist (e.g. "Open items" / "Open prompts"). */
  listLabel: string;
  /** aria-label for the "+" new-tab button (with `onNew`). */
  newLabel?: string;
  /** Plan 18 Back/Forward over previously viewed tabs (both or neither). The
   *  owner keeps the history (openTabs.ts) and passes whether each direction
   *  is available; at an end the button is `aria-disabled` and a no-op — never
   *  `disabled`, so a repeated press never drops focus to <body>. */
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  /** Plan 18 "Close all" for this strip (D1). Optional like `onNew`; the
   *  owner runs the consent flow (closeAll.ts). */
  onCloseAll?: () => void;
  /** Accessible name for the Close all button (e.g. "Close all open items"). */
  closeAllLabel?: string;
  /** Plan 19 "Close saved" for this strip (D4/D7). Optional like `onCloseAll`;
   *  the owner runs the one-confirm flow (closeAll.ts `runCloseSaved`). The
   *  button is `aria-disabled` + a no-op while no tab is saved. */
  onCloseSaved?: () => void;
  /** Accessible name for the Close saved button (e.g. "Close saved open items"). */
  closeSavedLabel?: string;
}

// The tab is a `<div role="tab">`, not a `<button>`, so the close control can be
// a REAL sibling `<button>` inside it — a <button> nested in a <button> (the
// mock's `role="button"` span) is invalid and unreachable by keyboard. Roving
// tabindex + arrow/Home/End navigation mirror App's page-tabs; Delete/Backspace
// closes the focused tab, and focus follows the neighbor that takes over.
//
// Plan 18: the tablist is wrapped in `.editor-tabs-bar`, which carries the
// hairline/background and the strip's controls — ‹ › before the scroller, `+`,
// `Close saved` (plan 19) and `Close all` after it. Controls sit OUTSIDE
// `role="tablist"` (only tabs belong in one), so they keep their own focus
// after a partial close: the focus-after-close effect keys on `.editor-tabs`
// membership.
function EditorTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onNew,
  listLabel,
  newLabel,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
  onCloseAll,
  closeAllLabel,
  onCloseSaved,
  closeSavedLabel,
}: Props) {
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  // Keys from the previous render, so we can move focus to the tab that took over
  // after a close — but ONLY when a close ACTUALLY happened (a key disappeared)
  // AND focus was orphaned to <body> (the closed tab/its × had focus and is now
  // detached) or is still inside the strip. Keying this on a real removal — not a
  // pre-set flag — means a cancelled dirty-close, a plain activation, or a
  // rail-driven open never spuriously steals focus. The last-tab-closed case
  // (activeKey === null) is left to the parent (it focuses the empty placeholder).
  const prevKeys = useRef<string[]>([]);
  useEffect(() => {
    const keys = tabs.map((t) => t.key);
    const closed = prevKeys.current.some((k) => !keys.includes(k));
    prevKeys.current = keys;
    if (!closed || !activeKey) return;
    const ae = document.activeElement;
    const orphaned = ae === null || ae === document.body;
    const withinStrip = ae instanceof HTMLElement && !!ae.closest(".editor-tabs");
    if (orphaned || withinStrip) tabEls.current.get(activeKey)?.focus();
  }, [tabs, activeKey]);

  // Plan 18: keep the active tab in view however it was activated — rail
  // click, Back/Forward, neighbour take-over (before, only the arrow keys
  // scrolled). `nearest` on both axes never scrolls a tab that is already
  // visible and never scrolls the page vertically.
  useEffect(() => {
    if (!activeKey) return;
    tabEls.current.get(activeKey)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeKey]);

  // Plan 19 (D9, R-11): the vertical wheel scrolls the tablist sideways. A
  // NATIVE non-passive listener on the scroller ref — React registers `wheel`
  // as a passive root listener (facebook/react#19651), so a React `onWheel`
  // could never preventDefault. Only vertical-dominant deltas are mapped:
  // Shift+wheel and trackpad swipes already arrive as `deltaX` in Chromium
  // and scroll the strip natively. `null` from the helper means "not ours"
  // (no overflow, Ctrl+wheel, already at that edge …) and default is NOT
  // prevented, so the event chains to an ancestor as usual. Assigned directly
  // (no smooth scrollBy: quick notches would stack animations). The tablist
  // is always rendered while EditorTabs is mounted, so `[]` is sufficient.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      const next = wheelToScrollLeft(e, el);
      if (next === null) return;
      e.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function focusTab(key: string) {
    const el = tabEls.current.get(key);
    el?.focus();
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>, key: string) {
    // R-6: Alt+Left/Right is the Back/Forward chord (useBackForwardKeys) and
    // Ctrl/Meta combos belong to the app — never also walk the tabs.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const i = tabs.findIndex((t) => t.key === key);
    if (i === -1) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = e.key === "ArrowLeft" ? i - 1 : i + 1;
      const target = tabs[(next + tabs.length) % tabs.length];
      onActivate(target.key);
      focusTab(target.key);
    } else if (e.key === "Home") {
      e.preventDefault();
      onActivate(tabs[0].key);
      focusTab(tabs[0].key);
    } else if (e.key === "End") {
      e.preventDefault();
      onActivate(tabs[tabs.length - 1].key);
      focusTab(tabs[tabs.length - 1].key);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClose(key);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(key);
    }
  }

  const showNav = onBack !== undefined || onForward !== undefined;
  // Plan 19 (R-2/R-5): the same eligibility test as planCloseSaved, so the
  // button can never look enabled while the sequencer would find nothing.
  const hasSaved = tabs.some((t) => !t.dirty && !t.isDraft);

  return (
    <div className="editor-tabs-bar">
      {showNav && (
        <>
          <button
            className="etab-nav"
            aria-label="Back"
            title="Back (Alt+Left)"
            aria-keyshortcuts="Alt+ArrowLeft"
            aria-disabled={!canBack}
            onClick={() => {
              if (canBack) onBack?.();
            }}
          >
            ‹
          </button>
          <button
            className="etab-nav"
            aria-label="Forward"
            title="Forward (Alt+Right)"
            aria-keyshortcuts="Alt+ArrowRight"
            aria-disabled={!canForward}
            onClick={() => {
              if (canForward) onForward?.();
            }}
          >
            ›
          </button>
        </>
      )}
      <div className="editor-tabs" role="tablist" aria-label={listLabel} ref={listRef}>
        {tabs.map((t) => {
          const on = t.key === activeKey;
          return (
            <div
              key={t.key}
              ref={(el) => {
                if (el) tabEls.current.set(t.key, el);
                else tabEls.current.delete(t.key);
              }}
              className={on ? "etab etab-on" : "etab"}
              role="tab"
              id={tabDomId(t.key)}
              // Explicit accessible name = the title, so the tab isn't announced
              // from its subtree (which would fold in the close button's "Close …"
              // label and the pin/dot/unsaved title= attributes). Because this
              // overrides the subtree, the unsaved state must be spelled into it
              // (plan 17): the dot alone was never heard.
              aria-label={t.dirty ? `${t.title}, unsaved changes` : t.title}
              aria-selected={on}
              aria-controls={tabPanelDomId(t.key)}
              tabIndex={on ? 0 : -1}
              onClick={() => onActivate(t.key)}
              onKeyDown={(e) => onTabKeyDown(e, t.key)}
            >
              {t.pinned && <span className="pin" title="Pinned" />}
              {t.dotClass && <span className={t.dotClass} title={t.dotTitle} />}
              <span className="etab-title">{t.title}</span>
              {t.dirty && <span className="etab-unsaved" title="Unsaved changes" />}
              <button
                className="etab-x"
                aria-label={`Close ${t.title}`}
                tabIndex={on ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.key);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {onNew && (
        <button className="etab-new" aria-label={newLabel} onClick={onNew}>
          +
        </button>
      )}
      {onCloseSaved && (
        <button
          className="etab-closesaved"
          aria-label={closeSavedLabel}
          title="Close tabs with no unsaved changes"
          // Never `disabled` (R-5): it would drop focus to <body>.
          aria-disabled={!hasSaved}
          onClick={() => {
            if (hasSaved) onCloseSaved();
          }}
        >
          Close saved
        </button>
      )}
      {onCloseAll && (
        <button className="etab-closeall" aria-label={closeAllLabel} onClick={onCloseAll}>
          Close all
        </button>
      )}
    </div>
  );
}

export default memo(EditorTabs);

/** Plan 18: after a Back/Forward SHORTCUT (Alt+Left/Right, mouse buttons),
 *  move focus to the tab that became active so a keyboard user sees where
 *  they landed — unless focus is on one of the bar's CONTROLS (‹ ›, +, Close
 *  all keep their own). A focused TAB does move: it is about to lose its
 *  roving tabIndex=0, so leaving focus there would break the tab order.
 *  Looked up by id (`tabDomId`), never through a selector: tab keys contain
 *  `:` (R-9). Shared by the three tab owners. */
export function focusTabFromShortcut(key: string): void {
  const ae = document.activeElement;
  if (
    ae instanceof HTMLElement &&
    ae.closest(".editor-tabs-bar") &&
    !ae.closest(".editor-tabs")
  )
    return;
  document.getElementById(tabDomId(key))?.focus();
}
