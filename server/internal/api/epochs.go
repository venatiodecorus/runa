package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/store"
)

// tier3StructuralCode maps a Validate* failure to its error code: a
// non-pinned alg is unsupported_alg exactly as on the tier-2 path (§5.3/§5.4
// reuse the §4 mechanism verbatim, error codes included); everything else is
// invalid_record.
func tier3StructuralCode(err error) string {
	if errors.Is(err, record.ErrUnsupportedAlg) {
		return "unsupported_alg"
	}
	return "invalid_record"
}

// Tier-3 scoped posts (Phase 5, docs/protocol.md §5, §6). The server
// materializes epoch scope and the frozen fan-out membership, enforces who
// may grant keys and who may post, and serves scoped posts to members only.
// Wraps and ciphertext are opaque throughout: no decryption key ever
// reaches this process (docs/architecture.md invariant 3).

// validateTier3Ingest runs the epoch / epoch-key / scoped-post ingest rules
// after the usual signature + cert-chain verification: structural checks,
// epoch existence, and the §5.3 authorization rules. Returns false after
// writing the error response.
func (s *server) validateTier3Ingest(w http.ResponseWriter, rec *record.Record) bool {
	switch rec.Type() {
	case "epoch":
		// Unknown and reserved scope sources alike are rejected rather than
		// interpreted (§5.1); the fan-out itself is never validated against
		// the named scope — that is client authority.
		if err := record.ValidateEpoch(rec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
			return false
		}
		return true

	case "epoch-key":
		if err := record.ValidateEpochKey(rec); err != nil {
			writeError(w, http.StatusBadRequest, tier3StructuralCode(err), err.Error())
			return false
		}
		epoch, ok := s.lookupEpoch(w, rec)
		if !ok {
			return false
		}
		to, _ := rec.String("to")
		exists, err := s.st.AccountExists(to)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		if !exists {
			writeError(w, http.StatusBadRequest, "unknown_account", "to: recipient has no account on this instance")
			return false
		}
		if rec.Author() == epoch.Author {
			return true
		}
		// Late wraps (§5.3): a member may re-wrap the epoch key to another
		// member's new device, but only the epoch author admits new accounts.
		authorMember, err := s.st.IsEpochMember(epoch.ID, rec.Author())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		toMember, err := s.st.IsEpochMember(epoch.ID, to)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		if !authorMember || !toMember {
			writeError(w, http.StatusForbidden, "not_epoch_member",
				"only the epoch author may admit accounts; members may re-wrap only to existing members")
			return false
		}
		return true

	case "scoped-post":
		if err := record.ValidateScopedPost(rec); err != nil {
			writeError(w, http.StatusBadRequest, tier3StructuralCode(err), err.Error())
			return false
		}
		epoch, ok := s.lookupEpoch(w, rec)
		if !ok {
			return false
		}
		// v1: only the epoch's author may post into it (§5.4; the group layer
		// widens this to members).
		if rec.Author() != epoch.Author {
			writeError(w, http.StatusForbidden, "not_epoch_author", "only the epoch's author may post into it")
			return false
		}
		return true
	}
	return true
}

// lookupEpoch resolves the record's `epoch` field to an ingested epoch,
// writing 400 unknown_epoch if this instance has never seen it.
func (s *server) lookupEpoch(w http.ResponseWriter, rec *record.Record) (*store.Epoch, bool) {
	epochID, _ := rec.String("epoch")
	epoch, err := s.st.GetEpoch(epochID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return nil, false
	}
	if epoch == nil {
		writeError(w, http.StatusBadRequest, "unknown_epoch", "epoch: no such epoch record on this instance")
		return nil, false
	}
	return epoch, true
}

// applyTier3Record materializes a verified, stored tier-3 record: the epoch
// and its author-membership, the membership an accepted key grant confers,
// or a scoped post's epoch binding.
func (s *server) applyTier3Record(typ string, rec *record.Record, recordID string) error {
	switch typ {
	case "epoch":
		scope, _ := rec.Map("scope")
		source, _ := scope["source"].(string)
		prev, _ := rec.String("prev")
		return s.st.InsertEpoch(store.Epoch{
			ID:          recordID,
			Author:      rec.Author(),
			ScopeSource: source,
			Prev:        prev,
			CreatedAt:   rec.CreatedAt(),
		})
	case "epoch-key":
		epochID, _ := rec.String("epoch")
		to, _ := rec.String("to")
		return s.st.InsertEpochKey(recordID, epochID, to, rec.CreatedAt())
	case "scoped-post":
		epochID, _ := rec.String("epoch")
		return s.st.InsertScopedPost(recordID, epochID, rec.Author(), rec.CreatedAt())
	}
	return nil
}

// handleEpochKeys serves the viewer's key grants (epoch-key records naming
// them as `to`), newest first, with every referenced epoch record inlined so
// the client learns scope/prev/author without extra round-trips
// (docs/protocol.md §6). Grants addressed to anyone else are never served —
// a grant is a key, and keys are for their recipient only.
func (s *server) handleEpochKeys(w http.ResponseWriter, r *http.Request) {
	viewer := s.authAccount(w, r)
	if viewer == "" {
		return
	}
	limit, ok := pageLimit(w, r)
	if !ok {
		return
	}
	grants, nextBefore, err := s.st.EpochKeysFor(viewer, limit, r.URL.Query().Get("before"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	keys := make([]json.RawMessage, len(grants))
	epochs := map[string]json.RawMessage{}
	for i, g := range grants {
		keys[i] = json.RawMessage(g.Body)
		if _, done := epochs[g.EpochID]; done {
			continue
		}
		body, err := s.st.EpochRecordBody(g.EpochID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if body != nil {
			epochs[g.EpochID] = json.RawMessage(body)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"keys":        keys,
		"epochs":      epochs,
		"next_before": nullableStr(nextBefore),
	})
}

// pageLimit parses the shared `limit` query parameter (default 50, capped
// at 200). Returns false after writing the error response.
func pageLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return 50, true
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
		return 0, false
	}
	return min(n, 200), true
}
