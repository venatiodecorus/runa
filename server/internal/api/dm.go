package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// validateDMIngest runs the dm-specific ingest checks (docs/protocol.md §4,
// §6) after the usual signature + cert-chain verification: envelope
// structure, pinned alg, and a `to` that names a local account. The
// ciphertext and recipient entries are opaque — the server cannot and must
// not attempt decryption. Returns false after writing the error response.
func (s *server) validateDMIngest(w http.ResponseWriter, rec *record.Record) bool {
	if err := record.ValidateDMEnvelope(rec); err != nil {
		switch {
		case errors.Is(err, record.ErrUnsupportedAlg):
			writeError(w, http.StatusBadRequest, "unsupported_alg", err.Error())
		case errors.Is(err, record.ErrInvalidTo):
			writeError(w, http.StatusBadRequest, "unknown_account", err.Error())
		default:
			writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		}
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
	return true
}

// handleDMWith serves one page of the viewer's conversation with {id}: dm
// records where (author=viewer AND to=id) OR (author=id AND to=viewer),
// oldest→newest within the page, stored canonical bytes verbatim. Paging
// (`limit`/`before`, next_before) walks backwards through history as for
// /accounts/{id}/records.
func (s *server) handleDMWith(w http.ResponseWriter, r *http.Request) {
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
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		limit = min(n, 200)
	}
	bodies, nextBefore, err := s.st.DMsWith(viewer, id, limit, r.URL.Query().Get("before"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"records":     rawList(bodies),
		"next_before": nullableStr(nextBefore),
	})
}

// handleDMInbox serves one entry per counterparty, sorted by last activity
// desc. `request` classifies cold inbound (Phase-3 tray, classification
// only — token spend arrives with M4): true iff the viewer has no trust
// path to the counterparty (viewer's graph + mutes, exactly as /feed) AND
// the viewer has never sent a dm to that counterparty.
func (s *server) handleDMInbox(w http.ResponseWriter, r *http.Request) {
	viewer := s.authAccount(w, r)
	if viewer == "" {
		return
	}
	convs, err := s.st.DMInbox(viewer)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	gv, err := s.graphView(viewer)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	// TrustMap never keys the viewer and omits muted accounts (implicit
	// zero), so absence ⇒ no trust path.
	tm := trust.TrustMap(viewer, gv, trust.DefaultParams)
	type conversation struct {
		With    string          `json:"with"`
		Last    json.RawMessage `json:"last"`
		Request bool            `json:"request"`
	}
	out := make([]conversation, len(convs))
	for i, c := range convs {
		request := !c.ViewerSent && c.With != viewer && tm[c.With] <= 0
		out[i] = conversation{With: c.With, Last: json.RawMessage(c.LastBody), Request: request}
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": out})
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
