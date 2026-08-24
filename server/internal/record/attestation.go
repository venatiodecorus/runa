package record

import (
	"errors"
	"fmt"
	"regexp"
)

// attestationMethods are the deliberate out-of-band acts docs/protocol.md
// §8.1 recognizes; unknown values are rejected, never interpreted.
var attestationMethods = map[string]bool{
	"qr":            true,
	"safety-number": true,
	"domain-proof":  true,
}

// ValidateAttestation checks the attestation-specific fields (§8.1):
// subject is a well-formed account id, subject_root_pub equals subject
// byte-for-byte, method is a known value, and self-attestation
// (author == subject) is rejected. It does not verify the signature.
func ValidateAttestation(rec *Record) error {
	if rec.Type() != "attestation" {
		return errors.New("not an attestation")
	}
	subject := rec.str("subject")
	if _, err := DecodeKey(subject); err != nil {
		return fmt.Errorf("subject: %w", err)
	}
	if rec.str("subject_root_pub") != subject {
		return errors.New("subject_root_pub must equal subject")
	}
	if !attestationMethods[rec.str("method")] {
		return fmt.Errorf("unknown method: %q", rec.str("method"))
	}
	if rec.Author() == subject {
		return errors.New("self-attestation (author == subject) is rejected")
	}
	return nil
}

// ValidateAttestationRevoke checks the attestation-revoke-specific field: a
// well-formed subject account id. It does not verify the signature.
func ValidateAttestationRevoke(rec *Record) error {
	if rec.Type() != "attestation-revoke" {
		return errors.New("not an attestation-revoke")
	}
	if _, err := DecodeKey(rec.str("subject")); err != nil {
		return fmt.Errorf("subject: %w", err)
	}
	return nil
}

// domainRE matches a bare lowercase registrable hostname (docs/protocol.md
// §8.4): at least two dot-separated labels, each 1-63 chars, alphanumeric
// with internal hyphens only — no scheme, port, or path.
var domainRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// ValidateDomainClaim checks the domain-claim-specific field: domain must
// match domainRE and be at most 253 bytes total. It does not verify the
// signature.
func ValidateDomainClaim(rec *Record) error {
	if rec.Type() != "domain-claim" {
		return errors.New("not a domain-claim")
	}
	domain := rec.str("domain")
	if len(domain) > 253 || !domainRE.MatchString(domain) {
		return fmt.Errorf("domain is not a plausible lowercase hostname: %q", domain)
	}
	return nil
}
