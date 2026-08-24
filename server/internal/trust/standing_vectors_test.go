package trust

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// tolerance shared with the TS reference: the standing-01 vector's expected
// values are produced by calling the TypeScript functions, and both
// implementations must reproduce them within 1e-9.
const standingTol = 1e-9

func loadStandingVector(t *testing.T, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("../../../docs/protocol/vectors", "standing-01.json"))
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("decode vector: %v", err)
	}
}

func closeTo(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > standingTol {
		t.Errorf("%s = %.17g, want %.17g", label, got, want)
	}
}

// weightInput is one reporter's (p_adj, Σ inbound_trust) pair — the inputs
// to ReporterWeight.
type weightInput struct {
	AdjPenalty   float64 `json:"adj_penalty"`
	InboundTrust float64 `json:"inbound_trust"`
}

// standingVector mirrors docs/protocol/vectors/standing-01.json. The
// end_to_end cases come in two shapes: one shared weight_input for every
// reporter (many_unconnected), or a per-reporter weights_input map
// (tight_cluster) — the clustering case uses the latter.
type standingVector struct {
	Cases struct {
		Decay []struct {
			P0           float64 `json:"p0"`
			ElapsedDays  float64 `json:"elapsed_days"`
			HalfLifeDays float64 `json:"half_life_days"`
			Expected     float64 `json:"expected"`
		} `json:"decay"`
		ReporterWeights []struct {
			AdjPenalty   float64 `json:"adj_penalty"`
			InboundTrust float64 `json:"inbound_trust"`
			Expected     float64 `json:"expected"`
		} `json:"reporter_weights"`
		Clustering struct {
			clusterCase
			JaccardThreshold  float64 `json:"jaccard_threshold"`
			StandingGivenPAdj []struct {
				PAuto    float64 `json:"p_auto"`
				PAdj     float64 `json:"p_adj"`
				Expected float64 `json:"expected"`
			} `json:"standing_given_p_adj"`
		} `json:"clustering"`
		EndToEnd map[string]clusterCase `json:"end_to_end"`
	} `json:"cases"`
}

type clusterCase struct {
	Reporters        []string               `json:"reporters"`
	Follows          map[string][]string    `json:"follows"`
	WeightInput      *weightInput           `json:"weight_input"`
	WeightsInput     map[string]weightInput `json:"weights_input"`
	ExpectedClusters [][]string             `json:"expected_clusters"`
	ExpectedWeights  map[string]float64     `json:"expected_weights"`
	ExpectedMass     float64                `json:"expected_mass"`
	ExpectedPAuto    *float64               `json:"expected_p_auto"`
}

// weights resolves the case's per-reporter weight inputs, whether given as
// one shared pair or a map, and runs them through ReporterWeight.
func (c clusterCase) weights() map[string]float64 {
	out := make(map[string]float64, len(c.Reporters))
	for _, r := range c.Reporters {
		in := c.WeightsInput[r]
		if c.WeightInput != nil {
			in = *c.WeightInput
		}
		out[r] = ReporterWeight(in.AdjPenalty, in.InboundTrust)
	}
	return out
}

func TestVectorStandingDecay(t *testing.T) {
	var v standingVector
	loadStandingVector(t, &v)
	if len(v.Cases.Decay) == 0 {
		t.Fatal("no decay cases")
	}
	for _, c := range v.Cases.Decay {
		got := DecayPenalty(c.P0, c.ElapsedDays, c.HalfLifeDays)
		closeTo(t, "DecayPenalty", got, c.Expected)
	}
}

func TestVectorStandingReporterWeights(t *testing.T) {
	var v standingVector
	loadStandingVector(t, &v)
	if len(v.Cases.ReporterWeights) == 0 {
		t.Fatal("no reporter_weights cases")
	}
	for _, c := range v.Cases.ReporterWeights {
		got := ReporterWeight(c.AdjPenalty, c.InboundTrust)
		closeTo(t, "ReporterWeight", got, c.Expected)
	}
}

// checkClusterCase runs the full cluster → weights → mass (→ p_auto)
// pipeline against one fixture, the shared shape of the `clustering` case
// and both `end_to_end` cases.
func checkClusterCase(t *testing.T, name string, c clusterCase, jaccardThreshold float64) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		clusters := ClusterReporters(c.Reporters, c.Follows, jaccardThreshold)
		if !reflect.DeepEqual(clusters, c.ExpectedClusters) {
			t.Fatalf("clusters = %v, want %v", clusters, c.ExpectedClusters)
		}
		weights := c.weights()
		if len(c.ExpectedWeights) != len(weights) {
			t.Fatalf("weights = %d entries, want %d", len(weights), len(c.ExpectedWeights))
		}
		names := make([]string, 0, len(c.ExpectedWeights))
		for r := range c.ExpectedWeights {
			names = append(names, r)
		}
		sort.Strings(names)
		for _, r := range names {
			closeTo(t, "weight["+r+"]", weights[r], c.ExpectedWeights[r])
		}
		mass := ReportMass(clusters, weights)
		closeTo(t, "mass", mass, c.ExpectedMass)
		if c.ExpectedPAuto != nil {
			closeTo(t, "p_auto", AutoPenalty(mass), *c.ExpectedPAuto)
		}
	})
}

func TestVectorStandingClustering(t *testing.T) {
	var v standingVector
	loadStandingVector(t, &v)
	cl := v.Cases.Clustering
	if len(cl.Reporters) == 0 {
		t.Fatal("no clustering fixture")
	}
	checkClusterCase(t, "clustering", cl.clusterCase, cl.JaccardThreshold)

	if len(cl.StandingGivenPAdj) == 0 {
		t.Fatal("no standing_given_p_adj cases")
	}
	for _, c := range cl.StandingGivenPAdj {
		closeTo(t, "StandingFrom", StandingFrom(c.PAuto, c.PAdj), c.Expected)
	}
}

func TestVectorStandingEndToEnd(t *testing.T) {
	var v standingVector
	loadStandingVector(t, &v)
	if len(v.Cases.EndToEnd) == 0 {
		t.Fatal("no end_to_end cases")
	}
	names := make([]string, 0, len(v.Cases.EndToEnd))
	for name := range v.Cases.EndToEnd {
		names = append(names, name)
	}
	sort.Strings(names) // deterministic subtest order
	for _, name := range names {
		// The end-to-end cases run at this instance's published threshold —
		// the vector's own `clustering` case pins the threshold explicitly.
		checkClusterCase(t, name, v.Cases.EndToEnd[name], ReportClusterJaccard)
	}
}
