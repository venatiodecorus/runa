package api

import (
	"net/http"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// Standing (Phase 7 / M7, docs/protocol.md §9.3, trust-and-reach §4): the
// one server-computed, server-authoritative enforcement factor, computed
// lazily at read time from stored adjudication state plus the graph. The
// math itself lives in internal/trust/standing.go (vector-shared with
// packages/core); everything here is the storage plumbing around it.
//
// Well-foundedness (the grounding rule of trust-and-reach §4): a reporter's
// weight uses their *adjudicated* component only, and the Σ inbound_trust
// inside that weight likewise weights followers by 1 − p_adj. Since p_adj is
// stored state, the recursion bottoms out immediately — standing(A) →
// p_auto(A) → reporterWeight(R) → Σ over R's followers of (1 − p_adj(F)),
// and no p_auto is ever needed to compute another p_auto. The *budget*
// formula's Σ weights followers by full standing (§3), which is grounded the
// same way one level up.

// standingCalc is one request's standing computation, memoizing the values
// it derives so a feed page recomputing dozens of authors' standings (each
// summing over followers) hits the database once per account.
type standingCalc struct {
	s    *server
	now  time.Time
	adj  map[string]float64
	auto map[string]float64
	full map[string]float64
}

func (s *server) standingCalc() *standingCalc {
	return &standingCalc{
		s:    s,
		now:  s.now().UTC(),
		adj:  map[string]float64{},
		auto: map[string]float64{},
		full: map[string]float64{},
	}
}

// windowStart is the oldest created_at a report may carry and still count
// toward p_auto: now − report_window_days (trust-and-reach §4, "reports age
// out of the window — that is the automated rung's decay").
func (c *standingCalc) windowStart() string {
	return c.now.Add(-time.Duration(trust.ReportWindowDays) * 24 * time.Hour).Format("2006-01-02T15:04:05Z")
}

// adjPenalty is p_adj(A, now): the stored adjudicated penalty decayed with
// the standing half-life since it was set. No stored row (or no timestamp)
// means 0 — the default, never-adjudicated case.
func (c *standingCalc) adjPenalty(account string) (float64, error) {
	if v, ok := c.adj[account]; ok {
		return v, nil
	}
	row, err := c.s.st.GetStanding(account)
	if err != nil {
		return 0, err
	}
	p := 0.0
	if row != nil && row.PAdj > 0 {
		elapsed := 0.0
		if row.PAdjUpdatedAt != "" {
			if set, perr := time.Parse(time.RFC3339, row.PAdjUpdatedAt); perr == nil {
				elapsed = c.now.Sub(set).Hours() / 24
			}
		}
		p = trust.DecayPenalty(row.PAdj, elapsed, trust.StandingHalfLifeDays)
	}
	c.adj[account] = p
	return p, nil
}

// inboundAdjWeighted is Σ inbound_trust(A) with each follower weighted by
// their adjudicated component 1 − p_adj — the grounding rule of
// trust-and-reach §4, used inside the reporter-weight formula so the mass
// computation never depends on any p_auto.
func (c *standingCalc) inboundAdjWeighted(account string) (float64, error) {
	followers, err := c.s.st.Followers(account)
	if err != nil {
		return 0, err
	}
	sum := 0.0
	for _, f := range followers {
		pAdj, err := c.adjPenalty(f)
		if err != nil {
			return 0, err
		}
		sum += 1 - pAdj
	}
	return sum, nil
}

// inboundStandingWeighted is Σ inbound_trust(A) with each follower weighted
// by their full standing — the budget formula's sum (trust-and-reach §3).
func (c *standingCalc) inboundStandingWeighted(account string) (float64, error) {
	followers, err := c.s.st.Followers(account)
	if err != nil {
		return 0, err
	}
	sum := 0.0
	for _, f := range followers {
		st, err := c.standing(f)
		if err != nil {
			return 0, err
		}
		sum += st
	}
	return sum, nil
}

// autoPenalty is p_auto(A, now): the diversity-weighted mass of A's
// non-dismissed reports inside the trailing window, capped
// (trust-and-reach §4). Accounts with no reports in the window — the
// overwhelming majority — take the cheap path and never touch the graph.
func (c *standingCalc) autoPenalty(account string) (float64, error) {
	if v, ok := c.auto[account]; ok {
		return v, nil
	}
	reports, err := c.s.st.ReportsForSubjectSince(account, c.windowStart())
	if err != nil {
		return 0, err
	}
	if len(reports) == 0 {
		c.auto[account] = 0
		return 0, nil
	}
	// Distinct reporters, in first-report order: volume from one reporter is
	// no more than one reporter's worth, and clustering handles volume from
	// one *region*.
	reporters := []string{}
	seen := map[string]bool{}
	for _, r := range reports {
		if seen[r.Reporter] {
			continue
		}
		seen[r.Reporter] = true
		reporters = append(reporters, r.Reporter)
	}
	weights := make(map[string]float64, len(reporters))
	follows := make(map[string][]string, len(reporters))
	for _, r := range reporters {
		pAdj, err := c.adjPenalty(r)
		if err != nil {
			return 0, err
		}
		inbound, err := c.inboundAdjWeighted(r)
		if err != nil {
			return 0, err
		}
		weights[r] = trust.ReporterWeight(pAdj, inbound)
		outbound, err := c.s.st.FollowSubjects(r)
		if err != nil {
			return 0, err
		}
		follows[r] = outbound
	}
	clusters := trust.ClusterReporters(reporters, follows, trust.ReportClusterJaccard)
	p := trust.AutoPenalty(trust.ReportMass(clusters, weights))
	c.auto[account] = p
	return p, nil
}

// standing is standing(A) = (1 − p_auto)(1 − p_adj) ∈ [0,1], default 1.0.
func (c *standingCalc) standing(account string) (float64, error) {
	if v, ok := c.full[account]; ok {
		return v, nil
	}
	// Memoize before recursing: inboundStandingWeighted (budget path) walks
	// followers, and a follow cycle would otherwise loop forever. A
	// provisional 1.0 is the default standing, so a cycle degrades to "not
	// yet penalized", never to a hang.
	c.full[account] = 1
	pAdj, err := c.adjPenalty(account)
	if err != nil {
		return 0, err
	}
	pAuto, err := c.autoPenalty(account)
	if err != nil {
		return 0, err
	}
	st := trust.StandingFrom(pAuto, pAdj)
	c.full[account] = st
	return st, nil
}

// frozenUntil returns the account's freeze deadline if one is in the
// future, else "" (§9.4).
func (c *standingCalc) frozenUntil(account string) (string, error) {
	row, err := c.s.st.GetStanding(account)
	if err != nil || row == nil || row.FrozenUntil == "" {
		return "", err
	}
	until, perr := time.Parse(time.RFC3339, row.FrozenUntil)
	if perr != nil || !c.now.Before(until) {
		return "", nil
	}
	return row.FrozenUntil, nil
}

// handleStanding is GET /standing (docs/protocol.md §9.3): the
// told-that-not-why disclosure of design §4.2. `reasons` names mechanisms
// only — never reporters, counts, or trigger values — and nothing here
// leaks how far past a threshold the account is.
func (s *server) handleStanding(w http.ResponseWriter, r *http.Request) {
	account := s.authAccount(w, r)
	if account == "" {
		return
	}
	c := s.standingCalc()
	pAdj, err := c.adjPenalty(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	pAuto, err := c.autoPenalty(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	frozen, err := c.frozenUntil(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	reasons := []string{}
	if pAuto > 0 {
		reasons = append(reasons, "reports")
	}
	if pAdj > 0 {
		reasons = append(reasons, "adjudication")
	}
	if frozen != "" {
		reasons = append(reasons, "frozen")
	}
	st := trust.StandingFrom(pAuto, pAdj)
	writeJSON(w, http.StatusOK, map[string]any{
		"standing":     st,
		"limited":      st < 1 || frozen != "",
		"reasons":      reasons,
		"frozen_until": nullableStr(frozen),
	})
}
