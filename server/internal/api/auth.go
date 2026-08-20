package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/record"
)

const (
	challengeTTL = 5 * time.Minute
	sessionTTL   = 24 * time.Hour

	// authContext prefixes the challenge before signing so a challenge
	// signature can never be replayed as some other kind of signature.
	authContext = "runa-auth-v1:"
)

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func rfc3339(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

func (s *server) handleAuthChallenge(w http.ResponseWriter, r *http.Request) {
	challenge, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	expires := time.Now().Add(challengeTTL)
	s.mu.Lock()
	for c, exp := range s.challenges { // lazy sweep of expired challenges
		if time.Now().After(exp) {
			delete(s.challenges, c)
		}
	}
	s.challenges[challenge] = expires
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":  challenge,
		"expires_at": rfc3339(expires),
	})
}

// takeChallenge consumes a challenge: valid at most once, and only before
// its expiry.
func (s *server) takeChallenge(challenge string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.challenges[challenge]
	if !ok {
		return false
	}
	delete(s.challenges, challenge)
	return time.Now().Before(exp)
}

func (s *server) handleAuthSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Account   string `json:"account"`
		Device    string `json:"device"`
		Challenge string `json:"challenge"`
		Sig       string `json:"sig"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return
	}
	if !s.takeChallenge(req.Challenge) {
		writeError(w, http.StatusBadRequest, "invalid_challenge", "unknown, expired, or already-used challenge")
		return
	}
	pub, err := record.DecodeKey(req.Device)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "device: "+err.Error())
		return
	}
	dev, err := s.st.GetDevice(req.Account, req.Device)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if dev == nil {
		writeError(w, http.StatusUnauthorized, "unknown_device", "no device-cert binds this device to the account")
		return
	}
	if dev.RevokedAt != "" {
		writeError(w, http.StatusForbidden, "revoked_device", "device has been revoked")
		return
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(req.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize ||
		!ed25519.Verify(ed25519.PublicKey(pub), []byte(authContext+req.Challenge), sig) {
		writeError(w, http.StatusUnauthorized, "invalid_signature", "challenge signature verification failed")
		return
	}
	token, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	expiresAt := rfc3339(time.Now().Add(sessionTTL))
	if err := s.st.CreateSession(token, req.Account, req.Device, expiresAt); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_at": expiresAt,
	})
}

// authAccount resolves the Bearer token to an unexpired session's account,
// or returns "" after writing a 401.
func (s *server) authAccount(w http.ResponseWriter, r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing bearer token")
		return ""
	}
	account, _, expiresAt, found, err := s.st.GetSession(token)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return ""
	}
	if !found || expiresAt <= rfc3339(time.Now()) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or expired session")
		return ""
	}
	return account
}

func readAll(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	return io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
}
