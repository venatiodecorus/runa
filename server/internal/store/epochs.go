package store

import (
	"database/sql"
	"errors"
)

// Tier-3 storage (Phase 5): metadata materialized from verified epoch /
// epoch-key / scoped-post records on ingest. Record bodies remain in
// records and are served verbatim; nothing here is derived from ciphertext
// or wraps — the server never holds a decryption key (docs/protocol.md §5).

// Epoch is a materialized epoch record: the epoch id (= record id), its
// author, the abstract scope source it declared, and the epoch it
// supersedes (empty when none).
type Epoch struct {
	ID          string
	Author      string
	ScopeSource string
	Prev        string
	CreatedAt   string
}

// InsertEpoch materializes a stored epoch record and seeds its membership
// with the author, who is a member by construction (§5.2). Records are
// content-addressed, so re-submission is idempotent.
func (s *Store) InsertEpoch(e Epoch) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO epochs (record_id, author, scope_source, prev, created_at) VALUES (?, ?, ?, ?, ?)`,
		e.ID, e.Author, e.ScopeSource, nullable(e.Prev), e.CreatedAt,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO epoch_members (epoch_id, member) VALUES (?, ?)`,
		e.ID, e.Author,
	); err != nil {
		return err
	}
	return tx.Commit()
}

// GetEpoch returns the materialized epoch, or nil if this instance has not
// ingested that epoch record.
func (s *Store) GetEpoch(epochID string) (*Epoch, error) {
	e := Epoch{ID: epochID}
	var prev sql.NullString
	err := s.DB.QueryRow(
		`SELECT author, scope_source, prev, created_at FROM epochs WHERE record_id = ?`, epochID,
	).Scan(&e.Author, &e.ScopeSource, &prev, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	e.Prev = prev.String
	return &e, nil
}

// EpochRecordBody returns the stored canonical bytes of an epoch record, or
// nil if unknown.
func (s *Store) EpochRecordBody(epochID string) ([]byte, error) {
	var body string
	err := s.DB.QueryRow(`SELECT body FROM records WHERE id = ? AND type = 'epoch'`, epochID).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []byte(body), nil
}

// IsEpochMember reports whether account is in the epoch's frozen membership
// (the author, plus every accepted epoch-key recipient).
func (s *Store) IsEpochMember(epochID, account string) (bool, error) {
	var n int
	err := s.DB.QueryRow(
		`SELECT EXISTS (SELECT 1 FROM epoch_members WHERE epoch_id = ? AND member = ?)`,
		epochID, account,
	).Scan(&n)
	return n > 0, err
}

// HasEpochKeyFor reports whether an accepted epoch-key record addressed to
// `recipient` exists for the epoch — the *structural* recipiency proof of
// docs/protocol.md §9.2 for a scoped-post report. Deliberately narrower
// than IsEpochMember, which also counts the epoch's author: §9.2 asks
// specifically for a key grant naming the reporter, and no key material is
// ever inspected to answer it.
func (s *Store) HasEpochKeyFor(epochID, recipient string) (bool, error) {
	var n int
	err := s.DB.QueryRow(
		`SELECT EXISTS (SELECT 1 FROM epoch_keys WHERE epoch_id = ? AND recipient = ?)`,
		epochID, recipient,
	).Scan(&n)
	return n > 0, err
}

// InsertEpochKey materializes an accepted key grant: its routing row plus
// the membership it confers on `to` (§5.2 — members are the author plus
// every account addressed by an accepted epoch-key record).
func (s *Store) InsertEpochKey(recordID, epochID, recipient, createdAt string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO epoch_keys (record_id, epoch_id, recipient, created_at) VALUES (?, ?, ?, ?)`,
		recordID, epochID, recipient, createdAt,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO epoch_members (epoch_id, member) VALUES (?, ?)`,
		epochID, recipient,
	); err != nil {
		return err
	}
	return tx.Commit()
}

// EpochKeyGrant is one row of GET /epochs/keys: the grant record's stored
// canonical bytes and the epoch it names (so the handler can inline that
// epoch record without re-parsing the body).
type EpochKeyGrant struct {
	Body    []byte
	EpochID string
}

// EpochKeysFor returns one page of the key grants addressed to viewer,
// newest first; before (exclusive created_at bound) pages backwards, and
// nextBefore is the cursor for the next page, empty when the page was not
// full — the same convention as ListRecords.
func (s *Store) EpochKeysFor(viewer string, limit int, before string) (grants []EpochKeyGrant, nextBefore string, err error) {
	q := `SELECT r.body, k.epoch_id, k.created_at FROM epoch_keys k JOIN records r ON r.id = k.record_id
	 WHERE k.recipient = ?`
	args := []any{viewer}
	if before != "" {
		q += ` AND k.created_at < ?`
		args = append(args, before)
	}
	q += ` ORDER BY k.created_at DESC, k.record_id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	grants = []EpochKeyGrant{}
	var lastCreatedAt string
	for rows.Next() {
		var body string
		var g EpochKeyGrant
		if err := rows.Scan(&body, &g.EpochID, &lastCreatedAt); err != nil {
			return nil, "", err
		}
		g.Body = []byte(body)
		grants = append(grants, g)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if len(grants) == limit {
		nextBefore = lastCreatedAt
	}
	return grants, nextBefore, nil
}

// InsertScopedPost materializes a stored scoped-post's epoch binding, the
// key to member-only delivery.
func (s *Store) InsertScopedPost(recordID, epochID, author, createdAt string) error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO scoped_posts (record_id, epoch_id, author, created_at) VALUES (?, ?, ?, ?)`,
		recordID, epochID, author, createdAt,
	)
	return err
}

// MemberScopedPosts returns one page of author's scoped posts that viewer is
// entitled to — those whose epoch viewer is a member of — reverse-
// chronologically. Everything else is silently absent: non-membership is
// never signalled, so the existence of an epoch stays hidden (design §8).
// An empty viewer (unauthenticated caller) matches nothing.
func (s *Store) MemberScopedPosts(author, viewer string, limit int, before string) ([]RecordRow, error) {
	if viewer == "" {
		return nil, nil
	}
	q := `SELECT r.id, r.account, COALESCE(r.device, ''), r.type, r.created_at, r.body
	 FROM scoped_posts sp JOIN records r ON r.id = sp.record_id
	 WHERE sp.author = ?
	   AND EXISTS (SELECT 1 FROM epoch_members m WHERE m.epoch_id = sp.epoch_id AND m.member = ?)`
	args := []any{author, viewer}
	if before != "" {
		q += ` AND sp.created_at < ?`
		args = append(args, before)
	}
	q += ` ORDER BY sp.created_at DESC, sp.record_id DESC LIMIT ?`
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
