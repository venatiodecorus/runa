package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// graphRecord signs and submits a follow/unfollow/mute/unmute record,
// asserting 201.
func (c *testClient) graphRecord(typ string, root, device keypair, subject, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, map[string]any{
		"v": 1, "type": typ, "author": root.pub, "device": device.pub,
		"created_at": createdAt, "subject": subject,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("%s: status = %d, body %v", typ, status, resp)
	}
	return body
}

// post signs and submits a post record, asserting 201, and returns its
// canonical bytes.
func (c *testClient) post(root, device keypair, text, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "body": text,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("post: status = %d, body %v", status, resp)
	}
	return body
}

func (c *testClient) followsOf(token, id string) (int, []json.RawMessage) {
	c.t.Helper()
	status, body := c.do("GET", "/accounts/"+id+"/follows", token, nil)
	if status != http.StatusOK {
		return status, nil
	}
	var follows []json.RawMessage
	if err := json.Unmarshal(body["follows"], &follows); err != nil {
		c.t.Fatalf("follows not a list: %s", body["follows"])
	}
	return status, follows
}

func (c *testClient) followerCount(id string) int {
	c.t.Helper()
	status, body := c.do("GET", "/accounts/"+id, "", nil)
	if status != http.StatusOK {
		c.t.Fatalf("get account: status = %d", status)
	}
	var n int
	if err := json.Unmarshal(body["follower_count"], &n); err != nil {
		c.t.Fatalf("follower_count = %s", body["follower_count"])
	}
	return n
}

func TestFollowLifecycle(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, _ := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)

	followRec := c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
	status, follows := c.followsOf(tokenA, rootA.pub)
	if status != http.StatusOK || len(follows) != 1 {
		t.Fatalf("after follow: status = %d, %d records, want 200 with 1", status, len(follows))
	}
	if !bytes.Equal(bytes.TrimSpace(follows[0]), followRec) {
		t.Errorf("served follow = %s, want the exact signed record", follows[0])
	}
	if n := c.followerCount(rootB.pub); n != 1 {
		t.Errorf("follower_count = %d, want 1", n)
	}

	// An unfollow older than the stored follow loses: latest created_at wins.
	c.graphRecord("unfollow", rootA, devA, rootB.pub, "2026-08-20T12:59:59Z")
	if _, follows := c.followsOf(tokenA, rootA.pub); len(follows) != 1 {
		t.Fatalf("stale unfollow removed the edge")
	}

	// A newer unfollow removes the edge.
	c.graphRecord("unfollow", rootA, devA, rootB.pub, "2026-08-20T14:00:00Z")
	if _, follows := c.followsOf(tokenA, rootA.pub); len(follows) != 0 {
		t.Fatalf("after unfollow: %d follows, want 0", len(follows))
	}
	if n := c.followerCount(rootB.pub); n != 0 {
		t.Errorf("follower_count after unfollow = %d, want 0", n)
	}

	// A follow older than the stored unfollow arrives late: still unfollowed.
	c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T13:30:00Z")
	if _, follows := c.followsOf(tokenA, rootA.pub); len(follows) != 0 {
		t.Fatalf("out-of-order follow resurrected the edge")
	}

	// A genuinely newer follow re-creates it.
	c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T15:00:00Z")
	if _, follows := c.followsOf(tokenA, rootA.pub); len(follows) != 1 {
		t.Fatalf("re-follow: %d follows, want 1", len(follows))
	}
	if n := c.followerCount(rootB.pub); n != 1 {
		t.Errorf("follower_count after re-follow = %d, want 1", n)
	}
}

func TestFollowsVisibility(t *testing.T) {
	c := newClient(t)
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenB := c.authenticate(rootB, devB)
	tokenA := c.authenticate(rootA, devA)
	tokenS := c.authenticate(rootS, devS)

	target := genKey(t) // off-instance subject: valid id, no local account
	c.graphRecord("follow", rootB, devB, target.pub, "2026-08-20T13:00:00Z")

	// No auth at all → 401.
	if status, _ := c.do("GET", "/accounts/"+rootB.pub+"/follows", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: status = %d, want 401", status)
	}
	// A stranger → 403 not_visible.
	status, body := c.do("GET", "/accounts/"+rootB.pub+"/follows", tokenS, nil)
	if status != http.StatusForbidden || c.errorCode(body) != "not_visible" {
		t.Fatalf("stranger: status = %d code = %s, want 403 not_visible", status, c.errorCode(body))
	}
	// The owner → 200.
	if status, follows := c.followsOf(tokenB, rootB.pub); status != http.StatusOK || len(follows) != 1 {
		t.Fatalf("owner: status = %d, %d follows, want 200 with 1", status, len(follows))
	}
	// A follower of B (A follows B) → 200.
	c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T13:00:01Z")
	if status, follows := c.followsOf(tokenA, rootB.pub); status != http.StatusOK || len(follows) != 1 {
		t.Fatalf("follower: status = %d, %d follows, want 200 with 1", status, len(follows))
	}
	// B being a follower of S does not entitle S to B's list (direction matters).
	c.graphRecord("follow", rootB, devB, rootS.pub, "2026-08-20T13:00:02Z")
	if status, _ := c.do("GET", "/accounts/"+rootB.pub+"/follows", tokenS, nil); status != http.StatusForbidden {
		t.Fatalf("followee-of-B: status = %d, want 403", status)
	}
	// B opts up to public via a profile record → stranger sees it.
	profile, _ := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": rootB.pub, "device": devB.pub,
		"created_at": "2026-08-20T14:00:00Z", "display_name": "b", "follows_public": true,
	}, devB.priv)
	if status, _ := c.do("POST", "/records", "", profile); status != http.StatusCreated {
		t.Fatal("profile submit failed")
	}
	if status, follows := c.followsOf(tokenS, rootB.pub); status != http.StatusOK || len(follows) != 2 {
		t.Fatalf("follows_public stranger: status = %d, %d follows, want 200 with 2", status, len(follows))
	}
	// Unknown account → 404.
	ghost := genKey(t)
	if status, _ := c.do("GET", "/accounts/"+ghost.pub+"/follows", tokenS, nil); status != http.StatusNotFound {
		t.Fatalf("unknown account: status = %d, want 404", status)
	}
}

func TestMutesPrivate(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootO, devO := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)
	tokenO := c.authenticate(rootO, devO)

	muted := genKey(t)
	c.graphRecord("mute", rootA, devA, muted.pub, "2026-08-20T13:00:00Z")

	// Owner's /graph/2hop is the one place the mute appears.
	status, body := c.do("GET", "/graph/2hop", tokenA, nil)
	if status != http.StatusOK {
		t.Fatalf("2hop: status = %d", status)
	}
	var mutes []string
	if err := json.Unmarshal(body["mutes"], &mutes); err != nil {
		t.Fatalf("mutes = %s", body["mutes"])
	}
	if len(mutes) != 1 || mutes[0] != muted.pub {
		t.Fatalf("owner mutes = %v, want [%s]", mutes, muted.pub)
	}

	// Another account's 2hop never carries A's mutes, even if O follows A.
	c.graphRecord("follow", rootO, devO, rootA.pub, "2026-08-20T13:00:01Z")
	status, body = c.do("GET", "/graph/2hop", tokenO, nil)
	if status != http.StatusOK {
		t.Fatalf("other 2hop: status = %d", status)
	}
	if err := json.Unmarshal(body["mutes"], &mutes); err != nil || len(mutes) != 0 {
		t.Fatalf("other viewer's mutes = %s, want []", body["mutes"])
	}

	// The public records listing never serves mute records — not via the
	// type filter and not in the unfiltered listing.
	for _, path := range []string{
		"/accounts/" + rootA.pub + "/records?type=mute",
		"/accounts/" + rootA.pub + "/records",
	} {
		status, body := c.do("GET", path, tokenO, nil)
		if status != http.StatusOK {
			t.Fatalf("%s: status = %d", path, status)
		}
		if bytes.Contains(body["records"], []byte(`"mute"`)) || bytes.Contains(body["records"], []byte(muted.pub)) {
			t.Fatalf("%s leaked the mute: %s", path, body["records"])
		}
	}

	// Mute lifecycle: a stale unmute loses, a newer one clears the mute.
	c.graphRecord("unmute", rootA, devA, muted.pub, "2026-08-20T12:59:59Z")
	_, body = c.do("GET", "/graph/2hop", tokenA, nil)
	if err := json.Unmarshal(body["mutes"], &mutes); err != nil || len(mutes) != 1 {
		t.Fatalf("stale unmute removed the mute: %s", body["mutes"])
	}
	c.graphRecord("unmute", rootA, devA, muted.pub, "2026-08-20T14:00:00Z")
	_, body = c.do("GET", "/graph/2hop", tokenA, nil)
	if err := json.Unmarshal(body["mutes"], &mutes); err != nil || len(mutes) != 0 {
		t.Fatalf("after unmute: mutes = %s, want []", body["mutes"])
	}
}

func TestGraph2hopShape(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	rootC, _ := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)

	far := genKey(t) // followed by B; no local account
	mutedX := genKey(t)

	c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
	c.graphRecord("follow", rootA, devA, rootC.pub, "2026-08-20T13:00:01Z")
	c.graphRecord("follow", rootB, devB, far.pub, "2026-08-20T13:00:02Z")
	c.graphRecord("mute", rootA, devA, mutedX.pub, "2026-08-20T13:00:03Z")

	status, body := c.do("GET", "/graph/2hop", tokenA, nil)
	if status != http.StatusOK {
		t.Fatalf("2hop: status = %d", status)
	}
	var follows map[string][]string
	if err := json.Unmarshal(body["follows"], &follows); err != nil {
		t.Fatalf("follows = %s", body["follows"])
	}
	if len(follows) != 3 {
		t.Fatalf("follows has %d keys %v, want 3 (viewer + 2 followees)", len(follows), follows)
	}
	if got := follows[rootA.pub]; len(got) != 2 {
		t.Errorf("viewer list = %v, want the 2 followees", got)
	}
	if got := follows[rootB.pub]; len(got) != 1 || got[0] != far.pub {
		t.Errorf("followee B list = %v, want [%s]", got, far.pub)
	}
	if got, ok := follows[rootC.pub]; !ok || len(got) != 0 {
		t.Errorf("followee C list = %v (present=%v), want present and empty", got, ok)
	}
	var mutes []string
	if err := json.Unmarshal(body["mutes"], &mutes); err != nil || len(mutes) != 1 || mutes[0] != mutedX.pub {
		t.Errorf("mutes = %s, want [%s]", body["mutes"], mutedX.pub)
	}
}

func TestFeedRankingAndMutes(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	rootC, devC := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)

	// A → B → C; posts ordered so recency alone would rank C first.
	c.graphRecord("follow", rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
	c.graphRecord("follow", rootB, devB, rootC.pub, "2026-08-20T13:00:01Z")
	postB := c.post(rootB, devB, "from B", "2026-08-20T14:00:00Z")
	postC := c.post(rootC, devC, "from C", "2026-08-20T14:30:00Z")
	c.post(rootA, devA, "own post", "2026-08-20T14:45:00Z")

	status, body := c.do("GET", "/feed", tokenA, nil)
	if status != http.StatusOK {
		t.Fatalf("feed: status = %d", status)
	}
	var items []struct {
		Record         json.RawMessage `json:"record"`
		Author         string          `json:"author"`
		CandidateTrust float64         `json:"candidate_trust"`
	}
	if err := json.Unmarshal(body["items"], &items); err != nil {
		t.Fatalf("items = %s", body["items"])
	}
	if len(items) != 2 {
		t.Fatalf("feed has %d items, want 2 (own posts excluded)", len(items))
	}
	if items[0].Author != rootB.pub || items[0].CandidateTrust != 1.0 {
		t.Errorf("item 0 = %s trust %v, want B at 1.0 (direct follow outranks recency)", items[0].Author, items[0].CandidateTrust)
	}
	if items[1].Author != rootC.pub || items[1].CandidateTrust != 0.35 {
		t.Errorf("item 1 = %s trust %v, want C at 0.35", items[1].Author, items[1].CandidateTrust)
	}
	if !bytes.Equal(bytes.TrimSpace(items[0].Record), postB) || !bytes.Equal(bytes.TrimSpace(items[1].Record), postC) {
		t.Errorf("feed records are not the exact canonical post bytes")
	}
	var authors map[string]struct {
		DeviceCerts       []json.RawMessage `json:"device_certs"`
		DeviceRevocations []json.RawMessage `json:"device_revocations"`
	}
	if err := json.Unmarshal(body["authors"], &authors); err != nil {
		t.Fatalf("authors = %s", body["authors"])
	}
	if len(authors) != 2 {
		t.Fatalf("authors has %d entries, want 2", len(authors))
	}
	for _, id := range []string{rootB.pub, rootC.pub} {
		a, ok := authors[id]
		if !ok || len(a.DeviceCerts) != 1 || len(a.DeviceRevocations) != 0 {
			t.Errorf("authors[%s] = %+v, want 1 cert, 0 revocations", id, a)
		}
	}

	// Muting B zeroes B and prunes the only path to C.
	c.graphRecord("mute", rootA, devA, rootB.pub, "2026-08-20T15:00:00Z")
	status, body = c.do("GET", "/feed", tokenA, nil)
	if status != http.StatusOK {
		t.Fatalf("feed after mute: status = %d", status)
	}
	if err := json.Unmarshal(body["items"], &items); err != nil || len(items) != 0 {
		t.Fatalf("feed after mute = %s, want empty items", body["items"])
	}
	if string(bytes.TrimSpace(body["authors"])) != "{}" {
		t.Errorf("authors after mute = %s, want {}", body["authors"])
	}
}

func TestGraphRecordSubjectValidation(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")

	for _, subject := range []any{"not-b64url!!", "", nil} {
		fields := map[string]any{
			"v": 1, "type": "follow", "author": rootA.pub, "device": devA.pub,
			"created_at": "2026-08-20T13:00:00Z",
		}
		if subject != nil {
			fields["subject"] = subject
		}
		rec, _ := signRecord(t, fields, devA.priv)
		status, body := c.do("POST", "/records", "", rec)
		if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
			t.Fatalf("subject %v: status = %d code = %s, want 400 invalid_record", subject, status, c.errorCode(body))
		}
	}

	// A valid but off-instance subject is accepted.
	stranger := genKey(t)
	c.graphRecord("follow", rootA, devA, stranger.pub, "2026-08-20T13:00:01Z")
}
