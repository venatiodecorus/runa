package api

import (
	"fmt"
	"net/http"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// Cold-outreach metering (Phase 4, docs/protocol.md §6, trust-and-reach §3):
// initiations are metered on ingest, after all verification and before
// storage. An initiation is cold iff the recipient's effective trust in the
// sender is below the surface threshold from the RECIPIENT's vantage AND no
// reciprocal window is open (the recipient has previously sent the sender a
// DM). Metered in the PoC: cold `dm` (recipient = `to`) and cold `follow`
// (recipient = `subject`). Everything else is never metered.

// bucketDateLayout is the UTC calendar-date granularity of lazy refill.
const bucketDateLayout = "2006-01-02"

// budgetExhaustedMessage names the published constants, as the spec
// requires of the 429 body.
func budgetExhaustedMessage() string {
	return fmt.Sprintf(
		"cold-outreach budget exhausted: base %d/day + %d×log(1+inbound trust), carryover cap %d days — refills daily",
		trust.ColdBudgetOpen, trust.BudgetGrowthK, trust.BudgetCarryoverDays,
	)
}

// bucketState is an account's meter after lazy refill.
type bucketState struct {
	Tokens       float64
	DailyBudget  float64
	InboundTrust float64
}

// refreshBucket brings the account's bucket current to "today" (UTC, via
// the injected clock): each elapsed whole day applies one RefillBucket with
// the CURRENT daily budget, recomputed from live inbound trust — the
// standing-weighted follower sum of trust-and-reach §3, multiplied by the
// sender's own standing (§9.3). A brand-new bucket starts with one daily
// budget. Standing shrinks the budget the moment it drops, and a refill
// after the penalty decays restores it: the whole formula is lazy.
func (s *server) refreshBucket(account string) (bucketState, error) {
	calc := s.standingCalc()
	inbound, err := calc.inboundStandingWeighted(account)
	if err != nil {
		return bucketState{}, err
	}
	senderStanding, err := calc.standing(account)
	if err != nil {
		return bucketState{}, err
	}
	budget := trust.DailyBudget(trust.ColdBudgetOpen, inbound, trust.BudgetGrowthK, senderStanding)
	today := s.now().UTC().Format(bucketDateLayout)
	b, err := s.st.GetBucket(account)
	if err != nil {
		return bucketState{}, err
	}
	if b == nil {
		if err := s.st.PutBucket(account, budget, today); err != nil {
			return bucketState{}, err
		}
		return bucketState{Tokens: budget, DailyBudget: budget, InboundTrust: inbound}, nil
	}
	tokens := b.Tokens
	if b.LastRefill != today {
		last, err := time.Parse(bucketDateLayout, b.LastRefill)
		if err != nil {
			return bucketState{}, fmt.Errorf("bucket last_refill: %w", err)
		}
		now, err := time.Parse(bucketDateLayout, today)
		if err != nil {
			return bucketState{}, err
		}
		elapsed := int(now.Sub(last).Hours() / 24)
		// RefillBucket saturates at the carryover cap, so beyond
		// BudgetCarryoverDays elapsed days further refills are no-ops.
		for i := 0; i < elapsed && i < trust.BudgetCarryoverDays; i++ {
			tokens = trust.RefillBucket(tokens, budget, trust.BudgetCarryoverDays)
		}
		if elapsed > 0 {
			if err := s.st.PutBucket(account, tokens, today); err != nil {
				return bucketState{}, err
			}
		}
	}
	return bucketState{Tokens: tokens, DailyBudget: budget, InboundTrust: inbound}, nil
}

// meterColdInitiation runs after all verification passes and before
// storage. It returns true when ingest may proceed (not an initiation, warm
// path, reciprocal window open, or a token was spent) and false after
// writing the response (429 budget_exhausted, or 500). On 429 the record is
// never stored.
func (s *server) meterColdInitiation(w http.ResponseWriter, rec *record.Record, typ string) bool {
	var recipient string
	switch typ {
	case "dm":
		// validateDMIngest already guaranteed `to` names a local account.
		recipient, _ = rec.String("to")
	case "follow":
		// unfollow/mute/unmute are never initiations. A follow whose subject
		// has no local account notifies nobody — nothing to meter.
		subject, _ := rec.String("subject")
		exists, err := s.st.AccountExists(subject)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		if !exists {
			return true
		}
		recipient = subject
	default:
		// Posts, profiles, certs, revocations, replies: never metered.
		return true
	}
	sender := rec.Author()
	if recipient == sender {
		return true // self-initiation reaches no one else's attention
	}
	// Recipient's vantage: the graph slice is built from the RECIPIENT's
	// follows and mutes, because budgets protect the receiver's attention.
	gv, err := s.graphView(recipient)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	calc := s.standingCalc()
	senderStanding, err := calc.standing(sender)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	// Cold classification uses effective trust — subjective × the sender's
	// standing (§9.3) — so a penalized sender is cold to more people.
	if !trust.IsColdInitiation(recipient, sender, gv, trust.DefaultParams, senderStanding) {
		return true // warm path is never metered
	}
	// Reciprocal window (DM-based): if the recipient has ever sent the
	// sender a dm, conversations already started stay free.
	reciprocal, err := s.st.HasDMFrom(recipient, sender)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	if reciprocal {
		return true
	}
	// A freeze (§9.4) zeroes cold outreach until frozen_until, regardless of
	// what the bucket holds. Warm paths and posting are untouched — the
	// check sits behind the cold + reciprocal-window classification above.
	frozen, err := calc.frozenUntil(sender)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	if frozen != "" {
		writeError(w, http.StatusTooManyRequests, "cold_outreach_frozen",
			"cold outreach is frozen until "+frozen)
		return false
	}
	if _, err := s.refreshBucket(sender); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	spent, err := s.st.SpendToken(sender)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	if !spent {
		writeError(w, http.StatusTooManyRequests, "budget_exhausted", budgetExhaustedMessage())
		return false
	}
	return true
}

// handleGetBudget serves the sender-side meter (docs/protocol.md §6) after
// lazy refill. carryover_cap is the bucket's token ceiling,
// budget_carryover_days × daily_budget. Floats appear only in responses,
// never in signed records.
func (s *server) handleGetBudget(w http.ResponseWriter, r *http.Request) {
	account := s.authAccount(w, r)
	if account == "" {
		return
	}
	st, err := s.refreshBucket(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"daily_budget":  st.DailyBudget,
		"tokens":        st.Tokens,
		"base":          trust.ColdBudgetOpen,
		"inbound_trust": st.InboundTrust,
		"carryover_cap": trust.BudgetCarryoverDays * st.DailyBudget,
	})
}
