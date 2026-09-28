import { describe, it, expect } from "vitest";
import {
  closeAllQuestion,
  planCloseAll,
  runCloseAll,
  saveAllQuestion,
  type CloseAllDeps,
  type CloseAllTab,
} from "./closeAll";

// Builds a CloseAllDeps fake set that also records one ordered call log, so
// cross-flow ORDER assertions (Q1 -> Q2/save/discard -> per-draft loop) can be
// exact. `confirmAnswers` is shifted once per confirm() call (also recording
// the message + opts); `saveResults` maps key -> the save() outcome.
function fakeDeps(opts: {
  tabs: CloseAllTab[];
  confirmAnswers: boolean[];
  saveResults?: Map<string, boolean>;
  confirmDraftAnswers?: Map<string, boolean>;
}): {
  deps: CloseAllDeps;
  log: string[];
  confirmCalls: { message: string; opts?: { okLabel?: string; cancelLabel?: string } }[];
} {
  const log: string[] = [];
  const confirmCalls: { message: string; opts?: { okLabel?: string; cancelLabel?: string } }[] = [];
  const confirmAnswers = opts.confirmAnswers.slice();
  const saveResults = opts.saveResults ?? new Map<string, boolean>();
  const confirmDraftAnswers = opts.confirmDraftAnswers ?? new Map<string, boolean>();

  const deps: CloseAllDeps = {
    tabs: opts.tabs,
    confirm: async (message, callOpts) => {
      confirmCalls.push({ message, opts: callOpts });
      const answer = confirmAnswers.shift();
      log.push(`confirm:${answer ? "yes" : "no"}`);
      return answer ?? false;
    },
    save: async (key) => {
      const ok = saveResults.get(key) ?? false;
      log.push(`save:${key}`);
      return ok;
    },
    discard: async (key) => {
      log.push(`discard:${key}`);
    },
    activate: (key) => {
      log.push(`activate:${key}`);
    },
    confirmDraft: async (key) => {
      const answer = confirmDraftAnswers.get(key) ?? false;
      log.push(`confirmDraft:${key}`);
      return answer;
    },
  };

  return { deps, log, confirmCalls };
}

function tab(key: string, overrides: Partial<CloseAllTab> = {}): CloseAllTab {
  return { key, isDirty: false, isDraft: false, ...overrides };
}

describe("planCloseAll", () => {
  it("partitions clean, dirty-saved, and draft tabs while preserving tab order", () => {
    const tabs = [
      tab("a"),
      tab("b", { isDirty: true }),
      tab("c", { isDirty: true, isDraft: true }),
      tab("d"),
    ];
    expect(planCloseAll(tabs)).toEqual({
      clean: ["a", "d"],
      dirtySaved: ["b"],
      drafts: ["c"],
    });
  });
});

describe("closeAllQuestion / saveAllQuestion (pinned wording)", () => {
  it("closeAllQuestion uses singular wording for 1 tab / 1 unsaved", () => {
    expect(closeAllQuestion(1, 1)).toBe("Close all 1 tab? 1 has unsaved changes.");
  });

  it("closeAllQuestion uses plural wording for multiple tabs/unsaved", () => {
    expect(closeAllQuestion(5, 2)).toBe("Close all 5 tabs? 2 have unsaved changes.");
  });

  it("closeAllQuestion pluralizes tab count independently of the unsaved count", () => {
    expect(closeAllQuestion(3, 1)).toBe("Close all 3 tabs? 1 has unsaved changes.");
  });

  it("saveAllQuestion uses singular wording for 1 unsaved tab", () => {
    expect(saveAllQuestion(1)).toBe(
      "Save the 1 unsaved tab before closing? Yes saves and closes; No discards it.",
    );
  });

  it("saveAllQuestion uses plural wording for multiple unsaved tabs", () => {
    expect(saveAllQuestion(3)).toBe(
      "Save the 3 unsaved tabs before closing? Yes saves and closes; No discards them.",
    );
  });
});

describe("runCloseAll", () => {
  it("when every tab is clean, closes everything with no confirm call at all", async () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { deps, log, confirmCalls } = fakeDeps({ tabs, confirmAnswers: [] });

    const result = await runCloseAll(deps);

    expect(result).toEqual({ closed: ["a", "b", "c"], kept: [] });
    expect(confirmCalls).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it("some dirty + Q1 answered false (Cancel): nothing is saved or discarded, and nothing closes", async () => {
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c")];
    const { deps, log } = fakeDeps({ tabs, confirmAnswers: [false] });

    const result = await runCloseAll(deps);

    expect(result).toEqual({ closed: [], kept: ["a", "b", "c"] });
    expect(log).toEqual(["confirm:no"]);
  });

  it("Q1 true then Q2 true (Save): save is called for each dirty saved key in order; a false save keeps that key and is never discarded", async () => {
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c", { isDirty: true }), tab("d")];
    const saveResults = new Map([
      ["b", true],
      ["c", false], // simulated save failure
    ]);
    const { deps, log } = fakeDeps({ tabs, confirmAnswers: [true, true], saveResults });

    const result = await runCloseAll(deps);

    expect(result.closed).toEqual(["a", "b", "d"]);
    expect(result.kept).toEqual(["c"]); // failed save stays open
    expect(log).toEqual(["confirm:yes", "confirm:yes", "save:b", "save:c"]);
    expect(log).not.toContain("discard:c");
    expect(log).not.toContain("discard:b");
  });

  it("Q1 true then Q2 false (Discard): discard is called for each dirty saved key, then closed", async () => {
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c", { isDirty: true })];
    const { deps, log } = fakeDeps({ tabs, confirmAnswers: [true, false] });

    const result = await runCloseAll(deps);

    expect(result).toEqual({ closed: ["a", "b", "c"], kept: [] });
    expect(log).toEqual(["confirm:yes", "confirm:no", "discard:b", "discard:c"]);
  });

  it("drafts: activate precedes confirmDraft for each draft; true discards+closes, false keeps without discarding", async () => {
    const tabs = [
      tab("a"),
      tab("draft-1", { isDirty: true, isDraft: true }),
      tab("draft-2", { isDirty: true, isDraft: true }),
    ];
    const confirmDraftAnswers = new Map([
      ["draft-1", true],
      ["draft-2", false],
    ]);
    const { deps, log } = fakeDeps({ tabs, confirmAnswers: [true], confirmDraftAnswers });

    const result = await runCloseAll(deps);

    expect(result.closed).toEqual(["a", "draft-1"]);
    expect(result.kept).toEqual(["draft-2"]);
    expect(log).toEqual([
      "confirm:yes",
      "activate:draft-1",
      "confirmDraft:draft-1",
      "discard:draft-1",
      "activate:draft-2",
      "confirmDraft:draft-2",
    ]);
    expect(log).not.toContain("discard:draft-2");
  });

  it("no Q2 confirm when there are drafts but no dirty-saved tabs", async () => {
    const tabs = [tab("a"), tab("draft-1", { isDirty: true, isDraft: true })];
    const confirmDraftAnswers = new Map([["draft-1", true]]);
    const { deps, log, confirmCalls } = fakeDeps({
      tabs,
      confirmAnswers: [true],
      confirmDraftAnswers,
    });

    await runCloseAll(deps);

    expect(confirmCalls).toHaveLength(1); // only Q1 — no Save/Discard question
    expect(log[0]).toBe("confirm:yes");
    expect(log).not.toContain("confirm:no");
  });

  it("cross-flow order: with dirty-saved tabs AND drafts, the whole dirty-saved flow (Q2 + every save/discard) completes before the first activate/confirmDraft; drafts are confirmed in tab order", async () => {
    const tabs = [
      tab("a", { isDirty: true }),
      tab("b", { isDirty: true }),
      tab("draft-1", { isDirty: true, isDraft: true }),
      tab("draft-2", { isDirty: true, isDraft: true }),
    ];
    const saveResults = new Map([
      ["a", true],
      ["b", true],
    ]);
    const confirmDraftAnswers = new Map([
      ["draft-1", true],
      ["draft-2", true],
    ]);
    const { deps, log } = fakeDeps({
      tabs,
      confirmAnswers: [true, true],
      saveResults,
      confirmDraftAnswers,
    });

    const result = await runCloseAll(deps);

    expect(result.closed).toEqual(["a", "b", "draft-1", "draft-2"]);
    expect(result.kept).toEqual([]);
    expect(log).toEqual([
      "confirm:yes",
      "confirm:yes",
      "save:a",
      "save:b",
      "activate:draft-1",
      "confirmDraft:draft-1",
      "discard:draft-1",
      "activate:draft-2",
      "confirmDraft:draft-2",
      "discard:draft-2",
    ]);
  });

  it("discard is never called for a key that ends up in kept", async () => {
    const tabs = [
      tab("b", { isDirty: true }),
      tab("draft-1", { isDirty: true, isDraft: true }),
    ];
    const saveResults = new Map([["b", false]]); // save fails -> kept
    const confirmDraftAnswers = new Map([["draft-1", false]]); // kept
    const { deps, log } = fakeDeps({
      tabs,
      confirmAnswers: [true, true],
      saveResults,
      confirmDraftAnswers,
    });

    const result = await runCloseAll(deps);

    expect(result.kept).toEqual(["b", "draft-1"]);
    for (const key of result.kept) expect(log).not.toContain(`discard:${key}`);
  });

  it("passes the expected okLabel/cancelLabel to the Q1 confirm", async () => {
    const tabs = [tab("a", { isDirty: true })];
    const { deps, confirmCalls } = fakeDeps({ tabs, confirmAnswers: [false] });

    await runCloseAll(deps);

    expect(confirmCalls[0].opts).toEqual({ okLabel: "Close all", cancelLabel: "Cancel" });
  });
});
