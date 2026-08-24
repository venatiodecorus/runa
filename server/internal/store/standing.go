package store

import (
	"database/sql"
	"errors"
)

// Standing & report storage (Phase 7 / M7, docs/protocol.md §9). Reports are
// server-private: nothing here is ever reachable from a user-facing read
// path — the only consumers are the standing computation and the operator
// review queue (server/internal/api/standing.go, admin.go).

// ReportRow is one materialized report. Body is the stored signed record
// (including any forwarded plaintext), served only to the review queue.
type ReportRow struct {
	RecordID       string
	Reporter       string
	Subject        string
	ReportedRecord string
	Reason         string
	CreatedAt      string
	Body           []byte
}

// InsertReport materializes a verified, stored report record. Records are
// content-addressed, so re-submission is idempotent — and a resubmitted
// report can never double its own weight (the reporter is counted once
// regardless, but the row identity makes that structural).
func (s *Store) InsertReport(r ReportRow) error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO reports (record_id, reporter, subject, reported_record, reason, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		r.RecordID, r.Reporter, r.Subject, nullable(r.ReportedRecord), r.Reason, r.CreatedAt,
	)
	return err
}

// ReportsForSubjectSince returns subject's non-dismissed reports with
// created_at >= since — the trailing report_window_days that feed p_auto
// (trust-and-reach §4). Oldest first; the signed bodies come along for the
// review queue.
func (s *Store) ReportsForSubjectSince(subject, since string) ([]ReportRow, error) {
	rows, err := s.DB.Query(
		`SELECT p.record_id, p.reporter, p.subject, COALESCE(p.reported_record, ''), p.reason, p.created_at, r.body
		 FROM reports p JOIN records r ON r.id = p.record_id
		 WHERE p.subject = ? AND p.created_at >= ? AND p.dismissed = 0
		 ORDER BY p.created_at ASC, p.record_id ASC`,
		subject, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportRow{}
	for rows.Next() {
		var r ReportRow
		var body string
		if err := rows.Scan(&r.RecordID, &r.Reporter, &r.Subject, &r.ReportedRecord, &r.Reason, &r.CreatedAt, &body); err != nil {
			return nil, err
		}
		r.Body = []byte(body)
		out = append(out, r)
	}
	return out, rows.Err()
}

// DismissReportsForSubjectSince flags the subject's window reports as
// adjudicated false (§9.4 dismiss): excluded from mass forever. Returns the
// distinct reporters whose reports were dismissed — the accounts that take
// the false-report burn.
func (s *Store) DismissReportsForSubjectSince(subject, since string) ([]string, error) {
	rows, err := s.DB.Query(
		`SELECT DISTINCT reporter FROM reports WHERE subject = ? AND created_at >= ? AND dismissed = 0`,
		subject, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reporters := []string{}
	for rows.Next() {
		var reporter string
		if err := rows.Scan(&reporter); err != nil {
			return nil, err
		}
		reporters = append(reporters, reporter)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := s.DB.Exec(
		`UPDATE reports SET dismissed = 1 WHERE subject = ? AND created_at >= ? AND dismissed = 0`,
		subject, since,
	); err != nil {
		return nil, err
	}
	return reporters, nil
}

// StandingRow is an account's stored adjudication state. PAdjUpdatedAt is
// the origin of the decay clock; FrozenUntil is empty when never frozen.
type StandingRow struct {
	Account       string
	PAdj          float64
	PAdjUpdatedAt string
	FrozenUntil   string
}

// GetStanding returns the account's stored adjudication state, or nil when
// the account has never been adjudicated (p_adj 0, no freeze — the default
// standing 1.0 path).
func (s *Store) GetStanding(account string) (*StandingRow, error) {
	row := StandingRow{Account: account}
	var updatedAt, frozenUntil sql.NullString
	err := s.DB.QueryRow(
		`SELECT p_adj, p_adj_updated_at, frozen_until FROM standing WHERE account = ?`, account,
	).Scan(&row.PAdj, &updatedAt, &frozenUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.PAdjUpdatedAt = updatedAt.String
	row.FrozenUntil = frozenUntil.String
	return &row, nil
}

// SetAdjPenalty stores an account's adjudicated penalty and restarts its
// decay clock, leaving any freeze untouched.
func (s *Store) SetAdjPenalty(account string, pAdj float64, updatedAt string) error {
	_, err := s.DB.Exec(
		`INSERT INTO standing (account, p_adj, p_adj_updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (account) DO UPDATE SET p_adj = excluded.p_adj, p_adj_updated_at = excluded.p_adj_updated_at`,
		account, pAdj, updatedAt,
	)
	return err
}

// SetFrozenUntil stores a cold-outreach freeze deadline (§9.4), leaving
// p_adj untouched.
func (s *Store) SetFrozenUntil(account, frozenUntil string) error {
	_, err := s.DB.Exec(
		`INSERT INTO standing (account, p_adj, frozen_until) VALUES (?, 0, ?)
		 ON CONFLICT (account) DO UPDATE SET frozen_until = excluded.frozen_until`,
		account, frozenUntil,
	)
	return err
}

// Followers returns the accounts currently following subject — the inbound
// edges the reach formulas sum over (each weighted by the follower's own
// standing or adjudicated component, trust-and-reach §§3–4).
func (s *Store) Followers(subject string) ([]string, error) {
	rows, err := s.DB.Query(
		`SELECT follower FROM follows WHERE subject = ? ORDER BY follower`, subject,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var follower string
		if err := rows.Scan(&follower); err != nil {
			return nil, err
		}
		out = append(out, follower)
	}
	return out, rows.Err()
}

// ReviewEntry is one review-queue row. Resolved entries keep their
// decision and note; an open entry has an empty ResolvedAt.
type ReviewEntry struct {
	ID         int64
	Account    string
	OpenedAt   string
	ResolvedAt string
	Decision   string
	Note       string
}

// OpenReview opens a review-queue entry for account (§9.4: automation is
// exhausted at the p_auto cap, a human decides anything further).
func (s *Store) OpenReview(account, openedAt string) error {
	_, err := s.DB.Exec(
		`INSERT INTO review_queue (account, opened_at) VALUES (?, ?)`, account, openedAt,
	)
	return err
}

// OpenReviewFor returns the account's open (unresolved) entry, or nil.
func (s *Store) OpenReviewFor(account string) (*ReviewEntry, error) {
	e := ReviewEntry{Account: account}
	err := s.DB.QueryRow(
		`SELECT id, opened_at FROM review_queue WHERE account = ? AND resolved_at IS NULL
		 ORDER BY id ASC LIMIT 1`, account,
	).Scan(&e.ID, &e.OpenedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ListOpenReviews returns every unresolved entry, oldest first.
func (s *Store) ListOpenReviews() ([]ReviewEntry, error) {
	rows, err := s.DB.Query(
		`SELECT id, account, opened_at FROM review_queue WHERE resolved_at IS NULL ORDER BY id ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewEntry{}
	for rows.Next() {
		var e ReviewEntry
		if err := rows.Scan(&e.ID, &e.Account, &e.OpenedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LatestReviewResolvedAt returns the newest resolved_at across the
// account's closed entries, or "" if none — the guard against an
// immediately re-opened entry on reports a human already ruled on.
func (s *Store) LatestReviewResolvedAt(account string) (string, error) {
	var resolvedAt sql.NullString
	err := s.DB.QueryRow(
		`SELECT MAX(resolved_at) FROM review_queue WHERE account = ? AND resolved_at IS NOT NULL`,
		account,
	).Scan(&resolvedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return resolvedAt.String, nil
}

// ResolveReview closes an entry with the operator's decision and note.
func (s *Store) ResolveReview(id int64, resolvedAt, decision, note string) error {
	_, err := s.DB.Exec(
		`UPDATE review_queue SET resolved_at = ?, decision = ?, note = ? WHERE id = ?`,
		resolvedAt, decision, nullable(note), id,
	)
	return err
}
