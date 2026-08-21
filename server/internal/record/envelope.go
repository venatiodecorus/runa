package record

import (
	"errors"
	"fmt"
)

// DMAlgV1 is the only tier-2 envelope algorithm of protocol v1 (§4).
// Implementations MUST reject unknown `alg` values rather than guess.
const DMAlgV1 = "x25519-hkdf-sha256+xchacha20poly1305"

// Sentinel errors for the dm-envelope checks that map to distinct API error
// codes (docs/protocol.md §6): unknown alg → unsupported_alg, bad `to` →
// unknown_account. Everything else is a generic invalid_record.
var (
	ErrUnsupportedAlg = errors.New("unsupported envelope alg")
	ErrInvalidTo      = errors.New("to must be a 32-byte base64url account id")
)

// ValidateDMEnvelope checks the dm-envelope structural fields (protocol §4)
// on top of the common record shape: `alg` pinned to DMAlgV1, `to` a
// well-formed account id, `nonce`/`ciphertext` non-empty strings, and
// `recipients` a non-empty array of objects each carrying device/eph_pub/
// wrap_nonce/wrapped_key strings. The ciphertext and recipient entries are
// otherwise OPAQUE — the server cannot and must not attempt decryption. It
// does not verify the signature.
func ValidateDMEnvelope(env *Record) error {
	if env.Type() != "dm" {
		return errors.New("not a dm")
	}
	if alg := env.str("alg"); alg != DMAlgV1 {
		return fmt.Errorf("%w: %q", ErrUnsupportedAlg, alg)
	}
	if _, err := DecodeKey(env.str("to")); err != nil {
		return fmt.Errorf("%w (%v)", ErrInvalidTo, err)
	}
	for _, field := range []string{"nonce", "ciphertext"} {
		if s, ok := env.m[field].(string); !ok || s == "" {
			return fmt.Errorf("%s must be a non-empty string", field)
		}
	}
	recipients, ok := env.m["recipients"].([]any)
	if !ok || len(recipients) == 0 {
		return errors.New("recipients must be a non-empty array")
	}
	for i, entry := range recipients {
		obj, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("recipients[%d] must be an object", i)
		}
		for _, field := range []string{"device", "eph_pub", "wrap_nonce", "wrapped_key"} {
			if s, ok := obj[field].(string); !ok || s == "" {
				return fmt.Errorf("recipients[%d].%s must be a non-empty string", i, field)
			}
		}
	}
	return nil
}
