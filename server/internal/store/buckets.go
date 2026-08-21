package store

import (
	"database/sql"
	"errors"
)

// Bucket storage (Phase 4): the sender-side cold-outreach meter of
// docs/trust-and-reach.md §3. Refill policy (elapsed days, current daily
// budget, carryover cap) lives in the api layer; this file only persists
// the balance and the UTC date it was last brought current.

// Bucket is one account's token-bucket state.
type Bucket struct {
	Tokens     float64
	LastRefill string // UTC calendar date, YYYY-MM-DD
}

// GetBucket returns the account's bucket, or nil if none exists yet (a
// bucket is created lazily on first metered action or /budget read).
func (s *Store) GetBucket(account string) (*Bucket, error) {
	var b Bucket
	err := s.DB.QueryRow(
		`SELECT tokens, last_refill FROM buckets WHERE account = ?`, account,
	).Scan(&b.Tokens, &b.LastRefill)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// PutBucket creates or replaces the account's bucket state.
func (s *Store) PutBucket(account string, tokens float64, lastRefill string) error {
	_, err := s.DB.Exec(
		`INSERT INTO buckets (account, tokens, last_refill) VALUES (?, ?, ?)
		 ON CONFLICT (account) DO UPDATE
		 SET tokens = excluded.tokens, last_refill = excluded.last_refill`,
		account, tokens, lastRefill,
	)
	return err
}

// SpendToken atomically deducts one token from the account's bucket iff at
// least one whole token is available; false means the budget is exhausted
// (or no bucket exists). The conditional UPDATE makes the check-and-spend a
// single statement, so concurrent spends can never overdraw.
func (s *Store) SpendToken(account string) (bool, error) {
	res, err := s.DB.Exec(
		`UPDATE buckets SET tokens = tokens - 1 WHERE account = ? AND tokens >= 1`, account,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
