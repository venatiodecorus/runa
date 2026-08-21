package store

// DM storage (Phase 3): routing metadata materialized from verified dm
// records on ingest. Envelope bodies remain in records and are served
// verbatim; this table only answers "which records belong to this pair /
// this mailbox" (docs/protocol.md §6).

// InsertDM materializes a stored dm record's routing row. Records are
// content-addressed, so re-submission is idempotent.
func (s *Store) InsertDM(recordID, author, recipient, createdAt string) error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO dms (record_id, author, recipient, created_at) VALUES (?, ?, ?, ?)`,
		recordID, author, recipient, createdAt,
	)
	return err
}

// DMsWith returns one page of the conversation between viewer and other —
// dm records where (author=viewer AND to=other) OR (author=other AND
// to=viewer) — as stored canonical bodies, oldest→newest within the page.
// Paging walks backwards from the newest: before (exclusive created_at
// bound) selects older messages; nextBefore is the cursor for the next
// (older) page, empty when this page was not full.
func (s *Store) DMsWith(viewer, other string, limit int, before string) (bodies [][]byte, nextBefore string, err error) {
	q := `SELECT r.body, d.created_at FROM dms d JOIN records r ON r.id = d.record_id
	 WHERE ((d.author = ? AND d.recipient = ?) OR (d.author = ? AND d.recipient = ?))`
	args := []any{viewer, other, other, viewer}
	if before != "" {
		q += ` AND d.created_at < ?`
		args = append(args, before)
	}
	q += ` ORDER BY d.created_at DESC, d.record_id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	bodies = [][]byte{}
	var lastCreatedAt string
	for rows.Next() {
		var body string
		if err := rows.Scan(&body, &lastCreatedAt); err != nil {
			return nil, "", err
		}
		bodies = append(bodies, []byte(body))
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if len(bodies) == limit {
		nextBefore = lastCreatedAt
	}
	// Fetched newest-first for paging; the page itself is oldest→newest.
	for i, j := 0, len(bodies)-1; i < j; i, j = i+1, j-1 {
		bodies[i], bodies[j] = bodies[j], bodies[i]
	}
	return bodies, nextBefore, nil
}

// DMConversation is one inbox entry: the counterparty, the latest dm record
// of the pair (either direction), and whether the viewer has ever sent into
// the conversation (input to request-tray classification).
type DMConversation struct {
	With       string
	LastBody   []byte
	LastAt     string
	ViewerSent bool
}

// DMInbox returns one entry per counterparty the viewer has a dm with (as
// sender or recipient), sorted by last activity, newest first.
func (s *Store) DMInbox(viewer string) ([]DMConversation, error) {
	rows, err := s.DB.Query(
		`SELECT CASE WHEN d.author = ? THEN d.recipient ELSE d.author END, r.body, d.created_at
		 FROM dms d JOIN records r ON r.id = d.record_id
		 WHERE d.author = ? OR d.recipient = ?
		 ORDER BY d.created_at DESC, d.record_id DESC`,
		viewer, viewer, viewer,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DMConversation{}
	seen := map[string]bool{}
	for rows.Next() {
		var with, body, createdAt string
		if err := rows.Scan(&with, &body, &createdAt); err != nil {
			return nil, err
		}
		if seen[with] { // newest row per counterparty wins
			continue
		}
		seen[with] = true
		out = append(out, DMConversation{With: with, LastBody: []byte(body), LastAt: createdAt})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sent, err := s.DB.Query(`SELECT DISTINCT recipient FROM dms WHERE author = ?`, viewer)
	if err != nil {
		return nil, err
	}
	defer sent.Close()
	sentTo := map[string]bool{}
	for sent.Next() {
		var recipient string
		if err := sent.Scan(&recipient); err != nil {
			return nil, err
		}
		sentTo[recipient] = true
	}
	if err := sent.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].ViewerSent = sentTo[out[i].With]
	}
	return out, nil
}
