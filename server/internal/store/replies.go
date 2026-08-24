package store

import (
	"database/sql"
	"errors"
)

// GetRecord returns the stored record by id, or nil if this instance has
// never ingested it. Unlike ListRecords/RecordBodies this is not restricted
// to any type allowlist — callers (GET /records/{id} and the reply_to
// ingest check) apply their own visibility rules on the result.
func (s *Store) GetRecord(id string) (*RecordRow, error) {
	r := RecordRow{ID: id}
	var device, replyTo sql.NullString
	var body string
	err := s.DB.QueryRow(
		`SELECT account, COALESCE(device, ''), type, created_at, body, reply_to FROM records WHERE id = ?`, id,
	).Scan(&r.Account, &device, &r.Type, &r.CreatedAt, &body, &replyTo)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Device = device.String
	r.ReplyTo = replyTo.String
	r.Body = []byte(body)
	return &r, nil
}

// Replies returns one page of `post` records replying to parentID, in
// thread order (created_at ASC, id ASC — oldest first; the reverse of the
// reverse-chronological `before` cursors used elsewhere). after is an
// exclusive created_at lower bound, empty for the first page.
func (s *Store) Replies(parentID string, limit int, after string) ([]RecordRow, error) {
	q := `SELECT id, account, COALESCE(device, ''), type, created_at, body FROM records WHERE reply_to = ? AND type = 'post'`
	args := []any{parentID}
	if after != "" {
		q += ` AND created_at > ?`
		args = append(args, after)
	}
	q += ` ORDER BY created_at ASC, id ASC LIMIT ?`
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
		r.ReplyTo = parentID
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReplyCount returns the number of `post` records replying to parentID.
func (s *Store) ReplyCount(parentID string) (int, error) {
	var n int
	err := s.DB.QueryRow(
		`SELECT COUNT(*) FROM records WHERE reply_to = ? AND type = 'post'`, parentID,
	).Scan(&n)
	return n, err
}
