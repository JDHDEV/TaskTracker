import { describe, expect, it, vi } from "vitest";
import { missingKeyToastKey, reportAiError } from "./aiErrors";
import type { ProviderId } from "../types";

describe("missingKeyToastKey", () => {
  it("derives the stable toast key for anthropic", () => {
    expect(missingKeyToastKey("anthropic")).toBe("missing-key:anthropic");
  });

  it("derives the stable toast key for openai", () => {
    expect(missingKeyToastKey("openai")).toBe("missing-key:openai");
  });

  it("derives the stable toast key for atlassian (a plain string, not a ProviderId)", () => {
    expect(missingKeyToastKey("atlassian")).toBe("missing-key:atlassian");
  });
});

describe("reportAiError", () => {
  it("keys the toast when the injected checkKey resolves false, calling onError once with the message and the key", async () => {
    const checkKey = vi.fn().mockResolvedValue(false);
    const onError = vi.fn();

    await reportAiError("anthropic", "boom", onError, checkKey);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("boom", { key: "missing-key:anthropic" });
    expect(checkKey).toHaveBeenCalledWith("anthropic");
  });

  it("pushes an unkeyed toast when the injected checkKey resolves true", async () => {
    const checkKey = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();

    await reportAiError("openai", "boom", onError, checkKey);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("boom");
    expect(onError.mock.calls[0][1]).toBeUndefined(); // no opts — not keyed
    expect(checkKey).toHaveBeenCalledWith("openai");
  });

  it("falls back to an unkeyed toast when the injected checkKey rejects", async () => {
    const checkKey = vi.fn().mockRejectedValue(new Error("network down"));
    const onError = vi.fn();

    await reportAiError("anthropic", "boom", onError, checkKey);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("boom");
    expect(onError.mock.calls[0][1]).toBeUndefined(); // presence unknown — never keyed
  });

  it("passes an already-stringified message through verbatim", async () => {
    const checkKey = vi.fn().mockResolvedValue(false);
    const onError = vi.fn();

    await reportAiError("anthropic", "Rate limited, try again later.", onError, checkKey);

    expect(onError.mock.calls[0][0]).toBe("Rate limited, try again later.");
  });

  it("stringifies a raw non-string err via String()", async () => {
    const checkKey = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    const err = new Error("socket hang up");

    await reportAiError("openai", err, onError, checkKey);

    expect(onError.mock.calls[0][0]).toBe(String(err));
    expect(onError.mock.calls[0][0]).toBe("Error: socket hang up");
  });

  it("stringifies a non-Error, non-string err (plain object) via String()", async () => {
    const checkKey = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    const err = { weird: true };

    await reportAiError("anthropic", err, onError, checkKey);

    expect(onError.mock.calls[0][0]).toBe(String(err));
  });

  it("invokes the injected checkKey with the given provider, not a default", async () => {
    const checkKey = vi.fn().mockResolvedValue(false);
    const onError = vi.fn();
    const provider: ProviderId = "openai";

    await reportAiError(provider, "boom", onError, checkKey);

    expect(checkKey).toHaveBeenCalledTimes(1);
    expect(checkKey).toHaveBeenCalledWith("openai");
  });
});
