package api

import (
	"encoding/json"
	"net/http"
	"slices"

	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// handleGetRecord serves a single record by id, plus the context a client
// needs to verify and render it: the author's device certs/revocations and
// latest profile, a reply count, and a proposed candidate_trust. Only
// publicListTypes are ever served — any other type, and any unknown id,
// get the identical 404 so a private record's existence is never revealed
// (docs/protocol.md §6, design §8).
func (s *server) handleGetRecord(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	viewer, err := s.optionalAuthAccount(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	row, err := s.st.GetRecord(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if row == nil || !slices.Contains(publicListTypes, row.Type) {
		writeError(w, http.StatusNotFound, "not_found", "no such record")
		return
	}
	author, err := s.authorBundle(row.Account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	replyCount, err := s.st.ReplyCount(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	tr, standing, err := s.candidateTrust(viewer, row.Account)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"record":          json.RawMessage(row.Body),
		"author":          author,
		"reply_count":     replyCount,
		"candidate_trust": tr,
		"standing":        standing,
	})
}

// handleRecordReplies serves one thread-order page of a post's replies.
// Visibility follows the parent: it must exist as a publicListTypes record,
// else the same 404 as an unknown id. Every reply is included regardless of
// the viewer's trust in its author (design §5.1: "reply exists in-thread
// regardless — only the author-notification and default rank are gated") —
// candidate_trust is carried per item so the client buckets/re-ranks, not
// the server.
func (s *server) handleRecordReplies(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	viewer, err := s.optionalAuthAccount(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	limit, ok := pageLimit(w, r)
	if !ok {
		return
	}
	parent, err := s.st.GetRecord(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if parent == nil || !slices.Contains(publicListTypes, parent.Type) {
		writeError(w, http.StatusNotFound, "not_found", "no such record")
		return
	}
	rows, err := s.st.Replies(id, limit, r.URL.Query().Get("after"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	// One graphView + TrustMap for the whole page rather than one
	// SubjectiveTrust call (and its own graphView fetch) per reply.
	var tm map[string]float64
	if viewer != "" {
		gv, err := s.graphView(viewer)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		tm = trust.TrustMap(viewer, gv, trust.DefaultParams)
	}
	calc := s.standingCalc()
	items := make([]map[string]any, 0, len(rows))
	authors := map[string]any{}
	for _, row := range rows {
		replyCount, err := s.st.ReplyCount(row.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		// Standing multiplies the candidate value (§9.3) but never gates a
		// reply's existence: every reply is served regardless (design §5.1 —
		// throttle, don't silence), so the client buckets and re-ranks.
		standing, err := calc.standing(row.Account)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		var tr float64
		if viewer != "" && viewer != row.Account {
			// Implicit zero: muted, no path, or absent from the trust map.
			tr = trust.EffectiveTrust(tm[row.Account], standing)
		}
		items = append(items, map[string]any{
			"record":          json.RawMessage(row.Body),
			"author":          row.Account,
			"candidate_trust": tr,
			"standing":        standing,
			"reply_count":     replyCount,
		})
		if _, done := authors[row.Account]; !done {
			bundle, err := s.authorBundle(row.Account)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			authors[row.Account] = bundle
		}
	}
	var nextAfter any
	if len(rows) == limit {
		nextAfter = rows[len(rows)-1].CreatedAt
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"authors":    authors,
		"next_after": nextAfter,
	})
}
