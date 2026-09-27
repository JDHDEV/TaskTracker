import { memo, type RefObject } from "react";
import { selectionSegments, type CapturedSelection } from "../lib/selection";

interface Props {
  /** The live body — the mirror must wrap exactly like the textarea. */
  body: string;
  /** The captured range being reworked (plan 13's `selectionRework`). */
  sel: CapturedSelection | null;
  /** The editor's ref, so its `onScroll` can keep the mirror in step. */
  hlRef: RefObject<HTMLDivElement | null>;
}

/** Plan 17 feature 4 (D6): a mirrored backdrop that marks the captured range
 *  behind the body textarea while a selection rework is confirming or
 *  pending. A textarea's value is not DOM text, so nothing else can mark it
 *  and the native selection vanishes on blur. The mirror repeats the body in
 *  transparent glyphs with the same box/font/wrap metrics (see `.body-hl`),
 *  wraps `[start, end)` in a <mark>, and is `aria-hidden` + `pointer-events:
 *  none` — presentation only, never a target. Rendered only from the pure
 *  `selectionSegments`, so a stale range draws nothing (R-6): the highlight
 *  disappears rather than relocating (plan 13 D4). A trailing newline gets a
 *  zero-width sentinel so both boxes scroll to the same height. */
export default memo(function SelectionBackdrop({ body, sel, hlRef }: Props) {
  const seg = selectionSegments(body, sel);
  if (seg === null) return null;
  return (
    <div className="body-hl" aria-hidden="true" ref={hlRef}>
      {seg.before}
      <mark className="body-hl-mark">{seg.selected}</mark>
      {seg.after}
      {body.endsWith("\n") ? "​" : ""}
    </div>
  );
});
