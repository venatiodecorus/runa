package trust

import "math"

// GraphView is the viewer's entitled 2-hop slice (docs/protocol.md §6,
// GET /graph/2hop): their own follows, the follow list of each account they
// follow, plus their private mutes. This mirrors packages/core/src/trust.ts;
// the shared trust-graph-01 vector keeps the two implementations honest.
type GraphView struct {
	Follows map[string][]string
	Mutes   []string
}

// Params are the tunable constants of the trust computation
// (docs/trust-and-reach.md §6). Hop cap 2 is structural, not a parameter.
type Params struct {
	PerHopDecay     float64
	MultiPathSumCap float64
}

// DefaultParams are the published reference defaults.
var DefaultParams = Params{PerHopDecay: PerHopDecay, MultiPathSumCap: MultiPathSumCap}

func toSet(items []string) map[string]bool {
	set := make(map[string]bool, len(items))
	for _, it := range items {
		set[it] = true
	}
	return set
}

// SubjectiveTrust computes subjective_trust(viewer, author) per
// docs/trust-and-reach.md §1: direct follow = 1.0; each two-hop path adds
// PerHopDecay; paths sum, capped at MultiPathSumCap. Mutes are a hard zero
// that also prunes propagation through the muted account. Follow lists are
// deduped so a repeated edge can never double-count.
//
// Self-trust is not defined by the spec — callers always show the viewer
// their own records; SubjectiveTrust panics on viewer == author exactly as
// the TS reference throws.
func SubjectiveTrust(viewer, author string, graph GraphView, p Params) float64 {
	if author == viewer {
		panic("self-trust is not defined; treat own content as always visible")
	}
	muted := toSet(graph.Mutes)
	if muted[author] {
		return 0
	}
	weight := 0.0
	for mid := range toSet(graph.Follows[viewer]) {
		if muted[mid] { // hard zero prunes the muted account's outbound edges
			continue
		}
		if mid == author {
			weight += 1.0
			continue
		}
		if toSet(graph.Follows[mid])[author] {
			weight += p.PerHopDecay
		}
	}
	return math.Min(weight, p.MultiPathSumCap)
}

// TrustMap computes trust for every account reachable within the hop cap in
// one pass. The viewer is never a key; muted accounts are absent (their
// trust is the implicit zero).
func TrustMap(viewer string, graph GraphView, p Params) map[string]float64 {
	muted := toSet(graph.Mutes)
	out := make(map[string]float64)
	for mid := range toSet(graph.Follows[viewer]) {
		if muted[mid] {
			continue
		}
		out[mid] += 1.0
		for far := range toSet(graph.Follows[mid]) {
			if far == viewer || muted[far] {
				continue
			}
			out[far] += p.PerHopDecay
		}
	}
	for k, v := range out {
		out[k] = math.Min(v, p.MultiPathSumCap)
	}
	return out
}

// DailyBudget is the cold-outreach budget formula of docs/trust-and-reach.md
// §3: (base + k×ln(1+Σ inbound_trust)) × standing. Mirrors
// packages/core/src/budgets.ts; asserted by the budgets-01 vector. Negative
// inbound trust is clamped to zero. (Used by the Phase 4 budget mechanics;
// the math lands here with its vector.)
func DailyBudget(base, inboundTrust, k, standing float64) float64 {
	return (base + k*math.Log(1+math.Max(0, inboundTrust))) * standing
}
