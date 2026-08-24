package record

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
)

const ProtocolV = 1

// RootSignedTypes are the record types signed by the root key directly;
// they carry no `device` field (docs/protocol.md §3).
var RootSignedTypes = map[string]bool{
	"device-cert":   true,
	"device-revoke": true,
}

var createdAtRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)

// Record is a parsed signed record. The underlying map preserves number
// literals as json.Number so canonicalization reproduces the signed bytes.
type Record struct {
	m map[string]any
}

// Parse decodes a signed record from its JSON bytes.
func Parse(data []byte) (*Record, error) {
	v, err := ParseValue(data)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("record must be a JSON object")
	}
	return &Record{m: m}, nil
}

// FromMap wraps an already-built record map (values restricted to what
// Canonicalize accepts). The map is not copied.
func FromMap(m map[string]any) *Record { return &Record{m: m} }

func (r *Record) str(key string) string {
	s, _ := r.m[key].(string)
	return s
}

func (r *Record) Type() string      { return r.str("type") }
func (r *Record) Author() string    { return r.str("author") }
func (r *Record) Device() string    { return r.str("device") }
func (r *Record) CreatedAt() string { return r.str("created_at") }
func (r *Record) Sig() string       { return r.str("sig") }

// String returns the named field if it is a string.
func (r *Record) String(key string) (string, bool) {
	s, ok := r.m[key].(string)
	return s, ok
}

// Map returns the named field if it is a JSON object.
func (r *Record) Map(key string) (map[string]any, bool) {
	m, ok := r.m[key].(map[string]any)
	return m, ok
}

// RootSigned reports whether this record's type is root-signed.
func (r *Record) RootSigned() bool { return RootSignedTypes[r.Type()] }

// ValidateShape checks the common fields of docs/protocol.md §3.
func (r *Record) ValidateShape() error {
	if v, err := Canonicalize(r.m["v"]); err != nil || string(v) != "1" {
		return fmt.Errorf("unknown record version: %v", r.m["v"])
	}
	if r.Type() == "" {
		return errors.New("missing type")
	}
	if _, err := DecodeKey(r.Author()); err != nil {
		return fmt.Errorf("author: %w", err)
	}
	if r.RootSigned() {
		if _, present := r.m["device"]; present {
			return fmt.Errorf("%s must be root-signed (no device field)", r.Type())
		}
	} else if _, err := DecodeKey(r.Device()); err != nil {
		return fmt.Errorf("device: %w", err)
	}
	if !createdAtRE.MatchString(r.CreatedAt()) {
		return errors.New("created_at must be RFC 3339 UTC with Z suffix, second precision")
	}
	if _, ok := r.m["sig"].(string); !ok {
		return errors.New("missing sig")
	}
	return nil
}

// SigningBytes returns the canonical bytes of the record minus `sig`.
func (r *Record) SigningBytes() ([]byte, error) {
	rest := make(map[string]any, len(r.m))
	for k, v := range r.m {
		if k != "sig" {
			rest[k] = v
		}
	}
	return Canonicalize(rest)
}

// CanonicalBytes returns the canonical bytes of the full record including
// `sig` — the stored wire form and the input to the record ID.
func (r *Record) CanonicalBytes() ([]byte, error) { return Canonicalize(r.m) }

// ID is the content address: b64url(SHA-256(canonical bytes incl. sig)).
func (r *Record) ID() (string, error) {
	cb, err := r.CanonicalBytes()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cb)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// VerifySignature checks shape plus the record's own Ed25519 signature.
// Root-signed types verify against `author`, all others against `device`.
// For device-signed records the cert chain (VerifyDeviceBinding) is a
// separate, additionally required step.
func (r *Record) VerifySignature() error {
	if err := r.ValidateShape(); err != nil {
		return err
	}
	signer := r.Author()
	if !r.RootSigned() {
		signer = r.Device()
	}
	pub, err := DecodeKey(signer)
	if err != nil {
		return err
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(r.Sig())
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("sig is not a valid base64url Ed25519 signature")
	}
	sb, err := r.SigningBytes()
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), sb, sig) {
		return errors.New("signature verification failed")
	}
	return nil
}

// DecodeKey decodes a base64url-nopad 32-byte public key.
func DecodeKey(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("missing key")
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, errors.New("not valid base64url")
	}
	if len(b) != 32 {
		return nil, errors.New("must decode to 32 bytes")
	}
	return b, nil
}

// DecodeID decodes a base64url-nopad 32-byte content address — a record id
// (b64url(SHA-256(canonical bytes))), which happens to share DecodeKey's
// alphabet and length despite coming from an unrelated encoding (a digest,
// not an Ed25519 key). Identical checks to DecodeKey, but with error text
// that doesn't misleadingly call a record id a "key".
func DecodeID(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("missing id")
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, errors.New("not valid base64url")
	}
	if len(b) != 32 {
		return nil, errors.New("must decode to 32 bytes")
	}
	return b, nil
}
