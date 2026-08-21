// Package api wires the HTTP surface (/api/v1/...). Handlers verify
// signatures on ingest as hygiene; the client remains the authority
// (docs/architecture.md).
package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/store"
	"github.com/VenatioDecorus/runa/server/internal/trust"
)

const (
	SoftwareVersion = "0.0.1-dev"
	ProtocolVersion = "1"
)

type Config struct {
	InstanceName string
}

type server struct {
	st  *store.Store
	cfg Config

	// Outstanding auth challenges (single-use, short-lived). In-memory is
	// deliberate: a restart invalidating unanswered challenges is harmless.
	mu         sync.Mutex
	challenges map[string]time.Time
}

func New(st *store.Store, cfg Config) http.Handler {
	s := &server{st: st, cfg: cfg, challenges: make(map[string]time.Time)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/healthz", s.handleHealthz)
	mux.HandleFunc("GET /api/v1/meta", s.handleMeta)
	mux.HandleFunc("POST /api/v1/accounts", s.handleCreateAccount)
	mux.HandleFunc("GET /api/v1/accounts/{id}", s.handleGetAccount)
	mux.HandleFunc("GET /api/v1/accounts/{id}/records", s.handleListRecords)
	mux.HandleFunc("GET /api/v1/accounts/{id}/follows", s.handleGetFollows)
	mux.HandleFunc("GET /api/v1/graph/2hop", s.handleGraph2hop)
	mux.HandleFunc("GET /api/v1/feed", s.handleFeed)
	mux.HandleFunc("POST /api/v1/records", s.handleIngestRecord)
	mux.HandleFunc("GET /api/v1/auth/challenge", s.handleAuthChallenge)
	mux.HandleFunc("POST /api/v1/auth/session", s.handleAuthSession)
	mux.HandleFunc("POST /api/v1/backup", s.handleUpsertBackup)
	mux.HandleFunc("GET /api/v1/backup/{account}", s.handleGetBackup)
	return mux
}

func (s *server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleMeta is the instance self-description required by design §15: name,
// versions, and the constants this instance actually runs.
func (s *server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":             s.cfg.InstanceName,
		"software_version": SoftwareVersion,
		"protocol_version": ProtocolVersion,
		"constants":        trust.Constants(),
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
