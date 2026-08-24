package api

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// The M7 tests run on a frozen clock: standing decays continuously, so a
// stored p_adj read back a few microseconds later is *not* the value that
// was stored. Freezing the clock makes every assertion exact rather than
// approximate, and makes "one half-life later" a matter of backdating the
// stored decay clock — exactly what lazy evaluation reads.
var standingNow = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

func frozenClock() time.Time { return standingNow }

// rawStatus issues a request and returns only its status code — for the
// paths that answer with something other than a JSON body (a route that
// does not exist answers with net/http's plain-text 404).
func (c *testClient) rawStatus(method, path, token string, body []byte) int {
	c.t.Helper()
	req, err := http.NewRequest(method, c.ts.URL+"/api/v1"+path, bytes.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.ts.Client().Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// --- read helpers ---

type standingResp struct {
	Standing    float64  `json:"standing"`
	Limited     bool     `json:"limited"`
	Reasons     []string `json:"reasons"`
	FrozenUntil *string  `json:"frozen_until"`
}

func (c *testClient) standing(token string) standingResp {
	c.t.Helper()
	status, body := c.do("GET", "/standing", token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("standing: status = %d, body %v", status, body)
	}
	var out standingResp
	mustDecode(c.t, body, &out)
	return out
}

type reviewEntry struct {
	Account     string            `json:"account"`
	OpenedAt    string            `json:"opened_at"`
	Standing    float64           `json:"standing"`
	PAuto       float64           `json:"p_auto"`
	PAdj        float64           `json:"p_adj"`
	FrozenUntil *string           `json:"frozen_until"`
	Reports     []json.RawMessage `json:"reports"`
}

func (c *testClient) adminReview(token string) []reviewEntry {
	c.t.Helper()
	status, body := c.do("GET", "/admin/review", token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("admin review: status = %d, body %v", status, body)
	}
	var out struct {
		Entries []reviewEntry `json:"entries"`
	}
	mustDecode(c.t, body, &out)
	return out.Entries
}

type decisionResp struct {
	Account     string  `json:"account"`
	Decision    string  `json:"decision"`
	Standing    float64 `json:"standing"`
	PAuto       float64 `json:"p_auto"`
	PAdj        float64 `json:"p_adj"`
	FrozenUntil *string `json:"frozen_until"`
}

func (c *testClient) adminDecide(token, account, decision, note string) decisionResp {
	c.t.Helper()
	req, _ := json.Marshal(map[string]string{"decision": decision, "note": note})
	status, body := c.do("POST", "/admin/review/"+account, token, req)
	if status != http.StatusOK {
		c.t.Fatalf("admin decide %s: status = %d, body %v", decision, status, body)
	}
	var out decisionResp
	mustDecode(c.t, body, &out)
	return out
}

type reporter struct{ root, dev keypair }

// seedReporters signs up n reporters and gives each `followers` dedicated
// inbound follows (one throwaway account per edge, so no follower ever
// exceeds their own cold-outreach budget). With tight=true the reporters
// then all follow one another, making them a single connected component —
// the shape of a brigade (threat model A4). Their follower seeding runs
// first precisely so the mutual follows have budget to spend.
func seedReporters(c *testClient, n, followers int, tight bool) []reporter {
	c.t.Helper()
	out := make([]reporter, n)
	for i := range out {
		out[i].root, out[i].dev = c.signup("2026-08-20T12:00:00Z")
	}
	for _, r := range out {
		for f := 0; f < followers; f++ {
			rootF, devF := c.signup("2026-08-20T12:00:00Z")
			c.graphRecord("follow", rootF, devF, r.root.pub, "2026-08-22T10:00:00Z")
		}
	}
	if tight {
		for i, r := range out {
			for j, other := range out {
				if i == j {
					continue
				}
				c.graphRecord("follow", r.root, r.dev, other.root.pub, "2026-08-23T10:00:00Z")
			}
		}
	}
	return out
}

// fileReports has each reporter report subject once, with distinct
// timestamps.
func fileReports(c *testClient, reporters []reporter, subject, day string) {
	c.t.Helper()
	for i, r := range reporters {
		c.report(r.root, r.dev, subject, "spam", day+"T12:00:0"+string(rune('0'+i))+"Z")
	}
}

// --- the automated rung (§9.3, trust-and-reach §4) ---

// TestStandingMassCapsAndOpensReview is the diversity half of the thesis:
// five reporters from five unconnected regions contribute five full
// weights, saturating p_auto at report_auto_cap and opening a review-queue
// entry — automation is exhausted, and a human decides anything further
// (§9.4).
func TestStandingMassCapsAndOpensReview(t *testing.T) {
	c, _ := newStandingServer(t, frozenClock, "op-token")
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // the reported account
	tokenS := c.authenticate(rootS, devS)

	// 5 unconnected reporters, 11 followers each: 5 × ln(12) ≈ 12.42 mass,
	// past the cap/impact ratio of 12.
	reporters := seedReporters(c, 5, 11, false)
	if got := c.standing(tokenS); got.Standing != 1 {
		t.Fatalf("standing before any report = %v, want 1", got.Standing)
	}
	if len(c.adminReview("op-token")) != 0 {
		t.Fatal("review queue is not empty before any report")
	}

	fileReports(c, reporters, rootS.pub, "2026-08-24")

	// p_auto saturates at the cap: standing = 1 − 0.6 = 0.4.
	got := c.standing(tokenS)
	if math.Abs(got.Standing-(1-trust.ReportAutoCap)) > 1e-9 {
		t.Errorf("standing = %v, want %v (p_auto at the cap)", got.Standing, 1-trust.ReportAutoCap)
	}
	if !got.Limited {
		t.Error("limited = false, want true")
	}
	// Told *that*, never why: mechanisms only, no counts or thresholds.
	if len(got.Reasons) != 1 || got.Reasons[0] != "reports" {
		t.Errorf("reasons = %v, want [reports]", got.Reasons)
	}
	if got.FrozenUntil != nil {
		t.Errorf("frozen_until = %v, want null", *got.FrozenUntil)
	}

	entries := c.adminReview("op-token")
	if len(entries) != 1 || entries[0].Account != rootS.pub {
		t.Fatalf("review entries = %+v, want one for %s", entries, rootS.pub)
	}
	if math.Abs(entries[0].PAuto-trust.ReportAutoCap) > 1e-9 || entries[0].PAdj != 0 {
		t.Errorf("entry p_auto/p_adj = %v/%v, want %v/0", entries[0].PAuto, entries[0].PAdj, trust.ReportAutoCap)
	}
	if len(entries[0].Reports) != len(reporters) {
		t.Errorf("entry carries %d reports, want %d", len(entries[0].Reports), len(reporters))
	}
	// Further reports do not open a second entry while one is open.
	fileReports(c, reporters[:1], rootS.pub, "2026-08-25")
	if len(c.adminReview("op-token")) != 1 {
		t.Error("a second review entry opened while one was already open")
	}
}

// TestStandingTightClusterBarelyDents is the other half: a brigade is a
// tight cluster by definition (threat model A4), and a cluster contributes
// only its maximum member weight — volume inside it adds nothing. Six
// mutually-following reporters move standing far less than five unconnected
// ones and never reach the cap, so no review entry opens.
func TestStandingTightClusterBarelyDents(t *testing.T) {
	c, _ := newStandingServer(t, frozenClock, "op-token")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	const followers, n = 11, 6
	reporters := seedReporters(c, n, followers, true)
	fileReports(c, reporters, rootS.pub, "2026-08-24")

	// Mass = one member's weight. Every member has the same inbound trust
	// here: their 11 dedicated followers plus the 5 fellow brigade members
	// following them — which is exactly the point. Even counting the
	// brigade's own inflated follower graph, one cluster is one voice.
	wantMass := math.Log(1 + float64(followers+n-1))
	wantStanding := 1 - trust.AutoPenalty(wantMass)
	got := c.standing(tokenS)
	if math.Abs(got.Standing-wantStanding) > 1e-9 {
		t.Errorf("standing = %v, want %v", got.Standing, wantStanding)
	}
	if got.Standing < 1-trust.ReportAutoCap {
		t.Errorf("a tight cluster reached further than five unconnected reporters: %v", got.Standing)
	}
	if entries := c.adminReview("op-token"); len(entries) != 0 {
		t.Errorf("review queue opened for a sub-cap p_auto: %+v", entries)
	}
}

// --- enforcement (§9.3) ---

// TestStandingDirectFollowOverride covers trust-and-reach §5 invariant 3 /
// §9.3: a penalty shrinks reach to strangers but never severs a chosen
// edge. An author whose standing has collapsed to 0 still appears in the
// feed of someone who directly follows them — while a two-hop author with
// the same standing drops out.
func TestStandingDirectFollowOverride(t *testing.T) {
	c, st := newStandingServer(t, frozenClock, "")
	rootV, devV := c.signup("2026-08-20T12:00:00Z") // viewer
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // directly followed
	rootM, devM := c.signup("2026-08-20T12:00:00Z") // middle hop
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // two hops away
	tokenV := c.authenticate(rootV, devV)

	c.graphRecord("follow", rootV, devV, rootA.pub, "2026-08-21T10:00:00Z")
	c.graphRecord("follow", rootV, devV, rootM.pub, "2026-08-21T10:00:01Z")
	c.graphRecord("follow", rootM, devM, rootB.pub, "2026-08-21T10:00:02Z")
	c.post(rootA, devA, "from a chosen edge", "2026-08-24T12:00:00Z")
	c.post(rootB, devB, "from two hops away", "2026-08-24T12:00:01Z")

	// Both authors collapse to standing 0 (p_adj = 1).
	stamp := standingNow.Format(time.RFC3339)
	for _, a := range []string{rootA.pub, rootB.pub} {
		if err := st.SetAdjPenalty(a, 1, stamp); err != nil {
			t.Fatal(err)
		}
	}

	status, body := c.do("GET", "/feed", tokenV, nil)
	if status != http.StatusOK {
		t.Fatalf("feed: status = %d", status)
	}
	var feed struct {
		Items []struct {
			Author         string  `json:"author"`
			CandidateTrust float64 `json:"candidate_trust"`
			Standing       float64 `json:"standing"`
		} `json:"items"`
	}
	mustDecode(t, body, &feed)

	seen := map[string]bool{}
	for _, it := range feed.Items {
		seen[it.Author] = true
		if it.Standing != 0 {
			t.Errorf("author %s standing = %v, want 0", it.Author, it.Standing)
		}
		// Ordering still uses the standing-multiplied value; only inclusion
		// is overridden.
		if it.CandidateTrust != 0 {
			t.Errorf("author %s candidate_trust = %v, want 0 (subjective × standing)", it.Author, it.CandidateTrust)
		}
	}
	if !seen[rootA.pub] {
		t.Error("directly-followed author dropped out of the feed at standing 0")
	}
	if seen[rootB.pub] {
		t.Error("two-hop author at standing 0 still surfaced")
	}

	// The same standing rides along on the single-record read path.
	_, postAID := c.postWithID(rootA, devA, "another", "2026-08-24T12:05:00Z")
	status, body = c.do("GET", "/records/"+postAID, tokenV, nil)
	if status != http.StatusOK {
		t.Fatalf("get record: status = %d", status)
	}
	var rec struct {
		CandidateTrust float64 `json:"candidate_trust"`
		Standing       float64 `json:"standing"`
	}
	mustDecode(t, body, &rec)
	if rec.Standing != 0 || rec.CandidateTrust != 0 {
		t.Errorf("record standing/candidate_trust = %v/%v, want 0/0", rec.Standing, rec.CandidateTrust)
	}

	// And on the replies path, where trust gates rank but never existence.
	c.postReply(rootB, devB, "a reply from a penalized author", postAID, "2026-08-24T12:06:00Z")
	status, body = c.do("GET", "/records/"+postAID+"/replies", tokenV, nil)
	if status != http.StatusOK {
		t.Fatalf("replies: status = %d", status)
	}
	var replies struct {
		Items []struct {
			Author         string  `json:"author"`
			CandidateTrust float64 `json:"candidate_trust"`
			Standing       float64 `json:"standing"`
		} `json:"items"`
	}
	mustDecode(t, body, &replies)
	if len(replies.Items) != 1 {
		t.Fatalf("replies = %d, want 1 (every reply is served regardless of standing)", len(replies.Items))
	}
	if replies.Items[0].Standing != 0 || replies.Items[0].CandidateTrust != 0 {
		t.Errorf("reply standing/candidate_trust = %v/%v, want 0/0",
			replies.Items[0].Standing, replies.Items[0].CandidateTrust)
	}
}

// TestBudgetShrinksWithStanding covers the §3/§9.3 budget multiplier and
// the standing-weighted inbound sum: the sender's own standing scales the
// whole budget, and each follower counts only for their own standing.
func TestBudgetShrinksWithStanding(t *testing.T) {
	c, st := newStandingServer(t, frozenClock, "")
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootF, devF := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)
	c.graphRecord("follow", rootF, devF, rootA.pub, "2026-08-21T10:00:00Z")

	base := c.budget(tokenA)
	if base.InboundTrust != 1 {
		t.Fatalf("inbound_trust = %v, want 1 (one follower at standing 1)", base.InboundTrust)
	}

	stamp := standingNow.Format(time.RFC3339)
	// The follower is adjudicated: their inbound edge now carries only
	// their own standing, 1 − 0.6 = 0.4.
	if err := st.SetAdjPenalty(rootF.pub, trust.ReportUpholdPenalty, stamp); err != nil {
		t.Fatal(err)
	}
	wantInbound := 1 - trust.ReportUpholdPenalty
	if got := c.budget(tokenA); math.Abs(got.InboundTrust-wantInbound) > 1e-9 {
		t.Errorf("inbound_trust = %v, want %v (follower weighted by their standing)", got.InboundTrust, wantInbound)
	}

	// The sender's own standing multiplies the whole budget.
	if err := st.SetAdjPenalty(rootA.pub, trust.ReportUpholdPenalty, stamp); err != nil {
		t.Fatal(err)
	}
	penalized := c.budget(tokenA)
	wantBudget := trust.DailyBudget(trust.ColdBudgetOpen, wantInbound, trust.BudgetGrowthK, 1-trust.ReportUpholdPenalty)
	if math.Abs(penalized.DailyBudget-wantBudget) > 1e-9 {
		t.Errorf("daily_budget = %v, want %v", penalized.DailyBudget, wantBudget)
	}
	if penalized.DailyBudget >= base.DailyBudget {
		t.Errorf("daily_budget did not shrink with standing: %v >= %v", penalized.DailyBudget, base.DailyBudget)
	}
}

// TestFreezeBlocksColdOutreach covers the §9.4 freeze: cold initiations are
// refused with 429 cold_outreach_frozen regardless of the bucket, while
// warm paths (here, a reply inside an open reciprocal window) and posting
// are untouched.
func TestFreezeBlocksColdOutreach(t *testing.T) {
	c, st := newStandingServer(t, frozenClock, "")
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // the frozen sender
	rootT, _ := c.signup("2026-08-20T12:00:00Z")    // a stranger
	rootW, devW := c.signup("2026-08-20T12:00:00Z") // opens a warm window
	tokenS := c.authenticate(rootS, devS)

	// W cold-DMs S first: the reciprocal window is open for S → W.
	c.dm(rootW, devW, rootS.pub, "2026-08-24T11:00:00Z")

	until := standingNow.Add(48 * time.Hour).Format(time.RFC3339)
	if err := st.SetFrozenUntil(rootS.pub, until); err != nil {
		t.Fatal(err)
	}

	// A full bucket is no help: the freeze zeroes cold outreach.
	if b := c.budget(tokenS); b.Tokens != b.DailyBudget {
		t.Fatalf("bucket was already spent: %+v", b)
	}
	status, body := c.tryDM(rootS, devS, rootT.pub, "2026-08-24T12:00:00Z")
	if status != http.StatusTooManyRequests || c.errorCode(body) != "cold_outreach_frozen" {
		t.Fatalf("cold dm while frozen: status = %d code = %s, want 429 cold_outreach_frozen", status, c.errorCode(body))
	}
	var e struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body["error"], &e); err != nil || !bytes.Contains([]byte(e.Message), []byte(until)) {
		t.Fatalf("429 message = %q, want the frozen_until deadline named", e.Message)
	}
	// A cold follow is refused the same way.
	followBody, _ := signRecord(t, map[string]any{
		"v": 1, "type": "follow", "author": rootS.pub, "device": devS.pub,
		"created_at": "2026-08-24T12:00:01Z", "subject": rootT.pub,
	}, devS.priv)
	status, body = c.do("POST", "/records", "", followBody)
	if status != http.StatusTooManyRequests || c.errorCode(body) != "cold_outreach_frozen" {
		t.Fatalf("cold follow while frozen: status = %d code = %s, want 429 cold_outreach_frozen", status, c.errorCode(body))
	}
	// The warm reply inside the reciprocal window still works...
	if status, body := c.tryDM(rootS, devS, rootW.pub, "2026-08-24T12:01:00Z"); status != http.StatusCreated {
		t.Fatalf("warm reply while frozen: status = %d, body %v", status, body)
	}
	// ...and so does posting: a freeze throttles outreach, never speech.
	c.post(rootS, devS, "still speaking", "2026-08-24T12:02:00Z")
	// A report is never metered either, so a frozen account can still report.
	c.report(rootS, devS, rootT.pub, "harassment", "2026-08-24T12:03:00Z")

	// The subject is told *that* they are frozen, and the deadline.
	got := c.standing(tokenS)
	if !got.Limited || got.FrozenUntil == nil || *got.FrozenUntil != until {
		t.Errorf("standing = %+v, want limited with frozen_until %s", got, until)
	}
	if len(got.Reasons) != 1 || got.Reasons[0] != "frozen" {
		t.Errorf("reasons = %v, want [frozen]", got.Reasons)
	}

	// A freeze expires on its own: no permanent marks.
	expired := standingNow.Add(-48 * time.Hour).Format(time.RFC3339)
	if err := st.SetFrozenUntil(rootS.pub, expired); err != nil {
		t.Fatal(err)
	}
	if got := c.standing(tokenS); got.Limited || got.FrozenUntil != nil {
		t.Errorf("standing after the freeze lapsed = %+v, want unlimited", got)
	}
	if status, body := c.tryDM(rootS, devS, rootT.pub, "2026-08-24T12:04:00Z"); status != http.StatusCreated {
		t.Fatalf("cold dm after the freeze lapsed: status = %d, body %v", status, body)
	}
}

// TestStandingDefaultShape pins GET /standing for an untouched account:
// standing 1.0, not limited, no reasons, no freeze — and nothing else in
// the response, so no counts, thresholds, or reporter information can leak
// (§9.3).
func TestStandingDefaultShape(t *testing.T) {
	c, _ := newStandingServer(t, frozenClock, "")
	root, dev := c.signup("2026-08-20T12:00:00Z")
	token := c.authenticate(root, dev)

	if status, _ := c.do("GET", "/standing", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated standing: status = %d, want 401", status)
	}
	status, body := c.do("GET", "/standing", token, nil)
	if status != http.StatusOK {
		t.Fatalf("standing: status = %d", status)
	}
	if len(body) != 4 {
		t.Errorf("standing response has %d fields (%v), want exactly standing/limited/reasons/frozen_until", len(body), body)
	}
	var got standingResp
	mustDecode(t, body, &got)
	if got.Standing != 1 || got.Limited || len(got.Reasons) != 0 || got.FrozenUntil != nil {
		t.Errorf("default standing = %+v, want {1 false [] nil}", got)
	}
}

// --- the human rung (§9.4) ---

// TestAdminAuth covers the operator surface's gate: with no token
// configured the endpoints do not exist (404); with one configured, a
// missing or wrong token is 401.
func TestAdminAuth(t *testing.T) {
	unconfigured, _ := newStandingServer(t, frozenClock, "")
	if status := unconfigured.rawStatus("GET", "/admin/review", "op-token", nil); status != http.StatusNotFound {
		t.Errorf("GET /admin/review with no operator token configured: status = %d, want 404", status)
	}
	if status := unconfigured.rawStatus("POST", "/admin/review/anything", "op-token", []byte(`{"decision":"none"}`)); status != http.StatusNotFound {
		t.Errorf("POST /admin/review/{account} with no operator token configured: status = %d, want 404", status)
	}

	configured, _ := newStandingServer(t, frozenClock, "op-token")
	if status, _ := configured.do("GET", "/admin/review", "", nil); status != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", status)
	}
	if status, _ := configured.do("GET", "/admin/review", "wrong", nil); status != http.StatusUnauthorized {
		t.Errorf("wrong token: status = %d, want 401", status)
	}
	if entries := configured.adminReview("op-token"); len(entries) != 0 {
		t.Errorf("empty queue returned %d entries", len(entries))
	}
	// A decision on an account with no open entry is a 404.
	ghost := genKey(t)
	req, _ := json.Marshal(map[string]string{"decision": "none"})
	if status, _ := configured.do("POST", "/admin/review/"+ghost.pub, "op-token", req); status != http.StatusNotFound {
		t.Errorf("decision with no open entry: status = %d, want 404", status)
	}
}

// TestAdminDismissBurnsReporters covers the §9.4 dismiss decision: the
// window's reports are adjudicated false — excluded from mass forever, so
// the target recovers — and every distinct reporter takes the
// false_report_burn on their own p_adj. Reports carry consequences in both
// directions (design §4.1).
func TestAdminDismissBurnsReporters(t *testing.T) {
	c, _ := newStandingServer(t, frozenClock, "op-token")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	reporters := seedReporters(c, 5, 11, false)
	fileReports(c, reporters, rootS.pub, "2026-08-24")
	if len(c.adminReview("op-token")) != 1 {
		t.Fatal("expected an open review entry")
	}

	got := c.adminDecide("op-token", rootS.pub, "dismiss", "brigade")
	if got.PAuto != 0 || got.Standing != 1 {
		t.Errorf("after dismiss: p_auto/standing = %v/%v, want 0/1", got.PAuto, got.Standing)
	}
	if s := c.standing(tokenS); s.Standing != 1 || s.Limited {
		t.Errorf("subject standing after dismiss = %+v, want unlimited 1", s)
	}
	if entries := c.adminReview("op-token"); len(entries) != 0 {
		t.Errorf("entry still open after a decision: %+v", entries)
	}

	// Each reporter now carries the burn, disclosed by mechanism only.
	tokenR := c.authenticate(reporters[0].root, reporters[0].dev)
	burned := c.standing(tokenR)
	wantStanding := 1 - trust.FalseReportBurn
	if math.Abs(burned.Standing-wantStanding) > 1e-9 {
		t.Errorf("burned reporter standing = %v, want %v", burned.Standing, wantStanding)
	}
	if len(burned.Reasons) != 1 || burned.Reasons[0] != "adjudication" {
		t.Errorf("burned reporter reasons = %v, want [adjudication]", burned.Reasons)
	}

	// And their future reports weigh less: the same five reporters report a
	// second target, whose p_auto now falls short of the cap the identical
	// campaign reached before the burn.
	rootT, devT := c.signup("2026-08-20T12:00:00Z")
	tokenT := c.authenticate(rootT, devT)
	fileReports(c, reporters, rootT.pub, "2026-08-25")
	after := c.standing(tokenT)
	wantMass := 5 * (1 - trust.FalseReportBurn) * math.Log(1+11)
	wantT := 1 - trust.AutoPenalty(wantMass)
	if math.Abs(after.Standing-wantT) > 1e-9 {
		t.Errorf("second target standing = %v, want %v (burned reporters weigh less)", after.Standing, wantT)
	}
	if after.Standing <= 1-trust.ReportAutoCap {
		t.Errorf("burned reporters still reached the cap: standing = %v", after.Standing)
	}
}

// TestAdminUpholdDecays covers the §9.4 uphold decision and the "no
// permanent marks" invariant: p_adj is floored at report_uphold_penalty and
// then halves every standing_half_life_days. Elapsed time is simulated by
// backdating the stored decay clock, which is exactly what the lazy
// evaluation reads.
func TestAdminUpholdDecays(t *testing.T) {
	c, st := newStandingServer(t, frozenClock, "op-token")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	reporters := seedReporters(c, 5, 11, false)
	fileReports(c, reporters, rootS.pub, "2026-08-24")

	got := c.adminDecide("op-token", rootS.pub, "uphold", "confirmed")
	if math.Abs(got.PAdj-trust.ReportUpholdPenalty) > 1e-9 {
		t.Errorf("p_adj after uphold = %v, want %v", got.PAdj, trust.ReportUpholdPenalty)
	}
	// An uphold does not dismiss the reports, so both rungs apply:
	// standing = (1 − p_auto)(1 − p_adj).
	wantStanding := trust.StandingFrom(trust.ReportAutoCap, trust.ReportUpholdPenalty)
	if math.Abs(got.Standing-wantStanding) > 1e-9 {
		t.Errorf("standing after uphold = %v, want %v", got.Standing, wantStanding)
	}
	if s := c.standing(tokenS); len(s.Reasons) != 2 || s.Reasons[0] != "reports" || s.Reasons[1] != "adjudication" {
		t.Errorf("reasons after uphold = %v, want [reports adjudication]", s.Reasons)
	}

	// One half-life later, the human rung has halved. (The automated rung is
	// unchanged here: the reports are still inside the window.)
	row, err := st.GetStanding(rootS.pub)
	if err != nil || row == nil {
		t.Fatalf("standing row: %v", err)
	}
	backdated := standingNow.Add(-time.Duration(trust.StandingHalfLifeDays) * 24 * time.Hour)
	if err := st.SetAdjPenalty(rootS.pub, row.PAdj, backdated.Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	decayed := c.standing(tokenS)
	wantDecayed := trust.StandingFrom(trust.ReportAutoCap, trust.ReportUpholdPenalty/2)
	if math.Abs(decayed.Standing-wantDecayed) > 1e-9 {
		t.Errorf("standing after one half-life = %v, want %v", decayed.Standing, wantDecayed)
	}
	if decayed.Standing <= got.Standing {
		t.Errorf("standing did not recover with decay: %v <= %v", decayed.Standing, got.Standing)
	}
}

// TestAdminFreezeAndNone covers the remaining two §9.4 decisions: freeze
// sets the deadline (and closes the entry), and none closes without any
// state change.
func TestAdminFreezeAndNone(t *testing.T) {
	c, st := newStandingServer(t, frozenClock, "op-token")
	rootS, _ := c.signup("2026-08-20T12:00:00Z")
	reporters := seedReporters(c, 5, 11, false)
	fileReports(c, reporters, rootS.pub, "2026-08-24")

	got := c.adminDecide("op-token", rootS.pub, "freeze", "")
	if got.FrozenUntil == nil {
		t.Fatal("freeze decision returned no frozen_until")
	}
	until, err := time.Parse(time.RFC3339, *got.FrozenUntil)
	if err != nil {
		t.Fatalf("frozen_until %q: %v", *got.FrozenUntil, err)
	}
	if days := until.Sub(standingNow).Hours() / 24; math.Abs(days-trust.FreezeDays) > 1e-9 {
		t.Errorf("freeze length = %v days, want %d", days, trust.FreezeDays)
	}
	// A freeze is not a standing penalty: p_adj is untouched.
	if got.PAdj != 0 {
		t.Errorf("p_adj after freeze = %v, want 0", got.PAdj)
	}
	if entries := c.adminReview("op-token"); len(entries) != 0 {
		t.Errorf("entry still open after freeze: %+v", entries)
	}

	// "none" closes a fresh entry without touching anything.
	rootT, _ := c.signup("2026-08-20T12:00:00Z")
	fileReports(c, reporters, rootT.pub, "2026-08-25")
	none := c.adminDecide("op-token", rootT.pub, "none", "looked, did nothing")
	if none.PAdj != 0 || none.FrozenUntil != nil {
		t.Errorf(`"none" changed state: %+v`, none)
	}
	if math.Abs(none.PAuto-trust.ReportAutoCap) > 1e-9 {
		t.Errorf(`"none" changed p_auto: %v, want the reports still counting at %v`, none.PAuto, trust.ReportAutoCap)
	}
	if row, err := st.GetStanding(rootT.pub); err != nil || row != nil {
		t.Errorf(`"none" wrote a standing row: %+v (err %v)`, row, err)
	}
	// An unknown decision is rejected rather than interpreted.
	req, _ := json.Marshal(map[string]string{"decision": "ban"})
	if status, _ := c.do("POST", "/admin/review/"+rootT.pub, "op-token", req); status != http.StatusBadRequest {
		t.Errorf("unknown decision: status = %d, want 400", status)
	}
}
