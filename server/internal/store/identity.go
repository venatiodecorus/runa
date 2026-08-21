package store

import (
	"database/sql"
	"errors"
	"strings"
)

// ErrAccountExists is returned by CreateAccountWithCert for a duplicate id.
var ErrAccountExists = errors.New("account already exists")

// RecordRow is a stored signed record. Device is empty for root-signed
// records; Body is the canonical JSON, served verbatim.
type RecordRow struct {
	ID        string
	Account   string
	Device    string
	Type      string
	CreatedAt string
	Body      []byte
}

// Device is the materialized state of a device cert (+ any revocation).
type Device struct {
	Account      string
	SignPub      string
	KexPub       string
	CertRecordID string
	RevokedAt    string // empty if unrevoked
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// CreateAccountWithCert atomically creates the account, stores its first
// device-cert record, and materializes the device row.
func (s *Store) CreateAccountWithCert(accountID, createdAt string, cert RecordRow, dev Device) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = ?`, accountID).Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		return ErrAccountExists
	}
	if _, err := tx.Exec(`INSERT INTO accounts (id, created_at) VALUES (?, ?)`, accountID, createdAt); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO records (id, account, device, type, created_at, body) VALUES (?, ?, ?, ?, ?, ?)`,
		cert.ID, cert.Account, nullable(cert.Device), cert.Type, cert.CreatedAt, string(cert.Body),
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO devices (account, device_sign_pub, device_kex_pub, cert_record_id) VALUES (?, ?, ?, ?)`,
		dev.Account, dev.SignPub, dev.KexPub, dev.CertRecordID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AccountExists(id string) (bool, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}

// InsertRecord stores a record; duplicate IDs are ignored (records are
// content-addressed, so re-submission is idempotent).
func (s *Store) InsertRecord(r RecordRow) error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO records (id, account, device, type, created_at, body) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, r.Account, nullable(r.Device), r.Type, r.CreatedAt, string(r.Body),
	)
	return err
}

// ListRecords returns an account's records reverse-chronologically,
// restricted to the given types (at least one is required — callers pass an
// explicit allowlist so private types are never served by accident); before
// (exclusive created_at bound) pages backwards when non-empty.
func (s *Store) ListRecords(account string, types []string, limit int, before string) ([]RecordRow, error) {
	if len(types) == 0 {
		return nil, errors.New("ListRecords requires an explicit type allowlist")
	}
	q := `SELECT id, account, COALESCE(device, ''), type, created_at, body FROM records WHERE account = ?`
	args := []any{account}
	q += ` AND type IN (?` + strings.Repeat(", ?", len(types)-1) + `)`
	for _, t := range types {
		args = append(args, t)
	}
	if before != "" {
		q += ` AND created_at < ?`
		args = append(args, before)
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RecordRow
	for rows.Next() {
		var r RecordRow
		var body string
		if err := rows.Scan(&r.ID, &r.Account, &r.Device, &r.Type, &r.CreatedAt, &body); err != nil {
			return nil, err
		}
		r.Body = []byte(body)
		out = append(out, r)
	}
	return out, rows.Err()
}

// LatestRecordBody returns the newest record body of the given type, or
// nil if the account has none.
func (s *Store) LatestRecordBody(account, typ string) ([]byte, error) {
	var body string
	err := s.DB.QueryRow(
		`SELECT body FROM records WHERE account = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
		account, typ,
	).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []byte(body), nil
}

// RecordBodies returns all bodies of a type for an account, oldest first.
func (s *Store) RecordBodies(account, typ string) ([][]byte, error) {
	rows, err := s.DB.Query(
		`SELECT body FROM records WHERE account = ? AND type = ? ORDER BY created_at ASC, id ASC`,
		account, typ,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		out = append(out, []byte(body))
	}
	return out, rows.Err()
}

// UpsertDevice materializes a device-cert. An existing row keeps its
// revoked_at — re-certifying a revoked device does not un-revoke it.
func (s *Store) UpsertDevice(d Device) error {
	_, err := s.DB.Exec(
		`INSERT INTO devices (account, device_sign_pub, device_kex_pub, cert_record_id) VALUES (?, ?, ?, ?)
		 ON CONFLICT (account, device_sign_pub) DO UPDATE SET device_kex_pub = excluded.device_kex_pub, cert_record_id = excluded.cert_record_id`,
		d.Account, d.SignPub, d.KexPub, d.CertRecordID,
	)
	return err
}

// GetDevice returns the materialized device row, or nil if the device has
// no cert for this account.
func (s *Store) GetDevice(account, signPub string) (*Device, error) {
	d := Device{Account: account, SignPub: signPub}
	var revokedAt sql.NullString
	err := s.DB.QueryRow(
		`SELECT device_kex_pub, cert_record_id, revoked_at FROM devices WHERE account = ? AND device_sign_pub = ?`,
		account, signPub,
	).Scan(&d.KexPub, &d.CertRecordID, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.RevokedAt = revokedAt.String
	return &d, nil
}

// RevokeDevice marks a device revoked as of revokedAt, keeping the
// earliest revocation time if one is already set.
func (s *Store) RevokeDevice(account, signPub, revokedAt string) error {
	_, err := s.DB.Exec(
		`UPDATE devices SET revoked_at = ? WHERE account = ? AND device_sign_pub = ? AND (revoked_at IS NULL OR revoked_at > ?)`,
		revokedAt, account, signPub, revokedAt,
	)
	return err
}

func (s *Store) CreateSession(token, account, device, expiresAt string) error {
	_, err := s.DB.Exec(
		`INSERT INTO sessions (token, account, device, expires_at) VALUES (?, ?, ?, ?)`,
		token, account, device, expiresAt,
	)
	return err
}

// GetSession returns the session's account, device, and expiry; ok is
// false for an unknown token.
func (s *Store) GetSession(token string) (account, device, expiresAt string, ok bool, err error) {
	err = s.DB.QueryRow(
		`SELECT account, device, expires_at FROM sessions WHERE token = ?`, token,
	).Scan(&account, &device, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", "", false, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	return account, device, expiresAt, true, nil
}

func (s *Store) UpsertBackup(account, blob, updatedAt string) error {
	_, err := s.DB.Exec(
		`INSERT INTO backups (account, blob, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (account) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
		account, blob, updatedAt,
	)
	return err
}

// GetBackup returns the stored blob, or ok=false if none exists.
func (s *Store) GetBackup(account string) ([]byte, bool, error) {
	var blob string
	err := s.DB.QueryRow(`SELECT blob FROM backups WHERE account = ?`, account).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []byte(blob), true, nil
}
