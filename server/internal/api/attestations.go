package api

import (
	"encoding/json"
	"net/http"

	"github.com/VenatioDecorus/runa/server/internal/record"
)

// Attestation & verification (Phase 6 / M6, docs/protocol.md §8). Public by
// design: a verifiability claim is useless if hidden. The server is a
// registry and router of attestations, never an oracle of identity — TOFU
// everywhere, verification never gates any capability (docs/architecture.md
// invariant 6).

// validateAttestationIngest runs the attestation / attestation-revoke
// ingest rules of docs/protocol.md §6 after the usual signature + cert-
// chain verification: subject must be a well-formed, known account before
// the type-specific structural checks run. Returns false after writing the
// error response.
func (s *server) validateAttestationIngest(w http.ResponseWriter, rec *record.Record, typ string) bool {
	subject, _ := rec.String("subject")
	if _, err := record.DecodeKey(subject); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", "subject: "+err.Error())
		return false
	}
	exists, err := s.st.AccountExists(subject)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	if !exists {
		writeError(w, http.StatusBadRequest, "unknown_account", "subject has no account on this instance")
		return false
	}
	if typ == "attestation" {
		if err := record.ValidateAttestation(rec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
			return false
		}
		return true
	}
	if err := record.ValidateAttestationRevoke(rec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return false
	}
	return true
}

// handleGetAttestations serves subject's active attestations — public by
// design (docs/protocol.md §6, §8): unauthenticated, reverse-chronological,
// paginated. "Active" means not superseded by a later attestation-revoke
// from the same author (materialized latest-wins, ties favor the revoke —
// §8.1). The authors bundle is the usual convenience-not-authority: clients
// verify each attestation's signature + cert chain and apply their own
// trust filter before displaying anything (§8.3).
func (s *server) handleGetAttestations(w http.ResponseWriter, r *http.Request) {
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
	limit, ok := pageLimit(w, r)
	if !ok {
		return
	}
	rows, nextBefore, err := s.st.ActiveAttestationsOf(id, limit, r.URL.Query().Get("before"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	attestations := make([]json.RawMessage, len(rows))
	authors := map[string]any{}
	for i, row := range rows {
		attestations[i] = json.RawMessage(row.Body)
		if _, done := authors[row.Account]; done {
			continue
		}
		bundle, err := s.authorBundle(row.Account)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		authors[row.Account] = bundle
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"attestations": attestations,
		"authors":      authors,
		"next_before":  nullableStr(nextBefore),
	})
}
