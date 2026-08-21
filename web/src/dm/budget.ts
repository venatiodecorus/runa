/**
 * Cold-outreach budget UX helpers (protocol §6 `GET /budget`,
 * trust-and-reach §3).
 *
 * Why the meter is UNCONDITIONAL: coldness is classified from the
 * RECIPIENT's vantage (core `isColdInitiation` — budgets protect attention,
 * and attention belongs to receivers). The sender cannot compute that
 * vantage: the recipient's follow list is only served to entitled viewers.
 * So the composer shows the meter for every conversation instead of
 * predicting which sends will cost a token; the server remains the metering
 * authority and answers an exhausted bucket with `429 budget_exhausted`.
 *
 * What the client CAN predict with core math: the size of its own daily
 * budget. `auditDailyBudget` recomputes `dailyBudget(base, inbound_trust)`
 * locally and checks the server's figure agrees — audit, not authority,
 * same posture as feed re-ranking.
 *
 * Framework-free: no React imports.
 */
import { dailyBudget } from "@runa/core";
import { ApiError, type BudgetInfo } from "../api/client.js";

// --- meter formatting ---------------------------------------------------------

/**
 * "X of Y" for the meter. Tokens are floored for display (only whole tokens
 * are spendable-looking to a human; the fractional remainder still exists
 * server-side). Y is the floored daily budget; carryover can push X above Y
 * — that is real (cap = carryover_days × daily) and renders as e.g. "8 of 5".
 */
export function formatBudgetMeter(tokens: number, daily: number): string {
  const x = Math.floor(Math.max(0, tokens));
  const y = Math.floor(Math.max(0, daily));
  return `${x} of ${y}`;
}

/**
 * Recompute the daily budget with the shipping core math and compare with
 * the server's claim. Pre-M7 standing is the constant 1.0; k defaults to the
 * published `budget_growth_k` inside core `dailyBudget`.
 */
export function auditDailyBudget(info: BudgetInfo, epsilon = 1e-6): boolean {
  return Math.abs(dailyBudget(info.base, info.inbound_trust) - info.daily_budget) <= epsilon;
}

// --- composer send-state machine ------------------------------------------------

/**
 * Pure state helper for the DM composer's send lifecycle, so the
 * "budget_exhausted never loses composed text" guarantee is testable without
 * React. The UI owns rendering; this owns the transitions.
 */
export interface ComposerState {
  draft: string;
  sending: boolean;
  notice: SendNotice | null;
}

export type SendNotice =
  /** 429 budget_exhausted — expected, non-alarming; server message names the published constants. */
  | { kind: "budget_exhausted"; serverMessage: string }
  | { kind: "error"; message: string };

export const initialComposer: ComposerState = { draft: "", sending: false, notice: null };

export function composerSendStart(state: ComposerState): ComposerState {
  return { ...state, sending: true, notice: null };
}

/** Only success clears the draft. */
export function composerSendSuccess(_state: ComposerState): ComposerState {
  return { draft: "", sending: false, notice: null };
}

/**
 * Failure ALWAYS preserves the draft — nothing composed is ever lost. A 429
 * `budget_exhausted` becomes a calm budget notice (throttled, not silenced);
 * anything else stays a plain error.
 */
export function composerSendFailure(state: ComposerState, error: unknown): ComposerState {
  if (error instanceof ApiError && error.code === "budget_exhausted") {
    return {
      ...state,
      sending: false,
      notice: { kind: "budget_exhausted", serverMessage: error.message },
    };
  }
  return {
    ...state,
    sending: false,
    notice: { kind: "error", message: error instanceof Error ? error.message : String(error) },
  };
}
