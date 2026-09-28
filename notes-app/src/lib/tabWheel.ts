// Plan 19 (D9, R-11): the pure half of "the mouse wheel scrolls the tab strip
// sideways". EditorTabs owns the native `wheel` listener on the tablist and
// passes the event and the element straight in (a WheelEvent and an
// HTMLElement satisfy the two interfaces structurally); this function decides
// whether — and where — to scroll, so the mapping is unit-tested in the
// node-env vitest setup without a DOM.
//
// Contract: `null` means "let the browser handle it" — the listener must NOT
// preventDefault, so the event can still chain to an ancestor at the strip's
// edges. A number is the new clamped `scrollLeft` (it may be 0). Handled by
// the browser, never here: no overflow, Ctrl+wheel (zoom), a zero vertical
// delta, and any event whose horizontal delta dominates (Shift+wheel and
// trackpad swipes already arrive as `deltaX` in Chromium and scroll the strip
// natively).

/** Pixels per line for `deltaMode === 1` (DOM_DELTA_LINE). Chromium sends
 *  pixels, so this is a fallback, never the Windows 100px notch. */
export const WHEEL_LINE_PX = 16;

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  deltaMode: number;
  ctrlKey: boolean;
}

export interface StripMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export function wheelToScrollLeft(e: WheelInput, m: StripMetrics): number | null {
  const max = m.scrollWidth - m.clientWidth;
  if (!(max > 0)) return null; // no overflow (also rejects NaN metrics)
  if (e.ctrlKey) return null;
  if (e.deltaY === 0) return null;
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return null;
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? m.clientWidth : 1;
  const next = Math.min(max, Math.max(0, m.scrollLeft + e.deltaY * unit));
  // Already at that edge (or odd non-finite input): nothing to do — chain.
  if (!Number.isFinite(next) || next === m.scrollLeft) return null;
  return next;
}
