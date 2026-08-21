package trust

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

const vectorTolerance = 1e-9

func readVector(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("../../../docs/protocol/vectors", name))
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("decode vector: %v", err)
	}
}

// TestVectorTrust asserts SubjectiveTrust (and the TrustMap fast path)
// against the shared trust-graph-01 vector, so Go, core TS, and simlab all
// agree on the published math.
func TestVectorTrust(t *testing.T) {
	var v struct {
		Cases []struct {
			Name  string `json:"name"`
			Graph struct {
				Follows map[string][]string `json:"follows"`
				Mutes   []string            `json:"mutes"`
			} `json:"graph"`
			Viewer string  `json:"viewer"`
			Author string  `json:"author"`
			Trust  float64 `json:"trust"`
		} `json:"cases"`
	}
	readVector(t, "trust-graph-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no cases in vector")
	}
	for _, tc := range v.Cases {
		graph := GraphView{Follows: tc.Graph.Follows, Mutes: tc.Graph.Mutes}
		got := SubjectiveTrust(tc.Viewer, tc.Author, graph, DefaultParams)
		if math.Abs(got-tc.Trust) > vectorTolerance {
			t.Errorf("%s: SubjectiveTrust = %v, want %v", tc.Name, got, tc.Trust)
		}
		// TrustMap must agree pointwise; an absent key is the implicit zero.
		if got := TrustMap(tc.Viewer, graph, DefaultParams)[tc.Author]; math.Abs(got-tc.Trust) > vectorTolerance {
			t.Errorf("%s: TrustMap[%s] = %v, want %v", tc.Name, tc.Author, got, tc.Trust)
		}
	}
}

// TestVectorBudgets asserts DailyBudget against the shared budgets-01
// vector (natural log, tolerance 1e-9).
func TestVectorBudgets(t *testing.T) {
	var v struct {
		Cases []struct {
			Name         string  `json:"name"`
			Base         float64 `json:"base"`
			InboundTrust float64 `json:"inbound_trust"`
			K            float64 `json:"k"`
			Standing     float64 `json:"standing"`
			Budget       float64 `json:"budget"`
		} `json:"cases"`
	}
	readVector(t, "budgets-01.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no cases in vector")
	}
	for _, tc := range v.Cases {
		got := DailyBudget(tc.Base, tc.InboundTrust, tc.K, tc.Standing)
		if math.Abs(got-tc.Budget) > vectorTolerance {
			t.Errorf("%s: DailyBudget = %v, want %v", tc.Name, got, tc.Budget)
		}
	}
}
