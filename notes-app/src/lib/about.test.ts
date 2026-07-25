import { describe, it, expect } from "vitest";
import { ABOUT } from "./about";
import { isHttpUrl } from "./jira";

describe("ABOUT", () => {
  it("has a repoUrl that passes the same http(s) URL guard api.openExternal uses", () => {
    expect(isHttpUrl(ABOUT.repoUrl)).toBe(true);
  });

  it("has a non-empty name", () => {
    expect(typeof ABOUT.name).toBe("string");
    expect(ABOUT.name.length).toBeGreaterThan(0);
  });

  it("has a non-empty tagline", () => {
    expect(typeof ABOUT.tagline).toBe("string");
    expect(ABOUT.tagline.length).toBeGreaterThan(0);
  });
});
