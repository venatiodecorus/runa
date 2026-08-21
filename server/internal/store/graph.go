package store

// Graph edge storage (Phase 2): follows and mutes materialized from signed
// records. Both tables share the same shape and semantics — latest
// created_at wins — so the mutators are written once and parameterized by
// table. Table names are compile-time constants here, never user input.

// Edge is a materialized graph edge (a follow or a mute).
type Edge struct {
	Owner     string // follower / muter
	Subject   string
	RecordID  string
	CreatedAt string
}

const (
	followsCols = "(follower, subject, record_id, created_at)"
	mutesCols   = "(muter, subject, record_id, created_at)"
)

func (s *Store) upsertEdge(table, cols, ownerCol string, e Edge) error {
	_, err := s.DB.Exec(
		`INSERT INTO `+table+` `+cols+` VALUES (?, ?, ?, ?)
		 ON CONFLICT (`+ownerCol+`, subject) DO UPDATE
		 SET record_id = excluded.record_id, created_at = excluded.created_at
		 WHERE excluded.created_at > `+table+`.created_at`,
		e.Owner, e.Subject, e.RecordID, e.CreatedAt,
	)
	return err
}

func (s *Store) deleteEdgeBefore(table, ownerCol, owner, subject, createdAt string) error {
	_, err := s.DB.Exec(
		`DELETE FROM `+table+` WHERE `+ownerCol+` = ? AND subject = ? AND created_at < ?`,
		owner, subject, createdAt,
	)
	return err
}

// UpsertFollow materializes a follow edge, keeping the newer created_at if
// the pair already has one.
func (s *Store) UpsertFollow(e Edge) error {
	return s.upsertEdge("follows", followsCols, "follower", e)
}

// DeleteFollowBefore removes the pair's follow edge only if the stored edge
// is strictly older than createdAt (latest created_at wins).
func (s *Store) DeleteFollowBefore(follower, subject, createdAt string) error {
	return s.deleteEdgeBefore("follows", "follower", follower, subject, createdAt)
}

// UpsertMute materializes a mute edge, keeping the newer created_at.
func (s *Store) UpsertMute(e Edge) error {
	return s.upsertEdge("mutes", mutesCols, "muter", e)
}

// DeleteMuteBefore removes the pair's mute edge only if strictly older.
func (s *Store) DeleteMuteBefore(muter, subject, createdAt string) error {
	return s.deleteEdgeBefore("mutes", "muter", muter, subject, createdAt)
}

func (s *Store) edgeSubjects(table, ownerCol, owner string) ([]string, error) {
	rows, err := s.DB.Query(
		`SELECT subject FROM `+table+` WHERE `+ownerCol+` = ? ORDER BY subject`, owner,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var subj string
		if err := rows.Scan(&subj); err != nil {
			return nil, err
		}
		out = append(out, subj)
	}
	return out, rows.Err()
}

// FollowSubjects returns the accounts the follower currently follows.
func (s *Store) FollowSubjects(follower string) ([]string, error) {
	return s.edgeSubjects("follows", "follower", follower)
}

// MuteSubjects returns the accounts the muter currently mutes.
func (s *Store) MuteSubjects(muter string) ([]string, error) {
	return s.edgeSubjects("mutes", "muter", muter)
}

// FollowRecords returns the winning follow record bodies of the follower's
// current outbound follows, newest first — the payload of GET
// /accounts/{id}/follows.
func (s *Store) FollowRecords(follower string) ([][]byte, error) {
	rows, err := s.DB.Query(
		`SELECT r.body FROM follows f JOIN records r ON r.id = f.record_id
		 WHERE f.follower = ? ORDER BY f.created_at DESC, r.id DESC`, follower,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][]byte{}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		out = append(out, []byte(body))
	}
	return out, rows.Err()
}

// IsFollowing reports whether follower currently follows subject.
func (s *Store) IsFollowing(follower, subject string) (bool, error) {
	var n int
	err := s.DB.QueryRow(
		`SELECT COUNT(*) FROM follows WHERE follower = ? AND subject = ?`, follower, subject,
	).Scan(&n)
	return n > 0, err
}

// FollowerCount is the number of accounts currently following subject
// (inbound lists are count-only to others, design §8).
func (s *Store) FollowerCount(subject string) (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM follows WHERE subject = ?`, subject).Scan(&n)
	return n, err
}
