package record

import (
	"encoding/json"
	"fmt"
	"testing"
)

// TestVectorReport consumes the shared report-01 vector as the server side
// of docs/protocol.md §9.1: parse each case, verify signature + device-cert
// chain, then run ValidateReport, and confirm the overall pass/fail matches
// the vector's expectation. The `check` field pins which stage is expected
// to reject an invalid case, exactly as in attestation_vectors_test.go.
//
// Only the record *shape* is vector-testable here. The §9.1/§9.2 ingest
// rules — subject must be a known account, `record` must exist on this
// instance and be authored by subject, `plaintext` only with an encrypted
// dm/scoped-post the reporter can prove recipiency of — are
// server-contextual and covered by the API integration tests
// (server/internal/api/report_test.go), which is why the vector's
// `reported_record` / `reported_record_id` are context, not proof of
// existence.
func TestVectorReport(t *testing.T) {
	var v struct {
		Seeds            map[string]string `json:"seeds"`
		Keys             map[string]string `json:"keys"`
		Certs            []json.RawMessage `json:"certs"`
		ReportedRecord   json.RawMessage   `json:"reported_record"`
		ReportedRecordID string            `json:"reported_record_id"`
		Cases            []struct {
			Name   string          `json:"name"`
			Record json.RawMessage `json:"record"`
			Valid  bool            `json:"valid"`
			Check  string          `json:"check"`
			Reason string          `json:"reason"`
		} `json:"cases"`
	}
	loadVector(t, "report-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no report vector cases")
	}

	certs := make([]*Record, len(v.Certs))
	for i, raw := range v.Certs {
		rec, err := Parse(raw)
		if err != nil {
			t.Fatalf("parse cert: %v", err)
		}
		certs[i] = rec
	}

	// The referenced record's id must be its own content address — the
	// vector's claim that `reported_record_id` addresses `reported_record`.
	reported, err := Parse(v.ReportedRecord)
	if err != nil {
		t.Fatalf("parse reported_record: %v", err)
	}
	gotID, err := reported.ID()
	if err != nil {
		t.Fatalf("reported_record id: %v", err)
	}
	if gotID != v.ReportedRecordID {
		t.Errorf("reported_record_id = %s, want %s", v.ReportedRecordID, gotID)
	}

	validateType := func(rec *Record) error {
		if rec.Type() != "report" {
			return fmt.Errorf("unexpected type %q in report-01 vector", rec.Type())
		}
		return ValidateReport(rec)
	}

	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			rec, err := Parse(c.Record)
			if err != nil {
				t.Fatalf("parse record: %v", err)
			}
			verr := rec.VerifySignature()
			if verr == nil {
				verr = VerifyDeviceBinding(rec, certs, nil)
			}
			if verr == nil {
				verr = validateType(rec)
			}
			if c.Valid && verr != nil {
				t.Errorf("verify failed, want valid: %v", verr)
			}
			if !c.Valid && verr == nil {
				t.Errorf("verify passed, want invalid (%s)", c.Reason)
			}
			if c.Valid {
				return
			}
			// Pin the rejection to the stage the vector names. "type" cases
			// mutate a field of an otherwise-valid record without re-signing,
			// so signature verification may also fail for them — that's
			// incidental. What "type" pins down is that ValidateReport,
			// called directly on the record's fields, itself rejects.
			switch c.Check {
			case "signature":
				if err := rec.VerifySignature(); err == nil {
					t.Errorf("expected signature verification to fail")
				}
			case "type":
				if err := validateType(rec); err == nil {
					t.Errorf("expected type validation to reject (%s)", c.Reason)
				}
			default:
				t.Errorf("unrecognized check %q", c.Check)
			}
		})
	}
}
