package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/store"
)

const maxBodyBytes = 1 << 20

// Phase-1 accepted record types (docs/protocol.md §6).
var acceptedTypes = map[string]bool{
	"post":          true,
	"profile":       true,
	"device-cert":   true,
	"device-revoke": true,
}

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
	writeJSON(w, http.StatusOK, map[string]any{
		"account":            id,
		"profile":            rawOrNull(profile),
		"device_certs":       rawList(certs),
		"device_revocations": rawList(revocations),
		"follower_count":     0, // graph lands in Phase 2
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
	limit := 50
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
			return
		}
		limit = min(n, 200)
	}
	rows, err := s.st.ListRecords(id, q.Get("type"), limit, q.Get("before"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
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
