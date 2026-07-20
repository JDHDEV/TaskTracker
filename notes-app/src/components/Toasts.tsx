import { useRef } from "react";
import type { Toast } from "../lib/toasts";
import { pause, resume } from "../lib/toasts";

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

/** One toast row. Errors are `role="alert"` (assertive), notices `role="status"`
 *  (polite) — a distinct element per toast, never a single reused node with a
 *  swapped role. Hover OR keyboard focus pauses the auto-dismiss timer (WCAG
 *  2.2.1) and resumes it with only the remaining time, so a control inside a
 *  toast is never yanked away mid-interaction. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  // Track hover and focus independently so releasing one while the other holds
  // does not prematurely resume the timer.
  const hovering = useRef(false);
  const focused = useRef(false);
  const sync = () => {
    if (hovering.current || focused.current) pause(toast.id);
    else resume(toast.id);
  };
  return (
    <div
      className={toast.kind === "error" ? "toast" : "toast toast-notice"}
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => {
        hovering.current = true;
        sync();
      }}
      onMouseLeave={() => {
        hovering.current = false;
        sync();
      }}
      onFocus={() => {
        focused.current = true;
        sync();
      }}
      onBlur={() => {
        focused.current = false;
        sync();
      }}
    >
      <span className="toast-message">{toast.message}</span>
      <button className="btn btn-quiet" onClick={() => onDismiss(toast.id)}>
        Dismiss
      </button>
    </div>
  );
}

/** The toast stack: a plain (non-live) wrapper holding one live region per
 *  toast. Renders nothing when empty so it never occupies layout. */
export default function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
