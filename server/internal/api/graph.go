package api

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/store"
	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// --- ingest materialization ---

// newerNegationExists reports whether the account has a stored negation
// record (unfollow/unmute) for subject strictly newer than createdAt.
// Latest created_at wins even when records arrive out of order.
func (s *server) newerNegationExists(account, negType, subject, createdAt string) (bool, error) {
	bodies, err := s.st.RecordBodies(account, negType)
	if err != nil {
		return false, err
	}
	for _, body := range bodies {
		var neg struct {
			Subject   string `json:"subject"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.Unmarshal(body, &neg); err != nil {
			return false, err
		}
		if neg.Subject == subject && neg.CreatedAt > createdAt {
			return true, nil
		}
	}
	return false, nil
}

// applyGraphRecord materializes a verified, stored graph record into the
// follows/mutes tables. Latest created_at wins: a negation removes the edge
// only if strictly newer than the stored edge, and an edge record older
// than an already-stored negation materializes nothing.
func (s *server) applyGraphRecord(typ string, rec *record.Record, recordID string) error {
	subject, _ := rec.String("subject")
	edge := store.Edge{
		Owner:     rec.Author(),
		Subject:   subject,
		RecordID:  recordID,
		CreatedAt: rec.CreatedAt(),
	}
	switch typ {
	case "follow":
		newer, err := s.newerNegationExists(rec.Author(), "unfollow", subject, rec.CreatedAt())
		if err != nil || newer {
			return err
		}
		return s.st.UpsertFollow(edge)
	case "unfollow":
		return s.st.DeleteFollowBefore(rec.Author(), subject, rec.CreatedAt())
	case "mute":
		newer, err := s.newerNegationExists(rec.Author(), "unmute", subject, rec.CreatedAt())
		if err != nil || newer {
			return err
		}
		return s.st.UpsertMute(edge)
	case "unmute":
		return s.st.DeleteMuteBefore(rec.Author(), subject, rec.CreatedAt())
	}
	return nil
}

// newerOrEqualRevokeExists reports whether the attester has a stored
// attestation-revoke of subject with created_at >= createdAt — the §8.1
// tie-break: a revoke that ties with (or postdates) an attestation
// supersedes it, the opposite of newerNegationExists' strict inequality
// for follow/unfollow.
func (s *server) newerOrEqualRevokeExists(attester, subject, createdAt string) (bool, error) {
	bodies, err := s.st.RecordBodies(attester, "attestation-revoke")
	if err != nil {
		return false, err
	}
	for _, body := range bodies {
		var rev struct {
			Subject   string `json:"subject"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.Unmarshal(body, &rev); err != nil {
			return false, err
		}
		if rev.Subject == subject && rev.CreatedAt >= createdAt {
			return true, nil
		}
	}
	return false, nil
}

// applyAttestationRecord materializes a verified, stored attestation or
// attestation-revoke record into the attestations table (docs/protocol.md
// §8.1): latest created_at wins per (attester, subject), with ties broken
// toward the revoke — a revoke with created_at >= the attestation's
// supersedes it, in both arrival orders.
func (s *server) applyAttestationRecord(typ string, rec *record.Record, recordID string) error {
	subject, _ := rec.String("subject")
	switch typ {
	case "attestation":
		superseded, err := s.newerOrEqualRevokeExists(rec.Author(), subject, rec.CreatedAt())
		if err != nil || superseded {
			return err
		}
		method, _ := rec.String("method")
		return s.st.UpsertAttestation(store.Attestation{
			Attester:  rec.Author(),
			Subject:   subject,
			Method:    method,
			RecordID:  recordID,
			CreatedAt: rec.CreatedAt(),
		})
	case "attestation-revoke":
		return s.st.DeleteAttestationsBeforeOrAt(rec.Author(), subject, rec.CreatedAt())
	}
	return nil
}

// --- endpoints ---

// handleGetFollows serves the current outbound follow list as signed
// records. Visibility (design §8): the requester must be {id}, a follower
// of {id}, or {id} must have opted up to public via `"follows_public":
// true` in their latest profile record.
func (s *server) handleGetFollows(w http.ResponseWriter, r *http.Request) {
	viewer := s.authAccount(w, r)
	if viewer == "" {
		return
	}
	id := r.PathValue("id")
	exists, err := s.st.AccountExists(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "not_found", "no such account")
		return
	}
	allowed := viewer == id
	if !allowed {
		allowed, err = s.st.IsFollowing(viewer, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	if !allowed {
		profile, err := s.st.LatestRecordBody(id, "profile")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if profile != nil {
			var p struct {
				FollowsPublic bool `json:"follows_public"`
			}
			if err := json.Unmarshal(profile, &p); err == nil && p.FollowsPublic {
				allowed = true
			}
		}
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "not_visible", "follow list is visible to followers only")
		return
	}
	bodies, err := s.st.FollowRecords(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"follows": rawList(bodies)})
}

// graphView assembles the viewer's entitled 2-hop slice: their own follow
// list, the follow list of each followee (entitled: following makes the
// viewer their follower), and the viewer's private mutes. Off-instance
// followees simply have empty lists.
func (s *server) graphView(viewer string) (trust.GraphView, error) {
	subjects, err := s.st.FollowSubjects(viewer)
	if err != nil {
		return trust.GraphView{}, err
	}
	follows := map[string][]string{viewer: subjects}
	for _, subject := range subjects {
		theirs, err := s.st.FollowSubjects(subject)
		if err != nil {
			return trust.GraphView{}, err
		}
		follows[subject] = theirs
	}
	mutes, err := s.st.MuteSubjects(viewer)
	if err != nil {
		return trust.GraphView{}, err
	}
	return trust.GraphView{Follows: follows, Mutes: mutes}, nil
}

// handleGraph2hop serves the viewer's entitled slice in exactly the
// GraphView-plus-mutes shape of docs/protocol.md §6 — the input to the
// published client-side trust computation.
func (s *server) handleGraph2hop(w http.ResponseWriter, r *http.Request) {
	viewer := s.authAccount(w, r)
	if viewer == "" {
		return
	}
	gv, err := s.graphView(viewer)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"follows": gv.Follows,
		"mutes":   gv.Mutes,
	})
}

type feedItem struct {
	Record         json.RawMessage `json:"record"`
	Author         string          `json:"author"`
	CandidateTrust float64         `json:"candidate_trust"`
	ReplyCount     int             `json:"reply_count"`

	createdAt string
	id        string
}

// candidateTrust returns the viewer's proposed trust in author, the same
// value /feed ranks by: 0 for an anonymous viewer, for an author viewing
// their own record (SubjectiveTrust has no self-trust), or when no trust
// path exists. It is a proposal only — clients recompute from /graph/2hop
// and /meta before rendering anything as trusted.
func (s *server) candidateTrust(viewer, author string) (float64, error) {
	if viewer == "" || viewer == author {
		return 0, nil
	}
	gv, err := s.graphView(viewer)
	if err != nil {
		return 0, err
	}
	return trust.SubjectiveTrust(viewer, author, gv, trust.DefaultParams), nil
}

// handleFeed serves the candidate feed: post records from every account
// with positive trust in the viewer's TrustMap (mutes applied, standing 1.0
// pre-M7), ranked candidate_trust desc then created_at desc. The trust
// values are proposals — clients recompute from /graph/2hop and re-rank.
// The authors map carries each appearing author's device certs and
// revocations so clients can verify without per-author fetches.
func (s *server) handleFeed(w http.ResponseWriter, r *http.Request) {
	viewer := s.authAccount(w, r)
	if viewer == "" {
		return
	}
	limit, ok := pageLimit(w, r)
	if !ok {
		return
	}
	gv, err := s.graphView(viewer)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	// TrustMap never includes the viewer, so their own posts are excluded by
	// construction; muted accounts are absent (implicit zero).
	tm := trust.TrustMap(viewer, gv, trust.DefaultParams)
	items := []feedItem{}
	for author, tr := range tm {
		if tr <= 0 {
			continue
		}
		rows, err := s.st.ListRecords(author, []string{"post"}, limit, "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		// Tier-3 (§5.6): scoped posts change audience, not trust. They join
		// the same candidate pool under the same ranking, but only from
		// epochs the viewer is a member of — key possession is necessary and
		// never sufficient for feed placement.
		scoped, err := s.st.MemberScopedPosts(author, viewer, limit, "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		rows = append(rows, scoped...)
		for _, row := range rows {
			replyCount, err := s.st.ReplyCount(row.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", err.Error())
				return
			}
			items = append(items, feedItem{
				Record:         json.RawMessage(row.Body),
				Author:         author,
				CandidateTrust: tr,
				ReplyCount:     replyCount,
				createdAt:      row.CreatedAt,
				id:             row.ID,
			})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CandidateTrust != items[j].CandidateTrust {
			return items[i].CandidateTrust > items[j].CandidateTrust
		}
		if items[i].createdAt != items[j].createdAt {
			return items[i].createdAt > items[j].createdAt
		}
		return items[i].id > items[j].id // deterministic tie-break
	})
	if len(items) > limit {
		items = items[:limit]
	}
	authors := map[string]any{}
	for _, it := range items {
		if _, done := authors[it.Author]; done {
			continue
		}
		bundle, err := s.authorBundle(it.Author)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		authors[it.Author] = bundle
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":   items,
		"authors": authors,
	})
}
