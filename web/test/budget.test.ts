/**
 * Cold-outreach budget UX helpers (dm/budget.ts): meter formatting, the
 * core-math audit of the server's daily_budget, and the composer send-state
 * machine — in particular that a 429 budget_exhausted NEVER loses the draft.
 */
import { describe, expect, it } from "vitest";
import { CONSTANTS, dailyBudget } from "@runa/core";
import { ApiError, type BudgetInfo } from "../src/api/client.js";
import {
  auditDailyBudget,
  composerSendFailure,
  composerSendStart,
  composerSendSuccess,
  formatBudgetMeter,
  initialComposer,
  type ComposerState,
} from "../src/dm/budget.js";

describe("formatBudgetMeter", () => {
  it("floors both sides for display", () => {
    expect(formatBudgetMeter(3.9, 14.6)).toBe("3 of 14");
    expect(formatBudgetMeter(5, 5)).toBe("5 of 5");
  });

  it("clamps negatives to zero and keeps carryover overshoot honest", () => {
    expect(formatBudgetMeter(-0.2, 5)).toBe("0 of 5");
    // carryover cap = 2 × daily (published constant), so X > Y is legitimate
    expect(formatBudgetMeter(9.99, 5)).toBe("9 of 5");
  });
});

describe("auditDailyBudget", () => {
  const info = (over: Partial<BudgetInfo>): BudgetInfo => ({
    daily_budget: 5,
    tokens: 5,
    base: 5,
    inbound_trust: 0,
    carryover_cap: 10,
    ...over,
  });

  it("agrees when the server used the published formula (core dailyBudget)", () => {
    const inbound = 11;
    const daily = dailyBudget(5, inbound); // shipping core math, published k
    expect(CONSTANTS.budget_growth_k).toBe(4);
    expect(auditDailyBudget(info({ daily_budget: daily, inbound_trust: inbound }))).toBe(true);
  });

  it("flags a server figure that deviates from the published formula", () => {
    expect(auditDailyBudget(info({ daily_budget: 99, inbound_trust: 11 }))).toBe(false);
  });
});

describe("composer send-state machine", () => {
  const composed: ComposerState = { draft: "hello there", sending: false, notice: null };

  it("start marks sending and clears any stale notice; success clears the draft", () => {
    const started = composerSendStart({ ...composed, notice: { kind: "error", message: "old" } });
    expect(started).toEqual({ draft: "hello there", sending: true, notice: null });
    expect(composerSendSuccess(started)).toEqual(initialComposer);
  });

  it("budget_exhausted (429) preserves the composed text and yields a budget notice", () => {
    const err = new ApiError(429, "budget_exhausted", "cold-outreach budget exhausted (base 5/day)");
    const next = composerSendFailure(composerSendStart(composed), err);
    expect(next.draft).toBe("hello there"); // nothing composed is ever lost
    expect(next.sending).toBe(false);
    expect(next.notice).toEqual({
      kind: "budget_exhausted",
      serverMessage: "cold-outreach budget exhausted (base 5/day)",
    });
  });

  it("other failures also preserve the draft, as a plain error notice", () => {
    const next = composerSendFailure(composerSendStart(composed), new Error("network down"));
    expect(next.draft).toBe("hello there");
    expect(next.notice).toEqual({ kind: "error", message: "network down" });

    const nonError = composerSendFailure(composed, "boom");
    expect(nonError.draft).toBe("hello there");
    expect(nonError.notice).toEqual({ kind: "error", message: "boom" });
  });

  it("a non-budget ApiError is NOT dressed up as a budget notice", () => {
    const err = new ApiError(400, "invalid_record", "bad sig");
    const next = composerSendFailure(composed, err);
    expect(next.notice).toEqual({ kind: "error", message: "bad sig" });
  });
});
