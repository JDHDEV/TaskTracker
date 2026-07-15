import { useEffect, useRef, type RefObject } from "react";

interface PopoverRefs {
  /** Wraps the whole widget (trigger + panel); an outside mousedown closes. */
  wrapper: RefObject<HTMLElement | null>;
  /** The popover panel; focus moves to its first control on open. */
  panel: RefObject<HTMLElement | null>;
  /** The trigger button; focus returns here on Escape. */
  trigger: RefObject<HTMLElement | null>;
  /** Optional element to focus on open instead of the panel's first control. */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Dependency-free popover dismiss + focus management, shared by both tag
 * popups so they behave identically: close on outside mousedown / Escape,
 * move focus into the panel on open, and return focus to the trigger on Escape.
 */
export function usePopover(
  open: boolean,
  onClose: () => void,
  refs: PopoverRefs,
): void {
  const { wrapper, panel, trigger, initialFocus } = refs;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    function onDown(e: MouseEvent) {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        trigger.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);

    // Move focus into the popover once its content has mounted — a caller-
    // named control if given, else the panel's first focusable.
    const target =
      initialFocus?.current ??
      panel.current?.querySelector<HTMLElement>("button, input, [tabindex]");
    target?.focus();

    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, wrapper, panel, trigger, initialFocus]);
}
