package store

// Attestation storage (Phase 6 / M6, docs/protocol.md §8): active
// attestations materialized from signed attestation/attestation-revoke
// records. Public by design — no visibility filtering, unlike follows and
// mutes. The tie-break (a revoke with created_at >= the attestation's
// supersedes it) is asymmetric with follow/unfollow's strict '>', so it is
// not routed through graph.go's upsertEdge/deleteEdgeBefore even though the
// shapes are close.

// Attestation is a materialized active attestation edge (attester →
// subject).
type Attestation struct {
	Attester  string
	Subject   string
	Method    string
	RecordID  string
	CreatedAt string
}

// UpsertAttestation materializes an attestation edge, keeping the newer
// created_at if the (attester, subject) pair already has one. Callers are
// responsible for the §8.1 revoke tie-break (server/internal/api/graph.go)
// before calling this — it only ever makes an edge more current, never less.
func (s *Store) UpsertAttestation(a Attestation) error {
	_, err := s.DB.Exec(
		`INSERT INTO attestations (attester, subject, method, record_id, created_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (attester, subject) DO UPDATE
		 SET method = excluded.method, record_id = excluded.record_id, created_at = excluded.created_at
		 WHERE excluded.created_at > attestations.created_at`,
		a.Attester, a.Subject, a.Method, a.RecordID, a.CreatedAt,
	)
	return err
}

// DeleteAttestationsBeforeOrAt removes attester's stored attestation of
// subject if its created_at is <= revokeCreatedAt — the §8.1 tie-break: a
// revoke with an equal created_at supersedes the attestation it ties with
// (the opposite of follow/unfollow's strict inequality in
// DeleteFollowBefore).
func (s *Store) DeleteAttestationsBeforeOrAt(attester, subject, revokeCreatedAt string) error {
	_, err := s.DB.Exec(
		`DELETE FROM attestations WHERE attester = ? AND subject = ? AND created_at <= ?`,
		attester, subject, revokeCreatedAt,
	)
	return err
}

// ActiveAttestationsOf returns one reverse-chronological page of subject's
// active attestations as their signed records — the payload of GET
// /accounts/{id}/attestations (docs/protocol.md §6). before (exclusive
// created_at bound) pages backwards; nextBefore is the cursor for the next
// page, empty when this page was not full.
func (s *Store) ActiveAttestationsOf(subject string, limit int, before string) (rows []RecordRow, nextBefore string, err error) {
	q := `SELECT r.id, r.account, COALESCE(r.device, ''), r.type, r.created_at, r.body
	 FROM attestations a JOIN records r ON r.id = a.record_id
	 WHERE a.subject = ?`
	args := []any{subject}
	if before != "" {
		q += ` AND a.created_at < ?`
		args = append(args, before)
	}
	q += ` ORDER BY a.created_at DESC, a.record_id DESC LIMIT ?`
	args = append(args, limit)
	dbRows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, "", err
	}
	defer dbRows.Close()
	rows = []RecordRow{}
	for dbRows.Next() {
		var r RecordRow
		var body string
		if err := dbRows.Scan(&r.ID, &r.Account, &r.Device, &r.Type, &r.CreatedAt, &body); err != nil {
			return nil, "", err
		}
		r.Body = []byte(body)
		rows = append(rows, r)
	}
	if err := dbRows.Err(); err != nil {
		return nil, "", err
	}
	if len(rows) == limit {
		nextBefore = rows[len(rows)-1].CreatedAt
	}
	return rows, nextBefore, nil
}
