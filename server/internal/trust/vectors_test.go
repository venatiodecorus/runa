package trust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestVectorConstants asserts Constants() matches the shared protocol
// vector. Numeric comparison is by value, not JSON literal: the vector's
// "2" and Go's 2.0 are the same number.
func TestVectorConstants(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("../../../docs/protocol/vectors", "constants-01.json"))
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	var v struct {
		Constants map[string]float64 `json:"constants"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("decode vector: %v", err)
	}
	if len(v.Constants) == 0 {
		t.Fatal("no constants in vector")
	}

	got := Constants()
	if len(got) != len(v.Constants) {
		t.Errorf("Constants() has %d entries, vector has %d", len(got), len(v.Constants))
	}
	for key, want := range v.Constants {
		raw, ok := got[key]
		if !ok {
			t.Errorf("Constants() missing %q", key)
			continue
		}
		var gotNum float64
		switch x := raw.(type) {
		case int:
			gotNum = float64(x)
		case float64:
			gotNum = x
		default:
			t.Errorf("Constants()[%q] has non-numeric type %T", key, raw)
			continue
		}
		if gotNum != want {
			t.Errorf("Constants()[%q] = %v, want %v", key, gotNum, want)
		}
	}
}
