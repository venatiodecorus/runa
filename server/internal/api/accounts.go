package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/store"
)

const maxBodyBytes = 1 << 20

// Accepted record types (docs/protocol.md §6): Phase 1 identity/content,
// the Phase 2 graph types, the Phase 3 dm envelope, and the Phase 5 tier-3
// types.
var acceptedTypes = map[string]bool{
	"post":          true,
	"profile":       true,
	"device-cert":   true,
	"device-revoke": true,
	"follow":        true,
	"unfollow":      true,
	"mute":          true,
	"unmute":        true,
	"dm":            true,
	"epoch":         true,
	"epoch-key":     true,
	"scoped-post":   true,
}

// tier3Types are the scoped-post machinery of docs/protocol.md §5: extra
// ingest rules on submit, member-only visibility on read.
var tier3Types = map[string]bool{
	"epoch":       true,
	"epoch-key":   true,
	"scoped-post": true,
}

// graphTypes carry a `subject` account id and materialize edges on ingest.
var graphTypes = map[string]bool{
	"follow":   true,
	"unfollow": true,
	"mute":     true,
	"unmute":   true,
}

// publicListTypes are the only record types GET /accounts/{id}/records may
// serve: follows are follower-visible via /accounts/{id}/follows only, and
// mutes are never served to anyone but their author (docs/protocol.md §6).
var publicListTypes = []string{"post", "profile", "device-cert", "device-revoke"}

func nowUTC() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

func (s *server) handleCreateAccount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootPub    string          `json:"root_pub"`
		DeviceCert json.RawMessage `json:"device_cert"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return
	}
	if _, err := record.DecodeKey(req.RootPub); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "root_pub: "+err.Error())
		return
	}
	cert, err := record.Parse(req.DeviceCert)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", "device_cert: "+err.Error())
		return
	}
	if cert.Type() != "device-cert" || cert.Author() != req.RootPub {
		writeError(w, http.StatusBadRequest, "invalid_record", "device_cert must be a device-cert authored by root_pub")
		return
	}
	if err := record.ValidateDeviceCert(cert); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	if err := cert.VerifySignature(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	row, err := recordRow(cert)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	signPub, _ := cert.String("device_sign_pub")
	kexPub, _ := cert.String("device_kex_pub")
	err = s.st.CreateAccountWithCert(req.RootPub, nowUTC(), row, store.Device{
		Account:      req.RootPub,
		SignPub:      signPub,
		KexPub:       kexPub,
		CertRecordID: row.ID,
	})
	if errors.Is(err, store.ErrAccountExists) {
		writeError(w, http.StatusConflict, "account_exists", "account already exists")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"account": req.RootPub})
}

func (s *server) handleGetAccount(w http.ResponseWriter, r *http.Request) {
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
	profile, err := s.st.LatestRecordBody(id, "profile")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	certs, err := s.st.RecordBodies(id, "device-cert")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	revocations, err := s.st.RecordBodies(id, "device-revoke")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	followerCount, err := s.st.FollowerCount(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account":            id,
		"profile":            rawOrNull(profile),
		"device_certs":       rawList(certs),
		"device_revocations": rawList(revocations),
		"follower_count":     followerCount,
	})
}

// handleIngestRecord is verify-on-ingest (docs/architecture.md): shape,
// signature, and — for device-signed types — the cert chain, checked
// against the materialized devices table.
func (s *server) handleIngestRecord(w http.ResponseWriter, r *http.Request) {
	body, err := readAll(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	rec, err := record.Parse(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	typ := rec.Type()
	if typ == "" {
		writeError(w, http.StatusBadRequest, "invalid_record", "missing type")
		return
	}
	if !acceptedTypes[typ] {
		writeError(w, http.StatusBadRequest, "unknown_type", "unsupported record type: "+typ)
		return
	}
	// Imageboard mode (design §17, protocol §6): profile customization is
	// disabled on this instance; accounts render as their ids.
	if typ == "profile" && s.cfg.Imageboard {
		writeError(w, http.StatusForbidden, "profile_disabled", "this instance runs imageboard mode: profile records are disabled")
		return
	}
	if err := rec.VerifySignature(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	exists, err := s.st.AccountExists(rec.Author())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if !exists {
		writeError(w, http.StatusBadRequest, "unknown_account", "author has no account on this instance")
		return
	}

	switch typ {
	case "device-cert":
		if err := record.ValidateDeviceCert(rec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
			return
		}
	case "device-revoke":
		if err := record.ValidateDeviceRevoke(rec); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
			return
		}
	default: // device-signed content: chain check against materialized certs
		dev, err := s.st.GetDevice(rec.Author(), rec.Device())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		if dev == nil {
			writeError(w, http.StatusBadRequest, "invalid_record", "no device-cert binds this device to the author")
			return
		}
		if dev.RevokedAt != "" && dev.RevokedAt <= rec.CreatedAt() {
			writeError(w, http.StatusForbidden, "revoked_device", "device was revoked before this record")
			return
		}
	}
	if graphTypes[typ] {
		// The subject must be a well-formed account id, but need not have an
		// account here — unknown subjects simply contribute nothing.
		subject, _ := rec.String("subject")
		if _, err := record.DecodeKey(subject); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_record", "subject: "+err.Error())
			return
		}
	}
	if typ == "dm" && !s.validateDMIngest(w, rec) {
		return
	}
	if tier3Types[typ] && !s.validateTier3Ingest(w, rec) {
		return
	}
	// All verification has passed; meter cold initiations (M4) before any
	// storage — a 429 means the record is not stored at all.
	if !s.meterColdInitiation(w, rec, typ) {
		return
	}

	row, err := recordRow(rec)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return
	}
	if err := s.st.InsertRecord(row); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	switch typ {
	case "device-cert":
		signPub, _ := rec.String("device_sign_pub")
		kexPub, _ := rec.String("device_kex_pub")
		err = s.st.UpsertDevice(store.Device{Account: rec.Author(), SignPub: signPub, KexPub: kexPub, CertRecordID: row.ID})
	case "device-revoke":
		signPub, _ := rec.String("device_sign_pub")
		err = s.st.RevokeDevice(rec.Author(), signPub, rec.CreatedAt())
	case "follow", "unfollow", "mute", "unmute":
		err = s.applyGraphRecord(typ, rec, row.ID)
	case "dm":
		to, _ := rec.String("to")
		err = s.st.InsertDM(row.ID, rec.Author(), to, rec.CreatedAt())
	case "epoch", "epoch-key", "scoped-post":
		err = s.applyTier3Record(typ, rec, row.ID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": row.ID})
}

func (s *server) handleListRecords(w http.ResponseWriter, r *http.Request) {
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
	q := r.URL.Query()
	limit, ok := pageLimit(w, r)
	if !ok {
		return
	}
	// Only publicly-visible types are served here: follows go through the
	// follower-visible /accounts/{id}/follows, mutes only to their author,
	// and tier-3 records only to epoch members (scoped-post, below).
	typ := q.Get("type")
	var rows []store.RecordRow
	switch {
	case typ == "scoped-post":
		// Member-only, by silent omission: a non-member — or an
		// unauthenticated caller — simply sees none of them, so the existence
		// of the epoch stays hidden (docs/protocol.md §6, design §8).
		viewer, err := s.optionalAuthAccount(r)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		rows, err = s.st.MemberScopedPosts(id, viewer, limit, q.Get("before"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	case typ != "" && !slices.Contains(publicListTypes, typ):
		writeJSON(w, http.StatusOK, map[string]any{
			"records":     []json.RawMessage{},
			"next_before": nil,
		})
		return
	default:
		types := publicListTypes
		if typ != "" {
			types = []string{typ}
		}
		rows, err = s.st.ListRecords(id, types, limit, q.Get("before"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	records := make([]json.RawMessage, len(rows))
	for i, row := range rows {
		records[i] = json.RawMessage(row.Body)
	}
	var nextBefore any
	if len(rows) == limit {
		nextBefore = rows[len(rows)-1].CreatedAt
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"records":     records,
		"next_before": nextBefore,
	})
}

// recordRow converts a verified record into its storage row: canonical
// bytes (the wire form clients re-verify) plus the content-addressed ID.
func recordRow(rec *record.Record) (store.RecordRow, error) {
	body, err := rec.CanonicalBytes()
	if err != nil {
		return store.RecordRow{}, err
	}
	id, err := rec.ID()
	if err != nil {
		return store.RecordRow{}, err
	}
	return store.RecordRow{
		ID:        id,
		Account:   rec.Author(),
		Device:    rec.Device(),
		Type:      rec.Type(),
		CreatedAt: rec.CreatedAt(),
		Body:      body,
	}, nil
}

func rawOrNull(b []byte) any {
	if b == nil {
		return nil
	}
	return json.RawMessage(b)
}

func rawList(bs [][]byte) []json.RawMessage {
	out := make([]json.RawMessage, len(bs))
	for i, b := range bs {
		out[i] = json.RawMessage(b)
	}
	return out
}
