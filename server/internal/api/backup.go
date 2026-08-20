package api

import (
	"encoding/json"
	"net/http"
)

func (s *server) handleUpsertBackup(w http.ResponseWriter, r *http.Request) {
	account := s.authAccount(w, r)
	if account == "" {
		return
	}
	var req struct {
		Blob json.RawMessage `json:"blob"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return
	}
	if len(req.Blob) == 0 || string(req.Blob) == "null" {
		writeError(w, http.StatusBadRequest, "invalid_request", "missing blob")
		return
	}
	if err := s.st.UpsertBackup(account, string(req.Blob), nowUTC()); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleGetBackup is deliberately unauthenticated (docs/protocol.md §6 PoC
// caveat): the recovering user has no device key to sign with, and the
// blob is Argon2id-encrypted client-side.
func (s *server) handleGetBackup(w http.ResponseWriter, r *http.Request) {
	blob, ok, err := s.st.GetBackup(r.PathValue("account"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "no backup for this account")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"blob": json.RawMessage(blob)})
}
