package record

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
)

// TestVectorEnvelope consumes the shared tier-2 envelope vector as the
// server side of protocol §4: parse the envelope as a record, verify its
// Ed25519 signature (the device field is the signer; the vector needs no
// cert context), and check the structural ingest validation — including
// that an unknown `alg` is rejected. Decryption is deliberately absent:
// servers cannot and must not decrypt.
func TestVectorEnvelope(t *testing.T) {
	var v struct {
		Seeds    map[string]string `json:"seeds"`
		Envelope json.RawMessage   `json:"envelope"`
	}
	loadVector(t, "envelope-v1-01.json", &v)

	env, err := Parse(v.Envelope)
	if err != nil {
		t.Fatalf("parse envelope: %v", err)
	}

	// The stated device id must be derivable from the sender seed — pinning
	// our key conventions to the reference implementation's.
	seed, err := hex.DecodeString(v.Seeds["sender_device_ed25519"])
	if err != nil {
		t.Fatalf("sender seed: %v", err)
	}
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	if got := base64.RawURLEncoding.EncodeToString(pub); got != env.Device() {
		t.Errorf("device id from seed = %s, want %s", got, env.Device())
	}

	if err := env.VerifySignature(); err != nil {
		t.Errorf("envelope signature: %v", err)
	}
	if err := ValidateDMEnvelope(env); err != nil {
		t.Errorf("structural validation: %v", err)
	}

	// Ingest validation must reject an otherwise-identical envelope whose
	// alg is unknown (protocol versioning rule: reject, never guess).
	tampered, err := Parse(v.Envelope)
	if err != nil {
		t.Fatal(err)
	}
	tampered.m["alg"] = "x25519-hkdf-sha256+aes256gcm"
	err = ValidateDMEnvelope(tampered)
	if !errors.Is(err, ErrUnsupportedAlg) {
		t.Errorf("unknown alg: err = %v, want ErrUnsupportedAlg", err)
	}
}
