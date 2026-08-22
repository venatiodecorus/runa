package record

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
)

// signAs canonicalizes fields minus sig, signs them, and parses the result —
// the client side of §3, used here only to build the device certs the vector
// omits so the cert-chain path can be exercised.
func signAs(t *testing.T, fields map[string]any, priv ed25519.PrivateKey) *Record {
	t.Helper()
	sb, err := Canonicalize(fields)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	signed := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		signed[k] = v
	}
	signed["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, sb))
	body, err := FromMap(signed).CanonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	rec, err := Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func seedKey(t *testing.T, hexSeed string) (ed25519.PrivateKey, string) {
	t.Helper()
	seed, err := hex.DecodeString(hexSeed)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return priv, base64.RawURLEncoding.EncodeToString(pub)
}

// TestVectorEpoch consumes the shared tier-3 vector as the server side of
// protocol §5: parse all three record types, verify their signatures and
// device-cert chains, check the structural ingest validation, and confirm
// the epoch id is this implementation's content address of the epoch
// record. Decryption is deliberately absent — the server holds no key and
// never opens a wrap or a ciphertext (architecture invariant 3), so the
// vector's AEAD tamper cases are client-side only. The one tamper case that
// IS the server's business — a field mutated after signing — must fail
// signature verification here.
func TestVectorEpoch(t *testing.T) {
	var v struct {
		Seeds               map[string]string `json:"seeds"`
		Keys                map[string]string `json:"keys"`
		Epoch               json.RawMessage   `json:"epoch"`
		EpochID             string            `json:"epoch_id"`
		OtherEpochID        string            `json:"other_epoch_id"`
		EpochKeyToRecipient json.RawMessage   `json:"epoch_key_to_recipient"`
		EpochKeySelfGrant   json.RawMessage   `json:"epoch_key_self_grant"`
		ScopedPost          json.RawMessage   `json:"scoped_post"`
		TamperCases         []struct {
			Name     string `json:"name"`
			Record   string `json:"record"`
			Mutation struct {
				Field string `json:"field"`
				Op    string `json:"op"`
				Value string `json:"value"`
			} `json:"mutation"`
			Expect string `json:"expect"`
		} `json:"tamper_cases"`
	}
	loadVector(t, "epoch-v1-01.json", &v)

	// The stated ids must be derivable from the seeds — pinning our key
	// conventions to the reference implementation's.
	for seedName, keyName := range map[string]string{
		"author_root_ed25519":      "author",
		"author_device1_ed25519":   "author_device1",
		"author_device2_ed25519":   "author_device2",
		"recipient_root_ed25519":   "recipient",
		"recipient_device_ed25519": "recipient_device",
	} {
		if _, pub := seedKey(t, v.Seeds[seedName]); pub != v.Keys[keyName] {
			t.Errorf("%s = %s, want %s", keyName, pub, v.Keys[keyName])
		}
	}

	// The author's signing device, and a root-signed cert binding it — the
	// vector gives seeds, not certs, so the chain context is built here. The
	// kex pub is a well-formed placeholder: cert-chain verification never
	// reads it (the server cannot use a kex key for anything).
	rootPriv, _ := seedKey(t, v.Seeds["author_root_ed25519"])
	_, device1 := seedKey(t, v.Seeds["author_device1_ed25519"])
	cert := signAs(t, map[string]any{
		"v": 1, "type": "device-cert", "author": v.Keys["author"],
		"created_at":      "2026-08-20T11:00:00Z",
		"device_sign_pub": device1,
		"device_kex_pub":  v.Keys["author_device2"],
	}, rootPriv)
	certs := []*Record{cert}

	for _, c := range []struct {
		name     string
		raw      json.RawMessage
		validate func(*Record) error
	}{
		{"epoch", v.Epoch, ValidateEpoch},
		{"epoch-key to recipient", v.EpochKeyToRecipient, ValidateEpochKey},
		{"epoch-key self grant", v.EpochKeySelfGrant, ValidateEpochKey},
		{"scoped-post", v.ScopedPost, ValidateScopedPost},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec, err := Parse(c.raw)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if err := Verify(rec, certs, nil); err != nil {
				t.Errorf("signature + cert chain: %v", err)
			}
			if err := c.validate(rec); err != nil {
				t.Errorf("structural validation: %v", err)
			}
		})
	}

	// The epoch id IS the content address of the epoch record (§5.2).
	epoch, err := Parse(v.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	id, err := epoch.ID()
	if err != nil {
		t.Fatal(err)
	}
	if id != v.EpochID {
		t.Errorf("epoch id = %s, want %s", id, v.EpochID)
	}
	if v.EpochID == v.OtherEpochID {
		t.Error("vector's two epoch ids collide")
	}
	// Both key grants and the post name that epoch.
	for name, raw := range map[string]json.RawMessage{
		"epoch_key_to_recipient": v.EpochKeyToRecipient,
		"epoch_key_self_grant":   v.EpochKeySelfGrant,
		"scoped_post":            v.ScopedPost,
	} {
		rec, err := Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := rec.String("epoch"); got != v.EpochID {
			t.Errorf("%s.epoch = %s, want %s", name, got, v.EpochID)
		}
	}

	// The post-signing mutation case: a tampered field the server can and
	// must catch, without ever touching the ciphertext.
	raws := map[string]json.RawMessage{
		"epoch":                  v.Epoch,
		"epoch_key_to_recipient": v.EpochKeyToRecipient,
		"scoped_post":            v.ScopedPost,
	}
	sigCases := 0
	for _, c := range v.TamperCases {
		if c.Expect != "signature verification fails (record was mutated post-signing)" {
			continue // AEAD cases are client-side: the server never decrypts
		}
		sigCases++
		t.Run("tamper: "+c.Name, func(t *testing.T) {
			rec, err := Parse(raws[c.Record])
			if err != nil {
				t.Fatalf("parse %s: %v", c.Record, err)
			}
			rec.m[c.Mutation.Field] = c.Mutation.Value
			if err := rec.VerifySignature(); err == nil {
				t.Errorf("tampered %s verified, want failure", c.Mutation.Field)
			}
		})
	}
	if sigCases == 0 {
		t.Error("no signature-tamper case in the vector")
	}

	// Reserved and unknown scope sources are rejected, never interpreted
	// (§5.1): "roster" belongs to the group layer, not to v1.
	for _, source := range []string{"roster", "definitely-not-a-source"} {
		rec, err := Parse(v.Epoch)
		if err != nil {
			t.Fatal(err)
		}
		rec.m["scope"] = map[string]any{"source": source}
		if err := ValidateEpoch(rec); err == nil {
			t.Errorf("scope source %q accepted, want rejection", source)
		}
	}
	// Unknown alg → reject, never guess (versioning rule).
	for name, raw := range map[string]json.RawMessage{
		"epoch-key":   v.EpochKeyToRecipient,
		"scoped-post": v.ScopedPost,
	} {
		rec, err := Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		rec.m["alg"] = "x25519-hkdf-sha256+aes256gcm"
		var verr error
		if name == "epoch-key" {
			verr = ValidateEpochKey(rec)
		} else {
			verr = ValidateScopedPost(rec)
		}
		if verr == nil {
			t.Errorf("%s with unknown alg accepted, want rejection", name)
		}
	}
}
