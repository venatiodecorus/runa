package record

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const vectorsDir = "../../../docs/protocol/vectors"

func loadVector(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatalf("read vector %s: %v", name, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("decode vector %s: %v", name, err)
	}
}

func TestVectorJCS(t *testing.T) {
	var v struct {
		Cases []struct {
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			Canonical string          `json:"canonical"`
		} `json:"cases"`
	}
	loadVector(t, "jcs-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no JCS vector cases")
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			parsed, err := ParseValue(c.Input)
			if err != nil {
				t.Fatalf("parse input: %v", err)
			}
			got, err := Canonicalize(parsed)
			if err != nil {
				t.Fatalf("canonicalize: %v", err)
			}
			if string(got) != c.Canonical {
				t.Errorf("canonical = %q, want %q", got, c.Canonical)
			}
		})
	}
}

func TestVectorRecords(t *testing.T) {
	var v struct {
		Seeds       map[string]string `json:"seeds"`
		Keys        map[string]string `json:"keys"`
		Certs       []json.RawMessage `json:"certs"`
		Revocations []json.RawMessage `json:"revocations"`
		Cases       []struct {
			Name         string          `json:"name"`
			Record       json.RawMessage `json:"record"`
			Valid        bool            `json:"valid"`
			Check        string          `json:"check"`
			Reason       string          `json:"reason"`
			SigningBytes string          `json:"signing_bytes_utf8"`
		} `json:"cases"`
	}
	loadVector(t, "records-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no record vector cases")
	}

	// The stated key IDs must be derivable from the seeds — this pins our
	// b64url and Ed25519 conventions to the reference implementation's.
	for seedName, keyName := range map[string]string{
		"root_ed25519":   "account_id",
		"device_ed25519": "device_id",
	} {
		seed, err := hex.DecodeString(v.Seeds[seedName])
		if err != nil {
			t.Fatalf("seed %s: %v", seedName, err)
		}
		pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		if got := base64.RawURLEncoding.EncodeToString(pub); got != v.Keys[keyName] {
			t.Errorf("%s = %s, want %s", keyName, got, v.Keys[keyName])
		}
	}

	parseAll := func(raws []json.RawMessage) []*Record {
		recs := make([]*Record, len(raws))
		for i, raw := range raws {
			rec, err := Parse(raw)
			if err != nil {
				t.Fatalf("parse context record: %v", err)
			}
			recs[i] = rec
		}
		return recs
	}
	certs := parseAll(v.Certs)
	revocations := parseAll(v.Revocations)

	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			rec, err := Parse(c.Record)
			if err != nil {
				t.Fatalf("parse record: %v", err)
			}
			verr := rec.VerifySignature()
			if c.Check == "chain" && verr == nil {
				verr = VerifyDeviceBinding(rec, certs, revocations)
			}
			if c.Valid && verr != nil {
				t.Errorf("verify failed, want valid: %v", verr)
			}
			if !c.Valid && verr == nil {
				t.Errorf("verify passed, want invalid (%s)", c.Reason)
			}
			if c.Valid && c.SigningBytes != "" {
				sb, err := rec.SigningBytes()
				if err != nil {
					t.Fatalf("signing bytes: %v", err)
				}
				if string(sb) != c.SigningBytes {
					t.Errorf("signing bytes = %q, want %q", sb, c.SigningBytes)
				}
			}
		})
	}
}
