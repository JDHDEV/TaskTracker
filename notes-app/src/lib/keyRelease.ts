/**
 * Which keys are physically held right now, by `KeyboardEvent.code`, and a
 * promise for the moment none are. A native modal (the dialog plugin's `ask`,
 * the folder picker) must open only after the key that triggered it is
 * released: Windows' "Hide pointer while typing" hides the pointer on the
 * key-UP as well, and a key-up that lands in the freshly opened native dialog
 * can never be undone by a mouse move (see `restore_pointer` in commands.rs).
 * A key-up delivered to the page, before the dialog exists, is harmless.
 *
 * Capture-phase listeners, so a handler that stops propagation cannot strand
 * a key in the set; `blur` clears it because the key-up goes elsewhere once
 * the window loses focus. `whenReleased` is capped so a lost key-up can only
 * delay a dialog, never block it. The cap stays under the shortest Windows
 * auto-repeat delay (250 ms): a key held past it would otherwise re-fire its
 * handler into the wait and queue a second dialog behind the first.
 */
export const RELEASE_CAP_MS = 200;

export interface HeldKeys {
  /** Codes currently down; exposed for tests and diagnostics. */
  readonly held: ReadonlySet<string>;
  /** Resolves once no key is held, or after `capMs`, whichever comes first. */
  whenReleased(capMs?: number): Promise<void>;
}

export function trackHeldKeys(target: EventTarget): HeldKeys {
  const held = new Set<string>();
  const waiters = new Set<() => void>();
  const settle = () => {
    if (held.size !== 0) return;
    for (const wake of waiters) wake();
  };
  target.addEventListener("keydown", (e) => held.add((e as KeyboardEvent).code), true);
  target.addEventListener(
    "keyup",
    (e) => {
      held.delete((e as KeyboardEvent).code);
      settle();
    },
    true,
  );
  target.addEventListener("blur", () => {
    held.clear();
    settle();
  });
  return {
    held,
    whenReleased(capMs = RELEASE_CAP_MS) {
      if (held.size === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, capMs);
        waiters.add(done);
      });
    },
  };
}
