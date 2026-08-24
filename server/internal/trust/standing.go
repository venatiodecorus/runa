package trust

import (
	"math"
	"sort"
)

// Standing math (docs/trust-and-reach.md §4): the one server-computed,
// server-authoritative enforcement factor. Pure functions only — this file
// mirrors packages/core/src/standing.ts function-for-function, and the
// shared standing-01 vector asserts the two agree to 1e-9. Clients never
// recompute standing itself (its inputs, reports, are private by design);
// the duplication exists so the server's enforcement and the simlab's
// simulation run the same published formulas.

func clamp01(x float64) float64 {
	return math.Min(1, math.Max(0, x))
}

// DecayPenalty is p_adj(t) = p0 · 2^(-Δt / half-life) (trust-and-reach §4):
// the human rung decays toward 0 with the standing half-life. p0 is clamped
// into [0,1] first; a negative elapsedDays (clock skew, same-instant
// adjudication) is treated as 0 elapsed.
func DecayPenalty(p0, elapsedDays, halfLifeDays float64) float64 {
	p := clamp01(p0)
	dt := math.Max(0, elapsedDays)
	return p * math.Pow(2, -dt/halfLifeDays)
}

// ReporterWeight is w(R) = (1 - p_adj(R)) × ln(1 + inbound_trust(R))
// (trust-and-reach §4) — natural log, the same scale as the budget formula
// (DailyBudget). Deliberately the reporter's *adjudicated* component only
// (not full standing including p_auto): discounting by p_auto would let
// mass-reporting a target's likely defenders silence their reports
// (report-the-reporters), and the definition would be recursive. Only a
// human-confirmed false-report burn or uphold ever reduces a reporter's
// future report weight.
func ReporterWeight(adjPenalty, inboundTrust float64) float64 {
	return (1 - clamp01(adjPenalty)) * math.Log(1+math.Max(0, inboundTrust))
}

// jaccard is the overlap of two outbound follow sets. Jaccard(∅,∅) = 0 by
// convention here, never 1: two accounts with empty outbound follow sets
// share no evidence of coordination and must NOT be linked just because
// both sets are empty.
func jaccard(a, b map[string]bool) float64 {
	intersection := 0
	for x := range a {
		if b[x] {
			intersection++
		}
	}
	union := len(a) + len(b) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

// ClusterReporters returns the connected components of the reporter link
// graph (trust-and-reach §4): reporters R1, R2 are linked iff either
// follows the other, or the Jaccard overlap of their outbound follow sets
// >= jaccardThreshold. Deterministic output: components sorted by their
// lexicographically-smallest member, members sorted within each component.
// `reporters` is deduped defensively.
func ClusterReporters(reporters []string, follows map[string][]string, jaccardThreshold float64) [][]string {
	nodes := make([]string, 0, len(reporters))
	seen := map[string]bool{}
	for _, r := range reporters {
		if seen[r] {
			continue
		}
		seen[r] = true
		nodes = append(nodes, r)
	}
	followSets := make(map[string]map[string]bool, len(nodes))
	for _, r := range nodes {
		followSets[r] = toSet(follows[r])
	}

	// Union-find over the deduped reporter list.
	parent := make(map[string]string, len(nodes))
	for _, r := range nodes {
		parent[r] = r
	}
	var find func(string) string
	find = func(x string) string {
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}
	union := func(a, b string) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[ra] = rb
		}
	}
	for i := 0; i < len(nodes); i++ {
		for j := i + 1; j < len(nodes); j++ {
			a, b := nodes[i], nodes[j]
			linked := followSets[a][b] || followSets[b][a] ||
				jaccard(followSets[a], followSets[b]) >= jaccardThreshold
			if linked {
				union(a, b)
			}
		}
	}

	groups := map[string][]string{}
	roots := []string{}
	for _, r := range nodes {
		root := find(r)
		if _, ok := groups[root]; !ok {
			roots = append(roots, root)
		}
		groups[root] = append(groups[root], r)
	}
	components := make([][]string, 0, len(groups))
	for _, root := range roots {
		members := groups[root]
		sort.Strings(members)
		components = append(components, members)
	}
	sort.Slice(components, func(i, j int) bool {
		return components[i][0] < components[j][0]
	})
	return components
}

// ReportMass is the diversity-weighted report mass (trust-and-reach §4):
// each cluster contributes only its maximum member weight — volume inside a
// cluster adds nothing. A reporter absent from `weights` counts as 0.
func ReportMass(clusters [][]string, weights map[string]float64) float64 {
	mass := 0.0
	for _, cluster := range clusters {
		max := 0.0
		for _, member := range cluster {
			if w := weights[member]; w > max {
				max = w
			}
		}
		mass += max
	}
	return mass
}

// AutoPenaltyWith is p_auto = min(cap, impact × max(0, mass))
// (trust-and-reach §4) with explicit constants — the shape the vector
// exercises and the instance-configurable form.
func AutoPenaltyWith(mass, impact, cap float64) float64 {
	return math.Min(cap, impact*math.Max(0, mass))
}

// AutoPenalty applies AutoPenaltyWith with this instance's published
// constants.
func AutoPenalty(mass float64) float64 {
	return AutoPenaltyWith(mass, ReportImpact, ReportAutoCap)
}

// StandingFrom is standing = (1 - p_auto) × (1 - p_adj) (protocol §9.3),
// each clamped to [0,1].
func StandingFrom(pAuto, pAdj float64) float64 {
	return (1 - clamp01(pAuto)) * (1 - clamp01(pAdj))
}
