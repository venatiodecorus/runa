package api

import (
	"crypto/subtle"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// Operator review queue (Phase 7 / M7, docs/protocol.md §9.4) — the human
// rung. Automation may only move the early rungs: an entry opens
// automatically when a target's p_auto reaches report_auto_cap, and a human
// decides anything further. This is instance-local operations, not
// protocol-visible to users: the endpoints exist only when an operator
// token is configured (`-admin-token` / RUNAD_ADMIN_TOKEN), and are absent
// (404, from the mux having no route) otherwise.
//
// The review capability over encrypted content IS the reporters'
// forwarding (threat model A5) — the entries carry the reporters' signed
// records including any forwarded plaintext, and never a server key.
//
// The final ladder rung (account action) is deliberately absent: penalties
// never delete content or sever edges (trust-and-reach §5), and
// governance.md owns the human process before any such mechanism exists.

// adminAuth checks the operator bearer token. Constant-time comparison:
// the token is a shared secret, not a public identifier.
func (s *server) adminAuth(w http.ResponseWriter, r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "operator token required")
		return false
	}
	return true
}

// accountStanding assembles one account's full standing picture — the
// operator's view, which unlike GET /standing does name the numbers.
func (c *standingCalc) accountStanding(account string) (standing, pAuto, pAdj float64, frozenUntil string, err error) {
	if pAdj, err = c.adjPenalty(account); err != nil {
		return
	}
	if pAuto, err = c.autoPenalty(account); err != nil {
		return
	}
	if frozenUntil, err = c.frozenUntil(account); err != nil {
		return
	}
	standing = trust.StandingFrom(pAuto, pAdj)
	return
}

// handleAdminReview lists every open entry with the evidence behind it.
func (s *server) handleAdminReview(w http.ResponseWriter, r *http.Request) {
	if !s.adminAuth(w, r) {
		return
	}
	open, err := s.st.ListOpenReviews()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	calc := s.standingCalc()
	entries := make([]map[string]any, 0, len(open))
	for _, e := range open {
		standing, pAuto, pAdj, frozenUntil, err := calc.accountStanding(e.Account)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		reports, err := s.st.ReportsForSubjectSince(e.Account, calc.windowStart())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		bodies := make([]json.RawMessage, len(reports))
		for i, rep := range reports {
			bodies[i] = json.RawMessage(rep.Body)
		}
		entries = append(entries, map[string]any{
			"account":      e.Account,
			"opened_at":    e.OpenedAt,
			"standing":     standing,
			"p_auto":       pAuto,
			"p_adj":        pAdj,
			"frozen_until": nullableStr(frozenUntil),
			"reports":      bodies,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// reviewDecisions are the operator decisions §9.4 defines. Anything else is
// rejected rather than interpreted.
var reviewDecisions = map[string]bool{
	"dismiss": true,
	"uphold":  true,
	"freeze":  true,
	"none":    true,
}

// handleAdminReviewDecide closes an open entry with one of the §9.4
// decisions, applying its state change first:
//
//	dismiss — the window's reports are adjudicated false: excluded from mass
//	          forever, and each distinct reporter's own p_adj rises by
//	          false_report_burn (capped at 1.0). Reports carry consequences
//	          in both directions (design §4.1).
//	uphold  — the target's p_adj = max(decayed current, report_uphold_penalty),
//	          its decay clock restarted. It decays per half-life: no
//	          permanent marks.
//	freeze  — cold outreach frozen until now + freeze_days.
//	none    — close without action.
func (s *server) handleAdminReviewDecide(w http.ResponseWriter, r *http.Request) {
	if !s.adminAuth(w, r) {
		return
	}
	account := r.PathValue("account")
	var req struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
	}
	body, err := readAll(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return
	}
	if !reviewDecisions[req.Decision] {
		writeError(w, http.StatusBadRequest, "invalid_request",
			`decision must be one of "dismiss", "uphold", "freeze", "none"`)
		return
	}
	entry, err := s.st.OpenReviewFor(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "not_found", "no open review entry for this account")
		return
	}

	calc := s.standingCalc()
	now := rfc3339(calc.now)
	switch req.Decision {
	case "dismiss":
		reporters, err := s.st.DismissReportsForSubjectSince(account, calc.windowStart())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		for _, reporter := range reporters {
			current, err := calc.adjPenalty(reporter)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			burned := math.Min(1, current+trust.FalseReportBurn)
			if err := s.st.SetAdjPenalty(reporter, burned, now); err != nil {
				writeError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
		}
	case "uphold":
		current, err := calc.adjPenalty(account)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if err := s.st.SetAdjPenalty(account, math.Max(current, trust.ReportUpholdPenalty), now); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	case "freeze":
		until := rfc3339(calc.now.Add(time.Duration(trust.FreezeDays) * 24 * time.Hour))
		if err := s.st.SetFrozenUntil(account, until); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	if err := s.st.ResolveReview(entry.ID, now, req.Decision, req.Note); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}

	// Report the post-decision picture from a fresh computation: the
	// memoized one predates the state change.
	after := s.standingCalc()
	standing, pAuto, pAdj, frozenUntil, err := after.accountStanding(account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account":      account,
		"decision":     req.Decision,
		"standing":     standing,
		"p_auto":       pAuto,
		"p_adj":        pAdj,
		"frozen_until": nullableStr(frozenUntil),
	})
}
