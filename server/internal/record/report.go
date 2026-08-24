package record

import (
	"errors"
	"fmt"
)

// Reports & standing, wire format (docs/protocol.md §9.1): a public-graph-
// adjacent but server-**private** signed record — "I am reporting this
// account/record" — device-signed, never metered, never served to any user.
// This mirrors packages/core/src/report.ts validateReport; the shared
// report-01 vector keeps the two implementations honest.

// reportReasons are the reasons §9.1 recognizes; unknown values are
// rejected, never interpreted.
var reportReasons = map[string]bool{
	"spam":       true,
	"harassment": true,
	"illegal":    true,
	"other":      true,
}

// ReportCommentMax is the §9.1 cap on the optional free-text comment.
const ReportCommentMax = 1000

// utf16Len counts UTF-16 code units, the unit JavaScript's String.length
// reports — so the Go server accepts exactly the comments the TS reference
// (packages/core/src/report.ts) accepts, byte lengths and rune counts
// notwithstanding.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ValidateReport checks the report-specific fields (§9.1): subject is a
// well-formed account id, self-report (author == subject) is rejected,
// reason is a known value, comment (if present) respects the length cap,
// record (if present) looks like a record id, and plaintext (if present) is
// a string. It does not verify the signature, and it does NOT check
// recipiency / existence / instance-membership — those rules (§9.2, "subject
// must be a known account", "record must exist and be authored by subject",
// "plaintext only with an encrypted dm/scoped-post record") are
// server-contextual and live at the ingest layer (server/internal/api).
func ValidateReport(rec *Record) error {
	if rec.Type() != "report" {
		return errors.New("not a report")
	}
	subject := rec.str("subject")
	if _, err := DecodeKey(subject); err != nil {
		return fmt.Errorf("subject: %w", err)
	}
	if rec.Author() == subject {
		return errors.New("self-report (author == subject) is rejected")
	}
	if !reportReasons[rec.str("reason")] {
		return fmt.Errorf("unknown report reason: %q", rec.str("reason"))
	}
	if rec.Has("comment") {
		comment, ok := rec.String("comment")
		if !ok {
			return errors.New("comment must be a string")
		}
		if utf16Len(comment) > ReportCommentMax {
			return fmt.Errorf("comment exceeds %d chars", ReportCommentMax)
		}
	}
	if rec.Has("record") {
		id, ok := rec.String("record")
		if !ok {
			return errors.New("record must be a string")
		}
		if _, err := DecodeID(id); err != nil {
			return fmt.Errorf("record: %w", err)
		}
	}
	if rec.Has("plaintext") {
		if _, ok := rec.String("plaintext"); !ok {
			return errors.New("plaintext must be a string")
		}
	}
	return nil
}
