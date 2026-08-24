package record

import (
	"encoding/json"
	"fmt"
	"testing"
)

// TestVectorAttestation consumes the shared attest-01 vector as the server
// side of docs/protocol.md §8: parse each case, verify signature + device-
// cert chain, then run the matching type-specific validator, and confirm
// the overall pass/fail matches the vector's expectation. The `check` field
// pins which stage is expected to be the one that rejects an invalid case,
// so a bug in one validator can't be masked by another rejecting first.
//
// Safety numbers (§8.2) are a client-side display derivation only — the
// server never computes them — so safety-number-01.json is TS-only and
// deliberately not consumed here. The vector's `reduction` block exercises
// the active-attestation latest-wins semantics (ties favor the revoke);
// Go materializes that state in SQL, so it is covered by the store-level
// integration tests in server/internal/api (attestations_test.go) rather
// than duplicated as a pure function here — this test only pins that the
// reduction fixture itself is well-formed.
func TestVectorAttestation(t *testing.T) {
	var v struct {
		Seeds map[string]string `json:"seeds"`
		Keys  map[string]string `json:"keys"`
		Certs []json.RawMessage `json:"certs"`
		Cases []struct {
			Name   string          `json:"name"`
			Record json.RawMessage `json:"record"`
			Valid  bool            `json:"valid"`
			Check  string          `json:"check"`
			Reason string          `json:"reason"`
		} `json:"cases"`
		Reduction struct {
			Subject                     string            `json:"subject"`
			Attestations                []json.RawMessage `json:"attestations"`
			Revokes                     []json.RawMessage `json:"revokes"`
			ActiveAuthors               []string          `json:"active_authors"`
			WithoutRevokesActiveAuthors []string          `json:"without_revokes_active_authors"`
		} `json:"reduction"`
	}
	loadVector(t, "attest-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no attestation vector cases")
	}

	certs := make([]*Record, len(v.Certs))
	for i, raw := range v.Certs {
		rec, err := Parse(raw)
		if err != nil {
			t.Fatalf("parse cert: %v", err)
		}
		certs[i] = rec
	}

	validateType := func(rec *Record) error {
		switch rec.Type() {
		case "attestation":
			return ValidateAttestation(rec)
		case "attestation-revoke":
			return ValidateAttestationRevoke(rec)
		case "domain-claim":
			return ValidateDomainClaim(rec)
		default:
			return fmt.Errorf("unexpected type %q in attest-01 vector", rec.Type())
		}
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
			// mutate a field of an otherwise-valid record without
			// re-signing (the sig is reused from the valid case, or from
			// another case entirely), so signature verification may also
			// fail for them — that's incidental. What "type" pins down is
			// that the type-specific validator, called directly on the
			// record's fields, itself rejects.
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

	if len(v.Reduction.Attestations) == 0 || len(v.Reduction.Revokes) == 0 {
		t.Fatal("reduction fixture is missing attestations or revokes")
	}
	if v.Reduction.Subject == "" {
		t.Fatal("reduction fixture is missing subject")
	}
}
