import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { usePopover } from "../hooks/usePopover";

export type SendDestination = "note" | "task" | "prompt";

interface Props {
  open: boolean;
  /** Pointer position from the `contextmenu` event (viewport coordinates). */
  x: number;
  y: number;
  /** The textarea the menu was opened from — focus returns there on Escape. */
  anchor: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onSendTo: (dest: SendDestination) => void;
}

// Static labels — never user text (the selection itself is not previewed).
const ITEMS: { dest: SendDestination; label: string }[] = [
  { dest: "note", label: "New note from selection" },
  { dest: "task", label: "New task from selection" },
  { dest: "prompt", label: "New prompt from selection" },
];

/**
 * The scratch pad's right-click menu (Plan 13, D8): a React-rendered
 * `role="menu"` shown only for a non-empty selection — the caller decides that
 * and lets the native WebView2 menu through otherwise. Fixed-positioned at the
 * pointer and clamped inside the viewport via the React `style` prop (CSSOM, so
 * the strict CSP is untouched); dismissal (outside mousedown / Escape / focus
 * return) reuses `usePopover` with the menu as both wrapper and panel and the
 * textarea as the trigger. The caller restores the text selection on close —
 * `usePopover` only refocuses the trigger.
 */
export default function SelectionMenu({ open, x, y, anchor, onClose, onSendTo }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  usePopover(open, onClose, { wrapper: menuRef, panel: menuRef, trigger: anchor });

  // Measure once mounted and keep the whole menu on-screen (never negative), so
  // a right-click near the bottom/right edge doesn't push items off the window.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(0, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [open, x, y]);

  if (!open) return null;

  // Roving focus among the items — the vertical mirror of EditorTabs' strip.
  // Tab closes the menu (focus returns to the pad via onClose) rather than
  // walking out of it and leaving it open, per the ARIA menu pattern.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const i = items.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  }

  return (
    <div
      className="popover context-menu"
      role="menu"
      aria-label="Selection"
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      {ITEMS.map((it) => (
        <button
          key={it.dest}
          role="menuitem"
          className="context-menu-item"
          onClick={() => onSendTo(it.dest)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
