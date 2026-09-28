import { describe, it, expect } from "vitest";
import {
  closeAllQuestion,
  closeSavedQuestion,
  planCloseAll,
  planCloseSaved,
  runCloseAll,
  runCloseSaved,
  saveAllQuestion,
  type CloseAllDeps,
  type CloseAllTab,
  type CloseSavedDeps,
} from "./closeAll";
import {
  activateTab,
  activeTab,
  closeTabs,
  dirtyCount,
  dirtyKeys,
  emptyTabs,
  openTab,
} from "./openTabs";

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

describe("planCloseSaved", () => {
  it("excludes dirty tabs, keeping tab order", () => {
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c")];
    expect(planCloseSaved(tabs)).toEqual(["a", "c"]);
  });

  it("excludes a draft even when its isDirty is false (SEC-1 shape, R-2)", () => {
    const tabs = [tab("a"), tab("draft-1", { isDraft: true, isDirty: false }), tab("b")];
    expect(planCloseSaved(tabs)).toEqual(["a", "b"]);
  });

  it("excludes a dirty draft too", () => {
    const tabs = [tab("a"), tab("draft-1", { isDraft: true, isDirty: true })];
    expect(planCloseSaved(tabs)).toEqual(["a"]);
  });

  it("returns [] for an empty tab list", () => {
    expect(planCloseSaved([])).toEqual([]);
  });

  it("returns every key in order when all tabs are clean and saved", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(planCloseSaved(tabs)).toEqual(["a", "b", "c"]);
  });
});

describe("closeSavedQuestion (pinned wording)", () => {
  it("(3, 2) -> plural saved, plural unsaved", () => {
    expect(closeSavedQuestion(3, 2)).toBe("Close 3 saved tabs? 2 with unsaved changes stay open.");
  });

  it("(1, 1) -> singular saved, singular unsaved", () => {
    expect(closeSavedQuestion(1, 1)).toBe("Close 1 saved tab? 1 with unsaved changes stays open.");
  });

  it("(3, 0) -> plural saved, no unsaved clause", () => {
    expect(closeSavedQuestion(3, 0)).toBe("Close 3 saved tabs?");
  });

  it("(1, 0) -> singular saved, no unsaved clause", () => {
    expect(closeSavedQuestion(1, 0)).toBe("Close 1 saved tab?");
  });

  it("(1, 2) -> singular saved, plural unsaved", () => {
    expect(closeSavedQuestion(1, 2)).toBe("Close 1 saved tab? 2 with unsaved changes stay open.");
  });

  it("(2, 1) -> plural saved, singular unsaved", () => {
    expect(closeSavedQuestion(2, 1)).toBe("Close 2 saved tabs? 1 with unsaved changes stays open.");
  });
});

describe("runCloseSaved", () => {
  function fakeConfirm(answers: boolean[]) {
    const calls: { message: string; opts?: { okLabel?: string; cancelLabel?: string } }[] = [];
    const queue = answers.slice();
    const confirm: CloseAllDeps["confirm"] = async (message, opts) => {
      calls.push({ message, opts });
      return queue.shift() ?? false;
    };
    return { confirm, calls };
  }

  it("zero saved tabs (all dirty) never calls confirm and returns { closed: [] }", async () => {
    const tabs = [tab("a", { isDirty: true }), tab("b", { isDirty: true })];
    const { confirm, calls } = fakeConfirm([]);

    const result = await runCloseSaved({ getTabs: () => tabs, confirm });

    expect(result).toEqual({ closed: [] });
    expect(calls).toHaveLength(0);
  });

  it("zero saved tabs (only drafts) never calls confirm", async () => {
    const tabs = [tab("draft-1", { isDraft: true }), tab("draft-2", { isDraft: true, isDirty: true })];
    const { confirm, calls } = fakeConfirm([]);

    const result = await runCloseSaved({ getTabs: () => tabs, confirm });

    expect(result).toEqual({ closed: [] });
    expect(calls).toHaveLength(0);
  });

  it("zero saved tabs (empty tab list) never calls confirm", async () => {
    const { confirm, calls } = fakeConfirm([]);

    const result = await runCloseSaved({ getTabs: () => [], confirm });

    expect(result).toEqual({ closed: [] });
    expect(calls).toHaveLength(0);
  });

  it("the one confirm names the SAVED and dirty counts (not the total) with the exact opts, called exactly once", async () => {
    // 5 tabs total, 3 saved (a, c, e), 2 dirty (b, d).
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c"), tab("d", { isDirty: true }), tab("e")];
    const { confirm, calls } = fakeConfirm([true]);

    await runCloseSaved({ getTabs: () => tabs, confirm });

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe(closeSavedQuestion(3, 2));
    expect(calls[0].message).toBe("Close 3 saved tabs? 2 with unsaved changes stay open.");
    expect(calls[0].message).not.toContain("5");
    expect(calls[0].opts).toEqual({ okLabel: "Close saved", cancelLabel: "Cancel" });
  });

  it("Cancel (confirm resolves false) closes nothing; confirm is called exactly once", async () => {
    const tabs = [tab("a"), tab("b", { isDirty: true })];
    const { confirm, calls } = fakeConfirm([false]);

    const result = await runCloseSaved({ getTabs: () => tabs, confirm });

    expect(result).toEqual({ closed: [] });
    expect(calls).toHaveLength(1);
  });

  it("OK on an unchanged tab set closes exactly planCloseSaved(tabs)", async () => {
    const tabs = [tab("a"), tab("b", { isDirty: true }), tab("c"), tab("draft-1", { isDraft: true })];
    const { confirm } = fakeConfirm([true]);

    const result = await runCloseSaved({ getTabs: () => tabs, confirm });

    expect(result).toEqual({ closed: planCloseSaved(tabs) });
    expect(result.closed).toEqual(["a", "c"]);
  });

  describe("re-validation against a mutated tab set while the dialog is pending (D5)", () => {
    function deferredConfirm() {
      let resolve!: (v: boolean) => void;
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      const confirm: CloseAllDeps["confirm"] = () => promise;
      return { confirm, resolve };
    }

    it("a tab that turned dirty while the dialog was pending is excluded", async () => {
      let tabs: CloseAllTab[] = [tab("a"), tab("b"), tab("c")];
      let getTabsCalls = 0;
      const getTabs = () => {
        getTabsCalls++;
        return tabs;
      };
      const { confirm, resolve } = deferredConfirm();

      const pending = runCloseSaved({ getTabs, confirm });
      tabs = [tab("a", { isDirty: true }), tab("b"), tab("c")]; // "a" turned dirty mid-dialog
      resolve(true);
      const result = await pending;

      expect(result.closed).toEqual(["b", "c"]);
      expect(result.closed).not.toContain("a");
      expect(getTabsCalls).toBeGreaterThanOrEqual(2);
    });

    it("a tab that turned CLEAN while pending is NOT included (never more than the dialog counted)", async () => {
      let tabs: CloseAllTab[] = [tab("a", { isDirty: true }), tab("b"), tab("c")];
      const getTabs = () => tabs;
      const { confirm, resolve } = deferredConfirm();

      const pending = runCloseSaved({ getTabs, confirm });
      tabs = [tab("a"), tab("b"), tab("c")]; // "a" turned clean mid-dialog
      resolve(true);
      const result = await pending;

      expect(result.closed).toEqual(["b", "c"]);
      expect(result.closed).not.toContain("a");
    });

    it("a tab that closed (removed from the array) while pending is excluded", async () => {
      let tabs: CloseAllTab[] = [tab("a"), tab("b"), tab("c")];
      const getTabs = () => tabs;
      const { confirm, resolve } = deferredConfirm();

      const pending = runCloseSaved({ getTabs, confirm });
      tabs = [tab("a"), tab("c")]; // "b" closed mid-dialog
      resolve(true);
      const result = await pending;

      expect(result.closed).toEqual(["a", "c"]);
      expect(result.closed).not.toContain("b");
    });

    it("getTabs is called at least twice (before and after the dialog)", async () => {
      const tabs: CloseAllTab[] = [tab("a"), tab("b")];
      let getTabsCalls = 0;
      const getTabs = () => {
        getTabsCalls++;
        return tabs;
      };
      const { confirm, resolve } = deferredConfirm();

      const pending = runCloseSaved({ getTabs, confirm });
      resolve(true);
      await pending;

      expect(getTabsCalls).toBeGreaterThanOrEqual(2);
    });
  });

  describe("integrated with the real closeTabs reducer", () => {
    it("folds into closeTabs: survivors are exactly the dirty tabs, active moves to the nearest surviving right neighbour, and dirtyKeys/dirtyCount stay consistent", async () => {
      let state = openTab(emptyTabs<string>(), "a", "Item A");
      state = openTab(state, "b", "Item B", true); // dirty
      state = openTab(state, "c", "Item C");
      state = openTab(state, "d", "Item D", true); // dirty
      state = openTab(state, "e", "Item E");
      state = activateTab(state, "c"); // active tab is among the saved ones

      expect(activeTab(state)?.key).toBe("c");

      const tabsSnapshot: CloseAllTab[] = state.tabs.map((t) => tab(t.key, { isDirty: t.isDirty }));

      const result = await runCloseSaved({
        getTabs: () => tabsSnapshot,
        confirm: async () => true,
      });
      expect(result.closed).toEqual(["a", "c", "e"]);

      state = closeTabs(state, result.closed);

      expect(state.tabs.map((t) => t.key)).toEqual(["b", "d"]);
      expect(state.activeKey).toBe("d"); // nearest surviving right neighbour of c's original slot
      expect(state.tabs.every((t) => t.isDirty)).toBe(true);
      expect(dirtyKeys(state)).toEqual(new Set(["b", "d"]));
      expect(dirtyCount(state)).toBe(2);
    });
  });
});

describe("CloseSavedDeps shape (plan 19 D5): getTabs + confirm only, no persistence verbs", () => {
  it("has exactly the keys getTabs and confirm", () => {
    type Keys = keyof CloseSavedDeps;
    const keys: Keys[] = ["getTabs", "confirm"];
    expect(keys).toHaveLength(2);
  });

  it("rejects an object carrying a save field (type-level; requires this file in tsc's `include`)", () => {
    const bad: CloseSavedDeps = {
      getTabs: () => [],
      confirm: async () => true,
      // @ts-expect-error CloseSavedDeps has no save/discard/activate/confirmDraft — plan 19 has no persistence verbs.
      save: async () => true,
    };
    expect(bad).toBeTruthy();
  });
});
