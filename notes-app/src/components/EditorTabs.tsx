import { memo, useEffect, useRef, type KeyboardEvent } from "react";
import { tabDomId, tabPanelDomId } from "../lib/openTabs";

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
}

// The tab is a `<div role="tab">`, not a `<button>`, so the close control can be
// a REAL sibling `<button>` inside it — a <button> nested in a <button> (the
// mock's `role="button"` span) is invalid and unreachable by keyboard. Roving
// tabindex + arrow/Home/End navigation mirror App's page-tabs; Delete/Backspace
// closes the focused tab, and focus follows the neighbor that takes over.
function EditorTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onNew,
  listLabel,
  newLabel,
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

  function focusTab(key: string) {
    const el = tabEls.current.get(key);
    el?.focus();
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>, key: string) {
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

  return (
    <div className="editor-tabs" role="tablist" aria-label={listLabel}>
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
            // label and the pin/dot/unsaved title= attributes).
            aria-label={t.title}
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
      {onNew && (
        <button className="etab-new" aria-label={newLabel} onClick={onNew}>
          +
        </button>
      )}
    </div>
  );
}

export default memo(EditorTabs);
