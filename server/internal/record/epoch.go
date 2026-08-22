package record

import (
	"errors"
	"fmt"
)

// Tier-3 record validation (docs/protocol.md §5). The server materializes
// scope/routing metadata and enforces membership, but every wrap and every
// ciphertext here is OPAQUE to it: it holds no decryption key and never
// attempts one (docs/architecture.md invariant 3).

// EpochAlgV1 pins `epoch-key` and `scoped-post` to the §4 hybrid mechanism,
// which §5.3/§5.4 reuse verbatim. Unknown algs are rejected, never guessed.
const EpochAlgV1 = DMAlgV1

// EpochScopeSourcesV1 are the abstract recipient sources of protocol §5.1.
// "roster" is RESERVED for the group layer (design §18.1) and, like any
// unknown source, must be rejected rather than interpreted.
var EpochScopeSourcesV1 = map[string]bool{
	"follows": true,
	"web":     true,
}

// ErrUnknownScopeSource marks a scope source this protocol version does not
// define, including the reserved "roster".
var ErrUnknownScopeSource = errors.New("unknown epoch scope source")

// ValidateEpoch checks the epoch-specific fields (§5.2) on top of the
// common record shape: a `scope` object whose `source` is a known,
// non-reserved v1 value, and an optional `prev` record id. The concrete
// membership is NOT validated against the named scope — the fan-out is the
// snapshot and scope enumeration is client authority (§5.1). It does not
// verify the signature.
func ValidateEpoch(rec *Record) error {
	if rec.Type() != "epoch" {
		return errors.New("not an epoch")
	}
	scope, ok := rec.m["scope"].(map[string]any)
	if !ok {
		return errors.New("scope must be an object")
	}
	source, ok := scope["source"].(string)
	if !ok || source == "" {
		return errors.New("scope.source must be a non-empty string")
	}
	if !EpochScopeSourcesV1[source] {
		return fmt.Errorf("%w: %q", ErrUnknownScopeSource, source)
	}
	if prev, present := rec.m["prev"]; present {
		if s, ok := prev.(string); !ok || s == "" {
			return errors.New("prev must be a non-empty record id when present")
		}
	}
	return nil
}

// ValidateEpochKey checks the key-grant fields (§5.3): pinned `alg`, an
// `epoch` record id, a well-formed `to` account id, and the same opaque
// per-device wrap array as §4. It does not verify the signature, and the
// authorization rule (author is the epoch author, or a member wrapping to
// an existing member) is a store-backed check made by the API layer.
func ValidateEpochKey(rec *Record) error {
	if rec.Type() != "epoch-key" {
		return errors.New("not an epoch-key")
	}
	if alg := rec.str("alg"); alg != EpochAlgV1 {
		return fmt.Errorf("%w: %q", ErrUnsupportedAlg, alg)
	}
	if s, ok := rec.m["epoch"].(string); !ok || s == "" {
		return errors.New("epoch must be a non-empty record id")
	}
	if _, err := DecodeKey(rec.str("to")); err != nil {
		return fmt.Errorf("to: %w", err)
	}
	return validateWraps(rec.m)
}

// ValidateScopedPost checks the scoped-post fields (§5.4): pinned `alg`, an
// `epoch` record id, and non-empty `nonce`/`ciphertext` strings — both
// opaque. It does not verify the signature; the author-is-epoch-author rule
// is a store-backed check made by the API layer.
func ValidateScopedPost(rec *Record) error {
	if rec.Type() != "scoped-post" {
		return errors.New("not a scoped-post")
	}
	if alg := rec.str("alg"); alg != EpochAlgV1 {
		return fmt.Errorf("%w: %q", ErrUnsupportedAlg, alg)
	}
	if s, ok := rec.m["epoch"].(string); !ok || s == "" {
		return errors.New("epoch must be a non-empty record id")
	}
	for _, field := range []string{"nonce", "ciphertext"} {
		if s, ok := rec.m[field].(string); !ok || s == "" {
			return fmt.Errorf("%s must be a non-empty string", field)
		}
	}
	return nil
}
