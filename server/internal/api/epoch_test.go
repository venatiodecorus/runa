package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/VenatioDecorus/runa/server/internal/store"
)

// --- tier-3 record builders ---
//
// Wraps and ciphertext are arbitrary well-shaped strings: the server treats
// them as opaque and never attempts decryption, so the API tests need no
// real cryptography (protocol §5).

const (
	testWrappedKey = "b3BhcXVlLXdyYXBwZWQtZXBvY2gta2V5"
	// The scoped-post plaintext and ciphertext of docs/protocol/vectors/
	// epoch-v1-01.json — used by the dump test: the ciphertext must reach
	// disk, the plaintext must not exist anywhere on this server.
	vectorCiphertext = "howDXfHMJbzT9QeUDJ8fs86SviT_xSHR4McCn2xMd5JhyMjwihFgdF1KBQ"
	vectorPlaintext  = "hello, web scope"
)

func epochFields(root, device keypair, source, createdAt string) map[string]any {
	return map[string]any{
		"v": 1, "type": "epoch",
		"author": root.pub, "device": device.pub, "created_at": createdAt,
		"scope": map[string]any{"source": source},
	}
}

func epochKeyFields(root, device keypair, epochID, to, createdAt string) map[string]any {
	return map[string]any{
		"v": 1, "type": "epoch-key", "alg": "x25519-hkdf-sha256+xchacha20poly1305",
		"author": root.pub, "device": device.pub, "created_at": createdAt,
		"epoch": epochID, "to": to,
		"recipients": []any{map[string]any{
			"device":      device.pub,
			"eph_pub":     "kAtA1UP7cYSWq-ptwZFEG6rATvyzLAJrmRnJ3aGz1wo",
			"wrap_nonce":  "WVtdX2FjZWdpa21vcXN1d3l7fX-Bg4WH",
			"wrapped_key": testWrappedKey,
		}},
	}
}

func scopedPostFields(root, device keypair, epochID, ciphertext, createdAt string) map[string]any {
	return map[string]any{
		"v": 1, "type": "scoped-post", "alg": "x25519-hkdf-sha256+xchacha20poly1305",
		"author": root.pub, "device": device.pub, "created_at": createdAt,
		"epoch": epochID,
		"nonce": "cXN1d3l7fX-Bg4WHiYuNj5GTlZeZm52f", "ciphertext": ciphertext,
	}
}

// submit signs fields and posts them, returning the status and error code.
func (c *testClient) submit(fields map[string]any, device keypair) (int, string) {
	c.t.Helper()
	body, _ := signRecord(c.t, fields, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status == http.StatusCreated {
		return status, ""
	}
	return status, c.errorCode(resp)
}

// epoch submits an epoch record, asserting 201, and returns its epoch id
// (= the record id, §5.2).
func (c *testClient) epoch(root, device keypair, source, createdAt string) string {
	c.t.Helper()
	body, id := signRecord(c.t, epochFields(root, device, source, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("epoch: status = %d, body %v", status, resp)
	}
	if got := str(c.t, resp["id"]); got != id {
		c.t.Fatalf("epoch id = %s, want the client-computed content address %s", got, id)
	}
	return id
}

// epochKey submits a key grant, asserting 201, and returns its canonical
// bytes.
func (c *testClient) epochKey(root, device keypair, epochID, to, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, epochKeyFields(root, device, epochID, to, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("epoch-key: status = %d, body %v", status, resp)
	}
	return body
}

// scopedPost submits a scoped post, asserting 201, and returns its
// canonical bytes.
func (c *testClient) scopedPost(root, device keypair, epochID, ciphertext, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, scopedPostFields(root, device, epochID, ciphertext, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("scoped-post: status = %d, body %v", status, resp)
	}
	return body
}

// --- read helpers ---

func (c *testClient) records(token, id, query string) []json.RawMessage {
	c.t.Helper()
	status, body := c.do("GET", "/accounts/"+id+"/records"+query, token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("records%s: status = %d, body %v", query, status, body)
	}
	var records []json.RawMessage
	if err := json.Unmarshal(body["records"], &records); err != nil {
		c.t.Fatalf("records = %s", body["records"])
	}
	return records
}

type epochKeysResp struct {
	Keys       []json.RawMessage          `json:"keys"`
	Epochs     map[string]json.RawMessage `json:"epochs"`
	NextBefore json.RawMessage            `json:"next_before"`
}

func (c *testClient) epochKeys(token, query string) epochKeysResp {
	c.t.Helper()
	status, body := c.do("GET", "/epochs/keys"+query, token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("epochs/keys: status = %d, body %v", status, body)
	}
	var out epochKeysResp
	raw, _ := json.Marshal(body)
	if err := json.Unmarshal(raw, &out); err != nil {
		c.t.Fatalf("epochs/keys body = %s", raw)
	}
	return out
}

// feedRecords returns the raw feed items' record bodies.
func (c *testClient) feedRecords(token string) []json.RawMessage {
	c.t.Helper()
	status, body := c.do("GET", "/feed", token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("feed: status = %d, body %v", status, body)
	}
	var items []struct {
		Record json.RawMessage `json:"record"`
	}
	if err := json.Unmarshal(body["items"], &items); err != nil {
		c.t.Fatalf("items = %s", body["items"])
	}
	out := make([]json.RawMessage, len(items))
	for i, it := range items {
		out[i] = it.Record
	}
	return out
}

func containsRecord(list []json.RawMessage, want []byte) bool {
	for _, r := range list {
		if bytes.Equal(bytes.TrimSpace(r), want) {
			return true
		}
	}
	return false
}

// TestScopedPostMemberDelivery is the full tier-3 flow: epoch → key fan-out
// → scoped posts, then the member/non-member split on every read path.
func TestScopedPostMemberDelivery(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // author
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // member
	rootC, devC := c.signup("2026-08-20T12:00:00Z") // non-member
	tokenA := c.authenticate(rootA, devA)
	tokenB := c.authenticate(rootB, devB)
	tokenC := c.authenticate(rootC, devC)

	// Both B and C follow A, so trust is identical from either vantage: the
	// only thing separating them is epoch membership.
	c.graphRecord("follow", rootB, devB, rootA.pub, "2026-08-20T12:01:00Z")
	c.graphRecord("follow", rootC, devC, rootA.pub, "2026-08-20T12:01:00Z")

	epochID := c.epoch(rootA, devA, "follows", "2026-08-20T12:02:00Z")
	// The author grants to themselves (other devices) and to B — never to C.
	selfGrant := c.epochKey(rootA, devA, epochID, rootA.pub, "2026-08-20T12:03:00Z")
	grantB := c.epochKey(rootA, devA, epochID, rootB.pub, "2026-08-20T12:03:01Z")
	post := c.scopedPost(rootA, devA, epochID, "b3BhcXVlLXNjb3BlZC1jaXBoZXJ0ZXh0", "2026-08-20T12:04:00Z")

	// Member: the post is a feed candidate and shows in the author's listing.
	if !containsRecord(c.feedRecords(tokenB), post) {
		t.Error("member does not see the scoped post in /feed")
	}
	if got := c.records(tokenB, rootA.pub, "?type=scoped-post"); !containsRecord(got, post) {
		t.Errorf("member's listing = %s, want the scoped post", got)
	}

	// Author: reads their own scoped history (implicit member, §5.2). Their
	// own posts never appear in their own feed, tier-1 or tier-3.
	if got := c.records(tokenA, rootA.pub, "?type=scoped-post"); !containsRecord(got, post) {
		t.Errorf("author's own listing = %s, want the scoped post", got)
	}

	// Non-member: silent omission everywhere. No 403 — an error would itself
	// disclose that the epoch exists.
	if containsRecord(c.feedRecords(tokenC), post) {
		t.Error("non-member sees the scoped post in /feed")
	}
	if got := c.records(tokenC, rootA.pub, "?type=scoped-post"); len(got) != 0 {
		t.Errorf("non-member's listing = %s, want empty", got)
	}
	if got := c.epochKeys(tokenC, ""); len(got.Keys) != 0 || len(got.Epochs) != 0 {
		t.Errorf("non-member's /epochs/keys = %+v, want empty", got)
	}

	// Tier-3 records never appear in public listings, filtered or not, and
	// never leak the wrapped key or ciphertext to a non-member.
	for _, path := range []string{
		"/accounts/" + rootA.pub + "/records",
		"/accounts/" + rootA.pub + "/records?type=post",
		"/accounts/" + rootA.pub + "/records?type=epoch",
		"/accounts/" + rootA.pub + "/records?type=epoch-key",
		"/feed",
	} {
		for _, token := range []string{"", tokenC} {
			if path == "/feed" && token == "" {
				continue // /feed requires auth
			}
			status, body := c.do("GET", path, token, nil)
			if status != http.StatusOK {
				t.Fatalf("%s: status = %d", path, status)
			}
			raw, _ := json.Marshal(body)
			for _, leak := range []string{`"epoch"`, `"epoch-key"`, `"scoped-post"`, testWrappedKey, "b3BhcXVlLXNjb3BlZC1jaXBoZXJ0ZXh0"} {
				if bytes.Contains(raw, []byte(leak)) {
					t.Errorf("%s (token %q) leaked %s: %s", path, token, leak, raw)
				}
			}
		}
	}
	// An unauthenticated caller asking for scoped posts directly gets an
	// empty page, not a 401 that would confirm the type exists here.
	if got := c.records("", rootA.pub, "?type=scoped-post"); len(got) != 0 {
		t.Errorf("anonymous scoped-post listing = %s, want empty", got)
	}

	// The member's key grants come back with their epoch record inlined, and
	// only grants addressed to them: B never sees A's self-grant.
	keys := c.epochKeys(tokenB, "")
	if len(keys.Keys) != 1 || !bytes.Equal(bytes.TrimSpace(keys.Keys[0]), grantB) {
		t.Fatalf("member's keys = %s, want exactly their own grant", keys.Keys)
	}
	if containsRecord(keys.Keys, selfGrant) {
		t.Error("member sees the author's self-grant")
	}
	epochRec, ok := keys.Epochs[epochID]
	if !ok {
		t.Fatalf("epochs = %v, want the referenced epoch inlined under %s", keys.Epochs, epochID)
	}
	var ep struct {
		Type   string `json:"type"`
		Author string `json:"author"`
		Scope  struct {
			Source string `json:"source"`
		} `json:"scope"`
	}
	if err := json.Unmarshal(epochRec, &ep); err != nil {
		t.Fatal(err)
	}
	if ep.Type != "epoch" || ep.Author != rootA.pub || ep.Scope.Source != "follows" {
		t.Errorf("inlined epoch = %+v, want A's follows-scoped epoch", ep)
	}
	if string(keys.NextBefore) != "null" {
		t.Errorf("next_before = %s, want null", keys.NextBefore)
	}
	// The author sees their own self-grant, and nothing addressed to B.
	keysA := c.epochKeys(tokenA, "")
	if len(keysA.Keys) != 1 || !bytes.Equal(bytes.TrimSpace(keysA.Keys[0]), selfGrant) {
		t.Errorf("author's keys = %s, want exactly the self-grant", keysA.Keys)
	}
	// Auth is required.
	if status, _ := c.do("GET", "/epochs/keys", "", nil); status != http.StatusUnauthorized {
		t.Errorf("unauthenticated /epochs/keys: status = %d, want 401", status)
	}
}

// TestScopedPostSnapshotAcrossEpochs checks the §7.2 snapshot semantics the
// server is responsible for: membership is per-epoch and frozen at fan-out,
// so a second epoch that omits B leaves B reading the first epoch's history
// and nothing newer.
func TestScopedPostSnapshotAcrossEpochs(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	tokenB := c.authenticate(rootB, devB)
	c.graphRecord("follow", rootB, devB, rootA.pub, "2026-08-20T12:01:00Z")

	epoch1 := c.epoch(rootA, devA, "follows", "2026-08-20T12:02:00Z")
	c.epochKey(rootA, devA, epoch1, rootB.pub, "2026-08-20T12:03:00Z")
	old := c.scopedPost(rootA, devA, epoch1, "b2xkLXNjb3BlZC1jaXBoZXJ0ZXh0", "2026-08-20T12:04:00Z")

	// B is unfollowed (removed from the scope), so the next epoch's fan-out
	// omits them; `prev` chains it to the epoch it supersedes (§5.5).
	c.graphRecord("unfollow", rootB, devB, rootA.pub, "2026-08-20T13:00:00Z")
	fields := epochFields(rootA, devA, "follows", "2026-08-20T13:01:00Z")
	fields["prev"] = epoch1
	body, epoch2 := signRecord(t, fields, devA.priv)
	if status, resp := c.do("POST", "/records", "", body); status != http.StatusCreated {
		t.Fatalf("rotated epoch: status = %d, body %v", status, resp)
	}
	fresh := c.scopedPost(rootA, devA, epoch2, "bmV3LXNjb3BlZC1jaXBoZXJ0ZXh0", "2026-08-20T13:02:00Z")

	got := c.records(tokenB, rootA.pub, "?type=scoped-post")
	if !containsRecord(got, old) {
		t.Error("removal un-shared the past: B lost the first epoch's post")
	}
	if containsRecord(got, fresh) {
		t.Error("B reads a post from an epoch they were never granted")
	}
}

// TestScopedPostNeedsTrustNotJustKeys pins §5.6: scoped posts change
// audience, not trust. A member with no trust path to the author gets no
// feed placement — key possession is necessary and never sufficient — but
// can still read the epoch's posts on the author's own timeline.
func TestScopedPostNeedsTrustNotJustKeys(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // member, but follows nobody
	tokenB := c.authenticate(rootB, devB)

	epochID := c.epoch(rootA, devA, "web", "2026-08-20T12:02:00Z")
	c.epochKey(rootA, devA, epochID, rootB.pub, "2026-08-20T12:03:00Z")
	post := c.scopedPost(rootA, devA, epochID, "b3BhcXVlLXNjb3BlZC1jaXBoZXJ0ZXh0", "2026-08-20T12:04:00Z")

	if containsRecord(c.feedRecords(tokenB), post) {
		t.Error("scoped post surfaced in the feed of a member with no trust path to the author")
	}
	if got := c.records(tokenB, rootA.pub, "?type=scoped-post"); !containsRecord(got, post) {
		t.Errorf("member's listing = %s, want the scoped post", got)
	}
}

// TestEpochKeysPagination follows the shared records paging convention:
// newest first, `before` walks backwards, next_before is null on a
// non-full page.
func TestEpochKeysPagination(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	tokenB := c.authenticate(rootB, devB)

	// One epoch per grant, so each page inlines one epoch record per grant.
	epochStamps := []string{"2026-08-20T12:02:00Z", "2026-08-20T12:02:01Z", "2026-08-20T12:02:02Z"}
	stamps := []string{"2026-08-20T12:03:00Z", "2026-08-20T12:03:01Z", "2026-08-20T12:03:02Z"}
	grants := make([][]byte, len(stamps))
	for i, ts := range stamps {
		epochID := c.epoch(rootA, devA, "follows", epochStamps[i])
		grants[i] = c.epochKey(rootA, devA, epochID, rootB.pub, ts)
	}

	page := c.epochKeys(tokenB, "?limit=2")
	if len(page.Keys) != 2 ||
		!bytes.Equal(bytes.TrimSpace(page.Keys[0]), grants[2]) ||
		!bytes.Equal(bytes.TrimSpace(page.Keys[1]), grants[1]) {
		t.Fatalf("page 1 = %s, want the newest two grants newest-first", page.Keys)
	}
	if len(page.Epochs) != 2 {
		t.Errorf("page 1 inlined %d epochs, want one per referenced epoch (2)", len(page.Epochs))
	}
	if got := str(t, page.NextBefore); got != stamps[1] {
		t.Fatalf("next_before = %s, want %s", got, stamps[1])
	}

	page = c.epochKeys(tokenB, "?limit=2&before="+stamps[1])
	if len(page.Keys) != 1 || !bytes.Equal(bytes.TrimSpace(page.Keys[0]), grants[0]) {
		t.Fatalf("page 2 = %s, want just the oldest grant", page.Keys)
	}
	if string(page.NextBefore) != "null" {
		t.Errorf("final next_before = %s, want null", page.NextBefore)
	}
}

// TestEpochIngestRules covers the §5.3/§5.4 authorization and the §5.1
// reserved-scope rejection.
func TestEpochIngestRules(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // epoch author
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // member
	rootC, devC := c.signup("2026-08-20T12:00:00Z") // outsider
	rootD, devD := c.signup("2026-08-20T12:00:00Z") // account B tries to admit

	epochID := c.epoch(rootA, devA, "web", "2026-08-20T12:02:00Z")
	c.epochKey(rootA, devA, epochID, rootB.pub, "2026-08-20T12:03:00Z")

	// Reserved and unknown scope sources are rejected, never interpreted.
	for _, source := range []string{"roster", "mailing-list"} {
		if status, code := c.submit(epochFields(rootA, devA, source, "2026-08-20T12:05:00Z"), devA); status != http.StatusBadRequest || code != "invalid_record" {
			t.Errorf("scope source %q: status = %d code = %s, want 400 invalid_record", source, status, code)
		}
	}

	// An epoch that this instance has never ingested.
	unknown := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if status, code := c.submit(epochKeyFields(rootA, devA, unknown, rootB.pub, "2026-08-20T12:06:00Z"), devA); status != http.StatusBadRequest || code != "unknown_epoch" {
		t.Errorf("epoch-key for unknown epoch: status = %d code = %s, want 400 unknown_epoch", status, code)
	}
	if status, code := c.submit(scopedPostFields(rootA, devA, unknown, "Y2lwaGVy", "2026-08-20T12:06:01Z"), devA); status != http.StatusBadRequest || code != "unknown_epoch" {
		t.Errorf("scoped-post for unknown epoch: status = %d code = %s, want 400 unknown_epoch", status, code)
	}

	// Only the epoch's author may post into it (v1, §5.4) — not even a
	// member with the key.
	if status, code := c.submit(scopedPostFields(rootB, devB, epochID, "Y2lwaGVy", "2026-08-20T12:07:00Z"), devB); status != http.StatusForbidden || code != "not_epoch_author" {
		t.Errorf("member posting into the epoch: status = %d code = %s, want 403 not_epoch_author", status, code)
	}

	// Key grants (§5.3): an outsider may not grant at all...
	if status, code := c.submit(epochKeyFields(rootC, devC, epochID, rootC.pub, "2026-08-20T12:08:00Z"), devC); status != http.StatusForbidden || code != "not_epoch_member" {
		t.Errorf("outsider self-grant: status = %d code = %s, want 403 not_epoch_member", status, code)
	}
	// ...a member may re-wrap to an existing member (late wraps for a new
	// device)...
	if status, code := c.submit(epochKeyFields(rootB, devB, epochID, rootA.pub, "2026-08-20T12:09:00Z"), devB); status != http.StatusCreated {
		t.Errorf("member re-wrapping to an existing member: status = %d code = %s, want 201", status, code)
	}
	// ...but never extend membership: only the author admits accounts.
	if status, code := c.submit(epochKeyFields(rootB, devB, epochID, rootD.pub, "2026-08-20T12:10:00Z"), devB); status != http.StatusForbidden || code != "not_epoch_member" {
		t.Errorf("member admitting a new account: status = %d code = %s, want 403 not_epoch_member", status, code)
	}
	// The rejected grant conferred nothing: D is still not a member.
	tokenD := c.authenticate(rootD, devD)
	if got := c.epochKeys(tokenD, ""); len(got.Keys) != 0 {
		t.Errorf("rejected grant still reached D: %s", got.Keys)
	}
	// The author, of course, may admit D.
	if status, code := c.submit(epochKeyFields(rootA, devA, epochID, rootD.pub, "2026-08-20T12:11:00Z"), devA); status != http.StatusCreated {
		t.Errorf("author admitting a new account: status = %d code = %s, want 201", status, code)
	}

	// `to` must name a local account.
	offInstance := genKey(t)
	if status, code := c.submit(epochKeyFields(rootA, devA, epochID, offInstance.pub, "2026-08-20T12:12:00Z"), devA); status != http.StatusBadRequest || code != "unknown_account" {
		t.Errorf("off-instance to: status = %d code = %s, want 400 unknown_account", status, code)
	}

	// Pinned alg: same code as the tier-2 path (reject, never guess).
	for name, fields := range map[string]map[string]any{
		"epoch-key unknown alg": mutate(epochKeyFields(rootA, devA, epochID, rootB.pub, "2026-08-20T12:13:00Z"), func(f map[string]any) {
			f["alg"] = "x25519-hkdf-sha256+aes256gcm"
		}),
		"scoped-post unknown alg": mutate(scopedPostFields(rootA, devA, epochID, "Y2lwaGVy", "2026-08-20T12:13:03Z"), func(f map[string]any) {
			f["alg"] = "x25519-hkdf-sha256+aes256gcm"
		}),
	} {
		if status, code := c.submit(fields, devA); status != http.StatusBadRequest || code != "unsupported_alg" {
			t.Errorf("%s: status = %d code = %s, want 400 unsupported_alg", name, status, code)
		}
	}

	// Structural rejects: the opaque-but-shaped fields.
	for name, fields := range map[string]map[string]any{
		"epoch-key empty recipients": mutate(epochKeyFields(rootA, devA, epochID, rootB.pub, "2026-08-20T12:13:01Z"), func(f map[string]any) {
			f["recipients"] = []any{}
		}),
		"epoch-key recipient missing field": mutate(epochKeyFields(rootA, devA, epochID, rootB.pub, "2026-08-20T12:13:02Z"), func(f map[string]any) {
			f["recipients"] = []any{map[string]any{"device": devA.pub, "eph_pub": "eA", "wrap_nonce": "bg"}}
		}),
		"scoped-post empty ciphertext": mutate(scopedPostFields(rootA, devA, epochID, "", "2026-08-20T12:13:04Z"), nil),
		"scoped-post missing nonce": mutate(scopedPostFields(rootA, devA, epochID, "Y2lwaGVy", "2026-08-20T12:13:05Z"), func(f map[string]any) {
			delete(f, "nonce")
		}),
		"epoch missing scope": mutate(epochFields(rootA, devA, "follows", "2026-08-20T12:13:06Z"), func(f map[string]any) {
			delete(f, "scope")
		}),
		"epoch empty prev": mutate(epochFields(rootA, devA, "follows", "2026-08-20T12:13:07Z"), func(f map[string]any) {
			f["prev"] = ""
		}),
	} {
		if status, code := c.submit(fields, devA); status != http.StatusBadRequest || code != "invalid_record" {
			t.Errorf("%s: status = %d code = %s, want 400 invalid_record", name, status, code)
		}
	}
}

func mutate(fields map[string]any, f func(map[string]any)) map[string]any {
	if f != nil {
		f(fields)
	}
	return fields
}

// TestScopedPostDumpHasNoPlaintext is the operator-side check: the SQLite
// file holds the scoped post's ciphertext and no plaintext — the server is a
// mailbox, and a dump of it reveals nothing readable (design §7.2).
func TestScopedPostDumpHasNoPlaintext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runa.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ts := httptest.NewServer(New(st, Config{InstanceName: "test"}))
	defer ts.Close()
	c := &testClient{t: t, ts: ts}

	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	c.graphRecord("follow", rootB, devB, rootA.pub, "2026-08-20T12:01:00Z")
	epochID := c.epoch(rootA, devA, "web", "2026-08-20T12:02:00Z")
	c.epochKey(rootA, devA, epochID, rootB.pub, "2026-08-20T12:03:00Z")
	c.scopedPost(rootA, devA, epochID, vectorCiphertext, "2026-08-20T12:04:00Z")

	// Close checkpoints the WAL into the main file.
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var dump []byte
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		dump = append(dump, b...)
	}
	if !bytes.Contains(dump, []byte(vectorCiphertext)) {
		t.Fatal("dump does not contain the scoped post's ciphertext — the test is not exercising storage")
	}
	if bytes.Contains(dump, []byte(vectorPlaintext)) {
		t.Errorf("dump contains the scoped post's PLAINTEXT %q", vectorPlaintext)
	}
}
