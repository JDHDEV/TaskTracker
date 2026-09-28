import { describe, it, expect } from "vitest";
import { WHEEL_LINE_PX, wheelToScrollLeft, type StripMetrics, type WheelInput } from "./tabWheel";

function wheel(overrides: Partial<WheelInput> = {}): WheelInput {
  return { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, ...overrides };
}

function strip(overrides: Partial<StripMetrics> = {}): StripMetrics {
  return { scrollLeft: 0, scrollWidth: 1000, clientWidth: 400, ...overrides };
}

describe("wheelToScrollLeft", () => {
  describe("no overflow", () => {
    it("returns null at the exact boundary scrollWidth === clientWidth", () => {
      // scrollLeft is deliberately nonzero so a null-vs-number result is
      // distinguishable from the coincidental "already at 0" no-op case.
      const result = wheelToScrollLeft(
        wheel({ deltaY: 100 }),
        strip({ scrollLeft: 50, scrollWidth: 400, clientWidth: 400 }),
      );
      expect(result).toBeNull();
    });

    it("returns null when scrollWidth < clientWidth", () => {
      const result = wheelToScrollLeft(
        wheel({ deltaY: 100 }),
        strip({ scrollLeft: 50, scrollWidth: 300, clientWidth: 400 }),
      );
      expect(result).toBeNull();
    });
  });

  it("returns null when ctrlKey is true, even with overflow and a dominant vertical delta", () => {
    expect(wheelToScrollLeft(wheel({ ctrlKey: true, deltaY: 100 }), strip())).toBeNull();
  });

  it("returns null when deltaY is 0", () => {
    expect(wheelToScrollLeft(wheel({ deltaY: 0 }), strip())).toBeNull();
  });

  describe("horizontal delta dominates or ties (left to the browser)", () => {
    it("returns null when |deltaX| equals |deltaY|", () => {
      expect(wheelToScrollLeft(wheel({ deltaX: 50, deltaY: 50 }), strip())).toBeNull();
    });

    it("returns null when |deltaX| exceeds |deltaY| (positive deltaX)", () => {
      expect(wheelToScrollLeft(wheel({ deltaX: 100, deltaY: 50 }), strip())).toBeNull();
    });

    it("returns null when |deltaX| exceeds |deltaY| (negative deltaX)", () => {
      expect(wheelToScrollLeft(wheel({ deltaX: -100, deltaY: 50 }), strip())).toBeNull();
    });
  });

  describe("pixel mode (deltaMode 0)", () => {
    it("scrolls down (positive deltaY) by deltaY pixels", () => {
      expect(wheelToScrollLeft(wheel({ deltaY: 50 }), strip({ scrollLeft: 100 }))).toBe(150);
    });

    it("scrolls up (negative deltaY) by |deltaY| pixels", () => {
      expect(wheelToScrollLeft(wheel({ deltaY: -50 }), strip({ scrollLeft: 300 }))).toBe(250);
    });
  });

  it("line mode (deltaMode 1) scales by WHEEL_LINE_PX", () => {
    const result = wheelToScrollLeft(wheel({ deltaY: 3, deltaMode: 1 }), strip({ scrollLeft: 100 }));
    expect(result).toBe(100 + 3 * WHEEL_LINE_PX);
  });

  it("page mode (deltaMode 2) scales by clientWidth, clamped to max", () => {
    // 1 page (+400) from scrollLeft 300 would overshoot max 600 -> clamped.
    const result = wheelToScrollLeft(
      wheel({ deltaY: 1, deltaMode: 2 }),
      strip({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 400 }),
    );
    expect(result).toBe(600);
  });

  it("clamps at the right edge", () => {
    const result = wheelToScrollLeft(
      wheel({ deltaY: 100 }),
      strip({ scrollLeft: 550, scrollWidth: 1000, clientWidth: 400 }),
    );
    expect(result).toBe(600);
  });

  it("clamps at the left edge", () => {
    const result = wheelToScrollLeft(wheel({ deltaY: -100 }), strip({ scrollLeft: 30 }));
    expect(result).toBe(0);
  });

  it("returns null already at the right edge, scrolling further right", () => {
    const result = wheelToScrollLeft(
      wheel({ deltaY: 50 }),
      strip({ scrollLeft: 600, scrollWidth: 1000, clientWidth: 400 }), // scrollLeft === max
    );
    expect(result).toBeNull();
  });

  it("returns null already at 0, scrolling further left (chains to the browser)", () => {
    const result = wheelToScrollLeft(wheel({ deltaY: -50 }), strip({ scrollLeft: 0 }));
    expect(result).toBeNull();
  });

  it("returns exactly 0 (not null) when scrolling back to the left edge — the null-vs-0 contract", () => {
    const result = wheelToScrollLeft(wheel({ deltaY: -50 }), strip({ scrollLeft: 50 }));
    expect(result).toBe(0);
    expect(result).not.toBeNull();
  });

  describe("odd metrics never throw", () => {
    it("returns null for a NaN scrollWidth", () => {
      expect(() => wheelToScrollLeft(wheel(), strip({ scrollWidth: NaN }))).not.toThrow();
      expect(wheelToScrollLeft(wheel(), strip({ scrollWidth: NaN }))).toBeNull();
    });

    it("handles a fractional scrollLeft", () => {
      const result = wheelToScrollLeft(wheel({ deltaY: 100 }), strip({ scrollLeft: 49.6 }));
      expect(result).toBe(149.6);
    });
  });
});
