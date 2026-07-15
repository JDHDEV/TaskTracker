import { describe, it, expect } from "vitest";
import { isHttpUrl, ticketLabel } from "./jira";

describe("isHttpUrl", () => {
  it("accepts http URLs with a host", () => {
    expect(isHttpUrl("http://h/x")).toBe(true);
  });

  it("accepts https URLs with a host", () => {
    expect(isHttpUrl("https://h/x")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects file: URLs", () => {
    expect(isHttpUrl("file:///etc")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isHttpUrl("data:text/html,x")).toBe(false);
  });

  // NOTE: per WHATWG URL parsing (as implemented by Node/browsers), "https:///path"
  // does NOT produce an empty host — the parser consumes the extra leading slash
  // into the authority and yields host === "path" (pathname "/"). Any input that
  // would truly leave protocol http/https with an empty host causes `new URL()`
  // to throw instead, which isHttpUrl already catches and returns false for. So
  // this case parses successfully with a non-empty host and is accepted.
  it("accepts 'https:///path' — WHATWG normalizes the extra slash into a non-empty host", () => {
    expect(isHttpUrl("https:///path")).toBe(true);
  });

  it("accepts an uppercase scheme (URL normalizes it)", () => {
    expect(isHttpUrl("HTTPS://h/x")).toBe(true);
  });

  it("returns false for an unparseable string without throwing", () => {
    expect(() => isHttpUrl("nope")).not.toThrow();
    expect(isHttpUrl("nope")).toBe(false);
  });
});

describe("ticketLabel", () => {
  it("extracts an uppercase key from the last path segment", () => {
    expect(ticketLabel("https://acme.atlassian.net/browse/PLAT-142")).toBe("PLAT-142 ↗");
  });

  it("ignores a trailing slash", () => {
    expect(ticketLabel("https://acme.atlassian.net/browse/PLAT-142/")).toBe("PLAT-142 ↗");
  });

  it("ignores query and hash after the key", () => {
    expect(ticketLabel("https://acme.atlassian.net/browse/PLAT-142?x=1#y")).toBe("PLAT-142 ↗");
  });

  it("uppercases a lowercase key", () => {
    expect(ticketLabel("https://acme.atlassian.net/plat-142")).toBe("PLAT-142 ↗");
  });

  it("falls back to the generic label when there is no path segment", () => {
    expect(ticketLabel("https://acme.atlassian.net")).toBe("Open ticket ↗");
  });

  it("falls back to the generic label for a key-like but invalid last segment (no letter prefix)", () => {
    expect(ticketLabel("https://acme.atlassian.net/browse/NOTAKEY")).toBe("Open ticket ↗");
    expect(ticketLabel("https://acme.atlassian.net/123-45")).toBe("Open ticket ↗");
  });

  it("falls back to the generic label for an unparseable string without throwing", () => {
    expect(() => ticketLabel("not a url")).not.toThrow();
    expect(ticketLabel("not a url")).toBe("Open ticket ↗");
  });
});
