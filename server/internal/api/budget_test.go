package api

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/store"
)

// newClockClient builds a test client whose server runs on the injected
// clock — budget refill depends on "today", so these tests advance days.
func newClockClient(t *testing.T, now func() time.Time) *testClient {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	ts := httptest.NewServer(New(st, Config{InstanceName: "test", Now: now}))
	t.Cleanup(ts.Close)
	return &testClient{t: t, ts: ts}
}

type budgetResp struct {
	DailyBudget  float64 `json:"daily_budget"`
	Tokens       float64 `json:"tokens"`
	Base         int     `json:"base"`
	InboundTrust float64 `json:"inbound_trust"`
	CarryoverCap float64 `json:"carryover_cap"`
}

func (c *testClient) budget(token string) budgetResp {
	c.t.Helper()
	status, body := c.do("GET", "/budget", token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("budget: status = %d, body %v", status, body)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		c.t.Fatal(err)
	}
	var b budgetResp
	if err := json.Unmarshal(raw, &b); err != nil {
		c.t.Fatalf("budget response %s: %v", raw, err)
	}
	return b
}

// tryDM signs and submits a dm without asserting the status.
func (c *testClient) tryDM(root, device keypair, to, createdAt string) (int, map[string]json.RawMessage) {
	c.t.Helper()
	body, _ := signRecord(c.t, dmFields(root, device, to, createdAt), device.priv)
	return c.do("POST", "/records", "", body)
}

func TestBudgetNewAccount(t *testing.T) {
	c := newClient(t)
	root, dev := c.signup("2026-08-20T12:00:00Z")
	token := c.authenticate(root, dev)

	if status, _ := c.do("GET", "/budget", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated budget: status = %d, want 401", status)
	}
	b := c.budget(token)
	// A brand-new bucket holds exactly one daily budget (base: no followers).
	if b.DailyBudget != 5 || b.Tokens != 5 || b.Base != 5 || b.InboundTrust != 0 || b.CarryoverCap != 10 {
		t.Fatalf("new-account budget = %+v, want {5 5 5 0 10}", b)
	}
}

func TestBudgetColdDMSpendsUntilExhausted(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	strangers := make([]keypair, 6)
	for i := range strangers {
		strangers[i], _ = c.signup("2026-08-20T12:00:00Z")
	}

	// Budget 5: five cold DMs to distinct strangers each cost one token.
	for i := 0; i < 5; i++ {
		ts := "2026-08-20T13:00:0" + string(rune('0'+i)) + "Z"
		if status, body := c.tryDM(rootS, devS, strangers[i].pub, ts); status != http.StatusCreated {
			t.Fatalf("cold dm %d: status = %d, body %v", i, status, body)
		}
	}
	if b := c.budget(tokenS); b.Tokens != 0 {
		t.Fatalf("after 5 cold dms: tokens = %v, want 0", b.Tokens)
	}

	// The sixth is refused with the published-constant explanation...
	status, body := c.tryDM(rootS, devS, strangers[5].pub, "2026-08-20T13:00:05Z")
	if status != http.StatusTooManyRequests || c.errorCode(body) != "budget_exhausted" {
		t.Fatalf("6th cold dm: status = %d code = %s, want 429 budget_exhausted", status, c.errorCode(body))
	}
	var e struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body["error"], &e); err != nil ||
		!strings.Contains(e.Message, "base 5/day") ||
		!strings.Contains(e.Message, "carryover cap 2 days") {
		t.Fatalf("429 message = %q, want the published constants named", e.Message)
	}
	// ...and NOT stored: five conversations of one message, nothing with the sixth.
	for i := 0; i < 5; i++ {
		if records, _ := c.dmWith(tokenS, strangers[i].pub, ""); len(records) != 1 {
			t.Fatalf("dm/with stranger %d: %d records, want 1", i, len(records))
		}
	}
	if records, _ := c.dmWith(tokenS, strangers[5].pub, ""); len(records) != 0 {
		t.Fatalf("refused dm was stored: %d records, want 0", len(records))
	}

	// A self-DM is never metered — it succeeds even on an empty bucket.
	if status, body := c.tryDM(rootS, devS, rootS.pub, "2026-08-20T13:00:06Z"); status != http.StatusCreated {
		t.Fatalf("self-dm on empty bucket: status = %d, body %v", status, body)
	}
}

func TestBudgetWarmDMFree(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)

	// B follows A: from B's (the recipient's) vantage A is warm.
	c.graphRecord("follow", rootB, devB, rootA.pub, "2026-08-20T13:00:00Z")
	if status, body := c.tryDM(rootA, devA, rootB.pub, "2026-08-20T14:00:00Z"); status != http.StatusCreated {
		t.Fatalf("warm dm: status = %d, body %v", status, body)
	}
	// Inbound trust from B's follow raises A's daily budget above base;
	// the bucket was created untouched, so tokens = one daily budget.
	b := c.budget(tokenA)
	if b.Tokens != b.DailyBudget {
		t.Fatalf("warm dm spent a token: tokens = %v, want the untouched daily budget %v", b.Tokens, b.DailyBudget)
	}
}

func TestBudgetReciprocalReplyFree(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // stranger who initiates
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)
	tokenA := c.authenticate(rootA, devA)

	// S cold-DMs A: S spends one token.
	if status, _ := c.tryDM(rootS, devS, rootA.pub, "2026-08-20T13:00:00Z"); status != http.StatusCreated {
		t.Fatal("initial cold dm failed")
	}
	if b := c.budget(tokenS); b.Tokens != 4 {
		t.Fatalf("initiator tokens = %v, want 4", b.Tokens)
	}
	// A replies to S. A is still a stranger from S's vantage, but S already
	// sent A a dm — the reciprocal window is open, so A spends nothing.
	if status, body := c.tryDM(rootA, devA, rootS.pub, "2026-08-20T13:30:00Z"); status != http.StatusCreated {
		t.Fatalf("reciprocal reply: status = %d, body %v", status, body)
	}
	if b := c.budget(tokenA); b.Tokens != 5 {
		t.Fatalf("replier tokens = %v, want 5 (reply within reciprocal window is free)", b.Tokens)
	}
}

func TestBudgetColdFollowAndFollowBack(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	rootT, devT := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)
	tokenT := c.authenticate(rootT, devT)

	// A follow of a local stranger is a cold initiation: S spends a token.
	c.graphRecord("follow", rootS, devS, rootT.pub, "2026-08-20T13:00:00Z")
	if b := c.budget(tokenS); b.Tokens != 4 {
		t.Fatalf("cold follow: tokens = %v, want 4", b.Tokens)
	}
	// T follows back. The subject of that follow is S, and S follows T, so
	// from S's vantage T is warm — the follow-back is free (the reciprocal
	// window itself is DM-based and plays no part here).
	c.graphRecord("follow", rootT, devT, rootS.pub, "2026-08-20T13:30:00Z")
	if b := c.budget(tokenT); b.Tokens != b.DailyBudget {
		t.Fatalf("follow-back spent a token: tokens = %v, want %v", b.Tokens, b.DailyBudget)
	}
	// Unfollow is never metered.
	c.graphRecord("unfollow", rootS, devS, rootT.pub, "2026-08-20T14:00:00Z")
	if b := c.budget(tokenS); b.Tokens != 4 {
		t.Fatalf("unfollow spent a token: tokens = %v, want 4", b.Tokens)
	}
	// A follow whose subject has no local account meters nothing.
	offInstance := genKey(t)
	c.graphRecord("follow", rootS, devS, offInstance.pub, "2026-08-20T14:30:00Z")
	if b := c.budget(tokenS); b.Tokens != 4 {
		t.Fatalf("off-instance follow spent a token: tokens = %v, want 4", b.Tokens)
	}
}

func TestBudgetMuteForcesColdAndIsUnmetered(t *testing.T) {
	c := newClient(t)
	rootP, devP := c.signup("2026-08-20T12:00:00Z")
	rootQ, devQ := c.signup("2026-08-20T12:00:00Z")
	tokenP := c.authenticate(rootP, devP)
	tokenQ := c.authenticate(rootQ, devQ)

	// Q follows P (cold, Q spends — not under test) and then mutes P.
	// Mute/unmute are never metered.
	c.graphRecord("follow", rootQ, devQ, rootP.pub, "2026-08-20T13:00:00Z")
	c.graphRecord("mute", rootQ, devQ, rootP.pub, "2026-08-20T13:10:00Z")
	if b := c.budget(tokenQ); b.Tokens != b.DailyBudget-1 {
		t.Fatalf("mute spent a token: tokens = %v, want %v", b.Tokens, b.DailyBudget-1)
	}
	// Without the mute, P following Q would be warm (Q follows P). The mute
	// zeroes Q's trust in P, so P's follow is cold and costs a token.
	c.graphRecord("follow", rootP, devP, rootQ.pub, "2026-08-20T14:00:00Z")
	if b := c.budget(tokenP); b.Tokens != b.DailyBudget-1 {
		t.Fatalf("follow of muter: tokens = %v, want %v (cold despite the inbound follow)", b.Tokens, b.DailyBudget-1)
	}
}

func TestBudgetGrowsWithFollowers(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	for i := 0; i < 3; i++ {
		rootF, devF := c.signup("2026-08-20T12:00:00Z")
		c.graphRecord("follow", rootF, devF, rootS.pub, "2026-08-20T13:00:00Z")
	}
	b := c.budget(tokenS)
	want := 5 + 4*math.Log(4) // base + k×log(1+inbound), inbound = 3 followers at standing 1.0
	if math.Abs(b.DailyBudget-want) > 1e-6 {
		t.Fatalf("daily_budget = %v, want %v", b.DailyBudget, want)
	}
	if b.InboundTrust != 3 {
		t.Fatalf("inbound_trust = %v, want 3", b.InboundTrust)
	}
	if b.Tokens != b.DailyBudget {
		t.Fatalf("fresh bucket tokens = %v, want one daily budget %v", b.Tokens, b.DailyBudget)
	}
	if math.Abs(b.CarryoverCap-2*b.DailyBudget) > 1e-9 {
		t.Fatalf("carryover_cap = %v, want 2×daily_budget = %v", b.CarryoverCap, 2*b.DailyBudget)
	}
}

func TestBudgetRefillAndCarryoverCap(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	c := newClockClient(t, func() time.Time { return now })
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenS := c.authenticate(rootS, devS)

	// Spend 3 of the 5 base tokens on cold DMs.
	for i := 0; i < 3; i++ {
		stranger, _ := c.signup("2026-08-20T12:00:00Z")
		ts := "2026-08-21T09:00:0" + string(rune('0'+i)) + "Z"
		if status, _ := c.tryDM(rootS, devS, stranger.pub, ts); status != http.StatusCreated {
			t.Fatalf("cold dm %d failed", i)
		}
	}
	if b := c.budget(tokenS); b.Tokens != 2 {
		t.Fatalf("tokens = %v, want 2", b.Tokens)
	}
	// Same day, later hour: no refill.
	now = now.Add(8 * time.Hour)
	if b := c.budget(tokenS); b.Tokens != 2 {
		t.Fatalf("same-day tokens = %v, want 2 (refill is per elapsed UTC day)", b.Tokens)
	}
	// Next day: one refill, 2 + 5 = 7.
	now = now.Add(24 * time.Hour)
	if b := c.budget(tokenS); b.Tokens != 7 {
		t.Fatalf("after 1 day: tokens = %v, want 7", b.Tokens)
	}
	// Three skipped days: refills saturate at the carryover cap, 2× the
	// daily budget.
	now = now.Add(3 * 24 * time.Hour)
	b := c.budget(tokenS)
	if b.Tokens != 2*b.DailyBudget || b.Tokens != 10 {
		t.Fatalf("after 3 skipped days: tokens = %v, want the cap 2×%v = 10", b.Tokens, b.DailyBudget)
	}
	// The cap holds: further days never exceed it.
	now = now.Add(24 * time.Hour)
	if b := c.budget(tokenS); b.Tokens != 10 {
		t.Fatalf("capped tokens = %v, want 10", b.Tokens)
	}
}
